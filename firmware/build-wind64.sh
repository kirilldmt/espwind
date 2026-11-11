#!/bin/sh
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$TASK_ROOT"
. "$TASK_ROOT/firmware/scripts/toolchain.sh"
node firmware/scripts/generate-assets.mjs
python3 firmware/scripts/generate-web.py
"$ARDUINO_CLI" --config-file "$WIND64_CONFIG" compile \
  --fqbn 'esp32:esp32:esp32s3:FlashMode=opi,FlashSize=32M,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=app5M_little24M_32MB' \
  --build-property "compiler.c.extra_flags=-ffile-prefix-map=$TASK_ROOT=." \
  --build-property "compiler.cpp.extra_flags=-DNO_GFX -ffile-prefix-map=$TASK_ROOT=." \
  --build-path firmware/build/wind64 --warnings all firmware/wind64
