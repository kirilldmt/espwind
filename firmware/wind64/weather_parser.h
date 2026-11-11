#pragma once
#include "core.h"
#include <ArduinoJson.h>
namespace wind64 {
void weatherFilter(JsonDocument &filter, bool forecast);
bool parseForecast(JsonVariantConst payload, Time now, Time base,
                   Forecast &out);
bool parseStation(JsonVariantConst payload, Time now, Station &fresh);
void mergeStation(Station &previous, const Station &fresh, Time now);
} // namespace wind64
