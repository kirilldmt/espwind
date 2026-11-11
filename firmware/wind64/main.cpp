#include "core.h"
#include "polling.h"
#include "weather_parser.h"
#include "web_page.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <atomic>
#include <esp_crt_bundle.h>
#include <esp_heap_caps.h>
#include <esp_http_client.h>
#include <esp_timer.h>
#include <new>
#include <sys/time.h>

using namespace wind64;
static constexpr const char *VERSION = "wind64-1.1.2";
static SemaphoreHandle_t stateMutex;
static Weather *weather, *displayWeather;
static Settings settings;
static Preferences storage;
static WebServer web(80);
static DNSServer dns;
static MatrixPanel_I2S_DMA *panel;
static Frame *frame, *target, *previous;
static Flow flows[2] = {Flow(1), Flow(2)};
static char apName[20], apPassword[9], webToken[25];
struct Credentials {
  char ssid[33] = {};
  char password[64] = {};
};
static Credentials savedCredentials, pendingCredentials;
static std::atomic_bool apActive{false}, needSetup{false},
    openPortalRequested{false};
static std::atomic<uint8_t> activeBrightness{8};
static std::atomic<int> activeScreen{0};
static std::atomic<uint32_t> renderedFrames{0}, maxFrameUs{0}, slowFrames{0},
    skippedFrames{0}, renderCycles{0};
static std::atomic<uint32_t> meanFrameUs{0};
static uint32_t forecastRevision = 0;
struct PollStats {
  uint32_t attempts = 0, successes = 0, failures = 0, durationMs = 0;
  uint64_t bytes = 0, nextAt = 0;
  int http = 0;
};
static PollStats pollStats[3];
static uint64_t weatherCooldownUntil = 0;
static uint32_t responseBufferBytes = 0;
static TaskHandle_t controlHandle = nullptr, weatherHandle = nullptr;
static bool pendingConnect = false, tryingCredentials = false,
            wasConnected = false, ntpStarted = false, mdnsStarted = false;
static uint32_t connectBegan = 0, apCloseAt = 0, lastReconnect = 0;
static const char *wifiResult = "idle";

struct StateLock {
  StateLock() { xSemaphoreTake(stateMutex, portMAX_DELAY); }
  ~StateLock() { xSemaphoreGive(stateMutex); }
};
template <class T> static T *externalObject() {
  void *p = heap_caps_malloc(sizeof(T), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p)
    return nullptr;
  return new (p) T();
}
static Time wallTime() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  return Time(tv.tv_sec) * 1000 + tv.tv_usec / 1000;
}
static uint64_t monotonicMs() { return uint64_t(esp_timer_get_time()) / 1000; }
static bool validSettings(const Settings &s) {
  return s.version == 1 && s.day <= 100 && s.night <= 100 && s.mode <= 2 &&
         s.nightStart < 1440 && s.nightEnd < 1440;
}
static void randomText(char *out, size_t n) {
  const char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (size_t i = 0; i < n; i++)
    out[i] = alphabet[esp_random() % (sizeof(alphabet) - 1)];
  out[n] = 0;
}

static void openPortal() {
  if (apActive)
    return;
  WiFi.mode(WIFI_AP_STA);
  if (WiFi.softAP(apName, apPassword, 1, false, 2)) {
    dns.start(53, "*", WiFi.softAPIP());
    apActive = true;
    needSetup = true;
    apCloseAt = 0;
    Serial.printf(
        "{\"setup\":true,\"ssid\":\"%s\",\"address\":\"192.168.4.1\"}\n",
        apName);
  }
}
static void closePortal() {
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apActive = false;
  needSetup = false;
  apCloseAt = 0;
}
static void jsonReply(int code, JsonDocument &doc) {
  String body;
  serializeJson(doc, body);
  web.sendHeader("Cache-Control", "no-store");
  web.sendHeader("X-Content-Type-Options", "nosniff");
  web.send(code, "application/json; charset=utf-8", body);
}
static void errorReply(int code, const char *error) {
  JsonDocument doc;
  doc["error"] = error;
  jsonReply(code, doc);
}
static bool authorizedWrite() {
  if (web.header("X-Wind64-Token") != webToken) {
    errorReply(403, "Обновите страницу настроек");
    return false;
  }
  String origin = web.header("Origin");
  if (origin.length() && origin != "http://" + web.hostHeader()) {
    errorReply(403, "Недопустимый источник запроса");
    return false;
  }
  if (web.arg("plain").length() > 1024) {
    errorReply(413, "Слишком большой запрос");
    return false;
  }
  return true;
}
static void statusDocument(JsonDocument &d, bool includeToken) {
  Time now = wallTime();
  bool connected = WiFi.status() == WL_CONNECTED;
  d["version"] = VERSION;
  d["connected"] = connected;
  d["ip"] = WiFi.localIP().toString();
  d["ssid"] = connected ? WiFi.SSID() : String(savedCredentials.ssid);
  d["clockKnown"] = validTime(now);
  d["brightness"] = activeBrightness.load();
  d["screen"] = activeScreen.load() + 1;
  d["uptimeMs"] = monotonicMs();
  d["refreshHz"] = panel->calculated_refresh_rate;
  d["frames"] = renderedFrames.load();
  d["maxFrameUs"] = maxFrameUs.load();
  d["slowFrames"] = slowFrames.load();
  d["skippedFrames"] = skippedFrames.load();
  uint32_t cycles = renderCycles.load();
  d["renderCycles"] = cycles;
  d["meanFrameUs"] = meanFrameUs.load();
  d["freeHeap"] = ESP.getFreeHeap();
  d["minFreeHeap"] = ESP.getMinFreeHeap();
  d["freePsram"] = ESP.getFreePsram();
  d["controlStackFree"] =
      controlHandle ? uxTaskGetStackHighWaterMark(controlHandle) : 0;
  d["weatherStackFree"] =
      weatherHandle ? uxTaskGetStackHighWaterMark(weatherHandle) : 0;
  d["wifiResult"] = wifiResult;
  d["setup"] = apActive.load();
  if (includeToken)
    d["token"] = webToken;
  StateLock lock;
  auto polls = d["polling"].to<JsonArray>();
  d["responseBufferBytes"] = responseBufferBytes;
  uint64_t elapsed = monotonicMs();
  d["apiCooldownMs"] = weatherCooldownUntil > elapsed
                           ? weatherCooldownUntil - elapsed : 0;
  for (int i = 0; i < 3; i++) {
    auto poll = polls.add<JsonObject>();
    const auto &stats = pollStats[i];
    poll["source"] = i == 0 ? "forecast" : i == 1 ? "kitepiter" : "pulkovo";
    poll["intervalMs"] = POLL_INTERVALS[i];
    poll["attempts"] = stats.attempts;
    poll["successes"] = stats.successes;
    poll["consecutiveFailures"] = stats.failures;
    poll["lastHttp"] = stats.http;
    poll["lastDurationMs"] = stats.durationMs;
    poll["bytes"] = stats.bytes;
    uint64_t next = std::max(stats.nextAt, weatherCooldownUntil);
    poll["nextInMs"] = next > elapsed ? next - elapsed : 0;
  }
  d["forecastReady"] = weather->forecast.available;
  d["forecastFetchedAt"] = weather->forecast.fetchedAt;
  d["modelUpdatedAt"] = weather->forecast.modelAt;
  d["forecastStatus"] = int(forecastStatus(weather->forecast, now));
  int knownHours = 0;
  for (const auto &h : weather->forecast.hours)
    if (std::isfinite(h.wind))
      knownHours++;
  d["forecastHours"] = knownHours;
  for (int i = 0; i < 2; i++) {
    const auto &s = weather->stations[i];
    d[i ? "pulkovoReady" : "kitepiterReady"] = s.count > 0;
  }
  auto stations = d["stations"].to<JsonArray>();
  for (int i = 0; i < 2; i++) {
    const auto &s = weather->stations[i];
    auto st = stations.add<JsonObject>();
    st["id"] = i ? "ULLI" : "1chipru_840d8eaa9b63";
    st["count"] = s.count;
    st["error"] = s.error;
    st["status"] = int(stationStatus(s, i, now));
    if (s.count) {
      const auto &r = s.rows[s.count - 1];
      st["timestamp"] = r.timestamp;
      if (std::isfinite(r.wind))
        st["wind"] = r.wind;
      else
        st["wind"] = nullptr;
    }
  }
  auto s = d["settings"].to<JsonObject>();
  s["day"] = settings.day;
  s["night"] = settings.night;
  s["mode"] = settings.mode;
  s["nightStart"] = settings.nightStart;
  s["nightEnd"] = settings.nightEnd;
}
static void beginWeb() {
  const char *headers[] = {"X-Wind64-Token", "Origin"};
  web.collectHeaders(headers, 2);
  web.on("/", HTTP_GET, [] {
    web.sendHeader("Content-Encoding", "gzip");
    web.sendHeader("Cache-Control", "no-store");
    web.send_P(200, "text/html; charset=utf-8",
               reinterpret_cast<const char *>(WEB_PAGE), sizeof(WEB_PAGE));
  });
  web.on("/api/status", HTTP_GET, [] {
    JsonDocument doc;
    statusDocument(doc, true);
    jsonReply(200, doc);
  });
  web.on("/api/settings", HTTP_POST, [] {
    if (!authorizedWrite())
      return;
    JsonDocument d;
    if (deserializeJson(d, web.arg("plain"))) {
      errorReply(400, "Неверные настройки");
      return;
    }
    const char *keys[] = {"day", "night", "mode", "nightStart", "nightEnd"};
    for (const auto key : keys)
      if (!d[key].is<int>()) {
        errorReply(400, "Заполните все настройки");
        return;
      }
    int day = d["day"], night = d["night"], mode = d["mode"],
        start = d["nightStart"], end = d["nightEnd"];
    if (day < 0 || day > 100 || night < 0 || night > 100 || mode < 0 ||
        mode > 2 || start < 0 || start >= 1440 || end < 0 || end >= 1440) {
      errorReply(400, "Проверьте яркость и время");
      return;
    }
    Settings next;
    next.day = day;
    next.night = night;
    next.mode = mode;
    next.nightStart = start;
    next.nightEnd = end;
    if (storage.putBytes("settings", &next, sizeof(next)) != sizeof(next)) {
      errorReply(500, "Не удалось сохранить настройки");
      return;
    }
    {
      StateLock lock;
      settings = next;
    }
    JsonDocument answer;
    answer["ok"] = true;
    jsonReply(200, answer);
  });
  web.on("/api/wifi", HTTP_POST, [] {
    if (!authorizedWrite())
      return;
    JsonDocument d;
    if (deserializeJson(d, web.arg("plain")) || !d["ssid"].is<const char *>() ||
        !d["password"].is<const char *>()) {
      errorReply(400, "Укажите сеть и пароль");
      return;
    }
    const char *ssid = d["ssid"], *password = d["password"];
    size_t sn = strlen(ssid), pn = strlen(password);
    if (!sn || sn > 32 || (pn && pn < 8) || pn > 63) {
      errorReply(400, "Проверьте название сети и длину пароля");
      return;
    }
    if (tryingCredentials || pendingConnect) {
      errorReply(409, "Подключение уже выполняется");
      return;
    }
    if (!apActive)
      openPortal();
    strlcpy(pendingCredentials.ssid, ssid, sizeof(pendingCredentials.ssid));
    strlcpy(pendingCredentials.password, password,
            sizeof(pendingCredentials.password));
    pendingConnect = true;
    wifiResult = "connecting";
    JsonDocument answer;
    answer["ok"] = true;
    jsonReply(202, answer);
  });
  web.onNotFound([] {
    if (web.uri().startsWith("/api/")) {
      errorReply(404, "Не найдено");
      return;
    }
    web.sendHeader("Location", String("http://") +
                                   (apActive ? WiFi.softAPIP().toString()
                                             : WiFi.localIP().toString()) +
                                   "/");
    web.send(302, "text/plain", "");
  });
  web.begin();
}

struct PsramAllocator : ArduinoJson::Allocator {
  void *allocate(size_t n) override {
    return heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  void deallocate(void *p) override { heap_caps_free(p); }
  void *reallocate(void *p, size_t n) override {
    return heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
};
struct ResponseBody {
  char *bytes = nullptr;
  size_t size = 0;
  size_t capacity = 0;
  bool overflow = false;
  char retryAfter[64]{};
  static constexpr size_t limit = 768 * 1024;
};
static esp_err_t receiveBody(esp_http_client_event_t *event) {
  auto &b = *static_cast<ResponseBody *>(event->user_data);
  if (event->event_id == HTTP_EVENT_ON_HEADER && event->header_key &&
      event->header_value && !strcasecmp(event->header_key, "Retry-After"))
    strlcpy(b.retryAfter, event->header_value, sizeof(b.retryAfter));
  if (event->event_id == HTTP_EVENT_ON_DATA) {
    if (b.size + event->data_len > ResponseBody::limit) {
      b.overflow = true;
      return ESP_FAIL;
    }
    size_t needed = b.size + event->data_len;
    if (needed > b.capacity) {
      size_t capacity = b.capacity;
      while (capacity < needed)
        capacity = std::min(ResponseBody::limit, capacity * 2);
      auto bytes = static_cast<char *>(heap_caps_realloc(
          b.bytes, capacity + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!bytes) {
        b.overflow = true;
        return ESP_FAIL;
      }
      b.bytes = bytes;
      b.capacity = capacity;
    }
    memcpy(b.bytes + b.size, event->data, event->data_len);
    b.size += event->data_len;
  }
  return ESP_OK;
}
static bool fetchJSON(const char *url, JsonDocument &document,
                      const JsonDocument &filter, ResponseBody &body,
                      int &status, uint64_t &retryAfter) {
  // Reuse the response allocation between requests instead of fragmenting PSRAM.
  body.size = 0;
  body.overflow = false;
  body.retryAfter[0] = 0;
  if (!body.bytes) {
    body.capacity = 32768;
    body.bytes = static_cast<char *>(heap_caps_malloc(
        body.capacity + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  if (!body.bytes)
    return false;
  esp_http_client_config_t config{};
  config.url = url;
  config.timeout_ms = 15000;
  config.crt_bundle_attach = esp_crt_bundle_attach;
  config.event_handler = receiveBody;
  config.user_data = &body;
  config.buffer_size = 4096;
  config.user_agent = "WIND64/1.1 (personal display)";
  config.disable_auto_redirect = true;
  auto client = esp_http_client_init(&config);
  if (!client)
    return false;
  esp_http_client_set_header(client, "Accept-Encoding", "identity");
  esp_http_client_set_header(client, "Accept", "application/json");
  esp_err_t result = esp_http_client_perform(client);
  status = esp_http_client_get_status_code(client);
  retryAfter = retryAfterMs(body.retryAfter, wallTime());
  esp_http_client_cleanup(client);
  body.bytes[body.size] = 0;
  bool ok = result == ESP_OK && status == 200 && !body.overflow &&
            !deserializeJson(document, static_cast<const char *>(body.bytes),
                             body.size, DeserializationOption::Filter(filter));
  if (!ok)
    Serial.printf("{\"weatherRequestFailed\":true,\"http\":%d,\"transport\":%d,"
                  "\"bytes\":%u}\n",
                  status, int(result), unsigned(body.size));
  return ok;
}
static void weatherTask(void *) {
  auto *incomingForecast = externalObject<Forecast>();
  auto *incomingStation = externalObject<Station>();
  PsramAllocator allocator;
  JsonDocument forecastFilter(&allocator), stationFilter(&allocator);
  weatherFilter(forecastFilter, true);
  weatherFilter(stationFilter, false);
  ResponseBody body;
  PollSchedule schedules[] = {PollSchedule(POLL_INTERVALS[0]),
                               PollSchedule(POLL_INTERVALS[1]),
                               PollSchedule(POLL_INTERVALS[2])};
  uint64_t hostNextAt = 0;
  int cursor = 0;
  if (!incomingForecast || !incomingStation) {
    Serial.println("ERROR: weather PSRAM allocation failed");
    vTaskDelete(nullptr);
    return;
  }
  for (;;) {
    Time now = wallTime();
    bool connected = WiFi.status() == WL_CONNECTED && validTime(now);
    uint64_t elapsed = monotonicMs();
    if (!connected || elapsed < hostNextAt) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    int source = -1;
    for (int offset = 0; offset < 3; offset++) {
      int i = (cursor + offset) % 3;
      if (schedules[i].due(elapsed, i == 0 ? midnight(now) : 0)) {
        source = i;
        break;
      }
    }
    if (source < 0) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    cursor = (source + 1) % 3;
    Time day = source == 0 ? midnight(now) : 0;
    char url[400];
    if (source == 0) {
      snprintf(url, sizeof(url),
               "https://api.windyapp.co/"
               "apiV9.php?method=forecastConstructor&from_ts=%lld&to_ts=%lld&"
               "lat=60.0111353&lon=29.6915455&models=gfs27_long&period=1h&"
               "userID=webForecastWidgetAPI",
               (long long)(day / 1000),
               (long long)((day + 8 * DAY) / 1000));
    } else {
      const char *id = source == 1 ? "1chipru_840d8eaa9b63" : "ULLI";
      snprintf(url, sizeof(url),
               "https://api.windyapp.co/v10/meteostations/getData/"
               "%s?predict=0&canWindNull=1&info=1", id);
    }
    int http = 0;
    uint64_t retryAfter = 0, began = monotonicMs();
    bool ok;
    {
      JsonDocument d(&allocator);
      ok = fetchJSON(url, d, source == 0 ? forecastFilter : stationFilter,
                     body, http, retryAfter);
      now = wallTime();
      if (ok)
        ok = source == 0 ? parseForecast(d, now, day, *incomingForecast)
                         : parseStation(d, now, *incomingStation);
    }
    elapsed = monotonicMs();
    auto &schedule = schedules[source];
    schedule.complete(elapsed, day, ok, http, retryAfter, esp_random());
    // All endpoints share the host: respect throttling across all three.
    hostNextAt = nextHostRequest(elapsed, http, retryAfter, schedule.nextAt);
    {
      StateLock lock;
      weatherCooldownUntil = hostNextAt;
      responseBufferBytes = body.capacity;
      auto &stats = pollStats[source];
      stats.attempts = schedule.attempts;
      stats.successes = schedule.successes;
      stats.failures = schedule.failures;
      stats.nextAt = schedule.nextAt;
      stats.http = http;
      stats.durationMs = elapsed - began;
      stats.bytes += body.size;
      if (source == 0) {
        if (ok)
          weather->forecast = *incomingForecast;
        else
          weather->forecast.error = true;
        if (ok)
          forecastRevision++;
      } else {
        if (ok)
          mergeStation(weather->stations[source - 1], *incomingStation, now);
        else
          weather->stations[source - 1].error = true;
      }
      weather->generation++;
    }
    Serial.printf("{\"weatherSource\":%d,\"updated\":%s,\"http\":%d,"
                  "\"nextInMs\":%llu}\n", source, ok ? "true" : "false", http,
                  (unsigned long long)(schedule.nextAt - elapsed));
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}
static void controlTask(void *) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("wind64");
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  if (savedCredentials.ssid[0])
    WiFi.begin(savedCredentials.ssid, savedCredentials.password);
  else
    openPortal();
  beginWeb();
  char serialCommand[64];
  size_t serialLength = 0;
  for (;;) {
    if (openPortalRequested.exchange(false))
      openPortal();
    web.handleClient();
    if (apActive)
      dns.processNextRequest();
    uint32_t now = millis();
    if (pendingConnect) {
      pendingConnect = false;
      tryingCredentials = true;
      connectBegan = now;
      WiFi.disconnect(false, false);
      WiFi.begin(pendingCredentials.ssid, pendingCredentials.password);
    }
    bool connected = WiFi.status() == WL_CONNECTED;
    if (tryingCredentials && connected &&
        WiFi.SSID() == pendingCredentials.ssid) {
      if (storage.putBytes("wifi", &pendingCredentials,
                           sizeof(pendingCredentials)) ==
          sizeof(pendingCredentials)) {
        savedCredentials = pendingCredentials;
        wifiResult = "connected";
        tryingCredentials = false;
        apCloseAt = now + 15000;
        needSetup = false;
        Serial.printf("{\"wifiConnected\":true,\"ip\":\"%s\"}\n",
                      WiFi.localIP().toString().c_str());
      } else {
        wifiResult = "failed";
        tryingCredentials = false;
      }
    } else if (tryingCredentials && now - connectBegan >= 25000) {
      tryingCredentials = false;
      wifiResult = "failed";
      WiFi.disconnect(false, false);
      if (savedCredentials.ssid[0])
        WiFi.begin(savedCredentials.ssid, savedCredentials.password);
    }
    if (connected && !wasConnected) {
      if (!ntpStarted) {
        configTime(0, 0, "time.cloudflare.com", "pool.ntp.org",
                   "time.google.com");
        ntpStarted = true;
      }
      if (!mdnsStarted) {
        mdnsStarted = MDNS.begin("wind64");
        if (mdnsStarted)
          MDNS.addService("http", "tcp", 80);
      }
    }
    if (!connected && !tryingCredentials && savedCredentials.ssid[0] &&
        now - lastReconnect >= 30000) {
      lastReconnect = now;
      WiFi.reconnect();
    }
    wasConnected = connected;
    if (apCloseAt && int32_t(now - apCloseAt) >= 0 && connected)
      closePortal();
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\r')
        continue;
      if (c == '\n') {
        serialCommand[serialLength] = 0;
        if (!strcmp(serialCommand, "status")) {
          JsonDocument d;
          statusDocument(d, false);
          // HWCDC drops data under many one-byte writes; emit one packet.
          String message;
          serializeJson(d, message);
          message += '\n';
          Serial.write(reinterpret_cast<const uint8_t *>(message.c_str()),
                       message.length());
        } else if (!strcmp(serialCommand, "setup"))
          openPortalRequested = true;
        else if (!strcmp(serialCommand, "reconnect"))
          WiFi.reconnect();
        serialLength = 0;
      } else if (serialLength + 1 < sizeof(serialCommand))
        serialCommand[serialLength++] = c;
      else
        serialLength = 0;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
void setup() {
  Serial.setTxBufferSize(4096);
  Serial.setRxBufferSize(512);
  Serial.setTxTimeoutMs(100);
  Serial.begin(115200);
  pinMode(0, INPUT_PULLUP);
  stateMutex = xSemaphoreCreateMutex();
  weather = externalObject<Weather>();
  displayWeather = externalObject<Weather>();
  frame = externalObject<Frame>();
  target = externalObject<Frame>();
  previous = externalObject<Frame>();
  if (!weather || !displayWeather || !frame || !target || !previous || !stateMutex) {
    Serial.println("ERROR: required memory unavailable");
    while (true)
      delay(1000);
  }
  storage.begin("wind64", false);
  Settings saved;
  if (storage.getBytesLength("settings") == sizeof(saved)) {
    storage.getBytes("settings", &saved, sizeof(saved));
    if (validSettings(saved))
      settings = saved;
  }
  if (storage.getBytesLength("wifi") == sizeof(savedCredentials)) {
    storage.getBytes("wifi", &savedCredentials, sizeof(savedCredentials));
    savedCredentials.ssid[32] = 0;
    savedCredentials.password[63] = 0;
  }
  uint64_t mac = ESP.getEfuseMac();
  snprintf(apName, sizeof(apName), "WIND64-%02X%02X",
           unsigned((mac >> 32) & 255), unsigned((mac >> 40) & 255));
  // A numeric code avoids indistinguishable S/5 glyphs and survives USB resets.
  String setupCode = storage.getString("setupCode", "");
  bool codeValid = setupCode.length() == 8;
  for (size_t i = 0; i < setupCode.length(); ++i)
    if (setupCode[i] < '0' || setupCode[i] > '9')
      codeValid = false;
  if (!codeValid) {
    for (size_t i = 0; i < 8; ++i)
      apPassword[i] = char('0' + esp_random() % 10);
    apPassword[8] = 0;
    storage.putString("setupCode", apPassword);
  } else {
    strlcpy(apPassword, setupCode.c_str(), sizeof(apPassword));
  }
  randomText(webToken, 24);
  HUB75_I2S_CFG::i2s_pins pins = {4, 5, 6,  7, 15, 16, 18,
                                  8, 3, 42, 9, 40, 2,  41};
  HUB75_I2S_CFG config(64, 64, 1, pins);
  config.clkphase = false;
  config.driver = HUB75_I2S_CFG::FM6126A;
  config.double_buff = true;
  config.i2sspeed = HUB75_I2S_CFG::HZ_20M;
  config.min_refresh_rate = 200;
  panel = new MatrixPanel_I2S_DMA(config);
  if (!panel->begin()) {
    Serial.println("ERROR: HUB75 initialization failed");
    while (true)
      delay(1000);
  }
  panel->setBrightness8(0);
  panel->clearScreen();
  panel->flipDMABuffer();
  panel->clearScreen();
  if (xTaskCreatePinnedToCore(controlTask, "control", 8192, nullptr, 1,
                              &controlHandle, 0) != pdPASS ||
      xTaskCreatePinnedToCore(weatherTask, "weather", 14336, nullptr, 1,
                              &weatherHandle, 0) != pdPASS) {
    Serial.println("ERROR: task allocation failed");
    while (true)
      delay(1000);
  }
  Serial.printf(
      "{\"firmware\":\"%s\",\"refreshHz\":%d,\"flash\":%u,\"psram\":%u}\n",
      VERSION, panel->calculated_refresh_rate, unsigned(ESP.getFlashChipSize()),
      unsigned(ESP.getPsramSize()));
}
void loop() {
  static uint64_t lastFrame = 0, cycleStart = 0, transitionStart = 0;
  static int oldScreen = -1;
  static Time presentationHour = -1, presentationDay = -1, graphSecond = -1;
  static uint32_t generation = UINT32_MAX;
  static uint32_t previousForecastRevision = 0;
  static bool fadeTransition = false;
  static Presentation p;
  static Graph graphs[2];
  static uint64_t totalFrameUs = 0;
  static bool lastOffline = true;
  static Status lastStatus = Status::Missing;
  static bool wasSetup = false;
  static bool pressed = false;
  static uint32_t pressedAt = 0;
  static bool longHandled = false;
  uint64_t elapsed = monotonicMs();
  if (!cycleStart)
    cycleStart = elapsed;
  bool down = digitalRead(0) == LOW;
  if (down && !pressed) {
    pressed = true;
    pressedAt = millis();
    longHandled = false;
  }
  if (down && pressed && !longHandled && millis() - pressedAt >= 5000) {
    openPortalRequested = true;
    longHandled = true;
  }
  if (!down)
    pressed = false;
  if (elapsed - lastFrame < 40) {
    delay(1);
    return;
  }
  lastFrame = elapsed;
  uint64_t began = esp_timer_get_time();
  Time now = wallTime();
  bool offline = WiFi.status() != WL_CONNECTED, setupMode = needSetup;
  int screen = int(((elapsed - cycleStart) / 10000) % 5);
  if (wasSetup && !setupMode) {
    cycleStart = elapsed;
    screen = 0;
    oldScreen = -1;
  }
  activeScreen = screen;
  int brightness;
  uint32_t revision;
  bool dataChanged = false;
  {
    StateLock lock;
    brightness = brightnessAt(settings, now);
    revision = forecastRevision;
    if (generation != weather->generation) {
      *displayWeather = *weather;
      generation = weather->generation;
      dataChanged = true;
    }
  }
  // Calendar, rendering and particle work never hold the shared weather lock.
  bool dirty = renderedFrames == 0;
  if (setupMode) {
    dirty = dirty || !wasSetup;
    if (dirty)
      setupScreen(*target, apName, apPassword, "ОТКРОЙТЕ WI-FI");
    brightness = std::max(5, std::min(8, brightness));
    transitionStart = 0;
  } else {
    Time hour = (now + HOUR - 1) / HOUR, day = midnight(now);
    Status status = forecastStatus(displayWeather->forecast, now);
    bool forecastChanged = previousForecastRevision != revision;
    if (forecastChanged || presentationHour != hour || presentationDay != day ||
        lastStatus != status || lastOffline != offline) {
      p = present(displayWeather->forecast, now, offline);
      presentationHour = hour;
      presentationDay = day;
      lastStatus = status;
      lastOffline = offline;
      dirty = true;
    }
    if (screen != oldScreen) {
      *previous = *frame;
      transitionStart = oldScreen >= 0 ? elapsed : 0;
      oldScreen = screen;
      fadeTransition = false;
      dirty = true;
    } else if (screen < 3 && forecastChanged) {
      *previous = *frame;
      transitionStart = elapsed;
      fadeTransition = true;
    }
    previousForecastRevision = revision;
    Flow *flow = nullptr;
    const Graph *graph = nullptr;
    if (screen >= 3) {
      int i = screen - 3;
      const auto &s = displayWeather->stations[i];
      if (graphSecond != now / 1000 || dataChanged || dirty) {
        graphs[i] = historyGraph(s, i, now);
        graphSecond = now / 1000;
      }
      graph = &graphs[i];
      Status state = stationStatus(s, i, now);
      flows[i].update(elapsed, s.count ? &s.rows[s.count - 1] : nullptr,
                      state == Status::Fresh || state == Status::Delayed);
      flow = &flows[i];
      dirty = true;
    }
    if (dirty)
      render(*target, screen, *displayWeather, p, now, offline, flow, graph);
  }
  wasSetup = setupMode;
  bool writeFrame = dirty || transitionStart;
  if (transitionStart && elapsed - transitionStart < 400)
    transition(*frame, *previous, *target,
               double(elapsed - transitionStart) / 400, fadeTransition);
  else if (writeFrame) {
    *frame = *target;
    transitionStart = 0;
  }
  if (activeBrightness != brightness || renderedFrames == 0) {
    activeBrightness = brightness;
    panel->setBrightness8((brightness * 255 + 50) / 100);
  }
  if (writeFrame) {
    for (int y = 0; y < 64; y++)
      for (int x = 0; x < 64; x++) {
        auto c = frame->pixels[y * 64 + x];
        panel->drawPixelRGB888(x, y, c.r, c.g, c.b);
      }
    panel->flipDMABuffer();
    renderedFrames++;
  } else
    skippedFrames++;
  uint32_t duration = uint32_t(esp_timer_get_time() - began);
  totalFrameUs += duration;
  uint32_t cycles = ++renderCycles;
  meanFrameUs = totalFrameUs / cycles;
  if (duration > 40000)
    slowFrames++;
  if (duration > maxFrameUs)
    maxFrameUs = duration;
}
