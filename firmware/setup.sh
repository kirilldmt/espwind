#!/bin/sh
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$TASK_ROOT/firmware/scripts/toolchain.sh"
"$ARDUINO_CLI" --config-file "$WIND64_CONFIG" core update-index
"$ARDUINO_CLI" --config-file "$WIND64_CONFIG" core install esp32:esp32@3.3.7
"$ARDUINO_CLI" --config-file "$WIND64_CONFIG" lib install \
  'ESP32 HUB75 LED MATRIX PANEL DMA Display@3.1.0' 'ArduinoJson@7.4.3'
