#include "core.h"
#include "polling.h"
#include "weather_parser.h"
#include <ArduinoJson.h>
#include <cassert>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
using namespace wind64;
static void pollingChecks() {
  const Time day = midnight(1794346200000LL);
  PollSchedule forecast(POLL_INTERVALS[0]);
  assert(forecast.due(0, day));
  forecast.complete(1000, day, true, 200, 0, 0);
  // Short reconnect, wall-clock corrections, and an early date rollover
  // must not trigger a burst. A long outage permits just one overdue refresh.
  assert(!forecast.due(11000, day));
  assert(!forecast.due(11000, day + DAY));
  assert(forecast.due(61000, day + DAY));
  assert(!forecast.due(3599999, day));
  assert(forecast.due(2 * HOUR, day));
  forecast.complete(2 * HOUR, day, false, 500, 0, 0);
  assert(forecast.nextAt == 2 * HOUR + MINUTE_MS);
  assert(!forecast.due(2 * HOUR + 1, day + DAY));
  for (unsigned i = 1; i < 12; i++) {
    auto previousDelay = forecast.nextAt - forecast.lastAttempt;
    forecast.complete(forecast.nextAt, day, false, 500, 0, 0);
    auto delay = forecast.nextAt - forecast.lastAttempt;
    assert(delay >= previousDelay && delay <= HOUR);
  }
  forecast.complete(forecast.nextAt, day, true, 200, 0, 0);
  assert(forecast.failures == 0 && forecast.nextAt - forecast.lastAttempt == HOUR);
  for (int http : {401, 403, 429}) {
    PollSchedule station(POLL_INTERVALS[1]);
    station.complete(1000, 0, false, http, 2 * HOUR, 10000);
    assert(station.nextAt >= 1000 + 2 * HOUR);
    assert(!station.due(station.nextAt - 1));
  }
  PollSchedule jitter(POLL_INTERVALS[1]);
  jitter.complete(1000, 0, true, 200, 0, 12345);
  assert(jitter.nextAt >= 1000 + POLL_INTERVALS[1]);
  assert(jitter.nextAt <= 1000 + POLL_INTERVALS[1] + 30000);
  assert(retryAfterMs("120", day) == 120000);
  assert(retryAfterMs(" 3600 ", day) == HOUR);
  assert(retryAfterMs("Wed, 11 Nov 2026 00:00:00 GMT", day) == 3 * HOUR);
  assert(retryAfterMs("Tue, 10 Nov 2026 00:00:00 GMT", day) == 0);
  assert(retryAfterMs("Tue, 31 Nov 2026 00:00:00 GMT", day) == 0);
  assert(retryAfterMs("9999999999999999999999999999999999999", day) == 0);
  assert(retryAfterMs("-10", day) == 0);
  assert(retryAfterMs("10garbage", day) == 0);
  assert(retryAfterMs(nullptr, day) == 0);
  assert(nextHostRequest(1000, 200, 0, HOUR) == 3000);
  assert(nextHostRequest(1000, 500, 0, HOUR) == 3000);
  assert(nextHostRequest(1000, 429, 0, HOUR) == HOUR);
  assert(nextHostRequest(1000, 503, MINUTE_MS, HOUR) == HOUR);
  uint32_t total = 0;
  for (auto interval : POLL_INTERVALS) {
    PollSchedule source(interval);
    for (uint64_t ms = 0; ms < uint64_t(DAY); ms += 1000)
      if (source.due(ms)) {
        source.complete(ms, 0, true, 200, 0, 0);
        total++;
      }
  }
  assert(total == 408);
  std::cout << "polling, backoff, reconnect deadlines, Retry-After, jitter, "
               "24h simulation (408 requests): passed\n";
}
static void parserChecks() {
  const Time now = 1794346200000LL, base = midnight(now);
  JsonDocument d;
  d["status"] = "success";
  auto response = d["response"].to<JsonObject>();
  response["timezone"] = "Europe/Moscow";
  response["available_models"].to<JsonArray>().add("gfs27_long");
  response["modelsUpdateTime"]["gfs27"] = (now - HOUR) / 1000;
  auto hours = response["forecast"].to<JsonArray>();
  for (int i = 0; i < 192; i++) {
    auto r = hours.add<JsonObject>();
    r["timestamp"] = (base + i * HOUR) / 1000;
    r["UGRD"] = 3;
    r["VGRD"] = 4;
    r["GUST"] = nullptr;
  }
  Forecast f;
  assert(parseForecast(d, now, base, f));
  auto presentation = present(f, now, false);
  assert(presentation.weekStart == base);
  assert(presentation.days.size() == 7);
  assert(presentation.best.day > base);
  // A stronger session wins even when its advantage is less than 1 m/s.
  assert(better(Session{base + DAY, 15, 5.7, 0},
                Session{base + DAY, 9, 5.2, 0}));
  assert(!better(Session{base + DAY, 9, 5.2, 0},
                 Session{base + DAY, 15, 5.7, 0}));
  JsonDocument filter, filtered;
  weatherFilter(filter, true);
  d["noise"] = "unused";
  hours[0]["temperature"] = 999;
  std::string json;
  serializeJson(d, json);
  assert(!deserializeJson(filtered, json, DeserializationOption::Filter(filter)));
  assert(filtered["noise"].isNull());
  assert(filtered["response"]["forecast"][0]["temperature"].isNull());
  assert(parseForecast(filtered, now, base, f));
  assert(f.hours[0].wind == 5);
  assert(std::isnan(f.hours[0].gust));
  hours[1]["UGRD"] = nullptr;
  assert(parseForecast(d, now, base, f));
  assert(std::isnan(f.hours[1].wind));
  hours[2]["UGRD"] = false;
  assert(parseForecast(d, now, base, f));
  assert(std::isnan(f.hours[2].wind));
  hours[3]["UGRD"] = 0;
  hours[3]["VGRD"] = 0;
  assert(parseForecast(d, now, base, f));
  assert(f.hours[3].wind == 0);
  hours[1]["timestamp"] = hours[0]["timestamp"];
  assert(!parseForecast(d, now, base, f));
  hours[1]["timestamp"] = (base + HOUR) / 1000;
  response["modelsUpdateTime"]["gfs27"] = (now - 19 * HOUR) / 1000;
  assert(!parseForecast(d, now, base, f));
  JsonDocument station;
  station["status"] = "success";
  auto rows = station["response"]["data"].to<JsonArray>();
  auto older = rows.add<JsonObject>();
  older["timestamp"] = (now - 120000) / 1000;
  older["wind_avg"] = 0;
  older["wind_direction"] = 360;
  auto latest = rows.add<JsonObject>();
  latest["timestamp"] = (now - 60000) / 1000;
  latest["wind_avg"] = nullptr;
  latest["wind_min"] = 0;
  latest["wind_max"] = 10;
  Station fresh, existing;
  assert(parseStation(station, now, fresh));
  assert(fresh.count == 2);
  assert(fresh.rows[0].wind == 0);
  assert(fresh.rows[0].direction == 0);
  assert(std::isnan(fresh.rows[1].wind));
  assert(std::isnan(fresh.rows[1].minimum));
  assert(std::isnan(fresh.rows[1].gust));
  mergeStation(existing, fresh, now);
  assert(existing.count == 2);
  assert(stationStatus(existing, 0, now) == Status::Missing);
  latest["wind_avg"] = 8;
  assert(parseStation(station, now, fresh));
  mergeStation(existing, fresh, now);
  assert(existing.count == 2 && existing.rows[1].wind == 8);
  assert(stationStatus(existing, 0, now + 29 * 60000) == Status::Stale);
  assert(stationStatus(existing, 1, now + 29 * 60000) == Status::Fresh);
  assert(stationStatus(existing, 1, now + 44 * 60000) == Status::Fresh);
  assert(stationStatus(existing, 1, now + 59 * 60000 - 1) == Status::Fresh);
  assert(stationStatus(existing, 1, now + 59 * 60000) == Status::Delayed);
  assert(stationStatus(existing, 1, now + 89 * 60000 - 1) == Status::Delayed);
  assert(stationStatus(existing, 1, now + 89 * 60000) == Status::Stale);
  weatherFilter(filter, false);
  station["response"]["info"]["name"] = "unused station metadata";
  json.clear();
  serializeJson(station, json);
  assert(!deserializeJson(filtered, json, DeserializationOption::Filter(filter)));
  assert(filtered["response"]["info"].isNull());
  assert(parseStation(filtered, now, fresh));
  assert(fresh.count == 2 && fresh.rows[1].wind == 8);
  Settings s;
  assert(brightnessAt(s, 0) == 8);
  s.day = 3;
  assert(brightnessAt(s, 0) == 3);
  Frame a, b, c;
  a.pixels.fill({255, 0, 0});
  b.pixels.fill({0, 255, 0});
  transition(c, a, b, 0);
  assert(c.pixels[0].r == 255);
  transition(c, a, b, 1);
  assert(c.pixels[0].g == 255);
  transition(c, a, b, .5, true);
  assert(c.pixels[0].r == 128 && c.pixels[0].g == 128);
  std::cout << "parser, unknown values, freshness, merge, brightness and "
               "transitions: passed\n";
}
static Sample sample(JsonVariantConst j) {
  Sample s;
  s.timestamp = j["timestamp"] | Time(0);
  s.wind = j["wind"].is<double>() ? j["wind"].as<double>() : UNKNOWN;
  s.direction =
      j["direction"].is<double>() ? j["direction"].as<double>() : UNKNOWN;
  return s;
}
int main(int argc, char **argv) {
  if (argc == 1) {
    pollingChecks();
    parserChecks();
    return 0;
  }
  if (argc != 3)
    return 2;
  JsonDocument doc;
  std::ifstream input(argv[1]);
  if (deserializeJson(doc, input))
    return 3;
  const Time now = doc["now"];
  Weather weather;
  auto &f = weather.forecast;
  f.base = doc["base"];
  f.fetchedAt = doc["fetchedAt"];
  f.modelAt = doc["modelAt"];
  f.error = doc["error"] | false;
  size_t i = 0;
  for (auto row : doc["hours"].as<JsonArray>()) {
    if (i >= 192)
      return 4;
    f.hours[i] = sample(row);
    if (std::isfinite(f.hours[i].wind))
      f.available = true;
    i++;
  }
  int st = 0;
  for (auto station : doc["stations"].as<JsonArray>()) {
    auto &s = weather.stations[st++];
    s.error = station["error"] | false;
    for (auto row : station["history"].as<JsonArray>())
      s.rows[s.count++] = sample(row);
  }
  bool offline = doc["offline"] | false;
  auto p = present(f, now, offline);
  JsonDocument out;
  out["bestHour"] = p.best.hour;
  out["bestDay"] = p.best.day;
  out["bestWind"] = std::isfinite(p.best.wind) ? p.best.wind : 0;
  out["status"] = int(p.status);
  auto days = out["days"].to<JsonArray>();
  for (int d = 0; d < 7; d++) {
    auto row = days.add<JsonObject>();
    Time day = midnight(now) + (d + 1) * DAY;
    auto sun = sunTimes(day);
    row["rise"] = sun.rise;
    row["set"] = sun.set;
    auto h = row["hours"].to<JsonArray>();
    auto allowed = ridingHours(day, now);
    for (int n = 0; n < 24; n++)
      if (allowed[n])
        h.add(n);
  }
  Frame frame;
  Flow flows[2] = {Flow(1), Flow(2)};
  if (doc["flow"].as<bool>()) {
    for (int i = 0; i < 2; ++i) {
      const auto &s = weather.stations[i];
      const auto state = stationStatus(s, i, now);
      for (uint64_t t = 0; t <= 1000; t += 40)
        flows[i].update(t, s.count ? &s.rows[s.count - 1] : nullptr,
                        state == Status::Fresh || state == Status::Delayed);
    }
  }
  for (int screen = 0; screen < 5; screen++) {
    render(frame, screen, weather, p, now, offline,
           screen >= 3 && doc["flow"].as<bool>() ? &flows[screen - 3]
                                                 : nullptr);
    if (screen >= 3) {
      Frame cached;
      auto graph = historyGraph(weather.stations[screen - 3], screen - 3, now);
      render(cached, screen, weather, p, now, offline,
             doc["flow"].as<bool>() ? &flows[screen - 3] : nullptr, &graph);
      for (size_t pixel = 0; pixel < frame.pixels.size(); pixel++) {
        const auto &a = frame.pixels[pixel], &b = cached.pixels[pixel];
        assert(a.r == b.r && a.g == b.g && a.b == b.b);
      }
    }
    if (frame.clipped) {
      std::cerr << "clipped " << frame.clipped << " screen " << screen << "\n";
      return 5;
    }
    std::ofstream file(std::string(argv[2]) + "-" + std::to_string(screen) +
                           ".rgb",
                       std::ios::binary);
    file.write(reinterpret_cast<const char *>(frame.pixels.data()),
               sizeof(frame.pixels));
  }
  for (int n = 0; n < 2; n++) {
    auto g = historyGraph(weather.stations[n], n, now);
    out["graphs"][n]["max"] = g.maximum;
    out["graphs"][n]["count"] = g.count;
  }
  Settings settings;
  settings.night = 8;
  out["brightness"] = brightnessAt(settings, now);
  serializeJson(out, std::cout);
  return 0;
}
