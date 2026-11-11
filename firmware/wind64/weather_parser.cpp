#include "weather_parser.h"
#include <algorithm>
#include <cstring>
namespace wind64 {
namespace {
double number(JsonVariantConst v) {
  return v.is<double>() ? v.as<double>() : UNKNOWN;
}
double speed(JsonVariantConst v) {
  double n = number(v);
  return std::isfinite(n) && n >= 0 && n <= 100 ? n : UNKNOWN;
}
} // namespace
void weatherFilter(JsonDocument &filter, bool forecast) {
  filter.clear();
  filter["status"] = true;
  auto response = filter["response"].to<JsonObject>();
  if (forecast) {
    response["timezone"] = true;
    response["available_models"] = true;
    response["modelsUpdateTime"]["gfs27"] = true;
  }
  auto row = response[forecast ? "forecast" : "data"].to<JsonArray>()
                 .add<JsonObject>();
  row["timestamp"] = true;
  if (forecast) {
    row["UGRD"] = row["VGRD"] = row["GUST"] = true;
  } else {
    row["wind_avg"] = row["wind_direction"] = true;
    row["wind_min"] = row["wind_max"] = true;
  }
}
bool parseForecast(JsonVariantConst payload, Time now, Time base,
                   Forecast &out) {
  auto r = payload["response"];
  if (strcmp(payload["status"] | "", "success") ||
      strcmp(r["timezone"] | "", "Europe/Moscow") ||
      !r["forecast"].is<JsonArrayConst>())
    return false;
  bool model = false;
  for (auto m : r["available_models"].as<JsonArrayConst>()) {
    const char *name = m | "";
    if (!strcmp(name, "gfs27") || !strcmp(name, "gfs27_long"))
      model = true;
  }
  double mt = number(r["modelsUpdateTime"]["gfs27"]);
  if (!model || !std::isfinite(mt) || now / 1000. - mt > 18 * 3600 ||
      mt > now / 1000. + 300)
    return false;
  auto rows = r["forecast"].as<JsonArrayConst>();
  if (rows.size() > 512)
    return false;
  Time seen[512];
  size_t count = 0;
  // Reset in place: a temporary Forecast would consume most of the task stack.
  out.available = false;
  out.error = false;
  out.fetchedAt = out.modelAt = 0;
  for (auto &hour : out.hours)
    hour = Sample{};
  out.base = base;
  for (size_t i = 0; i < 192; i++)
    out.hours[i].timestamp = base + Time(i) * HOUR;
  for (auto row : rows) {
    double ts = number(row["timestamp"]);
    if (!std::isfinite(ts))
      continue;
    if (ts < 1577836800. || ts >= 4102444800. || std::fmod(ts, 3600.))
      return false;
    Time t = Time(ts * 1000);
    for (size_t i = 0; i < count; i++)
      if (seen[i] == t)
        return false;
    seen[count++] = t;
    double u = number(row["UGRD"]), v = number(row["VGRD"]),
           w = std::hypot(u, v);
    if (t < base || t >= base + 8 * DAY)
      continue;
    auto &s = out.hours[(t - base) / HOUR];
    s.wind = std::isfinite(w) && w <= 100 ? w : UNKNOWN;
    s.direction = std::isfinite(s.wind) ? directionFromUV(u, v) : UNKNOWN;
    s.gust = speed(row["GUST"]);
    if (std::isfinite(s.wind))
      out.available = true;
  }
  out.fetchedAt = now;
  out.modelAt = Time(mt * 1000);
  return out.available;
}
bool parseStation(JsonVariantConst payload, Time now, Station &fresh) {
  if (strcmp(payload["status"] | "", "success") ||
      !payload["response"]["data"].is<JsonArrayConst>())
    return false;
  auto rows = payload["response"]["data"].as<JsonArrayConst>();
  if (rows.size() > 4096)
    return false;
  // Only rows below count are live; never put a 40 KB temporary on the stack.
  fresh.count = 0;
  fresh.error = false;
  for (auto row : rows) {
    double ts = number(row["timestamp"]);
    if (!std::isfinite(ts) || ts < 1577836800. || ts >= 4102444800. ||
        ts * 1000 > now + 300000)
      continue;
    Sample s;
    s.timestamp = Time(ts * 1000);
    s.wind = speed(row["wind_avg"]);
    double d = number(row["wind_direction"]);
    s.direction =
        std::isfinite(d) && d >= 0 && d <= 360 ? std::fmod(d, 360.) : UNKNOWN;
    s.minimum = speed(row["wind_min"]);
    s.gust = speed(row["wind_max"]);
    if (!std::isfinite(s.wind) || s.minimum > s.wind)
      s.minimum = UNKNOWN;
    if (!std::isfinite(s.wind) || s.gust < s.wind)
      s.gust = UNKNOWN;
    bool replaced = false;
    for (size_t i = 0; i < fresh.count; i++)
      if (fresh.rows[i].timestamp == s.timestamp) {
        fresh.rows[i] = s;
        replaced = true;
        break;
      }
    if (replaced)
      continue;
    if (fresh.count < HISTORY_CAPACITY)
      fresh.rows[fresh.count++] = s;
    else {
      auto first = std::min_element(fresh.rows.begin(), fresh.rows.end(),
                                    [](const Sample &a, const Sample &b) {
                                      return a.timestamp < b.timestamp;
                                    });
      if (s.timestamp > first->timestamp)
        *first = s;
    }
  }
  std::sort(fresh.rows.begin(), fresh.rows.begin() + fresh.count,
            [](const Sample &a, const Sample &b) {
              return a.timestamp < b.timestamp;
            });
  fresh.fetchedAt = now;
  return fresh.count > 0;
}
void mergeStation(Station &previous, const Station &fresh, Time now) {
  size_t kept = 0;
  for (size_t i = 0; i < previous.count; i++)
    if (previous.rows[i].timestamp >= now - 30 * HOUR)
      previous.rows[kept++] = previous.rows[i];
  previous.count = kept;
  for (size_t j = 0; j < fresh.count; j++) {
    const auto &row = fresh.rows[j];
    if (row.timestamp < now - 30 * HOUR)
      continue;
    auto begin = previous.rows.begin(), end = begin + previous.count;
    auto pos = std::lower_bound(
        begin, end, row.timestamp,
        [](const Sample &s, Time t) { return s.timestamp < t; });
    if (pos != end && pos->timestamp == row.timestamp) {
      *pos = row;
      continue;
    }
    size_t index = pos - begin;
    if (previous.count == HISTORY_CAPACITY) {
      if (index == 0)
        continue;
      std::move(begin + 1, end, begin);
      previous.count--;
      index--;
    }
    std::move_backward(begin + index, begin + previous.count,
                       begin + previous.count + 1);
    previous.rows[index] = row;
    previous.count++;
  }
  // Keep even an old latest observation when the first response is already
  // stale.
  if (!previous.count && fresh.count) {
    previous.rows[0] = fresh.rows[fresh.count - 1];
    previous.count = 1;
  }
  previous.fetchedAt = fresh.fetchedAt;
  previous.error = false;
}
} // namespace wind64
