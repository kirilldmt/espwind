#pragma once
#include "core.h"

namespace wind64 {
constexpr uint64_t MINUTE_MS = 60000;
constexpr uint64_t POLL_INTERVALS[] = {60 * MINUTE_MS, 5 * MINUTE_MS,
                                     15 * MINUTE_MS};
// Deadlines use monotonic time. Losing Wi-Fi never resets them.
struct PollSchedule {
  uint64_t interval, nextAt = 0, lastAttempt = 0;
  Time attemptedDay = 0;
  uint32_t attempts = 0, successes = 0, failures = 0;
  explicit PollSchedule(uint64_t interval) : interval(interval) {}
  bool due(uint64_t elapsed, Time day = 0) const;
  void complete(uint64_t elapsed, Time day, bool success, int http,
                uint64_t retryAfter, uint32_t random);
};
// Retry-After: delta seconds or IMF-fixdate in GMT; invalid values return zero.
uint64_t retryAfterMs(const char *value, Time now);
uint64_t nextHostRequest(uint64_t elapsed, int http, uint64_t retryAfter,
                         uint64_t sourceNextAt);
} // namespace wind64
