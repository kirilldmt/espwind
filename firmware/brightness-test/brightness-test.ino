#include "wind64_assets.h"
#include <Arduino.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

// Waveshare ESP32-S3-RGB-Matrix. Never use the library's generic ESP32 pins.
static HUB75_I2S_CFG::i2s_pins pins = {4, 5, 6,  7, 15, 16, 18,
                                       8, 3, 42, 9, 40, 2,  41};
static MatrixPanel_I2S_DMA *panel = nullptr;
static constexpr uint8_t levels[] = {5, 12, 30, 80};
static uint8_t brightness = 5;
static bool cycling = false;
static uint32_t nextStep = 0;
static char command[64];
static size_t commandLength = 0;
static bool commandOverflow = false;

static void pixel(int x, int y, uint8_t r, uint8_t g, uint8_t b) {
  if (x >= 0 && x < 64 && y >= 0 && y < 64)
    panel->drawPixelRGB888(x, y, r, g, b);
}

static void text(const char *s, int x, int y, uint8_t r, uint8_t g, uint8_t b,
                 int scale = 1) {
  for (; *s; ++s, x += 4 * scale) {
    const uint8_t *rows = WIND64_FONT[static_cast<unsigned char>(*s) & 127];
    for (int row = 0; row < 5; ++row)
      for (int col = 0; col < 3; ++col) {
        if (!(rows[row] & (4 >> col)))
          continue;
        for (int dy = 0; dy < scale; ++dy)
          for (int dx = 0; dx < scale; ++dx)
            pixel(x + col * scale + dx, y + row * scale + dy, r, g, b);
      }
  }
}

static void fill(int x, int y, int w, int h, uint8_t r, uint8_t g, uint8_t b) {
  for (int dy = 0; dy < h; ++dy)
    for (int dx = 0; dx < w; ++dx)
      pixel(x + dx, y + dy, r, g, b);
}

static void render() {
  panel->clearScreen();
  text("WIND64", 20, 2, 78, 223, 195);
  char label[5];
  snprintf(label, sizeof(label), "%u%%", brightness);
  text(label, (64 - (strlen(label) * 4 - 1) * 3) / 2, 12, 228, 242, 245, 3);
  const char *speeds[] = {"2", "5", "6", "10", "15", "22"};
  for (int i = 0; i < 6; ++i) {
    const auto &c = WIND64_TEST_COLORS[i];
    const auto &t = WIND64_TEST_TEXT[i];
    fill(2 + i * 10, 32, 9, 10, c[0], c[1], c[2]);
    text(speeds[i], 3 + i * 10 + (i < 3 ? 2 : 0), 35, t[0], t[1], t[2]);
  }
  fill(2, 46, 13, 4, 255, 0, 0);
  fill(17, 46, 13, 4, 0, 255, 0);
  fill(32, 46, 13, 4, 0, 0, 255);
  fill(47, 46, 14, 4, 255, 255, 255);
  const uint8_t gray[] = {8, 16, 32, 64, 128, 255};
  for (int i = 0; i < 6; ++i)
    fill(2 + i * 10, 53, 9, 3, gray[i], gray[i], gray[i]);
  text(cycling ? "AUTO 20S" : "USB / BOOT", cycling ? 16 : 12, 59, 115, 146,
       166);
  panel->flipDMABuffer();
}

static void status() {
  Serial.printf(
      "{\"firmware\":\"wind64-brightness-1\",\"brightness\":%u,\"cycle\":%s,"
      "\"uptime_ms\":%lu,\"flash_bytes\":%u,\"psram_bytes\":%u,\"heap_free\":%"
      "u,\"heap_min\":%u,\"refresh_hz\":%d}\n",
      brightness, cycling ? "true" : "false", (unsigned long)millis(),
      (unsigned)ESP.getFlashChipSize(), (unsigned)ESP.getPsramSize(),
      (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
      panel->calculated_refresh_rate);
}

static void setBrightness(int value) {
  brightness = constrain(value, 0, 100);
  // One brightness control: hardware OE only, no second RGB multiplication.
  panel->setBrightness8((brightness * 255 + 50) / 100);
  render();
  status();
}

static void advance() {
  int next = 0;
  for (int i = 0; i < 4; ++i)
    if (brightness == levels[i])
      next = (i + 1) % 4;
  setBrightness(levels[next]);
}

static void handleCommand() {
  command[commandLength] = '\0';
  if (!strcmp(command, "status"))
    status();
  else if (!strcmp(command, "cycle")) {
    cycling = true;
    nextStep = millis() + 20000;
    setBrightness(5);
  } else if (!strcmp(command, "hold")) {
    cycling = false;
    render();
    status();
  } else if (!strncmp(command, "b ", 2)) {
    char *end = nullptr;
    long n = strtol(command + 2, &end, 10);
    if (end != command + 2 && *end == '\0' && n >= 0 && n <= 100) {
      cycling = false;
      setBrightness(n);
    } else
      Serial.println("ERROR: b expects an integer from 0 to 100");
  } else
    Serial.println("Commands: status | b 0..100 | cycle | hold");
}

void setup() {
  Serial.begin(115200);
  pinMode(0, INPUT_PULLUP);
  HUB75_I2S_CFG config(64, 64, 1, pins);
  config.clkphase = false;
  config.driver = HUB75_I2S_CFG::FM6126A;
  config.double_buff = true;
  config.i2sspeed = HUB75_I2S_CFG::HZ_20M;
  config.min_refresh_rate = 200;
  panel = new MatrixPanel_I2S_DMA(config);
  if (!panel->begin()) {
    Serial.println("ERROR: HUB75 DMA initialization failed");
    while (true)
      delay(1000);
  }
  panel->setBrightness8(0);
  panel->clearScreen();
  panel->flipDMABuffer();
  panel->clearScreen();
  setBrightness(5);
}

void loop() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r')
      continue;
    if (ch == '\n') {
      if (!commandOverflow && commandLength)
        handleCommand();
      commandLength = 0;
      commandOverflow = false;
    } else if (commandLength + 1 < sizeof(command))
      command[commandLength++] = ch;
    else
      commandOverflow = true;
  }
  static bool pressed = false;
  static uint32_t pressedAt = 0;
  const bool down = digitalRead(0) == LOW;
  if (down && !pressed) {
    pressed = true;
    pressedAt = millis();
  }
  if (!down && pressed) {
    if (millis() - pressedAt >= 40) {
      cycling = false;
      advance();
    }
    pressed = false;
  }
  if (cycling && static_cast<int32_t>(millis() - nextStep) >= 0) {
    nextStep = millis() + 20000;
    advance();
  }
  delay(2);
}
