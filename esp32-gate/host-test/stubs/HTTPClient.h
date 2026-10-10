// A scripted HTTP client: every request is recorded and answered by the test's
// handler, so the sketch's real protocol code runs against a fake Worker.
#pragma once
#include <functional>
#include <sstream>
#include "WiFiClient.h"

struct HostRequest {
  std::string method;
  std::string url;
  std::string body;
  std::map<std::string, std::string> headers;
};

struct HostResponse {
  int status;
  std::string body;
};

extern std::vector<HostRequest> hostRequests;
extern std::function<HostResponse(const HostRequest&)> hostHttpHandler;

class HTTPClient {
 public:
  void useHTTP10(bool value) { http10_ = value; }
  void setTimeout(uint16_t) {}
  void setConnectTimeout(int32_t) {}
  bool begin(WiFiClient&, const char* url) { request_ = HostRequest(); request_.url = url; return true; }
  void addHeader(const char* name, const char* value) { request_.headers[name] = value; }
  int sendRequest(const char* method, uint8_t* payload = nullptr, size_t size = 0) {
    request_.method = method;
    if (payload) request_.body.assign((const char*)payload, size);
    if (!http10_) return -100;  // the sketch must never ask for a chunked response
    hostRequests.push_back(request_);
    HostResponse response = hostHttpHandler ? hostHttpHandler(request_) : HostResponse{ 404, "{}" };
    stream_.str(response.body);
    stream_.clear();
    return response.status;
  }
  std::istream& getStream() { return stream_; }
  void end() {}
 private:
  bool http10_ = false;
  HostRequest request_;
  std::istringstream stream_;
};
