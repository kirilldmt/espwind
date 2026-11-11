#include "polling.h"
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <limits>

namespace wind64 {
uint64_t nextHostRequest(uint64_t elapsed, int http, uint64_t retryAfter,
                         uint64_t sourceNextAt) {
  uint64_t deadline = elapsed + 2000;
  return http == 429 || (http == 503 && retryAfter)
             ? std::max(deadline, sourceNextAt) : deadline;
}
bool PollSchedule::due(uint64_t elapsed, Time day) const {
  return !attempts || elapsed >= nextAt ||
         (day && day != attemptedDay && !failures &&
          elapsed - lastAttempt >= MINUTE_MS);
}
void PollSchedule::complete(uint64_t elapsed, Time day, bool success, int http,
                            uint64_t retryAfter, uint32_t random) {
  attempts++;
  lastAttempt = elapsed;
  attemptedDay = day;
  uint64_t delay = interval;
  if (success) {
    successes++;
    failures = 0;
  } else {
    failures = std::min(failures + 1, uint32_t(16));
    delay = std::min(MINUTE_MS << (failures - 1),
                     std::max(interval, uint64_t(HOUR)));
    if (http == 429 || http == 401 || http == 403)
      delay = std::max(delay, uint64_t(HOUR));
  }
  delay = std::max(delay, retryAfter);
  // Positive jitter only: never retry earlier than requested by the server.
  delay += random % (std::min(delay / 10, uint64_t(30000)) + 1);
  nextAt = elapsed + delay;
}
uint64_t retryAfterMs(const char *value, Time now) {
  if (!value)
    return 0;
  while (std::isspace(static_cast<unsigned char>(*value)))
    value++;
  if (*value >= '0' && *value <= '9') {
    uint64_t seconds = 0;
    while (*value >= '0' && *value <= '9') {
      unsigned digit = *value++ - '0';
      // Leave enough headroom for addition to monotonic time and jitter.
      if (seconds > (std::numeric_limits<uint64_t>::max() / 2000 - digit) / 10)
        return 0;
      seconds = seconds * 10 + digit;
    }
    while (std::isspace(static_cast<unsigned char>(*value)))
      value++;
    return *value ? 0 : seconds * 1000;
  }
  char weekday[4]{}, month[4]{}, zone[4]{};
  int d, y, h, m, s, used = 0;
  if (std::sscanf(value, "%3[A-Za-z], %d %3s %d %d:%d:%d %3s%n", weekday, &d,
                  month, &y, &h, &m, &s, zone, &used) != 8 ||
      std::strcmp(zone, "GMT") || !validTime(now) || y < 2020 || y > 2099)
    return 0;
  const char *tail = value + used;
  while (std::isspace(static_cast<unsigned char>(*tail)))
    tail++;
  if (*tail)
    return 0;
  const char *months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  int mo = 0;
  while (mo < 12 && std::strcmp(month, months[mo]))
    mo++;
  if (mo == 12 || d < 1 || h < 0 || h > 23 || m < 0 || m > 59 || s < 0 ||
      s > 59)
    return 0;
  const int lengths[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
  if (d > lengths[mo] + (mo == 1 && leap))
    return 0;
  int days = 0;
  for (int year = 1970; year < y; year++)
    days += 365 + (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
  for (int monthIndex = 0; monthIndex < mo; monthIndex++)
    days += lengths[monthIndex] + (monthIndex == 1 && leap);
  Time deadline = (Time(days + d - 1) * 86400 + h * 3600 + m * 60 + s) * 1000;
  return deadline > now ? uint64_t(deadline - now) : 0;
}
} // namespace wind64
