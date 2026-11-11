#include "core.h"
#include "assets.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <ctime>

namespace wind64 {
namespace {
constexpr double PI = 3.14159265358979323846, RAD = PI / 180;
constexpr RGB WHITE{228, 242, 245}, MUTED{115, 146, 166}, LINE{23, 39, 50},
    ACCENT{78, 223, 195}, CAUTION{255, 188, 84}, GRAY{101, 116, 134},
    INK{5, 14, 22};
const char *DAYS[] = {"ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"};
int rnd(double v) { return int(std::floor(v + 0.5)); }
uint8_t byte(double v) { return uint8_t(std::clamp(rnd(v), 0, 255)); }
bool known(double v) { return std::isfinite(v); }
bool direction(double v) { return known(v) && v >= 0 && v < 360; }
uint32_t nextCode(const char *&s) {
  uint8_t a = uint8_t(*s++);
  if (a < 128)
    return a;
  if ((a & 0xe0) == 0xc0 && *s) {
    uint8_t b = uint8_t(*s++);
    return ((a & 31) << 6) | (b & 63);
  }
  if ((a & 0xf0) == 0xe0 && s[0] && s[1]) {
    uint8_t b = uint8_t(*s++), c = uint8_t(*s++);
    return ((a & 15) << 12) | ((b & 63) << 6) | (c & 63);
  }
  return '?';
}
const uint8_t *glyph(uint32_t code) {
  for (const auto &g : GLYPHS)
    if (g.code == code)
      return g.rows;
  for (const auto &g : GLYPHS)
    if (g.code == '?')
      return g.rows;
  return GLYPHS[0].rows;
}
void number(double value, char *out, size_t length) {
  if (!known(value))
    snprintf(out, length, "--");
  else
    snprintf(out, length, "%u", unsigned(std::clamp(rnd(value), 0, 99)));
}
void hourLabel(int h, char *out) {
  if (h < 0)
    snprintf(out, 3, "--");
  else {
    int n = std::clamp(h, 0, 99);
    out[0] = char('0' + n / 10);
    out[1] = char('0' + n % 10);
    out[2] = 0;
  }
}
void shortDate(Time t, char *out) {
  if (!t) {
    snprintf(out, 6, "--");
    return;
  }
  auto d = dateParts(t);
  snprintf(out, 6, "%02d.%02d", d.day, d.month);
}
void clockLabel(Time t, char *out) {
  if (!validTime(t)) {
    snprintf(out, 6, "--:--");
    return;
  }
  auto d = dateParts(t);
  snprintf(out, 6, "%02d:%02d", d.hour, d.minute);
}
const char *statusText(Status s) {
  switch (s) {
  case Status::Clock:
    return "НЕТ ВРЕМЕНИ";
  case Status::Stale:
    return "УСТАРЕЛО";
  case Status::Offline:
    return "НЕТ СЕТИ";
  case Status::Delayed:
    return "ЗАДЕРЖКА";
  default:
    return "НЕТ ДАННЫХ";
  }
}
void header(Frame &f, const char *title, const char *right = "") {
  f.rect(0, 0, 64, 8, {});
  f.text(title, 2, 1, WHITE);
  f.text(right, 63 - textWidth(right), 1, ACCENT);
  f.line(1, 7, 62, 7, LINE);
}
void arrow(Frame &f, int x, int y, double from, int radius = 5) {
  if (direction(from))
    f.arrow(x, y, from, WHITE, radius);
}
} // namespace
bool validTime(Time t) { return t >= 1577836800000LL && t < 4102444800000LL; }
Time midnight(Time t) { return ((t + 3 * HOUR) / DAY) * DAY - 3 * HOUR; }
Date dateParts(Time t) {
  time_t s = time_t((t + 3 * HOUR) / 1000);
  tm d{};
  gmtime_r(&s, &d);
  return {d.tm_year + 1900, d.tm_mon + 1, d.tm_mday,
          d.tm_wday,        d.tm_hour,    d.tm_min};
}
double directionFromUV(double u, double v) {
  return std::fmod(540 + std::atan2(u, v) / RAD, 360);
}
double circularMean(double a, double b) {
  if (!direction(a) || !direction(b))
    return UNKNOWN;
  double x = std::sin(a * RAD) + std::sin(b * RAD),
         y = std::cos(a * RAD) + std::cos(b * RAD);
  if (std::hypot(x, y) < 1e-8)
    return UNKNOWN;
  return std::fmod(std::atan2(x, y) / RAD + 360, 360);
}
int brightnessAt(const Settings &s, Time now) {
  auto d = dateParts(now);
  int m = d.hour * 60 + d.minute;
  bool scheduled =
      s.nightStart != s.nightEnd &&
      (s.nightStart < s.nightEnd ? (m >= s.nightStart && m < s.nightEnd)
                                 : (m >= s.nightStart || m < s.nightEnd));
  bool night = !validTime(now) || s.mode == 2 || (s.mode == 0 && scheduled);
  return night ? std::min(s.day, s.night) : s.day;
}
Status forecastStatus(const Forecast &f, Time now) {
  if (!validTime(now))
    return Status::Clock;
  if (!f.available)
    return Status::Missing;
  if (!f.fetchedAt || !f.modelAt)
    return Status::Stale;
  if (f.fetchedAt > now + 300000 || f.modelAt > now + 300000)
    return Status::Clock;
  if (now - f.fetchedAt > 6 * HOUR || now - f.modelAt > 18 * HOUR)
    return Status::Stale;
  return f.error ? Status::Offline : Status::Fresh;
}
Status stationStatus(const Station &s, int index, Time now) {
  if (!validTime(now))
    return Status::Clock;
  if (!s.count)
    return Status::Missing;
  const auto &r = s.rows[s.count - 1];
  Time age = now - r.timestamp;
  if (age < -300000)
    return Status::Clock;
  if (age >= (index ? 90 : 30) * 60000LL)
    return Status::Stale;
  if (!known(r.wind))
    return Status::Missing;
  return age >= (index ? 60 : 15) * 60000LL ? Status::Delayed : Status::Fresh;
}
const Sample *slot(const Forecast &f, Time ts) {
  if (ts < f.base || (ts - f.base) % HOUR)
    return nullptr;
  Time i = (ts - f.base) / HOUR;
  if (i < 0 || i >= 192)
    return nullptr;
  return &f.hours[size_t(i)];
}

// SunCalc 2.1.4 solar equations and bounded root solve, adapted to C++.
// Copyright (c) 2026 Volodymyr Agafonkin. See ../SUNCALC-LICENSE.
namespace {
struct Sun {
  double ra, dec;
};
double deltaT(double d) {
  double y = 2000 + d / 365.2425, t = y - 2000;
  if (y < 2050)
    return 62.92 + t * (.32217 + t * .005589);
  t = (y - 1820) / 100;
  return -20 + 32 * t * t - .5628 * (2150 - y);
}
Sun sun(double d) {
  d += deltaT(d) / 86400;
  double t = d / 36525,
         L0 = RAD * (280.46646 + t * (36000.76983 + t * .0003032)),
         M = RAD * (357.52911 + t * (35999.05029 - t * .0001537)), s = sin(M),
         c = cos(M);
  double C = RAD * ((1.914602 - t * (.004817 + t * .000014)) * s +
                    (.019993 - .000101 * t) * 2 * s * c +
                    .000289 * s * (3 - 4 * s * s));
  double Om = RAD * (125.04 - 1934.136 * t),
         L = L0 + C - RAD * (.00569 + .00478 * sin(Om)),
         e = RAD * (23.439291 -
                    t * (.0130042 + t * (.00000016 - t * .000000504))) +
             RAD * .00256 * cos(Om);
  return {atan2(cos(e) * sin(L), cos(L)), asin(sin(e) * sin(L))};
}
double sidereal(double d, double lw) {
  return RAD * (280.46061837 + 360.98564736629 * d) - lw;
}
double transit(double d, double lw) {
  for (int i = 0; i < 3; i++) {
    double h = sidereal(d, lw) - sun(d).ra;
    h -= 2 * PI * floor(h / (2 * PI) + .5);
    d -= h / (2 * PI);
  }
  return d;
}
double crossing(double a, double b, double sa, double sb, double dt, double lw,
                double phi, double dec) {
  double s0 = sin(-.833 * RAD);
  bool rising = sa < sb;
  if (!((sa - s0) * (sb - s0) <= 0))
    return UNKNOWN;
  double c = (s0 - sin(phi) * sin(dec)) / (cos(phi) * cos(dec)),
         h = c <= -1  ? PI
             : c >= 1 ? 0
                      : acos(c),
         d = dt + (rising ? -h : h) / (2 * PI), dx = b - a;
  for (int i = 0; i < 100; i++) {
    auto p = sun(d);
    double H = sidereal(d, lw) - p.ra, k = cos(phi) * cos(p.dec),
           f = sin(phi) * sin(p.dec) + k * cos(H) - s0;
    if ((f < 0) == rising)
      a = d;
    else
      b = d;
    double step = f / (2 * PI * k * sin(H));
    if (d + step > a && d + step < b && std::abs(step) <= std::abs(dx) / 2) {
      dx = step;
      d += step;
      if (std::abs(step) < 1e-5)
        return d;
    } else {
      dx = (b - a) / 2;
      d = a + dx;
      if (b - a < 1e-8)
        return d;
    }
  }
  return UNKNOWN;
}
} // namespace
SolarDay sunTimes(Time day) {
  double lw = -29.6915455 * RAD, phi = 60.0111353 * RAD,
         start = double(day) / DAY - 10957.5, end = start + 1,
         lon = .0009 + lw / (2 * PI),
         dt = transit(floor(start + .5 - lon + .5) + lon, lw);
  double dec = sun(dt).dec, sn = cos(phi - dec),
         s1 = -cos(phi + sun(dt - .5).dec), s2 = -cos(phi + sun(dt + .5).dec);
  bool prev = start<dt - .5, next = end> dt + .5;
  double dt2 = prev   ? transit(dt - 1, lw)
               : next ? transit(dt + 1, lw)
                      : dt,
         dec2 = sun(dt2).dec, sn2 = cos(phi - dec2);
  double rise = crossing(dt - .5, dt, s1, sn, dt, lw, phi, dec),
         set = crossing(dt, dt + .5, sn, s2, dt, lw, phi, dec);
  if (next && !(rise >= start))
    rise = crossing(dt + .5, dt2, s2, sn2, dt2, lw, phi, dec2);
  if (prev && !(set < end))
    set = crossing(dt2, dt - .5, sn2, s1, dt2, lw, phi, dec2);
  SolarDay out;
  out.rise = rise >= start && rise < end ? Time((rise + 10957.5) * DAY) : 0;
  out.set = set >= start && set < end ? Time((set + 10957.5) * DAY) : 0;
  if (!out.rise && !out.set) {
    out.alwaysUp =
        asin(sin(phi) * sin(dec) + cos(phi) * cos(dec)) > -.833 * RAD;
    out.alwaysDown = !out.alwaysUp;
  }
  return out;
}
std::array<bool, 24> ridingHours(Time day, Time now) {
  std::array<bool, 24> allowed{};
  if (!validTime(now))
    return allowed;
  Time start = day + 9 * HOUR, end = day + 22 * HOUR;
  auto d = dateParts(day);
  if (d.month > 3 && d.month < 12) {
    auto s = sunTimes(day);
    if (s.alwaysDown)
      return allowed;
    if (!s.alwaysUp) {
      if (!s.rise || !s.set)
        return allowed;
      start = std::max(start, s.rise);
      end = std::min(end, s.set);
    }
  }
  for (int h = 9; h < 22; h++) {
    Time t = day + h * HOUR;
    allowed[h] = t >= now && t >= start && t + HOUR <= end;
  }
  return allowed;
}
bool better(const Session &a, const Session &b) {
  if (!a.valid())
    return false;
  if (!b.valid())
    return true;
  double diff = a.wind - b.wind;
  return std::abs(diff) > 1e-9   ? diff > 0
         : a.hour != b.hour ? a.hour < b.hour
                            : a.day < b.day;
}
Presentation present(const Forecast &f, Time now, bool offline) {
  Presentation p;
  p.status = forecastStatus(f, now);
  if (!validTime(now))
    return p;
  if ((p.status == Status::Fresh || p.status == Status::Offline) && offline)
    p.status = Status::Offline;
  Time nearest = ((now + HOUR - 1) / HOUR) * HOUR;
  for (int i = 0; i < 4; i++) {
    Time t = nearest + i * 2 * HOUR;
    if (auto r = slot(f, t))
      p.detail[i] = *r;
    p.detail[i].timestamp = t;
  }
  p.weekStart = midnight(now);
  bool usable = p.status == Status::Fresh || p.status == Status::Offline;
  // Seven rows include today; the best-day screen keeps its future-only week.
  for (int day = 0; day <= 7; day++) {
    Time date = p.weekStart + day * DAY;
    auto allowed = ridingHours(date, now);
    Session bestForDay;
    if (usable)
      for (int h = 9; h < 21; h++) {
        auto a = slot(f, date + h * HOUR), b = slot(f, date + (h + 1) * HOUR);
        if (!allowed[h] || !allowed[h + 1] || !a || !b || !known(a->wind) ||
            !known(b->wind))
          continue;
        Session s{date, h, (a->wind + b->wind) / 2,
                  circularMean(a->direction, b->direction)};
        if (better(s, bestForDay))
          bestForDay = s;
      }
    if (day < 7)
      p.days[day] = bestForDay;
    if (day > 0 && better(bestForDay, p.best))
      p.best = bestForDay;
  }
  if (p.best.valid()) {
    auto allowed = ridingHours(p.best.day, now);
    int first = 24, last = -1;
    for (int h = 0; h < 24; h++)
      if (allowed[h]) {
        first = std::min(first, h);
        last = h;
      }
    int begin = std::max(first, std::min(p.best.hour - 2, last - 6));
    for (int i = 0; i < 4; i++) {
      int h = begin + i * 2;
      if (h < 24 && allowed[h]) {
        Time t = p.best.day + h * HOUR;
        if (auto r = slot(f, t))
          p.bestHours[i] = *r;
        p.bestHours[i].timestamp = t;
      }
    }
  }
  return p;
}
Graph historyGraph(const Station &s, int index, Time now) {
  Graph g;
  if (!validTime(now))
    return g;
  g.start = now - 6 * HOUR;
  g.end = now;
  Time previous = 0;
  int segment = 0;
  for (size_t i = 0; i < s.count; i++) {
    const auto &r = s.rows[i];
    if (r.timestamp < g.start || r.timestamp > now)
      continue;
    if (!known(r.wind)) {
      previous = 0;
      segment++;
      continue;
    }
    if (previous && r.timestamp - previous > (index ? 45 : 15) * 60000LL)
      segment++;
    int x = std::min(52, int((r.timestamp - g.start) * 52 / (6 * HOUR)));
    GraphColumn *c = nullptr;
    if (g.count && g.columns[g.count - 1].x == x) {
      c = &g.columns[g.count - 1];
      if (c->segment != segment)
        c->segment = -1;
    } else {
      c = &g.columns[g.count++];
      c->x = x;
      c->segment = segment;
    }
    c->sum += r.wind;
    c->count++;
    c->wind = c->sum / c->count;
    previous = r.timestamp;
  }
  for (int i = 0; i < g.count; i++)
    g.maximum = std::max(g.maximum, int(ceil(g.columns[i].wind / 5)) * 5);
  return g;
}
RGB windColor(double speed) {
  if (!known(speed) || speed < 0)
    return GRAY;
  for (size_t i = 1; i < sizeof(PALETTE) / sizeof(PALETTE[0]); i++)
    if (speed < PALETTE[i][0]) {
      const auto &a = PALETTE[i - 1];
      const auto &b = PALETTE[i];
      double f = (speed - a[0]) / (b[0] - a[0]);
      return {byte((a[1] + (b[1] - a[1]) * f) * 255),
              byte((a[2] + (b[2] - a[2]) * f) * 255),
              byte((a[3] + (b[3] - a[3]) * f) * 255)};
    }
  const auto &c = PALETTE[11];
  return {byte(c[1] * 255), byte(c[2] * 255), byte(c[3] * 255)};
}
namespace {
double luminance(RGB c) {
  double v[] = {c.r / 255., c.g / 255., c.b / 255.},
         w[] = {.2126, .7152, .0722}, sum = 0;
  for (int i = 0; i < 3; i++)
    sum += (v[i] <= .04045 ? v[i] / 12.92 : pow((v[i] + .055) / 1.055, 2.4)) *
           w[i];
  return sum;
}
} // namespace
RGB windTextColor(double speed) {
  double b = luminance(windColor(speed));
  return (luminance(WHITE) + .05) / (b + .05) >
                 (b + .05) / (luminance(INK) + .05)
             ? WHITE
             : INK;
}
int textWidth(const char *s, int scale) {
  int n = 0;
  while (*s) {
    nextCode(s);
    n++;
  }
  return std::max(0, n * 4 - 1) * scale;
}
void Frame::clear() {
  pixels.fill({});
  clipped = 0;
}
void Frame::pixel(int x, int y, RGB c) {
  if (x < 0 || y < 0 || x >= 64 || y >= 64) {
    clipped++;
    return;
  }
  pixels[y * 64 + x] = c;
}
void Frame::rect(int x, int y, int w, int h, RGB c) {
  for (int yy = y; yy < y + h; yy++)
    for (int xx = x; xx < x + w; xx++)
      pixel(xx, yy, c);
}
void Frame::line(double ax, double ay, double bx, double by, RGB c) {
  int x = rnd(ax), y = rnd(ay), tx = rnd(bx), ty = rnd(by), dx = abs(tx - x),
      sx = x < tx ? 1 : -1, dy = -abs(ty - y), sy = y < ty ? 1 : -1,
      error = dx + dy;
  while (true) {
    pixel(x, y, c);
    if (x == tx && y == ty)
      break;
    int e = 2 * error;
    if (e >= dy) {
      error += dy;
      x += sx;
    }
    if (e <= dx) {
      error += dx;
      y += sy;
    }
  }
}
void Frame::text(const char *s, int x, int y, RGB c, int scale, double v) {
  if (v == 0)
    v = scale;
  while (*s) {
    const auto rows = glyph(nextCode(s));
    for (int r = 0; r < 5; r++)
      for (int col = 0; col < 3; col++)
        if (rows[r] & (4 >> col))
          rect(x + col * scale, y + rnd(r * v), scale,
               rnd((r + 1) * v) - rnd(r * v), c);
    x += 4 * scale;
  }
}
void Frame::center(const char *s, int x, int y, int width, RGB c, int scale) {
  text(s, x + int(floor((width - textWidth(s, scale)) / 2.)), y, c, scale);
}
void Frame::arrow(double x, double y, double from, RGB c, int radius) {
  if (!known(from)) {
    line(x - 2, y, x + 2, y, c);
    return;
  }
  double rad = (from + 180) * RAD, dx = sin(rad), dy = -cos(rad),
         tx = x + dx * radius, ty = y + dy * radius;
  int wing = std::max(2, rnd(radius * .7));
  line(x - dx * radius, y - dy * radius, tx, ty, c);
  line(tx, ty, tx - dx * wing - dy * wing, ty - dy * wing + dx * wing, c);
  line(tx, ty, tx - dx * wing + dy * wing, ty - dy * wing - dx * wing, c);
}
Flow::Flow(uint32_t seed) {
  auto random = [&seed]() {
    seed = seed * 1664525u + 1013904223u;
    return double(seed) / 4294967296.;
  };
  for (auto &p : points)
    p = {random() * 64, random() * 64, .6 + random() * .4};
  auto c = windColor(0);
  color = {double(c.r), double(c.g), double(c.b)};
}
void Flow::update(uint64_t elapsed, const Sample *row, bool enabled) {
  double dt = started ? std::clamp(double(elapsed - last) / 1000., 0., .1) : 0;
  last = elapsed;
  started = true;
  double w = row ? row->wind : UNKNOWN, d = row ? row->direction : UNKNOWN,
         speed = enabled && known(w) && w > 0 && direction(d)
                     ? std::min(36., w * 1.4)
                     : 0,
         ease = 1 - exp(-dt / .75);
  vx = speed ? vx + (-sin(d * RAD) * speed - vx) * ease : 0;
  vy = speed ? vy + (cos(d * RAD) * speed - vy) * ease : 0;
  auto c = windColor(w);
  double channels[] = {double(c.r), double(c.g), double(c.b)};
  for (int i = 0; i < 3; i++)
    color[i] += (channels[i] - color[i]) * ease;
  for (auto &p : points) {
    p.x = fmod(p.x + vx * dt + 64, 64);
    p.y = fmod(p.y + vy * dt + 64, 64);
  }
}
void Flow::draw(Frame &f) const {
  double speed = hypot(vx, vy), dx = speed ? vx / speed : 0,
         dy = speed ? vy / speed : 0;
  for (const auto &p : points)
    for (int tail = 0; tail < (speed > .1 ? 5 : 1); tail++) {
      double x = fmod(p.x - dx * tail + 64, 64),
             y = fmod(p.y - dy * tail + 64, 64);
      int ix = int(floor(x)), iy = int(floor(y));
      double fx = x - ix, fy = y - iy,
             weights[] = {(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy,
                          fx * fy};
      for (int i = 0; i < 4; i++) {
        int px = (ix + i % 2) % 64, py = (iy + i / 2) % 64;
        const auto old = f.pixels[py * 64 + px];
        double k = weights[i] * p.glow * (5 - tail) / 5 * .3;
        f.pixel(px, py,
                {byte(old.r + color[0] * k), byte(old.g + color[1] * k),
                 byte(old.b + color[2] * k)});
      }
    }
}
namespace {
void columns(Frame &f, const std::array<Sample, 4> &rows, bool compact,
             bool full) {
  for (int i = 0; i < 4; i++) {
    int x = 2 + i * 15;
    char h[3], n[5];
    hourLabel(rows[i].timestamp ? dateParts(rows[i].timestamp).hour : -1, h);
    number(rows[i].wind, n, sizeof(n));
    f.text(h, x + 3, 11, WHITE, 1, 1.4);
    arrow(f, x + 6, 26, rows[i].direction, 6);
    f.rect(x, 35, 14, full ? (compact ? 21 : 27) : (compact ? 15 : 20),
           windColor(rows[i].wind));
    f.text(n, x + int(floor((14 - textWidth(n, 2)) / 2.)), full ? 41 : 37,
           windTextColor(rows[i].wind), 2, compact ? 2 : 3);
  }
}
void drawGraph(Frame &f, const Graph &g, bool warning) {
  int top = warning ? 39 : 33, bottom = 55;
  f.rect(0, top - 2, 64, 66 - top, {});
  f.line(10, top, 62, top, LINE);
  f.line(10, bottom, 62, bottom, LINE);
  char n[5];
  snprintf(n, sizeof(n), "%d", g.maximum);
  f.text(n, 0, top, MUTED);
  f.text("0", 4, 51, MUTED);
  for (int i = 0; i < g.count; i++) {
    const auto &c = g.columns[i];
    int y = bottom - rnd(c.wind / g.maximum * (bottom - top));
    if (i && c.segment >= 0 && g.columns[i - 1].segment == c.segment) {
      const auto &p = g.columns[i - 1];
      f.line(10 + p.x, bottom - rnd(p.wind / g.maximum * (bottom - top)),
             10 + c.x, y, windColor(c.wind));
    }
    f.pixel(10 + c.x, y, windColor(c.wind));
  }
  if (g.start) {
    int xs[7], labels[7], count = 0;
    Time times[7];
    for (Time t = ((g.start + HOUR - 1) / HOUR) * HOUR; t <= g.end && count < 7;
         t += HOUR) {
      xs[count] = 10 + rnd(double(t - g.start) / (g.end - g.start) * 52);
      labels[count] = std::min(57, xs[count] - 3);
      times[count++] = t;
    }
    for (int i = count - 2; i >= 0; i--)
      labels[i] = std::min(labels[i], labels[i + 1] - 8);
    for (int i = 0; i < count; i++) {
      char h[3];
      hourLabel(dateParts(times[i]).hour, h);
      f.pixel(xs[i], 56, MUTED);
      f.text(h, labels[i], 59, MUTED);
    }
  }
}
} // namespace
void render(Frame &f, int screen, const Weather &w, const Presentation &p,
            Time now, bool offline, const Flow *flow, const Graph *cachedGraph) {
  f.clear();
  if (screen >= 3) {
    int index = screen - 3;
    const auto &s = w.stations[index];
    Status status = stationStatus(s, index, now);
    if (flow)
      flow->draw(f);
    const Sample *last = s.count ? &s.rows[s.count - 1] : nullptr;
    char t[6];
    clockLabel(last ? last->timestamp : 0, t);
    header(f, index ? "PULKOVO" : "KITEPITER", t);
    bool fresh = status == Status::Fresh || status == Status::Delayed;
    const char *warning = s.error || offline          ? "НЕТ СЕТИ"
                          : status == Status::Delayed ? "ЗАДЕРЖКА"
                                                      : nullptr;
    if (fresh) {
      char n[12];
      snprintf(n, sizeof(n), "%.1f", last->wind);
      int scale = strlen(n) > 4 ? 2 : 3;
      f.text(n, int(floor((46 - textWidth(n, scale)) / 2.)), 13,
             windColor(last->wind), scale, 3);
      if (last->wind > 0)
        arrow(f, 55, 21, last->direction, 6);
    } else
      f.center(statusText(status), 0, 19, 64, CAUTION);
    if (warning)
      f.center(warning, 0, 30, 64, CAUTION);
    drawGraph(f, cachedGraph ? *cachedGraph : historyGraph(s, index, now), warning);
    return;
  }
  if (p.status == Status::Clock) {
    header(f, "КРОН");
    f.center("НЕТ ВРЕМЕНИ", 0, 25, 64, CAUTION);
    return;
  }
  bool compact = p.status != Status::Fresh;
  int caption = compact ? 52 : 58;
  char d[6];
  if (screen == 0) {
    shortDate(p.detail[0].timestamp, d);
    header(f, "КРОН", d);
    columns(f, p.detail, compact, true);
  } else if (screen == 1) {
    header(f, "КРОН", "НЕДЕЛЯ");
    for (int i = 0; i < 7; i++) {
      Time day = p.weekStart + i * DAY;
      int y = 9 + i * (compact ? 7 : 8);
      f.text(DAYS[dateParts(day).weekday], 1, y, i ? MUTED : WHITE);
      arrow(f, 12, y + 2, p.days[i].direction, 2);
      for (int h = 0; h < 24; h++) {
        auto r = slot(w.forecast, day + h * HOUR);
        bool ok = r && known(r->wind);
        f.rect(16 + h * 2, y, 2, compact ? 5 : 6,
               ok ? windColor(r->wind) : LINE);
        if (!ok)
          f.pixel(16 + h * 2, y + 2, GRAY);
      }
    }
  } else if (screen == 2) {
    if (!p.best.valid()) {
      header(f, "ЛУЧШИЙ ДЕНЬ");
      f.center(p.status == Status::Stale ? "УСТАРЕЛО" : "НЕТ ПОЛНОЙ", 0, 25, 64,
               CAUTION);
      f.center(p.status == Status::Stale ? "ПРОГНОЗ" : "ПАРЫ ЧАСОВ", 0, 37, 64,
               MUTED);
    } else {
      shortDate(p.best.day, d);
      header(f, DAYS[dateParts(p.best.day).weekday], d);
      columns(f, p.bestHours, compact, false);
      char label[40];
      snprintf(label, sizeof(label), "СЕССИЯ %02d-%02d", p.best.hour,
               p.best.hour + 2);
      f.text(label, 2, caption, ACCENT);
      arrow(f, 58, caption + 2, p.best.direction, 2);
    }
  }
  if (compact)
    f.center(statusText(p.status), 0, 59, 64, CAUTION);
}
void transition(Frame &out, const Frame &from, const Frame &to, double p,
                bool fade) {
  if (p <= 0) {
    out = from;
    return;
  }
  if (p >= 1) {
    out = to;
    return;
  }
  p = p * p * (3 - 2 * p);
  if (fade) {
    for (size_t i = 0; i < out.pixels.size(); ++i) {
      auto a = from.pixels[i], b = to.pixels[i];
      out.pixels[i] = {byte(a.r * (1 - p) + b.r * p),
                       byte(a.g * (1 - p) + b.g * p),
                       byte(a.b * (1 - p) + b.b * p)};
    }
    out.clipped = 0;
    return;
  }
  int offset = rnd(64 * p);
  out.clipped = 0;
  for (int y = 0; y < 64; y++)
    for (int x = 0; x < 64; x++) {
      int sx = x + offset;
      out.pixels[y * 64 + x] =
          sx < 64 ? from.pixels[y * 64 + sx] : to.pixels[y * 64 + sx - 64];
    }
}
void setupScreen(Frame &f, const char *ssid, const char *password,
                 const char *message) {
  f.clear();
  header(f, "WIND64", "WI-FI");
  f.center(ssid, 0, 12, 64, WHITE);
  f.center("ПАРОЛЬ", 0, 23, 64, MUTED);
  f.center(password, 0, 31, 64, ACCENT);
  f.center("192.168.4.1", 0, 44, 64, WHITE);
  f.center(message, 0, 58, 64, CAUTION);
}
} // namespace wind64
