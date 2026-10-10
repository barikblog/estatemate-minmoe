// LittleFS backed by a scratch directory on the host.
#pragma once
#include <cstdio>
#include "Arduino.h"

extern std::string hostFsRoot;

class File {
 public:
  File() {}
  explicit File(FILE* handle) : handle_(handle) {}
  explicit operator bool() const { return handle_ != nullptr; }
  size_t write(uint8_t c) { return handle_ && fputc(c, handle_) != EOF ? 1 : 0; }
  size_t write(const uint8_t* data, size_t size) { return handle_ ? fwrite(data, 1, size, handle_) : 0; }
  size_t read(uint8_t* data, size_t size) { return handle_ ? fread(data, 1, size, handle_) : 0; }
  int read() { return handle_ ? fgetc(handle_) : -1; }
  size_t readBytes(char* data, size_t size) { return read((uint8_t*)data, size); }
  void close() { if (handle_) fclose(handle_); handle_ = nullptr; }
 private:
  FILE* handle_ = nullptr;
};

struct HostLittleFS {
  bool begin(bool) { return true; }
  std::string full(const char* path) { return hostFsRoot + path; }
  File open(const char* path, const char* mode) { return File(fopen(full(path).c_str(), mode[0] == 'w' ? "wb" : "rb")); }
  bool remove(const char* path) { return ::remove(full(path).c_str()) == 0; }
  bool rename(const char* from, const char* to) { return ::rename(full(from).c_str(), full(to).c_str()) == 0; }
  bool exists(const char* path) { FILE* f = fopen(full(path).c_str(), "rb"); if (f) fclose(f); return f != nullptr; }
};
extern HostLittleFS LittleFS;
