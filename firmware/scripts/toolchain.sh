# Sourced by the build/setup scripts after TASK_ROOT has been set.
# All machine-specific paths are generated inside the ignored .tools directory.
if [ -z "${ARDUINO_CLI:-}" ]; then
  if [ -x "$TASK_ROOT/.tools/bin/arduino-cli" ]; then
    ARDUINO_CLI="$TASK_ROOT/.tools/bin/arduino-cli"
  else
    ARDUINO_CLI=arduino-cli
  fi
fi
if ! command -v "$ARDUINO_CLI" >/dev/null 2>&1; then
  echo 'Установите Arduino CLI 1.6.0 и добавьте его в PATH либо задайте ARDUINO_CLI.' >&2
  exit 1
fi
WIND64_CONFIG="$TASK_ROOT/.tools/arduino-cli.local.yaml"
mkdir -p "$TASK_ROOT/.tools"
python3 - "$TASK_ROOT" "$WIND64_CONFIG" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
config = {
    'board_manager': {'additional_urls': [
        'https://espressif.github.io/arduino-esp32/package_esp32_index.json']},
    'directories': {
        'data': str(root / '.tools/arduino-data'),
        'downloads': str(root / '.tools/arduino-downloads'),
        'user': str(root / '.tools/arduino-user'),
    },
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(config, indent=2) + '\n')
PY
