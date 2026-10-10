// Host tests for the EstateMate ESP32 gate sketch.
//
// The real sketch is compiled against small Arduino/ESP32 stand-ins (stubs/)
// and driven through a scripted fake Worker, so the decoding, caching, decision
// and protocol code that runs on the board is exactly the code exercised here.
//
//   node scripts/esp32-gate-host-test.mjs

#include "../EstateMateGate/EstateMateGate.ino"

#include <fstream>
#include <iostream>
#include <sstream>

uint32_t hostMillis = 1000;
int64_t hostEpoch = 0;
int hostPinLevel[64];
int hostPinMode[64];
HostEsp ESP;
HostSerial Serial;
HostWiFi WiFi;
HostLittleFS LittleFS;
std::string hostFsRoot;
std::vector<HostRequest> hostRequests;
std::function<HostResponse(const HostRequest&)> hostHttpHandler;

static int failures = 0;
static int checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; std::cerr << __FILE__ << ":" << __LINE__ << " CHECK failed: " #cond "\n"; } } while (0)
#define CHECK_EQ(a, b) do { checks++; auto _a = (a); auto _b = (b); if (!(_a == _b)) { failures++; std::cerr << __FILE__ << ":" << __LINE__ << " expected [" << _b << "] got [" << _a << "] for " #a "\n"; } } while (0)

static std::string fixturesDir;

static std::string readFixture(const char* name) {
  std::ifstream in(fixturesDir + "/" + name);
  std::stringstream buffer;
  buffer << in.rdbuf();
  std::string text = buffer.str();
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
  return text;
}

// ---- a tiny fake Worker ------------------------------------------------------

struct FakeCard { std::string value; std::string validUntil; };
struct FakeWorker {
  std::vector<FakeCard> cards;               // what a full snapshot serves (sorted by value)
  std::vector<FakeCard> deltaItems;          // what a delta serves
  std::vector<std::string> deltaRemoved;
  std::string operationsJson = "{\"items\":[],\"retryAfterSeconds\":10}";
  int failSnapshotPage = 0;                  // 1-based page number to fail, 0 = never
  int snapshotPagesServed = 0;
  std::vector<std::string> sinceSeen;
  int eventsStatus = 200;
};
static FakeWorker worker;

static std::string queryParam(const std::string& url, const std::string& name) {
  size_t q = url.find('?');
  if (q == std::string::npos) return "";
  std::string query = url.substr(q + 1);
  std::stringstream parts(query);
  std::string part;
  while (std::getline(parts, part, '&')) {
    size_t eq = part.find('=');
    if (part.substr(0, eq) != name) continue;
    std::string raw = eq == std::string::npos ? "" : part.substr(eq + 1), out;
    for (size_t i = 0; i < raw.size(); i++) {
      if (raw[i] == '%' && i + 2 < raw.size()) { out += (char)strtol(raw.substr(i + 1, 2).c_str(), nullptr, 16); i += 2; }
      else out += raw[i];
    }
    return out;
  }
  return "";
}

static HostResponse fakeWorker(const HostRequest& request) {
  const std::string prefix = "https://estatemate.test/api/isapi/v1/agents/agent-esp32-test";
  if (request.headers.count("X-EstateMate-Agent-Key") == 0 || request.headers.at("X-EstateMate-Agent-Key") != "host-test-secret") return { 401, "" };
  if (request.url.rfind(prefix, 0) != 0) return { 404, "{}" };
  std::string path = request.url.substr(prefix.size());
  path = path.substr(0, path.find('?'));
  if (path == "/heartbeat") return { 200, "{\"ok\":true,\"serverTime\":\"2026-10-10T08:00:00.000Z\"}" };
  if (path == "/credential-snapshot") {
    worker.snapshotPagesServed++;
    if (worker.failSnapshotPage && worker.snapshotPagesServed == worker.failSnapshotPage) return { 503, "{}" };
    std::string since = queryParam(request.url, "since");
    std::string cursor = queryParam(request.url, "cursor");
    worker.sinceSeen.push_back(since);
    const std::vector<FakeCard>& source = since.empty() ? worker.cards : worker.deltaItems;
    // Two cards per page plus an employee row, so paging and kind filtering both run.
    size_t start = 0;
    while (start < source.size() && !cursor.empty() && source[start].value <= cursor.substr(0, cursor.find('|'))) start++;
    std::string body = "{\"agentId\":\"agent-esp32-test\",\"version\":\"x\",\"serverTime\":\"2026-10-10T08:00:00.000Z\",\"full\":";
    body += since.empty() ? "true" : "false";
    body += ",\"items\":[{\"kind\":\"employee\",\"value\":\"EMPRITA\",\"personId\":\"p\",\"employeeNo\":\"EMPRITA\",\"status\":\"active\",\"validUntil\":null,\"updatedAt\":null}";
    size_t end = std::min(source.size(), start + 2);
    for (size_t i = start; i < end; i++) {
      body += ",{\"kind\":\"card\",\"value\":\"" + source[i].value + "\",\"personId\":\"p\",\"employeeNo\":null,\"status\":\"active\",\"validUntil\":";
      body += source[i].validUntil.empty() ? "null" : "\"" + source[i].validUntil + "\"";
      body += ",\"updatedAt\":\"2026-10-10 07:00:00\"}";
    }
    body += "],\"removed\":[";
    if (!since.empty()) {
      for (size_t i = 0; i < worker.deltaRemoved.size(); i++) body += std::string(i ? "," : "") + "{\"kind\":\"card\",\"value\":\"" + worker.deltaRemoved[i] + "\"}";
    }
    body += "],\"nextCursor\":";
    body += end < source.size() ? "\"" + source[end - 1].value + "|card\"" : "null";
    body += "}";
    return { 200, body };
  }
  if (path == "/operations") return { 200, worker.operationsJson };
  if (path.find("/operations/") == 0) return { 200, "{\"ok\":true}" };
  if (path == "/events") return { worker.eventsStatus, "{\"ok\":true}" };
  return { 404, "{}" };
}

static void resetState() {
  hostMillis = 1000;
  hostEpoch = parseTimestamp("2026-10-10T08:00:00Z");
  memset(hostPinLevel, 0, sizeof(hostPinLevel));
  hostPinLevel[ESTATEMATE_EXIT_BUTTON_PIN] = HIGH;  // pulled up, not pressed
  hostRequests.clear();
  worker = FakeWorker();
  hostHttpHandler = fakeWorker;
  LittleFS.remove("/snap.bin");
  LittleFS.remove("/visitors.json");
  prefs.clear();
  cardCache.setReady(false);
  std::vector<uint64_t> none;
  std::vector<CardEntry> empty;
  // Empty the cache by loading a zero-length snapshot.
  File f = LittleFS.open("/empty", "w"); f.close();
  cardCache.replaceFromFile("/empty", 0);
  cardCache.setReady(false);
  memset(&snapshotStats, 0, sizeof(snapshotStats));
  visitors.clear();
  eventHead = eventCount = 0; eventSeq = 0; eventsDropped = 0;
  grantedCount = deniedCount = 0;
  lastDecision[0] = lastReason[0] = lastResult[0] = '\0';
  doorMode = DOOR_NORMAL; relayOffAt = 0; relayOn = false;
  pinBuffer[0] = '\0'; pinFailures = 0; pinLockedUntil = 0;
  lastCardKey = 0; lastCardMs = 0;
  uint8_t drain; while (xQueueReceive(doorQueue, &drain, 0) == pdTRUE) {}
}

// Builds a Wiegand frame with correct parity: even over the first half, odd over the second.
static uint64_t wiegandFrame(uint64_t data, int count) {
  int dataBits = count - 2, half = dataBits / 2;
  uint64_t bits = data << 1;
  uint64_t firstHalf = (data >> (dataBits - half)) & ((1ULL << half) - 1);
  uint64_t secondHalf = data & ((1ULL << (dataBits - half)) - 1);
  if (popcount64(firstHalf) % 2) bits |= 1ULL << (count - 1);
  if (popcount64(secondHalf) % 2 == 0) bits |= 1ULL;
  return bits;
}

static const HostRequest* lastRequestTo(const std::string& fragment) {
  for (auto it = hostRequests.rbegin(); it != hostRequests.rend(); ++it) if (it->url.find(fragment) != std::string::npos) return &*it;
  return nullptr;
}

static void pressKeys(const char* keys) {
  for (const char* k = keys; *k; k++) handleKey(*k == '#' ? 11 : *k == '*' ? 10 : (uint8_t)(*k - '0'), hostMillis);
}

static GateEvent lastEvent() { return eventRing[(eventHead + eventCount - 1) % EVENT_RING_SIZE]; }

// ---- tests -------------------------------------------------------------------

static void testWiegand() {
  WiegandFrame f = decodeWiegand(wiegandFrame(1 * 65536 + 12345, 26), 26);
  CHECK_EQ((int)f.kind, (int)WG_CARD);
  CHECK_EQ(std::string(f.card), std::string("77881"));
  f = decodeWiegand(wiegandFrame(1 * 65536 + 12345, 26) ^ (1ULL << 5), 26);
  CHECK_EQ((int)f.kind, (int)WG_ERROR);
  f = decodeWiegand(wiegandFrame(3735928559ULL, 34), 34);
  CHECK_EQ((int)f.kind, (int)WG_CARD);
  CHECK_EQ(std::string(f.card), std::string("3735928559"));
  f = decodeWiegand(0x7, 4);
  CHECK_EQ((int)f.kind, (int)WG_KEY);
  CHECK_EQ((int)f.key, 7);
  f = decodeWiegand(0x4B, 8);  // '#' (0xB) with its complement (0x4) in the high nibble
  CHECK_EQ((int)f.kind, (int)WG_KEY);
  CHECK_EQ((int)f.key, 11);
  f = decodeWiegand(0xBB, 8);
  CHECK_EQ((int)f.kind, (int)WG_ERROR);
  f = decodeWiegand(0x1FF, 9);
  CHECK_EQ((int)f.kind, (int)WG_ERROR);
}

static void testTimeAndKeys() {
  CHECK_EQ(parseTimestamp("1970-01-01T00:00:00Z"), (int64_t)0);
  CHECK_EQ(parseTimestamp("2026-10-10T08:15:00.000Z"), (int64_t)1791620100);
  CHECK_EQ(parseTimestamp("2026-10-10 08:15:00"), (int64_t)1791620100);
  CHECK_EQ(parseTimestamp("2026-10-10T09:15:00+01:00"), (int64_t)1791620100);
  CHECK_EQ(parseTimestamp("2026-10-10"), (int64_t)1791590400);
  CHECK_EQ(parseTimestamp("not a date"), (int64_t)0);
  char out[24];
  formatTimestamp(1791620100, false, out, sizeof(out));
  CHECK_EQ(std::string(out), std::string("2026-10-10 08:15:00"));
  formatTimestamp(1791620100, true, out, sizeof(out));
  CHECK_EQ(std::string(out), std::string("2026-10-10T08:15:00Z"));
  CHECK(cardKey("0000077881") == cardKey("77881"));
  CHECK(cardKey("77881") != cardKey("77882"));
  CHECK(cardKey("0") == cardKey("0000"));
  CHECK(cardKey("") == 0);
}

static void testFullSnapshotAndDecisions() {
  resetState();
  // Cold cache: every card is denied.
  CHECK_EQ(std::string(decideCard("77881", nowSeconds()).reason), std::string("cache_not_ready"));
  worker.cards = { { "0000077881", "" }, { "10000002", "2026-10-09T00:00:00.000Z" }, { "10000003", "2027-01-01 00:00:00" }, { "10000004", "" }, { "10000005", "" } };
  CHECK(syncSnapshot());
  CHECK_EQ(worker.snapshotPagesServed, 3);
  CHECK_EQ(cardCache.count(), (size_t)5);   // employee rows are not cached
  CHECK(cardCache.ready());
  CHECK_EQ(std::string(snapshotStats.since), std::string("2026-10-10 07:58:00"));
  CHECK(LittleFS.exists("/snap.bin"));
  CHECK(!LittleFS.exists("/snap.full"));
  CHECK(decideCard("77881", nowSeconds()).granted);           // leading zeroes do not matter
  CHECK_EQ(std::string(decideCard("10000002", nowSeconds()).reason), std::string("credential_expired"));
  CHECK(decideCard("10000003", nowSeconds()).granted);
  CHECK_EQ(std::string(decideCard("99999999", nowSeconds()).reason), std::string("unknown_credential"));
  int64_t unset = 0;
  CHECK_EQ(std::string(decideCard("10000003", unset).reason), std::string("clock_not_set"));
  CHECK(decideCard("77881", unset).granted);                   // no expiry: the clock is irrelevant

  // The swipe path: relay pulses, event recorded with the verdict.
  handleCard("77881", hostMillis);
  CHECK(relayOn);
  CHECK_EQ(hostPinLevel[ESTATEMATE_RELAY_PIN], HIGH);
  CHECK_EQ(eventCount, (size_t)1);
  CHECK(lastEvent().granted);
  handleCard("77881", hostMillis + 200);                       // cooldown: no second event
  CHECK_EQ(eventCount, (size_t)1);
  hostMillis += ESTATEMATE_DOOR_OPEN_MS + 10;
  loop();
  CHECK(!relayOn);
  handleCard("99999999", hostMillis);
  CHECK(!relayOn);
  CHECK(!lastEvent().granted);
  CHECK_EQ(std::string(lastEvent().reason), std::string("unknown_credential"));

  // A restart restores the snapshot from flash: a warm cache works offline.
  cardCache.setReady(false);
  CHECK(cardCache.loadFromFile("/snap.bin"));
  CHECK(decideCard("10000005", nowSeconds()).granted);
}

static void testDeltaAndFailures() {
  resetState();
  worker.cards = { { "10000001", "" }, { "10000002", "" }, { "10000003", "" } };
  CHECK(syncSnapshot());
  // A delta revokes one card, adds one, and re-sends a card that was reissued
  // (revoked row + active row with the same number): the active row wins.
  worker.deltaItems = { { "10000003", "" }, { "20000001", "" } };
  worker.deltaRemoved = { "10000001", "10000003" };
  hostRequests.clear();
  CHECK(syncSnapshot());
  CHECK_EQ(worker.sinceSeen.back(), std::string("2026-10-10 07:58:00"));
  CHECK_EQ(std::string(decideCard("10000001", nowSeconds()).reason), std::string("unknown_credential"));
  CHECK(decideCard("10000002", nowSeconds()).granted);
  CHECK(decideCard("10000003", nowSeconds()).granted);
  CHECK(decideCard("20000001", nowSeconds()).granted);
  CHECK_EQ(snapshotStats.removedApplied, (uint32_t)2);
  // Every page of a delta carries `since` with the cursor, so page two is a delta too.
  const HostRequest* page = lastRequestTo("credential-snapshot");
  CHECK(page && page->url.find("since=") != std::string::npos);

  // A refresh that fails half-way changes nothing.
  worker.deltaItems = { { "30000001", "" }, { "30000002", "" }, { "30000003", "" } };
  worker.deltaRemoved = { "10000002" };
  worker.snapshotPagesServed = 0;
  worker.failSnapshotPage = 2;
  CHECK(!syncSnapshot());
  CHECK(decideCard("10000002", nowSeconds()).granted);
  CHECK_EQ(std::string(decideCard("30000001", nowSeconds()).reason), std::string("unknown_credential"));
  CHECK(cardCache.ready());                                    // a failed refresh never empties the gate
  CHECK(std::string(snapshotStats.lastSyncError).find("HTTP 503") != std::string::npos);
  CHECK_EQ(std::string(snapshotStats.since), std::string("2026-10-10 07:58:00"));

  // A full snapshot larger than the controller can hold is refused, and the
  // previous snapshot stays in force.
  resetState();
  worker.cards = { { "10000001", "" } };
  CHECK(syncSnapshot());
  for (int i = 0; i < 400; i++) worker.cards.push_back({ std::to_string(40000000 + i), "" });
  std::sort(worker.cards.begin(), worker.cards.end(), [](const FakeCard& a, const FakeCard& b) { return a.value < b.value; });
  cardCache.setReady(false);                                   // force a full refresh
  CHECK(!syncSnapshot());
  CHECK(std::string(snapshotStats.lastSyncError).find("this controller holds 300") != std::string::npos);
  cardCache.loadFromFile("/snap.bin");
  CHECK(decideCard("10000001", nowSeconds()).granted);
}

static void testOperations() {
  resetState();
  worker.cards = { { "10000001", "" } };
  CHECK(syncSnapshot());
  worker.operationsJson = R"({"items":[
    {"id":"op-open","kind":"door","deviceId":"device-gate-test","operation":"remote_open","payload":{"doorNo":1}},
    {"id":"op-door2","kind":"door","deviceId":"device-gate-test","operation":"remote_open","payload":{"doorNo":2}},
    {"id":"op-other","kind":"door","deviceId":"device-elsewhere","operation":"remote_open","payload":{"doorNo":1}},
    {"id":"op-visitor","kind":"visitor","deviceId":"device-gate-test","operation":"upsert_visitor","payload":{"credentialNumber":"V12345","pin":"482913","validFrom":"2026-10-10T07:00:00.000Z","validUntil":"2026-10-11T07:00:00.000Z","enabled":false}},
    {"id":"op-card","kind":"card","deviceId":"device-gate-test","operation":"upsert_card","payload":{"cardUid":"20000001"}},
    {"id":"op-finger","kind":"fingerprint","deviceId":"device-gate-test","operation":"upload_fingerprint","payload":{}}
  ],"retryAfterSeconds":1})";
  worker.deltaItems = { { "20000001", "" } };
  int wait = pollOperations();
  CHECK_EQ(wait, 1);
  auto resultOf = [](const char* id) -> std::string {
    const HostRequest* r = lastRequestTo(std::string("/operations/") + id + "/result");
    return r ? r->body : std::string("<none>");
  };
  CHECK(resultOf("op-open").find("\"status\":\"applied\"") != std::string::npos);
  CHECK(resultOf("op-door2").find("door 2 is not wired") != std::string::npos);
  CHECK(resultOf("op-other").find("serves one terminal only") != std::string::npos);
  CHECK(resultOf("op-visitor").find("\"status\":\"applied\"") != std::string::npos);
  CHECK(resultOf("op-card").find("\"status\":\"applied\"") != std::string::npos);
  CHECK(resultOf("op-card").find("\"kind\":\"card\"") != std::string::npos);
  CHECK(resultOf("op-finger").find("\"status\":\"failed\"") != std::string::npos);
  CHECK(decideCard("20000001", nowSeconds()).granted);         // the card op refreshed the snapshot

  // The queued door command reaches the relay on the gate loop.
  loop();
  CHECK(relayOn);

  // The visitor PIN opens the door inside its window and never leaves the controller.
  hostMillis += ESTATEMATE_DOOR_OPEN_MS + 10; loop();
  CHECK(!relayOn);
  pressKeys("482913#");
  CHECK(relayOn);
  CHECK(lastEvent().granted);
  CHECK_EQ(std::string(lastEvent().employeeNo), std::string("visitorV12345"));
  std::string doc = buildEventDocument(lastEvent());
  CHECK(doc.find("482913") == std::string::npos);
  CHECK(LittleFS.exists("/visitors.json"));

  // Outside the window it is refused.
  hostEpoch = parseTimestamp("2026-10-11T07:00:00Z");
  pressKeys("482913#");
  CHECK(!lastEvent().granted);
  CHECK_EQ(std::string(lastEvent().reason), std::string("credential_expired"));
  hostEpoch = parseTimestamp("2026-10-10T08:00:00Z");

  // Five wrong PINs lock the keypad, even for the right PIN.
  for (int i = 0; i < 5; i++) pressKeys("111111#");
  pressKeys("482913#");
  CHECK(!lastEvent().granted);
  CHECK_EQ(std::string(lastEvent().reason), std::string("too_many_attempts"));
  hostMillis += 61000;
  pressKeys("482913#");
  CHECK(lastEvent().granted);

  // Revocation removes the PIN.
  worker.operationsJson = R"({"items":[{"id":"op-revoke","kind":"visitor","deviceId":"device-gate-test","operation":"revoke_visitor","payload":{"credentialNumber":"V12345"}}],"retryAfterSeconds":10})";
  pollOperations();
  hostMillis += 5000;
  pressKeys("482913#");
  CHECK_EQ(std::string(lastEvent().reason), std::string("unknown_credential"));

  // Remain closed refuses credentials but never the exit button.
  applyDoorCommand(CMD_ALWAYS_CLOSE);
  CHECK_EQ(std::string(decideCard("10000001", nowSeconds()).reason), std::string("door_remain_closed"));
  hostMillis += 5000; loop();
  hostPinLevel[ESTATEMATE_EXIT_BUTTON_PIN] = LOW;
  hostMillis += 100; loop();
  CHECK(relayOn);
  CHECK_EQ((int)lastEvent().type, (int)EV_EXIT);
  hostPinLevel[ESTATEMATE_EXIT_BUTTON_PIN] = HIGH;
  hostMillis += 100; loop();
  applyDoorCommand(CMD_ALWAYS_OPEN);
  CHECK(relayOn);
  hostMillis += 60000; loop();
  CHECK(relayOn);                                              // held open
  applyDoorCommand(CMD_RESUME);
  CHECK(!relayOn);
  CHECK_EQ((int)prefs.getUChar("doorMode", 9), (int)DOOR_NORMAL);
}

static void testEventsAndHeartbeat() {
  resetState();
  GateEvent e;
  memset(&e, 0, sizeof(e));
  e.seq = 1; e.at = parseTimestamp("2026-10-10T08:15:00Z"); e.type = EV_CARD; e.granted = true; e.doorOpened = true;
  copyText(e.cardNo, sizeof(e.cardNo), "77881"); copyText(e.reason, sizeof(e.reason), "authorised");
  CHECK_EQ(buildEventDocument(e), readFixture("event-card-granted.json"));
  e.seq = 2; e.granted = false; e.doorOpened = false; copyText(e.reason, sizeof(e.reason), "unknown_credential");
  copyText(e.cardNo, sizeof(e.cardNo), "99999999");
  CHECK_EQ(buildEventDocument(e), readFixture("event-card-denied.json"));
  memset(&e, 0, sizeof(e));
  e.seq = 3; e.at = parseTimestamp("2026-10-10T08:16:00Z"); e.type = EV_PIN; e.granted = true; e.doorOpened = true;
  copyText(e.employeeNo, sizeof(e.employeeNo), "visitorV12345"); copyText(e.reason, sizeof(e.reason), "authorised");
  CHECK_EQ(buildEventDocument(e), readFixture("event-pin-granted.json"));
  memset(&e, 0, sizeof(e));
  e.seq = 4; e.at = parseTimestamp("2026-10-10T08:17:00Z"); e.type = EV_EXIT; e.granted = true; e.doorOpened = true;
  copyText(e.reason, sizeof(e.reason), "exit_button");
  CHECK_EQ(buildEventDocument(e), readFixture("event-exit.json"));

  // Upload: one batch, with the controller's verdict on credential events.
  recordEvent(EV_CARD, true, true, "77881", nullptr, "authorised");
  recordEvent(EV_EXIT, true, true, nullptr, nullptr, "exit_button");
  flushEvents();
  const HostRequest* post = lastRequestTo("/events");
  CHECK(post != nullptr);
  if (post) {
    JsonDocument body;
    deserializeJson(body, post->body);
    CHECK_EQ(body["items"].size(), (size_t)2);
    CHECK_EQ(std::string(body["items"][0]["deviceId"] | ""), std::string("device-gate-test"));
    CHECK_EQ(std::string(body["items"][0]["remoteVerification"]["doorResult"] | ""), std::string("opened"));
    CHECK(body["items"][1]["remoteVerification"].isNull());
  }
  CHECK_EQ(eventCount, (size_t)0);
  // A failed upload keeps the events for the next attempt.
  worker.eventsStatus = 503;
  recordEvent(EV_CARD, false, false, "1", nullptr, "unknown_credential");
  flushEvents();
  CHECK_EQ(eventCount, (size_t)1);
  // Offline for long: the ring keeps the newest events and counts the rest.
  for (int i = 0; i < 70; i++) recordEvent(EV_CARD, false, false, "1", nullptr, "unknown_credential");
  CHECK_EQ(eventCount, EVENT_RING_SIZE);
  CHECK(eventsDropped > 0);

  // Heartbeat: the controller reports its terminal as up and its snapshot health
  // in the shape the portal's Remote Network Verification panel reads.
  hostEpoch = 0;                                               // clock unset: adopt the portal's time
  sendHeartbeat();
  const HostRequest* hb = lastRequestTo("/heartbeat");
  CHECK(hb != nullptr);
  if (hb) {
    JsonDocument body;
    deserializeJson(body, hb->body);
    CHECK_EQ(std::string(body["devices"][0]["deviceId"] | ""), std::string("device-gate-test"));
    CHECK_EQ(std::string(body["devices"][0]["stream"] | ""), std::string("up"));
    CHECK_EQ(body["capabilities"].size(), (size_t)0);
    CHECK(body["remoteVerify"]["cache"]["credentialCount"].is<uint32_t>());
    CHECK(!body["remoteVerify"]["perDevice"]["device-gate-test"].isNull());
    CHECK(std::string(body["version"] | "").rfind("esp32-gate-", 0) == 0);
  }
  CHECK_EQ(hostEpoch, parseTimestamp("2026-10-10T08:00:00Z"));
  // Every request authenticated with the agent secret, over HTTP/1.0.
  for (const HostRequest& r : hostRequests) CHECK_EQ(r.headers.at("X-EstateMate-Agent-Key"), std::string("host-test-secret"));
  CHECK(secureClient.caCert == nullptr || strstr(secureClient.caCert, "BEGIN CERTIFICATE") != nullptr);
}

int main(int argc, char** argv) {
  if (argc < 3) { std::cerr << "usage: test <scratch-dir> <fixtures-dir>\n"; return 2; }
  hostFsRoot = argv[1];
  fixturesDir = argv[2];
  hostEpoch = parseTimestamp("2026-10-10T08:00:00Z");
  setup();  // the real setup(): pins, mutexes, flash, cache allocation
  CHECK(secureClient.caCert != nullptr);
  CHECK(strstr(ESTATEMATE_CA_BUNDLE, "BEGIN CERTIFICATE") != nullptr);
  CHECK_EQ(cardCache.capacity(), (size_t)300);
  testWiegand();
  testTimeAndKeys();
  testFullSnapshotAndDecisions();
  testDeltaAndFailures();
  testOperations();
  testEventsAndHeartbeat();
  std::cout << checks - failures << "/" << checks << " ESP32 gate host checks passed\n";
  return failures ? 1 : 0;
}
