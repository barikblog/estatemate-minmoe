#pragma once
#include "Arduino.h"

#define WL_CONNECTED 3
#define WIFI_STA 1

struct IPAddress {
  String toString() const { return String("192.168.1.50"); }
};

struct HostWiFi {
  int status() { return WL_CONNECTED; }
  void mode(int) {}
  void begin(const char*, const char*) {}
  IPAddress localIP() { return IPAddress(); }
  int32_t RSSI() { return -55; }
};
extern HostWiFi WiFi;
