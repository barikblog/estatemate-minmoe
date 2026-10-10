// Test identity for the host build. Not a real agent: the IDs and secret below
// exist only inside the host test's fake Worker.
#pragma once
#define ESTATEMATE_CONFIG_VERSION 1
#define ESTATEMATE_WIFI_CONFIGURED 1
#define ESTATEMATE_WIFI_SSID "test-network"
#define ESTATEMATE_WIFI_PASSWORD "test-password"
#define ESTATEMATE_WORKER_URL "https://estatemate.test"
#define ESTATEMATE_AGENT_ID "agent-esp32-test"
#define ESTATEMATE_AGENT_SECRET "host-test-secret"
#define ESTATEMATE_DEVICE_ID "device-gate-test"
#define ESTATEMATE_MAX_CARDS 300
