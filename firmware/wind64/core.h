#pragma once
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace wind64 {
using Time = int64_t;
constexpr Time HOUR = 3600000, DAY = 24 * HOUR;
constexpr size_t HISTORY_CAPACITY = 1024;
constexpr double UNKNOWN = __builtin_nan("");
struct RGB {
  uint8_t r = 0, g = 0, b = 0;
};
struct Sample {
  Time timestamp = 0;
  double wind = UNKNOWN, direction = UNKNOWN, gust = UNKNOWN, minimum = UNKNOWN;
};
struct Forecast {
  std::array<Sample, 192> hours{};
  Time base = 0, fetchedAt = 0, modelAt = 0;
  bool available = false, error = false;
};
struct Station {
  std::array<Sample, HISTORY_CAPACITY> rows{};
  size_t count = 0;
  Time fetchedAt = 0;
  bool error = false;
};
struct Weather {
  Forecast forecast{};
  std::array<Station, 2> stations{};
  uint32_t generation = 0;
};
enum class Status { Fresh, Offline, Missing, Stale, Clock, Delayed };
struct Settings {
  uint32_t version = 1;
  uint8_t day = 80, night = 8, mode = 0, reserved = 0;
  uint16_t nightStart = 23 * 60, nightEnd = 7 * 60;
};
struct Date {
  int year, month, day, weekday, hour, minute;
};
bool validTime(Time t);
Time midnight(Time t);
Date dateParts(Time t);
double directionFromUV(double u, double v);
double circularMean(double a, double b);
int brightnessAt(const Settings &, Time now);
Status forecastStatus(const Forecast &, Time now);
Status stationStatus(const Station &, int index, Time now);
const Sample *slot(const Forecast &, Time timestamp);
struct SolarDay {
  Time rise = 0, set = 0;
  bool alwaysUp = false, alwaysDown = false;
};
SolarDay sunTimes(Time day);
std::array<bool, 24> ridingHours(Time day, Time now);
struct Session {
  Time day = 0;
  int hour = -1;
  double wind = UNKNOWN, direction = UNKNOWN;
  bool valid() const { return hour >= 0; }
};
bool better(const Session &, const Session &);
struct Presentation {
  Status status = Status::Missing;
  Time weekStart = 0;
  std::array<Sample, 4> detail{}, bestHours{};
  std::array<Session, 7> days{};
  Session best{};
};
Presentation present(const Forecast &, Time now, bool offline);
struct GraphColumn {
  int x = 0, segment = 0;
  double sum = 0, wind = 0;
  int count = 0;
};
struct Graph {
  Time start = 0, end = 0;
  int maximum = 10, count = 0;
  std::array<GraphColumn, 53> columns{};
};
Graph historyGraph(const Station &, int index, Time now);
RGB windColor(double speed);
RGB windTextColor(double speed);
int textWidth(const char *, int scale = 1);
struct Frame {
  std::array<RGB, 4096> pixels{};
  unsigned clipped = 0;
  void clear();
  void pixel(int x, int y, RGB c);
  void rect(int x, int y, int w, int h, RGB c);
  void line(double x0, double y0, double x1, double y1, RGB c);
  void text(const char *, int x, int y, RGB c, int scale = 1,
            double verticalScale = 0);
  void center(const char *, int x, int y, int width, RGB c, int scale = 1);
  void arrow(double x, double y, double from, RGB c, int radius = 4);
};
struct Particle {
  double x, y, glow;
};
struct Flow {
  std::array<Particle, 64> points{};
  double vx = 0, vy = 0;
  std::array<double, 3> color{};
  uint64_t last = 0;
  bool started = false;
  explicit Flow(uint32_t seed = 1);
  void update(uint64_t elapsed, const Sample *, bool enabled);
  void draw(Frame &) const;
};
void render(Frame &, int screen, const Weather &, const Presentation &,
            Time now, bool offline, const Flow *flow = nullptr,
            const Graph *cachedGraph = nullptr);
void transition(Frame &out, const Frame &from, const Frame &to, double progress,
                bool fade = false);
void setupScreen(Frame &, const char *ssid, const char *password,
                 const char *message);
} // namespace wind64
