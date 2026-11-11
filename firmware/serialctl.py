#!/usr/bin/env python3
"""USB-диагностика: --interactive сохраняет порт открытым для нескольких команд."""
import argparse
import select
import sys
import time
import serial

parser = argparse.ArgumentParser(description="Диагностика WIND64 по USB", add_help=False)
parser._positionals.title = "Позиционные аргументы"
parser._optionals.title = "Параметры"
parser.add_argument("-h", "--help", action="help", help="Показать справку и выйти")
parser.add_argument("command", nargs="?", default="status", help="Команда: status, setup, reconnect")
parser.add_argument("--port", required=True, help="USB-порт устройства")
parser.add_argument("--seconds", type=float, default=3, help="Время чтения ответа в секундах")
parser.add_argument("--interactive", action="store_true", help="Оставить порт открытым; выход: quit")
args = parser.parse_args()
if "\n" in args.command or "\r" in args.command:
    parser.error("За один вызов передавайте одну команду")
port = serial.Serial(port=None, baudrate=115200, timeout=0.2)
port.dtr = False
port.rts = False
port.port = args.port
port.open()
try:
    port.write((args.command + "\n").encode("ascii"))
    port.flush()
    deadline = time.monotonic() + args.seconds
    while args.interactive or time.monotonic() < deadline:
        if args.interactive and select.select([sys.stdin], [], [], 0)[0]:
            command = sys.stdin.readline()
            if not command:
                break
            if command.strip() == "quit":
                break
            port.write(command.encode("ascii"))
            port.flush()
        line = port.readline()
        if line:
            print(line.decode("utf-8", errors="replace").rstrip(), flush=True)
finally:
    port.close()
