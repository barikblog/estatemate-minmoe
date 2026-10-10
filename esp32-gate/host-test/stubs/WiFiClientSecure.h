#pragma once
#include "WiFiClient.h"

class WiFiClientSecure : public WiFiClient {
 public:
  void setCACert(const char* pem) { caCert = pem; }
  const char* caCert = nullptr;
};
