#!/usr/bin/env python3
"""Создать публичный комплект прошивки без NVS и локальной диагностики."""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import zipfile

root = pathlib.Path(__file__).resolve().parents[2]
main = (root / 'firmware/wind64/main.cpp').read_text()
version = re.search(r'VERSION = "(wind64-[^"]+)"', main).group(1)
build = root / 'firmware/build/wind64'
output = root / 'firmware/build/dist'
folder = output / version
folder.mkdir(parents=True, exist_ok=True)
inputs = {
    'firmware.bin': build / 'wind64.ino.bin',
    'bootloader.bin': build / 'wind64.ino.bootloader.bin',
    'partitions.bin': build / 'wind64.ino.partitions.bin',
    'boot_app0.bin': root / '.tools/arduino-data/packages/esp32/hardware/esp32/3.3.7/tools/partitions/boot_app0.bin',
}
for name, source in inputs.items():
    if not source.is_file():
        raise SystemExit(f'Не найден {source.name}. Сначала выполните setup.sh и сборку.')
    data = source.read_bytes()
    if any(marker in data for marker in (b'/Users/', b'/home/runner/', b'/private/var/')):
        raise SystemExit(f'{name}: найден абсолютный путь сборки; проверьте -ffile-prefix-map.')
    shutil.copyfile(source, folder / name)
files = {name: {'bytes': (folder / name).stat().st_size,
                'sha256': hashlib.sha256((folder / name).read_bytes()).hexdigest()}
         for name in inputs}
commit = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'],
                        capture_output=True, text=True)
manifest = {
    'version': version,
    'sourceRepository': 'https://github.com/kirilldmt/espwind',
    'sourceCommit': commit.stdout.strip() if commit.returncode == 0 else None,
    'board': 'Waveshare ESP32-S3-RGB-Matrix',
    'panel': 'Waveshare RGB-Matrix-P3-64x64, HUB75, 1/32 scan',
    'flash': '32MB OPI', 'psram': '16MB OPI',
    'arduinoCore': '3.3.7', 'hub75Library': '3.1.0', 'arduinoJson': '7.4.3',
    'offsets': {'bootloader.bin': '0x0', 'partitions.bin': '0x8000',
                'boot_app0.bin': '0xe000', 'firmware.bin': '0x10000'},
    'files': files,
    'includesNvs': False,
}
(folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
shutil.copyfile(root / 'LICENSE', folder / 'LICENSE')
notices = (root / 'THIRD_PARTY_NOTICES.md').read_text()
notices = notices.replace('firmware/SUNCALC-LICENSE', 'LICENSES/SunCalc-BSD-2-Clause.txt')
notices = notices.replace('wind64-prototype/docs/PALETTE.md',
    'https://github.com/kirilldmt/espwind/blob/main/wind64-prototype/docs/PALETTE.md')
(folder / 'THIRD_PARTY_NOTICES.md').write_text(notices)
shutil.copytree(root / 'LICENSES', folder / 'LICENSES', dirs_exist_ok=True)
shutil.copyfile(root / 'firmware/SUNCALC-LICENSE', folder / 'LICENSES/SunCalc-BSD-2-Clause.txt')
(folder / 'ИНСТРУКЦИЯ.md').write_text(f'''# Установка {version}

API Windy.app может плохо работать без VPN на роутере. Перед установкой
проверьте его в браузере из той же Wi-Fi-сети:
https://github.com/kirilldmt/espwind/blob/main/docs/API-CHECK.md

Этот комплект предназначен для Waveshare ESP32-S3-RGB-Matrix с 32 МБ OPI Flash,
16 МБ OPI PSRAM и одной RGB-Matrix-P3-64×64. Питание — 5 В.

1. Проверьте SHA256SUMS: `shasum -a 256 -c SHA256SUMS`.
2. Установите esptool 4.8.1: `python3 -m pip install esptool==4.8.1`
   (рекомендуется отдельное виртуальное окружение Python).
3. Подключите компьютер к USB, а питание панели — к POWER.
4. Определите порт. Для первой установки запишите все четыре файла:

```sh
python3 -m esptool --chip esp32s3 --port ВАШ_ПОРТ --baud 921600 write_flash -z \\
  0x0 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 firmware.bin
```

Для обновления уже установленного WIND64 с этой разметкой достаточно:

```sh
python3 -m esptool --chip esp32s3 --port ВАШ_ПОРТ --baud 921600 write_flash -z \\
  0x10000 firmware.bin
```

При первом включении подключитесь к WIND64-XXXX. Пароль — на матрице.
Откройте http://192.168.4.1 и настройте домашний Wi-Fi 2,4 ГГц.
Затем из домашней сети откройте http://wind64.local.
Комплект не содержит NVS или чужих Wi-Fi-настроек.

Полная инструкция и исходники:
https://github.com/kirilldmt/espwind

Сторонние компоненты сохраняют свои лицензии. Набор LICENSES включён в архив.
''')
all_files = sorted(p for p in folder.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
(folder / 'SHA256SUMS').write_text(''.join(
    hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(folder).as_posix() + '\n'
    for p in all_files))
archive = output / f'{version}-firmware.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for p in sorted(folder.rglob('*')):
        if p.is_file():
            z.write(p, p.relative_to(output))
print(f'Готов комплект: {archive.relative_to(root)}')
