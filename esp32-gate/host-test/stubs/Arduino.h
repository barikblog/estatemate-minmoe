// Host stand-in for the ESP32 Arduino core, just enough of it for the gate
// sketch to compile and run under g++ in the test suite. Nothing here is used
// on a real board.
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <time.h>
#include <sys/time.h>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define FALLING 2
#define IRAM_ATTR

// ---- controllable clocks --------------------------------------------------
extern uint32_t hostMillis;
extern int64_t hostEpoch;  // 0 = "clock not set"
inline uint32_t millis() { return hostMillis; }
inline void delay(uint32_t ms) { hostMillis += ms; }
inline time_t host_time(time_t* out) {
  time_t value = (time_t)(hostEpoch ? hostEpoch : 1000);
  if (out) *out = value;
  return value;
}
inline int host_settimeofday(const struct timeval* tv, const void*) { hostEpoch = tv->tv_sec; return 0; }
#define time(x) host_time(x)
#define settimeofday(a, b) host_settimeofday(a, b)
inline void configTime(long, int, const char*, const char*) {}

// ---- GPIO ------------------------------------------------------------------
extern int hostPinLevel[64];
extern int hostPinMode[64];
inline void pinMode(int pin, int mode) { if (pin >= 0 && pin < 64) hostPinMode[pin] = mode; }
inline void digitalWrite(int pin, int level) { if (pin >= 0 && pin < 64) hostPinLevel[pin] = level; }
inline int digitalRead(int pin) { return (pin >= 0 && pin < 64) ? hostPinLevel[pin] : LOW; }
inline int digitalPinToInterrupt(int pin) { return pin; }
inline void attachInterrupt(int, void (*)(), int) {}

// ---- ESP32 bits --------------------------------------------------------------
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(m) ((void)(m))
#define portEXIT_CRITICAL(m) ((void)(m))
#define portENTER_CRITICAL_ISR(m) ((void)(m))
#define portEXIT_CRITICAL_ISR(m) ((void)(m))
inline uint32_t esp_random() { return 0x5eed1234u; }
inline bool psramFound() { return false; }
inline void* ps_malloc(size_t n) { return malloc(n); }

struct HostEsp {
  uint64_t getEfuseMac() { return 0xA1B2C3D4E5F6ULL; }
  uint32_t getFreeHeap() { return 123456; }
};
extern HostEsp ESP;

class String {
 public:
  String() {}
  String(const char* value) : value_(value ? value : "") {}
  String(const std::string& value) : value_(value) {}
  const char* c_str() const { return value_.c_str(); }
  size_t length() const { return value_.size(); }
 private:
  std::string value_;
};

struct HostSerial {
  void begin(unsigned long) {}
  void printf(const char* format, ...) {
    if (!getenv("ESP32_HOST_VERBOSE")) return;
    va_list args; va_start(args, format); vprintf(format, args); va_end(args);
  }
  void println(const char* text) { if (getenv("ESP32_HOST_VERBOSE")) puts(text); }
};
extern HostSerial Serial;

// ---- FreeRTOS ---------------------------------------------------------------
typedef std::recursive_mutex* SemaphoreHandle_t;
typedef std::deque<uint8_t>* QueueHandle_t;
typedef int BaseType_t;
#define pdTRUE 1
#define pdFALSE 0
#define portMAX_DELAY 0xFFFFFFFFu
inline SemaphoreHandle_t xSemaphoreCreateMutex() { return new std::recursive_mutex(); }
inline BaseType_t xSemaphoreTake(SemaphoreHandle_t m, uint32_t) { m->lock(); return pdTRUE; }
inline BaseType_t xSemaphoreGive(SemaphoreHandle_t m) { m->unlock(); return pdTRUE; }
inline QueueHandle_t xQueueCreate(int, int) { return new std::deque<uint8_t>(); }
inline BaseType_t xQueueSend(QueueHandle_t q, const void* item, uint32_t) { q->push_back(*(const uint8_t*)item); return pdTRUE; }
inline BaseType_t xQueueReceive(QueueHandle_t q, void* item, uint32_t) {
  if (q->empty()) return pdFALSE;
  *(uint8_t*)item = q->front(); q->pop_front(); return pdTRUE;
}
inline BaseType_t xTaskCreatePinnedToCore(void (*)(void*), const char*, uint32_t, void*, int, void*, int) { return pdTRUE; }
