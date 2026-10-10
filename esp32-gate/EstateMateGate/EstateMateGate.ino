/*
 * EstateMate ESP32 gate controller
 * =================================
 *
 * An ESP32 that *is* the gate: it reads a Wiegand card reader / keypad, decides
 * against a local copy of the estate's credentials, pulses the door relay, and
 * reports every decision to EstateMate. It signs in as a dedicated EstateMate
 * device agent, so it speaks the same agent protocol as the Windows, Linux and
 * Android bridges:
 *
 *   POST /api/isapi/v1/agents/<agent>/heartbeat            presence + snapshot health
 *   GET  /api/isapi/v1/agents/<agent>/credential-snapshot  the estate's active cards
 *   GET  /api/isapi/v1/agents/<agent>/operations           door commands, visitor PINs
 *   POST /api/isapi/v1/agents/<agent>/operations/<id>/result
 *   POST /api/isapi/v1/agents/<agent>/events               gate history
 *
 * It never contacts a Hikvision terminal: the terminal record it reports for in
 * the portal exists only to give the gate an EstateMate device ID, and its LAN
 * address is never dialled.
 *
 * Rules this file keeps (see esp32-gate/README.md):
 *   - Decisions are made against the cached snapshot, never a live query, so the
 *     gate keeps working when the estate's internet link drops.
 *   - A controller that has never loaded a snapshot denies every card.
 *   - A failed refresh keeps the previous snapshot; a refresh is applied only
 *     once every page of it has arrived.
 *   - Revoked cards leave the cache on the next refresh (the protocol's removals).
 *   - The exit button always opens the door, in every door mode (life safety).
 *   - Visitor PINs are admitted only inside their validity window, and the PIN
 *     typed at the keypad is never sent anywhere.
 *
 * Hardware (defaults; override any pin in secrets.h):
 *   Wiegand D0 -> GPIO 26, Wiegand D1 -> GPIO 27 (5 V readers need a level shifter)
 *   Door relay -> GPIO 25 (active HIGH), exit button -> GPIO 33 to GND
 *   Reader LED -> disabled, reader buzzer -> disabled
 *
 * Build: Arduino IDE 2 or arduino-cli with the "esp32 by Espressif" core
 * (2.0.x or 3.x) and the ArduinoJson library (7.x). Put the secrets.h you
 * downloaded from the portal next to this file.
 */

#include "secrets.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <time.h>
#include <sys/time.h>
#include <ctype.h>
#include <string.h>
#include <stdlib.h>
#include <algorithm>
#include <string>
#include <vector>

#define ESTATEMATE_GATE_VERSION "1.0.0"

// ---------------------------------------------------------------------------
// Configuration: secrets.h supplies the identity, everything else has a default
// ---------------------------------------------------------------------------

#ifndef ESTATEMATE_CONFIG_VERSION
#error "secrets.h is missing or is not an EstateMate ESP32 config. Download it from Device agent > Download ESP32 config."
#endif
#if ESTATEMATE_CONFIG_VERSION != 1
#error "This sketch expects ESTATEMATE_CONFIG_VERSION 1. Download a matching sketch and config from the portal."
#endif
#if !defined(ESTATEMATE_WIFI_CONFIGURED) || !ESTATEMATE_WIFI_CONFIGURED
#error "Fill in ESTATEMATE_WIFI_SSID and ESTATEMATE_WIFI_PASSWORD in secrets.h, then set ESTATEMATE_WIFI_CONFIGURED to 1."
#endif

#ifndef ESTATEMATE_WIEGAND_D0_PIN
#define ESTATEMATE_WIEGAND_D0_PIN 26
#endif
#ifndef ESTATEMATE_WIEGAND_D1_PIN
#define ESTATEMATE_WIEGAND_D1_PIN 27
#endif
#ifndef ESTATEMATE_RELAY_PIN
#define ESTATEMATE_RELAY_PIN 25
#endif
#ifndef ESTATEMATE_RELAY_ACTIVE_HIGH
#define ESTATEMATE_RELAY_ACTIVE_HIGH 1
#endif
#ifndef ESTATEMATE_EXIT_BUTTON_PIN
#define ESTATEMATE_EXIT_BUTTON_PIN 33
#endif
#ifndef ESTATEMATE_READER_LED_PIN
#define ESTATEMATE_READER_LED_PIN -1
#endif
#ifndef ESTATEMATE_READER_BUZZER_PIN
#define ESTATEMATE_READER_BUZZER_PIN -1
#endif
#ifndef ESTATEMATE_DOOR_OPEN_MS
#define ESTATEMATE_DOOR_OPEN_MS 3000
#endif
#ifndef ESTATEMATE_DOOR_NO
#define ESTATEMATE_DOOR_NO 1
#endif
#ifndef ESTATEMATE_WIEGAND_CHECK_PARITY
#define ESTATEMATE_WIEGAND_CHECK_PARITY 1
#endif
#ifndef ESTATEMATE_CARD_COOLDOWN_MS
#define ESTATEMATE_CARD_COOLDOWN_MS 1500
#endif
#ifndef ESTATEMATE_HEARTBEAT_SECONDS
#define ESTATEMATE_HEARTBEAT_SECONDS 60
#endif
#ifndef ESTATEMATE_SNAPSHOT_SECONDS
#define ESTATEMATE_SNAPSHOT_SECONDS 120
#endif
#ifndef ESTATEMATE_OPERATIONS_SECONDS
#define ESTATEMATE_OPERATIONS_SECONDS 10
#endif
#ifndef ESTATEMATE_SNAPSHOT_PAGE
#define ESTATEMATE_SNAPSHOT_PAGE 250
#endif
#ifndef ESTATEMATE_MAX_CARDS
#define ESTATEMATE_MAX_CARDS 0 /* 0 = automatic: 100000 with PSRAM, 8000 without */
#endif
#ifndef ESTATEMATE_MAX_VISITORS
#define ESTATEMATE_MAX_VISITORS 200
#endif
#ifndef ESTATEMATE_NTP_SERVER_1
#define ESTATEMATE_NTP_SERVER_1 "pool.ntp.org"
#endif
#ifndef ESTATEMATE_NTP_SERVER_2
#define ESTATEMATE_NTP_SERVER_2 "time.google.com"
#endif

// Trust anchors for the Worker's HTTPS certificate. Cloudflare issues from
// Google Trust Services, Let's Encrypt, SSL.com and Sectigo; these roots cover
// all four. A portal behind a different CA sets ESTATEMATE_CUSTOM_CA_PEM.
#ifdef ESTATEMATE_CUSTOM_CA_PEM
static const char ESTATEMATE_CA_BUNDLE[] = ESTATEMATE_CUSTOM_CA_PEM;
#else
static const char ESTATEMATE_CA_BUNDLE[] =
// ISRG_Root_X1
"-----BEGIN CERTIFICATE-----\n"
"MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n"
"TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\n"
"cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\n"
"WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\n"
"ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\n"
"MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\n"
"h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n"
"0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\n"
"A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\n"
"T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\n"
"B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\n"
"B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\n"
"KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\n"
"OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\n"
"jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\n"
"qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI\n"
"rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\n"
"HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\n"
"hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\n"
"ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n"
"3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\n"
"NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\n"
"ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\n"
"TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\n"
"jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\n"
"oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n"
"4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\n"
"mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\n"
"emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n"
"-----END CERTIFICATE-----\n"
// ISRG_Root_X2
"-----BEGIN CERTIFICATE-----\n"
"MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw\n"
"CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg\n"
"R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00\n"
"MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT\n"
"ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw\n"
"EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW\n"
"+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9\n"
"ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T\n"
"AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI\n"
"zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW\n"
"tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1\n"
"/q4AaOeMSQ+2b1tbFfLn\n"
"-----END CERTIFICATE-----\n"
// GTS_Root_R1
"-----BEGIN CERTIFICATE-----\n"
"MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw\n"
"CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU\n"
"MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw\n"
"MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp\n"
"Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA\n"
"A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo\n"
"27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w\n"
"Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw\n"
"TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl\n"
"qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH\n"
"szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8\n"
"Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk\n"
"MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92\n"
"wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p\n"
"aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN\n"
"VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID\n"
"AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E\n"
"FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb\n"
"C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe\n"
"QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy\n"
"h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4\n"
"7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J\n"
"ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef\n"
"MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/\n"
"Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT\n"
"6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ\n"
"0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm\n"
"2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb\n"
"bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c\n"
"-----END CERTIFICATE-----\n"
// GTS_Root_R4
"-----BEGIN CERTIFICATE-----\n"
"MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD\n"
"VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG\n"
"A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw\n"
"WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz\n"
"IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi\n"
"AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi\n"
"QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR\n"
"HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW\n"
"BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D\n"
"9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8\n"
"p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD\n"
"-----END CERTIFICATE-----\n"
// GlobalSign_Root_CA
"-----BEGIN CERTIFICATE-----\n"
"MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkG\n"
"A1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jv\n"
"b3QgQ0ExGzAZBgNVBAMTEkdsb2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAw\n"
"MDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9i\n"
"YWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJHbG9iYWxT\n"
"aWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaDuaZ\n"
"jc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavp\n"
"xy0Sy6scTHAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp\n"
"1Wrjsok6Vjk4bwY8iGlbKk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdG\n"
"snUOhugZitVtbNV4FpWi6cgKOOvyJBNPc1STE4U6G7weNLWLBYy5d4ux2x8gkasJ\n"
"U26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrXgzT/LCrBbBlDSgeF59N8\n"
"9iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8E\n"
"BTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0B\n"
"AQUFAAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOz\n"
"yj1hTdNGCbM+w6DjY1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE\n"
"38NflNUVyRRBnMRddWQVDf9VMOyGj/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymP\n"
"AbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhHhm4qxFYxldBniYUr+WymXUad\n"
"DKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveCX4XSQRjbgbME\n"
"HMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==\n"
"-----END CERTIFICATE-----\n"
// SSL.com_Root_Certification_Authority_ECC
"-----BEGIN CERTIFICATE-----\n"
"MIICjTCCAhSgAwIBAgIIdebfy8FoW6gwCgYIKoZIzj0EAwIwfDELMAkGA1UEBhMC\n"
"VVMxDjAMBgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQKDA9T\n"
"U0wgQ29ycG9yYXRpb24xMTAvBgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZpY2F0\n"
"aW9uIEF1dGhvcml0eSBFQ0MwHhcNMTYwMjEyMTgxNDAzWhcNNDEwMjEyMTgxNDAz\n"
"WjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hvdXN0\n"
"b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NMLmNvbSBS\n"
"b290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IEVDQzB2MBAGByqGSM49AgEGBSuB\n"
"BAAiA2IABEVuqVDEpiM2nl8ojRfLliJkP9x6jh3MCLOicSS6jkm5BBtHllirLZXI\n"
"7Z4INcgn64mMU1jrYor+8FsPazFSY0E7ic3s7LaNGdM0B9y7xgZ/wkWV7Mt/qCPg\n"
"CemB+vNH06NjMGEwHQYDVR0OBBYEFILRhXMw5zUE044CkvvlpNHEIejNMA8GA1Ud\n"
"EwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUgtGFczDnNQTTjgKS++Wk0cQh6M0wDgYD\n"
"VR0PAQH/BAQDAgGGMAoGCCqGSM49BAMCA2cAMGQCMG/n61kRpGDPYbCWe+0F+S8T\n"
"kdzt5fxQaxFGRrMcIQBiu77D5+jNB5n5DQtdcj7EqgIwH7y6C+IwJPt8bYBVCpk+\n"
"gA0z5Wajs6O7pdWLjwkspl1+4vAHCGht0nxpbl/f5Wpl\n"
"-----END CERTIFICATE-----\n"
// SSL.com_Root_Certification_Authority_RSA
"-----BEGIN CERTIFICATE-----\n"
"MIIF3TCCA8WgAwIBAgIIeyyb0xaAMpkwDQYJKoZIhvcNAQELBQAwfDELMAkGA1UE\n"
"BhMCVVMxDjAMBgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQK\n"
"DA9TU0wgQ29ycG9yYXRpb24xMTAvBgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZp\n"
"Y2F0aW9uIEF1dGhvcml0eSBSU0EwHhcNMTYwMjEyMTczOTM5WhcNNDEwMjEyMTcz\n"
"OTM5WjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hv\n"
"dXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NMLmNv\n"
"bSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IFJTQTCCAiIwDQYJKoZIhvcN\n"
"AQEBBQADggIPADCCAgoCggIBAPkP3aMrfcvQKv7sZ4Wm5y4bunfh4/WvpOz6Sl2R\n"
"xFdHaxh3a3by/ZPkPQ/CFp4LZsNWlJ4Xg4XOVu/yFv0AYvUiCVToZRdOQbngT0aX\n"
"qhvIuG5iXmmxX9sqAn78bMrzQdjt0Oj8P2FI7bADFB0QDksZ4LtO7IZl/zbzXmcC\n"
"C52GVWH9ejjt/uIZALdvoVBidXQ8oPrIJZK0bnoix/geoeOy3ZExqysdBP+lSgQ3\n"
"6YWkMyv94tZVNHwZpEpox7Ko07fKoZOI68GXvIz5HdkihCR0xwQ9aqkpk8zruFvh\n"
"/l8lqjRYyMEjVJ0bmBHDOJx+PYZspQ9AhnwC9FwCTyjLrnGfDzrIM/4RJTXq/LrF\n"
"YD3ZfBjVsqnTdXgDciLKOsMf7yzlLqn6niy2UUb9rwPW6mBo6oUWNmuF6R7As93E\n"
"JNyAKoFBbZQ+yODJgUEAnl6/f8UImKIYLEJAs/lvOCdLToD0PYFH4Ih86hzOtXVc\n"
"US4cK38acijnALXRdMbX5J+tB5O2UzU1/Dfkw/ZdFr4hc96SCvigY2q8lpJqPvi8\n"
"ZVWb3vUNiSYE/CUapiVpy8JtynziWV+XrOvvLsi81xtZPCvM8hnIk2snYxnP/Okm\n"
"+Mpxm3+T/jRnhE6Z6/yzeAkzcLpmpnbtG3PrGqUNxCITIJRWCk4sbE6x/c+cCbqi\n"
"M+2HAgMBAAGjYzBhMB0GA1UdDgQWBBTdBAkHovV6fVJTEpKV7jiAJQ2mWTAPBgNV\n"
"HRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFN0ECQei9Xp9UlMSkpXuOIAlDaZZMA4G\n"
"A1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsFAAOCAgEAIBgRlCn7Jp0cHh5wYfGV\n"
"cpNxJK1ok1iOMq8bs3AD/CUrdIWQPXhq9LmLpZc7tRiRux6n+UBbkflVma8eEdBc\n"
"Hadm47GUBwwyOabqG7B52B2ccETjit3E+ZUfijhDPwGFpUenPUayvOUiaPd7nNgs\n"
"PgohyC0zrL/FgZkxdMF1ccW+sfAjRfSda/wZY52jvATGGAslu1OJD7OAUN5F7kR/\n"
"q5R4ZJjT9ijdh9hwZXT7DrkT66cPYakylszeu+1jTBi7qUD3oFRuIIhxdRjqerQ0\n"
"cuAjJ3dctpDqhiVAq+8zD8ufgr6iIPv2tS0a5sKFsXQP+8hlAqRSAUfdSSLBv9jr\n"
"a6x+3uxjMxW3IwiPxg+NQVrdjsW5j+VFP3jbutIbQLH+cU0/4IGiul607BXgk90I\n"
"H37hVZkLId6Tngr75qNJvTYw/ud3sqB1l7UtgYgXZSD32pAAn8lSzDLKNXz1PQ/Y\n"
"K9f1JmzJBjSWFupwWRoyeXkLtoh/D1JIPb9s2KJELtFOt3JY04kTlf5Eq/jXixtu\n"
"nLwsoFvVagCvXzfh1foQC5ichucmj87w7G6KVwuA406ywKBjYZC6VWg3dGq2ktuf\n"
"oYYitmUnDuy2n0Jg5GfCtdpBC8TTi2EbvPofkSvXRAdeuims2cXp71NIWuuA8ShY\n"
"Ic2wBlX7Jz9TkHCpBB5XJ7k=\n"
"-----END CERTIFICATE-----\n"
// USERTrust_ECC_Certification_Authority
"-----BEGIN CERTIFICATE-----\n"
"MIICjzCCAhWgAwIBAgIQXIuZxVqUxdJxVt7NiYDMJjAKBggqhkjOPQQDAzCBiDEL\n"
"MAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNl\n"
"eSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMT\n"
"JVVTRVJUcnVzdCBFQ0MgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTAwMjAx\n"
"MDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBiDELMAkGA1UEBhMCVVMxEzARBgNVBAgT\n"
"Ck5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQKExVUaGUg\n"
"VVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBFQ0MgQ2VydGlm\n"
"aWNhdGlvbiBBdXRob3JpdHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQarFRaqflo\n"
"I+d61SRvU8Za2EurxtW20eZzca7dnNYMYf3boIkDuAUU7FfO7l0/4iGzzvfUinng\n"
"o4N+LZfQYcTxmdwlkWOrfzCjtHDix6EznPO/LlxTsV+zfTJ/ijTjeXmjQjBAMB0G\n"
"A1UdDgQWBBQ64QmG1M8ZwpZ2dEl23OA1xmNjmjAOBgNVHQ8BAf8EBAMCAQYwDwYD\n"
"VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNoADBlAjA2Z6EWCNzklwBBHU6+4WMB\n"
"zzuqQhFkoJ2UOQIReVx7Hfpkue4WQrO/isIJxOzksU0CMQDpKmFHjFJKS04YcPbW\n"
"RNZu9YO6bVi9JNlWSOrvxKJGgYhqOkbRqZtNyWHa0V1Xahg=\n"
"-----END CERTIFICATE-----\n"
// USERTrust_RSA_Certification_Authority
"-----BEGIN CERTIFICATE-----\n"
"MIIF3jCCA8agAwIBAgIQAf1tMPyjylGoG7xkDjUDLTANBgkqhkiG9w0BAQwFADCB\n"
"iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0pl\n"
"cnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNV\n"
"BAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTAw\n"
"MjAxMDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBiDELMAkGA1UEBhMCVVMxEzARBgNV\n"
"BAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQKExVU\n"
"aGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBSU0EgQ2Vy\n"
"dGlmaWNhdGlvbiBBdXRob3JpdHkwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIK\n"
"AoICAQCAEmUXNg7D2wiz0KxXDXbtzSfTTK1Qg2HiqiBNCS1kCdzOiZ/MPans9s/B\n"
"3PHTsdZ7NygRK0faOca8Ohm0X6a9fZ2jY0K2dvKpOyuR+OJv0OwWIJAJPuLodMkY\n"
"tJHUYmTbf6MG8YgYapAiPLz+E/CHFHv25B+O1ORRxhFnRghRy4YUVD+8M/5+bJz/\n"
"Fp0YvVGONaanZshyZ9shZrHUm3gDwFA66Mzw3LyeTP6vBZY1H1dat//O+T23LLb2\n"
"VN3I5xI6Ta5MirdcmrS3ID3KfyI0rn47aGYBROcBTkZTmzNg95S+UzeQc0PzMsNT\n"
"79uq/nROacdrjGCT3sTHDN/hMq7MkztReJVni+49Vv4M0GkPGw/zJSZrM233bkf6\n"
"c0Plfg6lZrEpfDKEY1WJxA3Bk1QwGROs0303p+tdOmw1XNtB1xLaqUkL39iAigmT\n"
"Yo61Zs8liM2EuLE/pDkP2QKe6xJMlXzzawWpXhaDzLhn4ugTncxbgtNMs+1b/97l\n"
"c6wjOy0AvzVVdAlJ2ElYGn+SNuZRkg7zJn0cTRe8yexDJtC/QV9AqURE9JnnV4ee\n"
"UB9XVKg+/XRjL7FQZQnmWEIuQxpMtPAlR1n6BB6T1CZGSlCBst6+eLf8ZxXhyVeE\n"
"Hg9j1uliutZfVS7qXMYoCAQlObgOK6nyTJccBz8NUvXt7y+CDwIDAQABo0IwQDAd\n"
"BgNVHQ4EFgQUU3m/WqorSs9UgOHYm8Cd8rIDZsswDgYDVR0PAQH/BAQDAgEGMA8G\n"
"A1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEMBQADggIBAFzUfA3P9wF9QZllDHPF\n"
"Up/L+M+ZBn8b2kMVn54CVVeWFPFSPCeHlCjtHzoBN6J2/FNQwISbxmtOuowhT6KO\n"
"VWKR82kV2LyI48SqC/3vqOlLVSoGIG1VeCkZ7l8wXEskEVX/JJpuXior7gtNn3/3\n"
"ATiUFJVDBwn7YKnuHKsSjKCaXqeYalltiz8I+8jRRa8YFWSQEg9zKC7F4iRO/Fjs\n"
"8PRF/iKz6y+O0tlFYQXBl2+odnKPi4w2r78NBc5xjeambx9spnFixdjQg3IM8WcR\n"
"iQycE0xyNN+81XHfqnHd4blsjDwSXWXavVcStkNr/+XeTWYRUc+ZruwXtuhxkYze\n"
"Sf7dNXGiFSeUHM9h4ya7b6NnJSFd5t0dCy5oGzuCr+yDZ4XUmFF0sbmZgIn/f3gZ\n"
"XHlKYC6SQK5MNyosycdiyA5d9zZbyuAlJQG03RoHnHcAP9Dc1ew91Pq7P8yF1m9/\n"
"qS3fuQL39ZeatTXaw2ewh0qpKJ4jjv9cJ2vhsE/zB+4ALtRZh8tSQZXq9EfX7mRB\n"
"VXyNWQKV3WKdwrnuWih0hKWbt5DHDAff9Yk2dDLWKMGwsAvgnEzDHNb842m1R0aB\n"
"L6KCq9NjRHDEjf8tM7qtj3u1cIiuPhnPQCjY/MiQu12ZIvVS5ljFH4gxQ+6IHdfG\n"
"jjxDah2nGN59PRbxYvnKkKj9\n"
"-----END CERTIFICATE-----\n";
#endif

// ---------------------------------------------------------------------------
// Types (all declared before the first function, for the Arduino builder)
// ---------------------------------------------------------------------------

enum DoorMode : uint8_t { DOOR_NORMAL = 0, DOOR_ALWAYS_OPEN = 1, DOOR_ALWAYS_CLOSED = 2 };
enum DoorCommand : uint8_t { CMD_OPEN = 1, CMD_CLOSE = 2, CMD_ALWAYS_OPEN = 3, CMD_ALWAYS_CLOSE = 4, CMD_RESUME = 5 };
enum WiegandKind : uint8_t { WG_NONE = 0, WG_CARD = 1, WG_KEY = 2, WG_ERROR = 3 };
enum GateEventType : uint8_t { EV_CARD = 1, EV_PIN = 2, EV_EXIT = 3 };

struct WiegandFrame {
  WiegandKind kind;
  uint8_t bits;
  uint8_t key;        // WG_KEY: 0-9, 10 = '*', 11 = '#'
  char card[24];      // WG_CARD: decimal card number
  char error[48];     // WG_ERROR: why the frame was refused
};

struct __attribute__((packed)) CardEntry {
  uint64_t key;        // FNV-1a 64 of the card number without leading zeroes
  uint32_t validUntil; // Unix seconds, 0 = no expiry
};

struct Visitor {
  char employeeNo[33];
  char pin[9];
  int64_t validFrom;
  int64_t validUntil;
};

struct GateEvent {
  uint32_t seq;
  int64_t at;          // Unix seconds, 0 when the clock was not set yet
  GateEventType type;
  bool granted;
  bool doorOpened;
  char cardNo[24];
  char employeeNo[33];
  char reason[32];
};

struct Decision {
  bool granted;
  const char* reason;
};

struct SnapshotStats {
  uint32_t syncCount;
  uint32_t removedApplied;
  uint32_t lastSyncLatencyMs;
  int64_t lastSyncAt;  // Unix seconds of the last successful refresh
  char lastSyncError[120];
  char since[24];      // "YYYY-MM-DD HH:MM:SS" the next delta asks from
};

class CardCache {
 public:
  bool begin(size_t capacity);
  size_t count() const { return count_; }
  size_t capacity() const { return capacity_; }
  bool ready() const { return ready_; }
  void setReady(bool value) { ready_ = value; }
  bool lookup(const char* cardNo, uint32_t* validUntil) const;
  bool loadFromFile(const char* path);
  bool saveToFile(const char* path) const;
  // Applies one complete delta: removals first, then additions, so a card
  // number that was reissued (one row revoked, one active) stays usable.
  size_t applyDelta(const std::vector<uint64_t>& removes, const std::vector<CardEntry>& adds, size_t* dropped);
  // Replaces the whole set from a complete full snapshot written to `path`.
  bool replaceFromFile(const char* path, size_t expected);
 private:
  long find(uint64_t key, size_t limit) const;
  void sortAndDedupe();
  CardEntry* entries_ = nullptr;
  size_t count_ = 0;
  size_t capacity_ = 0;
  bool ready_ = false;
};

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static CardCache cardCache;
static std::vector<Visitor> visitors;
static SnapshotStats snapshotStats;
static Preferences prefs;

static SemaphoreHandle_t cacheMutex = nullptr;
static SemaphoreHandle_t visitorMutex = nullptr;
static SemaphoreHandle_t eventMutex = nullptr;
static QueueHandle_t doorQueue = nullptr;

static const size_t EVENT_RING_SIZE = 64;
static GateEvent eventRing[EVENT_RING_SIZE];
static size_t eventHead = 0;     // oldest event
static size_t eventCount = 0;
static uint32_t eventsDropped = 0;
static uint32_t eventSeq = 0;
static char bootId[9] = "00000000";

static volatile DoorMode doorMode = DOOR_NORMAL;
static uint32_t relayOffAt = 0;
static bool relayOn = false;

static uint32_t grantedCount = 0;
static uint32_t deniedCount = 0;
static char lastDecision[12] = "";
static char lastReason[32] = "";
static char lastResult[16] = "";

static volatile bool snapshotRequested = false;

// Wiegand capture (written from interrupts)
static volatile uint64_t wgBits = 0;
static volatile uint8_t wgCount = 0;
static volatile uint32_t wgLastBitMs = 0;
static portMUX_TYPE wgMux = portMUX_INITIALIZER_UNLOCKED;

// Keypad PIN entry
static char pinBuffer[13] = "";
static uint32_t pinLastKeyMs = 0;
static uint8_t pinFailures = 0;
static uint32_t pinFailureWindowStart = 0;
static uint32_t pinLockedUntil = 0;

// Card cooldown (a card resting on the reader must not machine-gun the relay)
static uint64_t lastCardKey = 0;
static uint32_t lastCardMs = 0;

// Feedback
static uint32_t ledOffAt = 0;
static uint8_t beepsLeft = 0;
static uint32_t beepNextAt = 0;
static bool beepOn = false;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

static bool timeKnown() {
  return time(nullptr) > 1700000000;  // 2023-11-14: anything earlier is an unset clock
}

static int64_t nowSeconds() {
  return timeKnown() ? (int64_t)time(nullptr) : 0;
}

// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
static int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

static void civilFromDays(int64_t z, int* year, unsigned* month, unsigned* day) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = (unsigned)(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t y = (int64_t)yoe + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  *day = doy - (153 * mp + 2) / 5 + 1;
  *month = mp < 10 ? mp + 3 : mp - 9;
  *year = (int)(y + (*month <= 2));
}

static bool readDigits(const char* s, int count, int* out) {
  int value = 0;
  for (int i = 0; i < count; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    value = value * 10 + (s[i] - '0');
  }
  *out = value;
  return true;
}

// Parses "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS" and ISO 8601 with an optional
// fraction and "Z" / "+HH:MM" offset. A value without an offset is UTC, which is
// how D1 stores datetime('now'). Returns 0 for anything else.
static int64_t parseTimestamp(const char* s) {
  if (!s) return 0;
  int year, month, day, hour = 0, minute = 0, second = 0;
  if (strlen(s) < 10 || s[4] != '-' || s[7] != '-') return 0;
  if (!readDigits(s, 4, &year) || !readDigits(s + 5, 2, &month) || !readDigits(s + 8, 2, &day)) return 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return 0;
  const char* p = s + 10;
  if (*p == 'T' || *p == ' ') {
    if (strlen(p) < 9 || p[3] != ':' || p[6] != ':') return 0;
    if (!readDigits(p + 1, 2, &hour) || !readDigits(p + 4, 2, &minute) || !readDigits(p + 7, 2, &second)) return 0;
    p += 9;
    if (*p == '.') { p++; while (*p >= '0' && *p <= '9') p++; }
  }
  int64_t offset = 0;
  if (*p == '+' || *p == '-') {
    int oh, om;
    if (strlen(p) < 6 || p[3] != ':' || !readDigits(p + 1, 2, &oh) || !readDigits(p + 4, 2, &om)) return 0;
    offset = (int64_t)(oh * 3600 + om * 60) * (*p == '-' ? -1 : 1);
  }
  return daysFromCivil(year, (unsigned)month, (unsigned)day) * 86400 + hour * 3600 + minute * 60 + second - offset;
}

// "YYYY-MM-DDTHH:MM:SSZ" (iso = true) or D1's "YYYY-MM-DD HH:MM:SS".
static void formatTimestamp(int64_t t, bool iso, char* out, size_t size) {
  int year; unsigned month, day;
  int64_t days = t >= 0 ? t / 86400 : (t - 86399) / 86400;
  int64_t rem = t - days * 86400;
  civilFromDays(days, &year, &month, &day);
  snprintf(out, size, iso ? "%04d-%02u-%02uT%02d:%02d:%02dZ" : "%04d-%02u-%02u %02d:%02d:%02d",
           year, month, day, (int)(rem / 3600), (int)((rem % 3600) / 60), (int)(rem % 60));
}

static uint64_t fnv1a64(const char* s) {
  uint64_t hash = 1469598103934665603ULL;
  for (; *s; s++) { hash ^= (uint8_t)*s; hash *= 1099511628211ULL; }
  return hash;
}

// A card number as the cache files it: digits keep their value but lose leading
// zeroes, because a Wiegand reader reports 1234 for a card the portal stores as
// 0000001234. Anything that is not all digits is kept (upper-cased) and simply
// never matches a reader.
static uint64_t cardKey(const char* value) {
  if (!value) return 0;
  while (*value == ' ') value++;
  bool digits = *value != '\0';
  for (const char* p = value; *p && *p != ' '; p++) if (*p < '0' || *p > '9') { digits = false; break; }
  char buffer[48];
  size_t n = 0;
  if (digits) {
    while (*value == '0' && value[1] >= '0' && value[1] <= '9') value++;
    for (; *value >= '0' && *value <= '9' && n < sizeof(buffer) - 1; value++) buffer[n++] = *value;
  } else {
    for (; *value && n < sizeof(buffer) - 1; value++) buffer[n++] = (char)toupper((unsigned char)*value);
    while (n && buffer[n - 1] == ' ') n--;
  }
  buffer[n] = '\0';
  if (!n) return 0;
  uint64_t key = fnv1a64(buffer);
  return key == UINT64_MAX ? key - 1 : key;  // UINT64_MAX marks a removed slot
}

static void copyText(char* out, size_t size, const char* value) {
  if (!size) return;
  if (!value) value = "";
  strncpy(out, value, size - 1);
  out[size - 1] = '\0';
}

static bool validEmployeeNo(const char* value) {
  size_t n = value ? strlen(value) : 0;
  if (n < 1 || n > 32) return false;
  for (size_t i = 0; i < n; i++) if (!isalnum((unsigned char)value[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Wiegand
// ---------------------------------------------------------------------------

void IRAM_ATTR wiegandD0() {
  portENTER_CRITICAL_ISR(&wgMux);
  if (wgCount < 64) wgBits <<= 1;
  if (wgCount < 255) wgCount++;
  wgLastBitMs = millis();
  portEXIT_CRITICAL_ISR(&wgMux);
}

void IRAM_ATTR wiegandD1() {
  portENTER_CRITICAL_ISR(&wgMux);
  if (wgCount < 64) wgBits = (wgBits << 1) | 1ULL;
  if (wgCount < 255) wgCount++;
  wgLastBitMs = millis();
  portEXIT_CRITICAL_ISR(&wgMux);
}

static int popcount64(uint64_t value) {
  int n = 0;
  while (value) { n += (int)(value & 1ULL); value >>= 1; }
  return n;
}

// Decodes one complete frame, most significant (first received) bit first.
//   4 bits  keypad key (burst mode)
//   8 bits  keypad key + its complement
//   26..64  card: leading even parity, data, trailing odd parity
static WiegandFrame decodeWiegand(uint64_t bits, uint8_t count) {
  WiegandFrame frame;
  memset(&frame, 0, sizeof(frame));
  frame.bits = count;
  if (count == 4) {
    frame.kind = WG_KEY;
    frame.key = (uint8_t)(bits & 0x0F);
    return frame;
  }
  if (count == 8) {
    uint8_t low = (uint8_t)(bits & 0x0F), high = (uint8_t)((bits >> 4) & 0x0F);
    if ((uint8_t)(high ^ 0x0F) != low) {
      frame.kind = WG_ERROR;
      copyText(frame.error, sizeof(frame.error), "8-bit key failed its complement check");
      return frame;
    }
    frame.kind = WG_KEY;
    frame.key = low;
    return frame;
  }
  if (count < 26 || count > 64) {
    frame.kind = WG_ERROR;
    snprintf(frame.error, sizeof(frame.error), "unsupported %u-bit frame", (unsigned)count);
    return frame;
  }
  const uint8_t dataBits = (uint8_t)(count - 2);
  if (ESTATEMATE_WIEGAND_CHECK_PARITY && (count == 26 || count == 34)) {
    const uint8_t half = dataBits / 2;
    // First parity bit + first half of the data: even. Second half + last bit: odd.
    const uint64_t firstMask = ((1ULL << (half + 1)) - 1ULL) << (count - half - 1);
    const uint64_t secondMask = (1ULL << (half + 1)) - 1ULL;
    if ((popcount64(bits & firstMask) % 2) != 0 || (popcount64(bits & secondMask) % 2) != 1) {
      frame.kind = WG_ERROR;
      snprintf(frame.error, sizeof(frame.error), "%u-bit card failed its parity check", (unsigned)count);
      return frame;
    }
  }
  const uint64_t data = (bits >> 1) & (dataBits >= 64 ? UINT64_MAX : ((1ULL << dataBits) - 1ULL));
  frame.kind = WG_CARD;
  snprintf(frame.card, sizeof(frame.card), "%llu", (unsigned long long)data);
  return frame;
}

// ---------------------------------------------------------------------------
// Credential cache
// ---------------------------------------------------------------------------

static bool entryLess(const CardEntry& a, const CardEntry& b) { return a.key < b.key; }

bool CardCache::begin(size_t capacity) {
  if (entries_) return true;
  if (psramFound()) entries_ = (CardEntry*)ps_malloc(capacity * sizeof(CardEntry));
  if (!entries_) entries_ = (CardEntry*)malloc(capacity * sizeof(CardEntry));
  capacity_ = entries_ ? capacity : 0;
  count_ = 0;
  return entries_ != nullptr;
}

long CardCache::find(uint64_t key, size_t limit) const {
  size_t lo = 0, hi = limit;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (entries_[mid].key < key) lo = mid + 1; else hi = mid;
  }
  return (lo < limit && entries_[lo].key == key) ? (long)lo : -1;
}

void CardCache::sortAndDedupe() {
  std::sort(entries_, entries_ + count_, entryLess);
  size_t out = 0;
  for (size_t i = 0; i < count_; i++) {
    if (entries_[i].key == UINT64_MAX) continue;
    if (out && entries_[out - 1].key == entries_[i].key) {
      // Two active rows for one card number: keep the longer validity (0 = none).
      uint32_t a = entries_[out - 1].validUntil, b = entries_[i].validUntil;
      entries_[out - 1].validUntil = (a == 0 || b == 0) ? 0 : std::max(a, b);
      continue;
    }
    entries_[out++] = entries_[i];
  }
  count_ = out;
}

bool CardCache::lookup(const char* cardNo, uint32_t* validUntil) const {
  uint64_t key = cardKey(cardNo);
  if (!key || !entries_) return false;
  long index = find(key, count_);
  if (index < 0) return false;
  if (validUntil) *validUntil = entries_[index].validUntil;
  return true;
}

size_t CardCache::applyDelta(const std::vector<uint64_t>& removes, const std::vector<CardEntry>& adds, size_t* dropped) {
  size_t changed = 0;
  if (dropped) *dropped = 0;
  for (uint64_t key : removes) {
    long index = find(key, count_);
    if (index >= 0) { entries_[index].key = UINT64_MAX; changed++; }
  }
  if (changed) sortAndDedupe();
  const size_t sorted = count_;
  for (const CardEntry& add : adds) {
    long index = find(add.key, sorted);
    if (index >= 0) {
      if (entries_[index].validUntil != add.validUntil) { entries_[index].validUntil = add.validUntil; changed++; }
      continue;
    }
    if (count_ >= capacity_) { if (dropped) (*dropped)++; continue; }
    entries_[count_++] = add;
    changed++;
  }
  if (count_ != sorted) sortAndDedupe();
  return changed;
}

bool CardCache::replaceFromFile(const char* path, size_t expected) {
  if (expected > capacity_) return false;
  File file = LittleFS.open(path, "r");
  if (!file) return false;
  size_t bytes = expected * sizeof(CardEntry);
  size_t read = expected ? file.read((uint8_t*)entries_, bytes) : 0;
  file.close();
  if (read != bytes) { count_ = 0; ready_ = false; return false; }
  count_ = expected;
  sortAndDedupe();
  ready_ = true;
  return true;
}

// File layout: "EMC1", uint32 count, then `count` packed CardEntry records.
bool CardCache::saveToFile(const char* path) const {
  std::string tmp = std::string(path) + ".tmp";
  File file = LittleFS.open(tmp.c_str(), "w");
  if (!file) return false;
  uint32_t n = (uint32_t)count_;
  bool ok = file.write((const uint8_t*)"EMC1", 4) == 4 && file.write((const uint8_t*)&n, 4) == 4;
  if (ok && n) ok = file.write((const uint8_t*)entries_, n * sizeof(CardEntry)) == n * sizeof(CardEntry);
  file.close();
  if (!ok) { LittleFS.remove(tmp.c_str()); return false; }
  LittleFS.remove(path);
  return LittleFS.rename(tmp.c_str(), path);
}

bool CardCache::loadFromFile(const char* path) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;
  char magic[4];
  uint32_t n = 0;
  bool ok = file.read((uint8_t*)magic, 4) == 4 && memcmp(magic, "EMC1", 4) == 0 && file.read((uint8_t*)&n, 4) == 4 && n <= capacity_;
  if (ok && n) ok = file.read((uint8_t*)entries_, n * sizeof(CardEntry)) == n * sizeof(CardEntry);
  file.close();
  if (!ok) { count_ = 0; return false; }
  count_ = n;
  sortAndDedupe();
  ready_ = true;
  return true;
}

// ---------------------------------------------------------------------------
// Visitor PINs (delivered as upsert_visitor / revoke_visitor operations)
// ---------------------------------------------------------------------------

static void saveVisitors() {
  JsonDocument doc;
  JsonArray list = doc.to<JsonArray>();
  for (const Visitor& v : visitors) {
    JsonObject item = list.add<JsonObject>();
    item["e"] = v.employeeNo;
    item["p"] = v.pin;
    item["f"] = v.validFrom;
    item["u"] = v.validUntil;
  }
  File file = LittleFS.open("/visitors.tmp", "w");
  if (!file) return;
  serializeJson(doc, file);
  file.close();
  LittleFS.remove("/visitors.json");
  LittleFS.rename("/visitors.tmp", "/visitors.json");
}

static void loadVisitors() {
  visitors.clear();
  File file = LittleFS.open("/visitors.json", "r");
  if (!file) return;
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) return;
  for (JsonObject item : doc.as<JsonArray>()) {
    Visitor v;
    memset(&v, 0, sizeof(v));
    copyText(v.employeeNo, sizeof(v.employeeNo), item["e"] | "");
    copyText(v.pin, sizeof(v.pin), item["p"] | "");
    v.validFrom = item["f"] | (int64_t)0;
    v.validUntil = item["u"] | (int64_t)0;
    if (validEmployeeNo(v.employeeNo) && v.pin[0]) visitors.push_back(v);
  }
}

// Drops passes that ended more than a day ago, so the store cannot fill up with
// visitors whose revoke operation was handled elsewhere.
static void pruneVisitors(int64_t now) {
  if (!now) return;
  visitors.erase(std::remove_if(visitors.begin(), visitors.end(), [now](const Visitor& v) {
    return v.validUntil && v.validUntil < now - 86400;
  }), visitors.end());
}

static const char* upsertVisitor(const char* employeeNo, const char* pin, int64_t validFrom, int64_t validUntil) {
  if (!validEmployeeNo(employeeNo)) return "operation has no valid visitor employee number";
  size_t n = pin ? strlen(pin) : 0;
  if (n < 4 || n > 8) return "visitor PIN must be 4 to 8 digits";
  for (size_t i = 0; i < n; i++) if (pin[i] < '0' || pin[i] > '9') return "visitor PIN must be digits only";
  if (!validUntil) return "visitor pass has no readable validUntil";
  pruneVisitors(nowSeconds());
  for (Visitor& v : visitors) {
    if (strcmp(v.employeeNo, employeeNo) == 0) {
      copyText(v.pin, sizeof(v.pin), pin);
      v.validFrom = validFrom;
      v.validUntil = validUntil;
      saveVisitors();
      return nullptr;
    }
  }
  if (visitors.size() >= ESTATEMATE_MAX_VISITORS) return "this controller's visitor store is full";
  Visitor v;
  memset(&v, 0, sizeof(v));
  copyText(v.employeeNo, sizeof(v.employeeNo), employeeNo);
  copyText(v.pin, sizeof(v.pin), pin);
  v.validFrom = validFrom;
  v.validUntil = validUntil;
  visitors.push_back(v);
  saveVisitors();
  return nullptr;
}

static void revokeVisitor(const char* employeeNo) {
  size_t before = visitors.size();
  visitors.erase(std::remove_if(visitors.begin(), visitors.end(), [employeeNo](const Visitor& v) {
    return strcmp(v.employeeNo, employeeNo) == 0;
  }), visitors.end());
  if (visitors.size() != before) saveVisitors();
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

static Decision decideCard(const char* cardNo, int64_t now) {
  if (doorMode == DOOR_ALWAYS_CLOSED) return { false, "door_remain_closed" };
  if (!cardCache.ready()) return { false, "cache_not_ready" };
  uint32_t validUntil = 0;
  if (!cardCache.lookup(cardNo, &validUntil)) return { false, "unknown_credential" };
  if (validUntil) {
    if (!now) return { false, "clock_not_set" };
    if ((int64_t)validUntil <= now) return { false, "credential_expired" };
  }
  return { true, "authorised" };
}

static Decision decidePin(const char* pin, int64_t now, const Visitor** matched) {
  *matched = nullptr;
  if (doorMode == DOOR_ALWAYS_CLOSED) return { false, "door_remain_closed" };
  if (!now) return { false, "clock_not_set" };
  const char* reason = "unknown_credential";
  for (const Visitor& v : visitors) {
    if (strcmp(v.pin, pin) != 0) continue;
    *matched = &v;
    if (v.validFrom && now < v.validFrom) { reason = "credential_not_yet_valid"; continue; }
    if (now >= v.validUntil) { reason = "credential_expired"; continue; }
    return { true, "authorised" };
  }
  return { false, reason };
}

// ---------------------------------------------------------------------------
// Gate events
// ---------------------------------------------------------------------------

static void recordEvent(GateEventType type, bool granted, bool doorOpened, const char* cardNo, const char* employeeNo, const char* reason) {
  GateEvent event;
  memset(&event, 0, sizeof(event));
  event.type = type;
  event.granted = granted;
  event.doorOpened = doorOpened;
  event.at = nowSeconds();
  copyText(event.cardNo, sizeof(event.cardNo), cardNo);
  copyText(event.employeeNo, sizeof(event.employeeNo), employeeNo);
  copyText(event.reason, sizeof(event.reason), reason);
  xSemaphoreTake(eventMutex, portMAX_DELAY);
  event.seq = ++eventSeq;
  if (eventCount == EVENT_RING_SIZE) {
    // Offline for a long time: keep the newest history, count what was lost.
    eventHead = (eventHead + 1) % EVENT_RING_SIZE;
    eventCount--;
    eventsDropped++;
  }
  eventRing[(eventHead + eventCount) % EVENT_RING_SIZE] = event;
  eventCount++;
  if (type != EV_EXIT) {
    if (granted) grantedCount++; else deniedCount++;
    copyText(lastDecision, sizeof(lastDecision), granted ? "granted" : "denied");
    copyText(lastReason, sizeof(lastReason), reason);
    copyText(lastResult, sizeof(lastResult), doorOpened ? "opened" : "not_attempted");
  }
  xSemaphoreGive(eventMutex);
}

// The event as an ISAPI-style AccessControllerEvent document, which the Worker
// normalises with the same pipeline it uses for terminal events. The typed PIN
// is never part of it.
static std::string buildEventDocument(const GateEvent& event) {
  JsonDocument doc;
  doc["eventType"] = "AccessControllerEvent";
  if (event.at) {
    char when[24];
    formatTimestamp(event.at, true, when, sizeof(when));
    doc["dateTime"] = when;
  }
  JsonObject ace = doc["AccessControllerEvent"].to<JsonObject>();
  char serial[24];
  snprintf(serial, sizeof(serial), "%s-%lu", bootId, (unsigned long)event.seq);
  ace["serialNo"] = serial;
  ace["doorNo"] = ESTATEMATE_DOOR_NO;
  if (event.type == EV_EXIT) {
    ace["eventState"] = "granted";
    ace["eventDescription"] = "Exit button pressed at the ESP32 gate controller";
    ace["direction"] = "exit";
  } else {
    ace["eventState"] = event.granted ? "granted" : "denied";
    char description[96];
    if (event.granted) {
      snprintf(description, sizeof(description), "%s accepted by the ESP32 gate controller", event.type == EV_CARD ? "Card" : "PIN");
    } else {
      snprintf(description, sizeof(description), "%s refused by the ESP32 gate controller: %s", event.type == EV_CARD ? "Card" : "PIN", event.reason);
    }
    ace["eventDescription"] = description;
    ace["currentVerifyMode"] = event.type == EV_CARD ? "card" : "pin";
    if (event.cardNo[0]) ace["cardNo"] = event.cardNo;
    if (event.employeeNo[0]) ace["employeeNoString"] = event.employeeNo;
  }
  std::string out;
  serializeJson(doc, out);
  return out;
}

// ---------------------------------------------------------------------------
// Door, reader feedback and keypad
// ---------------------------------------------------------------------------

static void writeRelay(bool on) {
  relayOn = on;
  digitalWrite(ESTATEMATE_RELAY_PIN, (on == (bool)ESTATEMATE_RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

static void pulseDoor() {
  writeRelay(true);
  relayOffAt = millis() + ESTATEMATE_DOOR_OPEN_MS;
  if (relayOffAt == 0) relayOffAt = 1;
}

static void setDoorMode(DoorMode mode) {
  doorMode = mode;
  prefs.putUChar("doorMode", (uint8_t)mode);
  if (mode == DOOR_ALWAYS_OPEN) { relayOffAt = 0; writeRelay(true); }
  else { relayOffAt = 0; writeRelay(false); }
}

static void feedbackGranted() {
  if (ESTATEMATE_READER_LED_PIN >= 0) {
    digitalWrite(ESTATEMATE_READER_LED_PIN, LOW);  // reader LED lines are active low
    ledOffAt = millis() + ESTATEMATE_DOOR_OPEN_MS;
  }
  if (ESTATEMATE_READER_BUZZER_PIN >= 0) { beepsLeft = 1; beepNextAt = millis(); }
}

static void feedbackDenied() {
  if (ESTATEMATE_READER_BUZZER_PIN >= 0) { beepsLeft = 3; beepNextAt = millis(); }
}

static void serviceFeedback(uint32_t now) {
  if (ESTATEMATE_READER_LED_PIN >= 0 && ledOffAt && (int32_t)(now - ledOffAt) >= 0) {
    digitalWrite(ESTATEMATE_READER_LED_PIN, HIGH);
    ledOffAt = 0;
  }
  if (ESTATEMATE_READER_BUZZER_PIN >= 0 && (beepsLeft || beepOn) && (int32_t)(now - beepNextAt) >= 0) {
    beepOn = !beepOn;
    digitalWrite(ESTATEMATE_READER_BUZZER_PIN, beepOn ? LOW : HIGH);
    if (!beepOn && beepsLeft) beepsLeft--;
    beepNextAt = now + (beepOn ? 120 : 100);
  }
}

static void handleCard(const char* cardNo, uint32_t nowMs) {
  uint64_t key = cardKey(cardNo);
  if (key == lastCardKey && (uint32_t)(nowMs - lastCardMs) < ESTATEMATE_CARD_COOLDOWN_MS) return;
  lastCardKey = key;
  lastCardMs = nowMs;
  xSemaphoreTake(cacheMutex, portMAX_DELAY);
  Decision decision = decideCard(cardNo, nowSeconds());
  xSemaphoreGive(cacheMutex);
  Serial.printf("[gate] card %s %s (%s)\n", cardNo, decision.granted ? "GRANTED" : "DENIED", decision.reason);
  if (decision.granted) {
    if (doorMode != DOOR_ALWAYS_OPEN) pulseDoor();
    feedbackGranted();
  } else {
    feedbackDenied();
  }
  recordEvent(EV_CARD, decision.granted, decision.granted, cardNo, nullptr, decision.reason);
}

static void handlePin(const char* pin, uint32_t nowMs) {
  if (pinLockedUntil && (int32_t)(nowMs - pinLockedUntil) < 0) {
    feedbackDenied();
    recordEvent(EV_PIN, false, false, nullptr, nullptr, "too_many_attempts");
    return;
  }
  pinLockedUntil = 0;
  const Visitor* matched = nullptr;
  xSemaphoreTake(visitorMutex, portMAX_DELAY);
  Decision decision = decidePin(pin, nowSeconds(), &matched);
  char employeeNo[33] = "";
  if (matched) copyText(employeeNo, sizeof(employeeNo), matched->employeeNo);
  xSemaphoreGive(visitorMutex);
  Serial.printf("[gate] PIN %s (%s)\n", decision.granted ? "GRANTED" : "DENIED", decision.reason);
  if (decision.granted) {
    pinFailures = 0;
    if (doorMode != DOOR_ALWAYS_OPEN) pulseDoor();
    feedbackGranted();
  } else {
    if (!pinFailures || (uint32_t)(nowMs - pinFailureWindowStart) > 60000) { pinFailures = 0; pinFailureWindowStart = nowMs; }
    // Five wrong PINs inside a minute lock the keypad for a minute.
    if (++pinFailures >= 5) { pinLockedUntil = nowMs + 60000; if (!pinLockedUntil) pinLockedUntil = 1; pinFailures = 0; }
    feedbackDenied();
  }
  recordEvent(EV_PIN, decision.granted, decision.granted, nullptr, employeeNo[0] ? employeeNo : nullptr, decision.reason);
}

static void handleKey(uint8_t key, uint32_t nowMs) {
  if (pinBuffer[0] && (uint32_t)(nowMs - pinLastKeyMs) > 15000) pinBuffer[0] = '\0';
  pinLastKeyMs = nowMs;
  if (key <= 9) {
    size_t n = strlen(pinBuffer);
    if (n < sizeof(pinBuffer) - 1) { pinBuffer[n] = (char)('0' + key); pinBuffer[n + 1] = '\0'; }
  } else if (key == 10) {          // '*' clears
    pinBuffer[0] = '\0';
  } else if (key == 11) {          // '#' submits
    if (pinBuffer[0]) handlePin(pinBuffer, nowMs);
    pinBuffer[0] = '\0';
  }
}

static void applyDoorCommand(uint8_t command) {
  switch (command) {
    case CMD_OPEN: if (doorMode != DOOR_ALWAYS_OPEN) pulseDoor(); break;
    case CMD_CLOSE: if (doorMode != DOOR_ALWAYS_OPEN) { relayOffAt = 0; writeRelay(false); } break;
    case CMD_ALWAYS_OPEN: setDoorMode(DOOR_ALWAYS_OPEN); break;
    case CMD_ALWAYS_CLOSE: setDoorMode(DOOR_ALWAYS_CLOSED); break;
    case CMD_RESUME: setDoorMode(DOOR_NORMAL); break;
  }
  Serial.printf("[gate] door command %u applied, mode %u\n", (unsigned)command, (unsigned)doorMode);
}

// ---------------------------------------------------------------------------
// EstateMate API
// ---------------------------------------------------------------------------

static WiFiClientSecure secureClient;
static WiFiClient plainClient;

static bool workerIsHttps() {
  return strncmp(ESTATEMATE_WORKER_URL, "https://", 8) == 0;
}

// One request to the Worker. JSON responses are parsed straight from the
// socket (HTTP/1.0, so never chunked), through `filter` when given, which keeps
// a 250-credential snapshot page inside an ESP32's RAM.
static int apiRequest(const char* method, const std::string& path, const std::string& body, JsonDocument* out, JsonDocument* filter) {
  std::string url = std::string(ESTATEMATE_WORKER_URL) + path;
  HTTPClient http;
  http.useHTTP10(true);
  http.setTimeout(15000);
  http.setConnectTimeout(10000);
  bool begun = workerIsHttps() ? http.begin(secureClient, url.c_str()) : http.begin(plainClient, url.c_str());
  if (!begun) return -1;
  http.addHeader("X-EstateMate-Agent-Key", ESTATEMATE_AGENT_SECRET);
  http.addHeader("User-Agent", "EstateMate-ESP32-Gate/" ESTATEMATE_GATE_VERSION);
  if (!body.empty()) http.addHeader("Content-Type", "application/json");
  int status = body.empty()
    ? http.sendRequest(method)
    : http.sendRequest(method, (uint8_t*)body.data(), body.size());
  if (status >= 200 && status < 300 && out) {
    DeserializationError error = filter
      ? deserializeJson(*out, http.getStream(), DeserializationOption::Filter(*filter))
      : deserializeJson(*out, http.getStream());
    if (error) {
      Serial.printf("[api] %s %s: unreadable JSON (%s)\n", method, path.c_str(), error.c_str());
      status = -2;
    }
  }
  http.end();
  return status;
}

static std::string agentPath(const char* suffix) {
  return std::string("/api/isapi/v1/agents/") + ESTATEMATE_AGENT_ID + suffix;
}

static void adoptServerTime(const char* serverTime) {
  // Only a fallback for a plain-HTTP portal on the LAN: HTTPS cannot be reached
  // without a correct clock, so an HTTPS controller always gets its time by NTP.
  if (timeKnown() || !serverTime) return;
  int64_t t = parseTimestamp(serverTime);
  if (!t) return;
  struct timeval tv = { (time_t)t, 0 };
  settimeofday(&tv, nullptr);
  Serial.println("[time] clock set from the portal's serverTime");
}

static void sendHeartbeat() {
  JsonDocument doc;
  char hostname[32];
  uint64_t mac = ESP.getEfuseMac();
  snprintf(hostname, sizeof(hostname), "estatemate-gate-%06llx", (unsigned long long)(mac & 0xFFFFFFULL));
  doc["version"] = "esp32-gate-" ESTATEMATE_GATE_VERSION;
  doc["hostname"] = hostname;
  doc["ip"] = WiFi.localIP().toString().c_str();
  doc["capabilities"].to<JsonArray>();  // no person / fingerprint work for a controller
  JsonObject device = doc["devices"].to<JsonArray>().add<JsonObject>();
  device["deviceId"] = ESTATEMATE_DEVICE_ID;
  device["stream"] = "up";               // the controller is the gate: alive means up
  JsonObject stats = doc["stats"].to<JsonObject>();
  JsonObject remote = doc["remoteVerify"].to<JsonObject>();
  remote["enabled"] = true;
  remote["controller"] = "esp32";
  JsonObject cache = remote["cache"].to<JsonObject>();
  xSemaphoreTake(cacheMutex, portMAX_DELAY);
  cache["credentialCount"] = (uint32_t)cardCache.count();
  cache["capacity"] = (uint32_t)cardCache.capacity();
  cache["ready"] = cardCache.ready();
  cache["syncCount"] = snapshotStats.syncCount;
  cache["removedApplied"] = snapshotStats.removedApplied;
  cache["lastSyncLatencyMs"] = snapshotStats.lastSyncLatencyMs;
  if (snapshotStats.lastSyncAt) {
    char when[24];
    formatTimestamp(snapshotStats.lastSyncAt, true, when, sizeof(when));
    cache["lastSyncAt"] = when;
    int64_t now = nowSeconds();
    if (now) cache["cacheAgeSeconds"] = (int64_t)std::max<int64_t>(0, now - snapshotStats.lastSyncAt);
  } else {
    cache["lastSyncAt"] = nullptr;
    cache["cacheAgeSeconds"] = nullptr;
  }
  if (snapshotStats.lastSyncError[0]) cache["lastSyncError"] = snapshotStats.lastSyncError;
  else cache["lastSyncError"] = nullptr;
  xSemaphoreGive(cacheMutex);
  xSemaphoreTake(eventMutex, portMAX_DELAY);
  JsonObject state = remote["perDevice"].to<JsonObject>()[ESTATEMATE_DEVICE_ID].to<JsonObject>();
  if (lastDecision[0]) {
    state["lastDecision"] = lastDecision;
    state["lastReason"] = lastReason;
    state["lastResult"] = lastResult;
  }
  state["granted"] = grantedCount;
  state["denied"] = deniedCount;
  state["doorMode"] = doorMode == DOOR_ALWAYS_OPEN ? "remain_open" : doorMode == DOOR_ALWAYS_CLOSED ? "remain_closed" : "normal";
  stats["eventsQueued"] = (uint32_t)eventCount;
  stats["eventsDropped"] = eventsDropped;
  xSemaphoreGive(eventMutex);
  xSemaphoreTake(visitorMutex, portMAX_DELAY);
  stats["visitorPins"] = (uint32_t)visitors.size();
  xSemaphoreGive(visitorMutex);
  stats["freeHeap"] = (uint32_t)ESP.getFreeHeap();
  stats["uptimeSeconds"] = (uint32_t)(millis() / 1000);
  stats["wifiRssi"] = (int32_t)WiFi.RSSI();

  std::string body;
  serializeJson(doc, body);
  JsonDocument response;
  JsonDocument filter;
  filter["serverTime"] = true;
  int status = apiRequest("POST", agentPath("/heartbeat"), body, &response, &filter);
  if (status >= 200 && status < 300) adoptServerTime(response["serverTime"] | "");
  else Serial.printf("[api] heartbeat failed: HTTP %d\n", status);
}

static void setSyncError(const char* message) {
  xSemaphoreTake(cacheMutex, portMAX_DELAY);
  copyText(snapshotStats.lastSyncError, sizeof(snapshotStats.lastSyncError), message);
  xSemaphoreGive(cacheMutex);
  Serial.printf("[snapshot] %s\n", message);
}

static std::string urlEncode(const char* value) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (const char* p = value; *p; p++) {
    unsigned char c = (unsigned char)*p;
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += (char)c;
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}

// Refreshes the card cache. A full snapshot (first run, or no usable `since`)
// is streamed to flash page by page and swapped in only once the last page has
// arrived; a delta is collected in full and then applied in one step. Either
// way a failure leaves the previous snapshot exactly as it was.
static bool syncSnapshot() {
  const uint32_t startedMs = millis();
  char since[24];
  xSemaphoreTake(cacheMutex, portMAX_DELAY);
  const bool full = !cardCache.ready() || !snapshotStats.since[0];
  copyText(since, sizeof(since), full ? "" : snapshotStats.since);
  const size_t capacity = cardCache.capacity();
  xSemaphoreGive(cacheMutex);

  File tmp;
  if (full) {
    tmp = LittleFS.open("/snap.full", "w");
    if (!tmp) { setSyncError("cannot write the snapshot to flash"); return false; }
  }
  std::vector<CardEntry> adds;
  std::vector<uint64_t> removes;
  size_t fullCount = 0;
  std::string cursor;
  std::string firstServerTime;
  JsonDocument filter;
  filter["serverTime"] = true;
  filter["nextCursor"] = true;
  filter["items"][0]["kind"] = true;
  filter["items"][0]["value"] = true;
  filter["items"][0]["validUntil"] = true;
  filter["removed"][0]["kind"] = true;
  filter["removed"][0]["value"] = true;

  for (int page = 0; page < 1000; page++) {
    std::string path = agentPath("/credential-snapshot") + "?limit=" + std::to_string(ESTATEMATE_SNAPSHOT_PAGE);
    if (!cursor.empty()) path += "&cursor=" + urlEncode(cursor.c_str());
    if (since[0]) path += std::string("&since=") + urlEncode(since);
    JsonDocument doc;
    int status = apiRequest("GET", path, "", &doc, &filter);
    if (status < 200 || status >= 300) {
      if (full) { tmp.close(); LittleFS.remove("/snap.full"); }
      char message[80];
      snprintf(message, sizeof(message), "snapshot page %d failed: HTTP %d", page + 1, status);
      setSyncError(message);
      return false;
    }
    if (page == 0) firstServerTime = doc["serverTime"] | "";
    for (JsonObject item : doc["items"].as<JsonArray>()) {
      if (strcmp(item["kind"] | "", "card") != 0) continue;  // the reader presents cards only
      CardEntry entry;
      entry.key = cardKey(item["value"] | "");
      if (!entry.key) continue;
      int64_t until = parseTimestamp(item["validUntil"] | "");
      entry.validUntil = until > 0 ? (uint32_t)until : 0;
      if (full) {
        if (tmp.write((const uint8_t*)&entry, sizeof(entry)) != sizeof(entry)) {
          tmp.close(); LittleFS.remove("/snap.full");
          setSyncError("flash is full while writing the snapshot");
          return false;
        }
        fullCount++;
      } else {
        adds.push_back(entry);
      }
    }
    for (JsonObject gone : doc["removed"].as<JsonArray>()) {
      if (strcmp(gone["kind"] | "card", "card") != 0) continue;
      uint64_t key = cardKey(gone["value"] | "");
      if (key) removes.push_back(key);
    }
    if (!full && adds.size() + removes.size() > 20000) {
      // A delta that large is a full snapshot in disguise; start over cleanly.
      xSemaphoreTake(cacheMutex, portMAX_DELAY);
      snapshotStats.since[0] = '\0';
      xSemaphoreGive(cacheMutex);
      setSyncError("delta too large; a full snapshot follows");
      return false;
    }
    const char* next = doc["nextCursor"] | "";
    if (!next[0]) break;
    cursor = next;
  }

  int64_t serverNow = parseTimestamp(firstServerTime.c_str());
  if (!serverNow) serverNow = nowSeconds();
  char nextSince[24] = "";
  // Two minutes of overlap: re-applying a change is harmless, missing one is not.
  if (serverNow) formatTimestamp(serverNow - 120, false, nextSince, sizeof(nextSince));

  bool ok = true;
  size_t dropped = 0;
  size_t changed = 0;
  if (full) {
    tmp.close();
    if (fullCount > capacity) {
      LittleFS.remove("/snap.full");
      char message[120];
      snprintf(message, sizeof(message), "estate has %u cards but this controller holds %u; raise ESTATEMATE_MAX_CARDS or use a PSRAM board",
               (unsigned)fullCount, (unsigned)capacity);
      setSyncError(message);
      return false;
    }
    xSemaphoreTake(cacheMutex, portMAX_DELAY);
    ok = cardCache.replaceFromFile("/snap.full", fullCount);
    if (!ok) cardCache.loadFromFile("/snap.bin");  // keep the previous snapshot
    xSemaphoreGive(cacheMutex);
    LittleFS.remove("/snap.full");
    changed = fullCount;
  } else {
    xSemaphoreTake(cacheMutex, portMAX_DELAY);
    changed = cardCache.applyDelta(removes, adds, &dropped);
    snapshotStats.removedApplied += (uint32_t)removes.size();
    xSemaphoreGive(cacheMutex);
  }
  if (!ok) { setSyncError("could not load the downloaded snapshot"); return false; }

  xSemaphoreTake(cacheMutex, portMAX_DELAY);
  if (full || changed) cardCache.saveToFile("/snap.bin");
  copyText(snapshotStats.since, sizeof(snapshotStats.since), nextSince);
  snapshotStats.syncCount++;
  snapshotStats.lastSyncAt = serverNow;
  snapshotStats.lastSyncLatencyMs = millis() - startedMs;
  if (dropped) snprintf(snapshotStats.lastSyncError, sizeof(snapshotStats.lastSyncError), "card store full: %u new card(s) not cached", (unsigned)dropped);
  else snapshotStats.lastSyncError[0] = '\0';
  const size_t total = cardCache.count();
  xSemaphoreGive(cacheMutex);
  prefs.putString("since", nextSince);
  Serial.printf("[snapshot] %s refresh OK: %u card(s) cached, %u change(s)\n", full ? "full" : "delta", (unsigned)total, (unsigned)changed);
  return true;
}

static void reportResult(const char* id, const char* kind, bool applied, const char* error, uint32_t durationMs) {
  JsonDocument doc;
  doc["kind"] = kind;
  doc["status"] = applied ? "applied" : "failed";
  if (!applied && error) doc["errorMessage"] = error;
  doc["durationMs"] = durationMs;
  std::string body;
  serializeJson(doc, body);
  int status = apiRequest("POST", agentPath("/operations/") + urlEncode(id) + "/result", body, nullptr, nullptr);
  if (status < 200 || status >= 300) Serial.printf("[ops] result for %s not accepted: HTTP %d\n", id, status);
}

static int doorCommandFor(const char* operation) {
  if (!strcmp(operation, "remote_open")) return CMD_OPEN;
  if (!strcmp(operation, "remote_close")) return CMD_CLOSE;
  if (!strcmp(operation, "remote_always_open")) return CMD_ALWAYS_OPEN;
  if (!strcmp(operation, "remote_always_close")) return CMD_ALWAYS_CLOSE;
  if (!strcmp(operation, "remote_resume")) return CMD_RESUME;
  return 0;
}

// Returns the number of seconds the Worker asked us to wait before polling again.
static int pollOperations() {
  JsonDocument doc;
  int status = apiRequest("GET", agentPath("/operations?limit=10"), "", &doc, nullptr);
  if (status < 200 || status >= 300) {
    Serial.printf("[ops] poll failed: HTTP %d\n", status);
    return ESTATEMATE_OPERATIONS_SECONDS;
  }
  bool cardWork = false;
  std::vector<std::string> cardOps;
  for (JsonObject op : doc["items"].as<JsonArray>()) {
    const uint32_t started = millis();
    const char* id = op["id"] | "";
    const char* kind = op["kind"] | "";
    const char* operation = op["operation"] | "";
    const char* deviceId = op["deviceId"] | "";
    JsonObject payload = op["payload"].as<JsonObject>();
    if (!id[0]) continue;
    if (strcmp(deviceId, ESTATEMATE_DEVICE_ID) != 0) {
      reportResult(id, kind, false, "this ESP32 gate controller serves one terminal only; link this terminal to a bridge instead", millis() - started);
      continue;
    }
    if (!strcmp(kind, "door")) {
      int command = doorCommandFor(operation);
      int doorNo = payload["doorNo"] | 1;
      if (!command) { reportResult(id, kind, false, "unknown door command", millis() - started); continue; }
      if (doorNo != ESTATEMATE_DOOR_NO) {
        char message[96];
        snprintf(message, sizeof(message), "door %d is not wired to this controller (it drives door %d)", doorNo, ESTATEMATE_DOOR_NO);
        reportResult(id, kind, false, message, millis() - started);
        continue;
      }
      uint8_t value = (uint8_t)command;
      xQueueSend(doorQueue, &value, portMAX_DELAY);
      reportResult(id, kind, true, nullptr, millis() - started);
    } else if (!strcmp(kind, "visitor")) {
      char employeeNo[48] = "";
      const char* given = payload["employeeNo"] | "";
      const char* credential = payload["credentialNumber"] | "";
      if (given[0]) copyText(employeeNo, sizeof(employeeNo), given);
      else if (credential[0]) snprintf(employeeNo, sizeof(employeeNo), "visitor%s", credential);
      const char* error = nullptr;
      xSemaphoreTake(visitorMutex, portMAX_DELAY);
      if (!strcmp(operation, "upsert_visitor")) {
        error = upsertVisitor(employeeNo, payload["pin"] | "", parseTimestamp(payload["validFrom"] | ""), parseTimestamp(payload["validUntil"] | ""));
      } else if (!strcmp(operation, "revoke_visitor")) {
        if (validEmployeeNo(employeeNo)) revokeVisitor(employeeNo);
        else error = "operation has no valid visitor employee number";
      } else {
        error = "unknown visitor operation";
      }
      xSemaphoreGive(visitorMutex);
      reportResult(id, kind, error == nullptr, error, millis() - started);
    } else if (!strcmp(kind, "card")) {
      // Cards are enforced from the snapshot, so a card change is applied by
      // refreshing it. Reported after the refresh succeeds; if it fails the
      // operation is left unreported and the Worker hands it out again.
      cardWork = true;
      cardOps.push_back(id);
    } else {
      reportResult(id, kind, false, "the ESP32 gate controller has no person or fingerprint store; enrol at a terminal served by a bridge", millis() - started);
    }
  }
  if (cardWork) {
    const uint32_t started = millis();
    if (syncSnapshot()) {
      for (const std::string& id : cardOps) reportResult(id.c_str(), "card", true, nullptr, millis() - started);
    }
  }
  int retry = doc["retryAfterSeconds"] | ESTATEMATE_OPERATIONS_SECONDS;
  return std::max(1, std::min(retry, ESTATEMATE_OPERATIONS_SECONDS));
}

static void flushEvents() {
  GateEvent batch[20];
  size_t n = 0;
  xSemaphoreTake(eventMutex, portMAX_DELAY);
  n = std::min<size_t>(eventCount, 20);
  for (size_t i = 0; i < n; i++) batch[i] = eventRing[(eventHead + i) % EVENT_RING_SIZE];
  xSemaphoreGive(eventMutex);
  if (!n) return;

  JsonDocument doc;
  JsonArray items = doc["items"].to<JsonArray>();
  for (size_t i = 0; i < n; i++) {
    JsonObject item = items.add<JsonObject>();
    item["deviceId"] = ESTATEMATE_DEVICE_ID;
    item["contentType"] = "application/json";
    item["document"] = buildEventDocument(batch[i]);
    if (batch[i].type != EV_EXIT) {
      JsonObject verdict = item["remoteVerification"].to<JsonObject>();
      verdict["decision"] = batch[i].granted ? "granted" : "denied";
      verdict["reason"] = batch[i].reason;
      verdict["doorResult"] = batch[i].doorOpened ? "opened" : "not_attempted";
    }
  }
  std::string body;
  serializeJson(doc, body);
  int status = apiRequest("POST", agentPath("/events"), body, nullptr, nullptr);
  if ((status >= 200 && status < 300) || status == 409 || status == 400 || status == 413) {
    // 409: an Administrator switched agent event streaming off; 400/413: the
    // batch can never be accepted. Either way, retrying it forever helps nobody.
    if (status != 200 && status != 201) Serial.printf("[events] batch dropped: HTTP %d\n", status);
    xSemaphoreTake(eventMutex, portMAX_DELAY);
    // Only the events we sent; newer ones may have arrived meanwhile. If the
    // ring overflowed while we were sending, the oldest are already gone.
    size_t sent = 0;
    while (sent < n && eventCount && eventRing[eventHead].seq <= batch[n - 1].seq) {
      eventHead = (eventHead + 1) % EVENT_RING_SIZE;
      eventCount--;
      sent++;
    }
    xSemaphoreGive(eventMutex);
  } else {
    Serial.printf("[events] upload failed: HTTP %d (kept for retry)\n", status);
  }
}

// ---------------------------------------------------------------------------
// Network task (core 0): Wi-Fi, clock, heartbeat, snapshot, operations, events
// ---------------------------------------------------------------------------

static bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  static uint32_t lastAttempt = 0;
  if (lastAttempt && millis() - lastAttempt < 15000) return false;
  lastAttempt = millis();
  Serial.printf("[wifi] connecting to %s\n", ESTATEMATE_WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ESTATEMATE_WIFI_SSID, ESTATEMATE_WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  return false;
}

static void networkTask(void*) {
  uint32_t nextHeartbeat = 0, nextSnapshot = 0, nextOps = 0;
  bool clockStarted = false;
  for (;;) {
    if (!ensureWifi()) { delay(1000); continue; }
    if (!clockStarted) {
      configTime(0, 0, ESTATEMATE_NTP_SERVER_1, ESTATEMATE_NTP_SERVER_2);
      clockStarted = true;
      // TLS checks certificate dates, so give NTP a moment before the first call.
      for (int i = 0; i < 60 && !timeKnown() && workerIsHttps(); i++) delay(250);
      if (!timeKnown()) Serial.println("[time] no NTP answer yet; card expiry and visitor PINs wait for the clock");
    }
    const uint32_t now = millis();
    if ((int32_t)(now - nextHeartbeat) >= 0) {
      sendHeartbeat();
      nextHeartbeat = millis() + ESTATEMATE_HEARTBEAT_SECONDS * 1000UL;
    }
    if (snapshotRequested || (int32_t)(now - nextSnapshot) >= 0) {
      snapshotRequested = false;
      bool ok = syncSnapshot();
      // Retry a failed refresh sooner, but not in a tight loop.
      nextSnapshot = millis() + (ok ? ESTATEMATE_SNAPSHOT_SECONDS : 30) * 1000UL;
    }
    if ((int32_t)(now - nextOps) >= 0) {
      int wait = pollOperations();
      nextOps = millis() + (uint32_t)wait * 1000UL;
    }
    flushEvents();
    delay(200);
  }
}

// ---------------------------------------------------------------------------
// Arduino entry points (core 1 runs the gate)
// ---------------------------------------------------------------------------

static size_t cacheCapacity() {
  if (ESTATEMATE_MAX_CARDS > 0) return ESTATEMATE_MAX_CARDS;
  if (psramFound()) return 100000;
  return 8000;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nEstateMate ESP32 gate controller %s\nAgent %s, terminal %s\n", ESTATEMATE_GATE_VERSION, ESTATEMATE_AGENT_ID, ESTATEMATE_DEVICE_ID);
  snprintf(bootId, sizeof(bootId), "%08lx", (unsigned long)esp_random());

  pinMode(ESTATEMATE_RELAY_PIN, OUTPUT);
  writeRelay(false);
  if (ESTATEMATE_EXIT_BUTTON_PIN >= 0) pinMode(ESTATEMATE_EXIT_BUTTON_PIN, INPUT_PULLUP);
  if (ESTATEMATE_READER_LED_PIN >= 0) { pinMode(ESTATEMATE_READER_LED_PIN, OUTPUT); digitalWrite(ESTATEMATE_READER_LED_PIN, HIGH); }
  if (ESTATEMATE_READER_BUZZER_PIN >= 0) { pinMode(ESTATEMATE_READER_BUZZER_PIN, OUTPUT); digitalWrite(ESTATEMATE_READER_BUZZER_PIN, HIGH); }
  pinMode(ESTATEMATE_WIEGAND_D0_PIN, INPUT_PULLUP);
  pinMode(ESTATEMATE_WIEGAND_D1_PIN, INPUT_PULLUP);

  cacheMutex = xSemaphoreCreateMutex();
  visitorMutex = xSemaphoreCreateMutex();
  eventMutex = xSemaphoreCreateMutex();
  doorQueue = xQueueCreate(8, sizeof(uint8_t));

  prefs.begin("estatemate", false);
  memset(&snapshotStats, 0, sizeof(snapshotStats));
  if (!LittleFS.begin(true)) Serial.println("[flash] LittleFS unavailable: the snapshot will not survive a restart");
  if (!cardCache.begin(cacheCapacity())) Serial.println("[cache] not enough memory for the card cache");
  // A snapshot saved before a restart is a warm cache: the gate works offline
  // straight away, and the next refresh continues from where it left off.
  if (cardCache.loadFromFile("/snap.bin")) {
    copyText(snapshotStats.since, sizeof(snapshotStats.since), prefs.getString("since", "").c_str());
    Serial.printf("[cache] %u card(s) restored from flash\n", (unsigned)cardCache.count());
  } else {
    Serial.println("[cache] no snapshot yet: cards are denied until the first refresh");
  }
  loadVisitors();
  uint8_t savedMode = prefs.getUChar("doorMode", DOOR_NORMAL);
  if (savedMode == DOOR_ALWAYS_OPEN || savedMode == DOOR_ALWAYS_CLOSED) setDoorMode((DoorMode)savedMode);

  attachInterrupt(digitalPinToInterrupt(ESTATEMATE_WIEGAND_D0_PIN), wiegandD0, FALLING);
  attachInterrupt(digitalPinToInterrupt(ESTATEMATE_WIEGAND_D1_PIN), wiegandD1, FALLING);

  if (workerIsHttps()) secureClient.setCACert(ESTATEMATE_CA_BUNDLE);
  xTaskCreatePinnedToCore(networkTask, "estatemate-net", 16384, nullptr, 1, nullptr, 0);
}

void loop() {
  const uint32_t now = millis();

  // A Wiegand frame is complete once the lines have been quiet for 25 ms.
  uint64_t bits = 0;
  uint8_t count = 0;
  portENTER_CRITICAL(&wgMux);
  if (wgCount && (uint32_t)(now - wgLastBitMs) > 25) {
    bits = wgBits; count = wgCount;
    wgBits = 0; wgCount = 0;
  }
  portEXIT_CRITICAL(&wgMux);
  if (count) {
    WiegandFrame frame = decodeWiegand(bits, count);
    if (frame.kind == WG_CARD) {
      Serial.printf("[reader] %u-bit card %s\n", (unsigned)frame.bits, frame.card);
      handleCard(frame.card, now);
    } else if (frame.kind == WG_KEY) {
      handleKey(frame.key, now);
    } else {
      Serial.printf("[reader] ignored: %s\n", frame.error);
    }
  }

  // Exit button: active low, debounced; opens the door in every mode.
  static bool exitWasPressed = false;
  static uint32_t exitChangedAt = 0;
  if (ESTATEMATE_EXIT_BUTTON_PIN >= 0) {
    bool pressed = digitalRead(ESTATEMATE_EXIT_BUTTON_PIN) == LOW;
    if (pressed != exitWasPressed && (uint32_t)(now - exitChangedAt) > 50) {
      exitWasPressed = pressed;
      exitChangedAt = now;
      if (pressed) {
        if (doorMode != DOOR_ALWAYS_OPEN) pulseDoor();
        recordEvent(EV_EXIT, true, true, nullptr, nullptr, "exit_button");
      }
    }
  }

  uint8_t command;
  while (xQueueReceive(doorQueue, &command, 0) == pdTRUE) applyDoorCommand(command);

  if (relayOffAt && doorMode != DOOR_ALWAYS_OPEN && (int32_t)(now - relayOffAt) >= 0) {
    relayOffAt = 0;
    writeRelay(false);
  }
  serviceFeedback(now);
  delay(2);
}
