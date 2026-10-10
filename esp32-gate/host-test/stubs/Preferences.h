#pragma once
#include "Arduino.h"

class Preferences {
 public:
  bool begin(const char*, bool) { return true; }
  size_t putString(const char* key, const char* value) { strings_[key] = value ? value : ""; return strings_[key].size(); }
  String getString(const char* key, const char* fallback) {
    auto found = strings_.find(key);
    return String(found == strings_.end() ? std::string(fallback ? fallback : "") : found->second);
  }
  size_t putUChar(const char* key, uint8_t value) { bytes_[key] = value; return 1; }
  uint8_t getUChar(const char* key, uint8_t fallback) {
    auto found = bytes_.find(key);
    return found == bytes_.end() ? fallback : found->second;
  }
  void clear() { strings_.clear(); bytes_.clear(); }
 private:
  std::map<std::string, std::string> strings_;
  std::map<std::string, uint8_t> bytes_;
};
