# OBSCURA — NESH AI Voice Robot Firmware

Single-file Arduino/ESP32 firmware (`obscura_nesh_fixed.ino`) for a push-to-talk voice assistant robot ("NESH"). The device records audio on a button press, uploads it to a backend over HTTPS, and plays back the backend's spoken response through a speaker while showing a face on an OLED screen.

This document describes what the code in this repository actually does — including the parts that are hardcoded, stubbed, or dead.

---

## 1. Hardware Bill of Materials

| Component | Exact part | Interface | Notes |
|---|---|---|---|
| MCU | **ESP32** (Arduino core) — variant not declared in code | — | See [§6.1 Board ambiguity](#61-board-ambiguity--important) |
| Microphone | **INMP441** — I2S MEMS digital microphone | I2S (RX), `I2S_NUM_0` | Mono, left channel only |
| Amplifier | **MAX98357A** — I2S Class-D mono amplifier + speaker driver | I2S (TX), `I2S_NUM_1` | Drives an external 4–8Ω speaker (speaker itself not specified in code) |
| Display | **SSD1306** OLED, 128×64, I2C | I2C (`Wire`), address `0x3C` | Driven via `Adafruit_SSD1306` + `Adafruit_GFX` |
| Input | Momentary push button | GPIO, digital in | Push-to-talk trigger |
| Speaker | Not specified (passive speaker driven by MAX98357A output) | Analog (amp output) | No model/impedance given in code |

### Required Arduino libraries
- `WiFi.h` (ESP32 core)
- `WiFiClientSecure.h` (ESP32 core)
- `HTTPClient.h` (ESP32 core) — **included but never used**, see [§7 Dead code](#7-dead-code)
- `Wire.h` (I2C)
- `Adafruit_GFX.h`
- `Adafruit_SSD1306.h`
- `driver/i2s.h` (ESP-IDF legacy I2S driver, bundled with ESP32 Arduino core)

---

## 2. Wiring / Pinout

All pin numbers are `#define`s at the top of the sketch (lines 82–94).

### OLED (I2C)
| Signal | GPIO |
|---|---|
| SDA | 8 |
| SCL | 9 |
| I2C address | `0x3C` |

### Push button
| Signal | GPIO |
|---|---|
| Button | 7 (configured `INPUT_PULLUP` — button should short to GND when pressed) |

### INMP441 microphone — I2S_NUM_0, RX only
| Signal | GPIO | I2S role |
|---|---|---|
| SCK | 14 | BCLK |
| WS | 15 | LRCLK |
| SD | 16 | DIN → mic data into ESP32 |

Config: 16 kHz sample rate, 16-bit samples, mono (`I2S_CHANNEL_FMT_ONLY_LEFT`), standard I2S format, DMA: 8 buffers × 256 samples.

### MAX98357A amplifier — I2S_NUM_1, TX only
| Signal | GPIO | I2S role |
|---|---|---|
| BCLK | 4 | Bit clock |
| LRC | 5 | Word select |
| DIN | 6 | Data out → amp |

Config: same 16 kHz / 16-bit mono format as the mic, `tx_desc_auto_clear = true`.

### 6.1 Board ambiguity — important
The code never declares a specific ESP32 variant, but GPIO 6, 7, 8, and 9 are used as free general-purpose pins. On the **original ESP32** (WROOM/WROVER), GPIO 6–11 are wired internally to the SPI flash/PSRAM and are **not usable** for peripherals — using them will hang or crash the board. This pin layout only works on parts where those GPIOs are free, such as the **ESP32-S3**. Whoever flashes this firmware needs to select an ESP32-S3 (or equivalent) board profile in the IDE; the sketch itself doesn't enforce or document this.

---

## 3. Firmware architecture

### 3.1 State machine (`NeshExpression`)
The firmware is not a formal state machine class — it's a single `enum` driving what face is drawn on the OLED, plus straight-line procedural control flow in `handleVoiceInteraction()`:

```
FACE_IDLE       — calm eyes + smile            (idle / ready)
FACE_LISTENING  — wide circle eyes             (recording mic input)
FACE_THINKING   — squinted eyes + thought dots (waiting on HTTP request/response)
FACE_SPEAKING   — open mouth                   (playing back audio response)
FACE_ERROR      — X eyes + frown               (mic failure or HTTP failure)
FACE_NO_WIFI    — droopy eyes + wifi-off icon  (disconnected / connecting)
```
Each expression has hand-drawn primitives in `drawFace()` (rects/circles/lines on the `Adafruit_SSD1306` canvas) — no bitmaps or sprite assets. `showStatus()` wraps `drawFace()` with a one-line status string on the bottom of the screen and mirrors the same message to `Serial`.

### 3.2 `setup()`
1. `Serial.begin(115200)`.
2. Configure `BUTTON_PIN` as `INPUT_PULLUP`.
3. If `OLED_ENABLED`: init I2C on pins 8/9, `display.begin(SSD1306_SWITCHCAPVCC, 0x3C)`. Failure is logged but **not fatal** — the sketch continues without a screen.
4. Show "Booting..." face.
5. `malloc(RECORD_BUFFER_SIZE)` for the mic recording buffer — **this is fatal**: on failure it shows `FACE_ERROR` and hangs in an infinite `while(true) delay(1000)` loop (deliberate halt, does not reboot).
6. `initMicrophoneI2S()` — installs the I2S RX driver on `I2S_NUM_0`, then immediately calls `i2s_stop()` (idle until a recording starts).
7. `connectWiFi()`.
8. Show "NESH Ready".

### 3.3 `loop()`
Polls `BUTTON_PIN` every 20 ms with simple edge detection + a 50 ms debounce delay, re-checking the pin level after the debounce. On a confirmed HIGH→LOW transition it calls `handleVoiceInteraction()` synchronously (the loop blocks for the full duration of recording + upload + playback — there's no concurrency/async handling, no way to cancel mid-interaction, and the button is not polled again until the whole cycle finishes).

### 3.4 `handleVoiceInteraction()` — the main interaction flow
1. If WiFi is down, show "Reconnecting..." and call `connectWiFi()`; abort the interaction if it still fails.
2. Show `FACE_LISTENING`, call `recordAudio()`.
3. If 0 bytes were recorded → show `FACE_ERROR` for 2s, then back to idle.
4. Show `FACE_THINKING`, call `sendAudioAndPlayResponse()`.
5. On success → `FACE_IDLE`; on failure → `FACE_ERROR` for 2s, then `FACE_IDLE`.

---

## 4. Audio pipeline

### 4.1 Recording (`recordAudio()`)
- Fixed-length recording: always records for exactly `RECORD_SECONDS` (6s) worth of samples — **there is no voice-activity detection, silence trimming, or early stop**. The button is a single press to *start*; there's no press-to-stop or release-to-stop.
- `i2s_start()` → zero the DMA buffer → read from I2S in 1024-byte chunks into the pre-allocated `audioBuffer` until either `RECORD_BUFFER_SIZE` (16000 Hz × 6s × 2 bytes = 192,000 bytes) is filled or a deadline of `RECORD_SECONDS*1000 + 500` ms elapses → `i2s_stop()`.
- No gain control or AGC; raw 16-bit PCM samples straight from the INMP441.

### 4.2 Upload format (mic → backend)
The recorded PCM is wrapped in a **44-byte canonical WAV header** (`writeWavHeader()`, PCM format 1, mono, 16-bit, 16000 Hz) built manually and sent immediately before the raw sample bytes — the WAV file is never fully assembled in RAM as one buffer; header, then buffer contents, are streamed directly onto the TLS socket.

This WAV blob is sent as one part of a hand-built **`multipart/form-data`** body:
```
--<boundary>
Content-Disposition: form-data; name="audio"; filename="mic.wav"
Content-Type: audio/wav

<44-byte WAV header><raw PCM bytes>
--<boundary>--
```
Boundary string is the hardcoded literal `----ObscuraBoundary7MA4YWxk`.

### 4.3 Playback (backend → speaker)
The **response is assumed to be headerless raw 16-bit/16kHz mono PCM**, per the code's own comment — explicitly *not* MP3 (there is no MP3 decoder in this project; the function was previously misnamed `playMp3Stream` and was renamed to `playPcmStream` to reflect reality) and, notably, also **not WAV-wrapped**, unlike what's sent to the backend. `playPcmStream()` reads the response body in 512-byte chunks straight off the `WiFiClientSecure` socket, applies volume scaling, and writes each chunk directly to `I2S_NUM_1` via `i2s_write()`. There is no buffering/jitter handling beyond the raw I2S DMA queue and a 2ms `delay()` spin when no bytes are yet available.

⚠️ **Asymmetry risk**: if the backend ever returns audio wrapped in a WAV container (as the firmware itself does for the *upload*), the leading 44 header bytes would be played as an audible glitch/click, since there is no header-detection or skip logic on the receive path.

### 4.4 Volume
`applyVolumeScale()` multiplies every 16-bit sample by `SPEAKER_VOLUME` (hardcoded `0.30f`, i.e. 30%) and clamps to `int16_t` range. This is a **compile-time constant** — there is no runtime volume control (no pot, no button combo, no server-driven volume).

### 4.5 I2S driver lifecycle quirk
The amp's I2S driver (`I2S_NUM_1`) is installed once (`ampInstalled` static flag) and never uninstalled. On the **first** playback it installs the driver; on every subsequent playback it just calls `i2s_start()` again over the same, never-torn-down driver. This works but means the driver resource is permanently held after first use — not a bug in normal operation, just worth knowing if you ever need to reclaim I2S1.

---

## 5. Network / backend integration

### 5.1 Endpoint
```
POST https://obscura-backend-production-d7de.up.railway.app/voice/ask
    ?stream=<STREAM>&subject=<SUBJECT>&medium=<MEDIUM>&student_id=<STUDENT_ID>
```
`SERVER_URL`, `STREAM`, `SUBJECT`, `MEDIUM`, `STUDENT_ID` are all hardcoded `const char*` compile-time constants (see [§6](#6-hardcoded-values)). Query parameters are concatenated with plain `String` `+`; **none of the values are URL-encoded** — safe today only because the current hardcoded values contain no special characters.

### 5.2 Transport
- Raw `WiFiClientSecure` socket on port 443 — **not** the `HTTPClient` library that's included at the top of the file (that include is unused/dead, see [§7](#7-dead-code)).
- TLS certificate validation via a single **pinned root CA** (`ROOT_CA`), hardcoded as the ISRG Root X1 (Let's Encrypt) certificate, valid per its embedded dates to 2035. This replaced an earlier `setInsecure()` call per the changelog at the top of the file. If Railway's TLS chain ever changes root CAs, this pin will need to be updated or the connection will fail closed (fails safe, but will need a firmware update).
- HTTP request line and headers are built and written manually (`Host`, `Content-Type: multipart/form-data; boundary=...`, `Content-Length`, `Connection: close`).
- **No authentication header, API key, or bearer token is sent.** Anyone who can reach the endpoint URL (or intercept/replay this exact request shape) can pose as `STUDENT_ID`. There is no device-level auth in this firmware.

### 5.3 Request body
Multipart form with a single `audio` field containing the WAV file described in [§4.2](#42-upload-format-mic--backend).

### 5.4 Response handling
- Reads the HTTP status line; anything without `"200"` in it is treated as failure — response body is drained line-by-line to `Serial` for debugging, then the function returns `false`.
- Parses response headers looking specifically for `Content-Length:`; if absent, falls back to streaming until the socket closes (`streaming = true` in `playPcmStream`).
- On success, the body (raw PCM per §4.3) is streamed directly into `playPcmStream()`.
- **No JSON or structured response is parsed anywhere.** The firmware expects the response body to be pure audio bytes, not a JSON envelope with a URL/base64 field or similar — if the backend's actual contract wraps audio in JSON, this firmware would play the JSON text as noise.
- 30-second timeout waiting for the response to start; no retry on failure (a failed interaction just shows `FACE_ERROR` for 2s and returns to idle — the user has to press the button again).

---

## 6. Hardcoded values

| Value | Location | Notes |
|---|---|---|
| `WIFI_SSID` = `"4G-MIFI-D85D"` | line 29 | Plaintext in source |
| `WIFI_PASSWORD` = `"DAN202020"` | line 30 | Plaintext in source, committed to the repo |
| `SERVER_URL` | line 32 | Points at a specific Railway deployment |
| `STUDENT_ID` = `"550e8400-e29b-41d4-a716-446655440000"` | line 33 | This is the well-known example/placeholder UUID from RFC 4122-style documentation examples — **almost certainly a placeholder that was never swapped for a real student identifier**. Every interaction from this device currently claims to be this one fixed "student." |
| `STREAM` = `"Commerce"`, `SUBJECT` = `"Economics"`, `MEDIUM` = `"english"` | lines 34–36 | Fixed at compile time; device can only ever ask about one stream/subject/medium combination — no runtime or backend-driven selection |
| `SPEAKER_VOLUME` = `0.30f` | line 39 | Compile-time only, no runtime control |
| `ROOT_CA` | lines 45–77 | Pinned Let's Encrypt ISRG Root X1 cert, single CA only (no fallback/chain of alternates) |
| Multipart boundary `----ObscuraBoundary7MA4YWxk` | line 507 | Static literal, fine for a single-part body but would collide if the payload itself ever contained that string |
| I2S/OLED/button GPIO numbers | lines 82–94 | Fixed to one physical wiring layout, see [§2](#2-wiring--pinout) |
| `RECORD_SECONDS` = 6 | line 100 | Every recording is exactly 6 seconds regardless of actual speech length |
| OLED I2C address `0x3C` | line 648 | Standard for most SSD1306 modules but not configurable |

**Credentials note**: WiFi SSID/password and the backend host are all committed in plaintext in this source file. If this repo is or becomes public, rotate the WiFi password and treat `SERVER_URL` as disclosed.

---

## 7. Dead code

- **`#include <HTTPClient.h>`** (line 18) — the library is imported but never referenced anywhere in the file. All HTTP work is done manually over `WiFiClientSecure`. Safe to remove; costs a small amount of flash/no runtime cost since nothing instantiates `HTTPClient`.

## 8. Incomplete / stubbed features

- **No MP3 or any codec support** — despite the historical function name (`playMp3Stream`, per the changelog) the pipeline only ever handles raw PCM. If the backend is ever changed to return compressed audio, this firmware will play garbage until a decoder (e.g. libhelix-mp3, as the in-code comment suggests) is added.
- **No voice-activity detection / variable-length recording** — always exactly 6 seconds, whether the user talks for 1 second or 6+.
- **No response-format negotiation** — the firmware doesn't tell the backend what audio format it wants back and doesn't inspect any header beyond `Content-Length`; format compatibility is an unenforced convention between this firmware build and the specific backend deployment.
- **No authentication/authorization** on the outbound request (see [§5.2](#52-transport)).
- **No OTA update mechanism** — firmware updates require physical USB reflashing.
- **No WiFi re-provisioning UI** (no captive portal / BLE provisioning) — changing networks requires editing source and reflashing.
- **No retry/backoff on HTTP failure** — a single failed request just ends the interaction.
- **No mid-playback interrupt** — pressing the button again during `playPcmStream()` does nothing because `loop()` is blocked synchronously inside `handleVoiceInteraction()`.
- **Board target unstated** — see [§6.1](#61-board-ambiguity--important); the pin map implicitly assumes an ESP32-S3-class part but nothing in the code declares or checks this.
- **Legacy I2S driver** — `driver/i2s.h` is the older ESP-IDF I2S API. Newer `arduino-esp32` core releases (v3.x / IDF5) have deprecated it in favor of `driver/i2s_std.h` / the `ESP32-A2DP`-style new driver. This sketch may not compile as-is against the newest board package versions without pinning an older core release.

---

## 9. What's actually working (as written)

- WiFi connect with a bounded retry loop (30 × 500ms) and status feedback on the OLED.
- TLS connection with real certificate validation (not `setInsecure()`).
- Button-triggered, fixed-duration I2S recording into a pre-allocated heap buffer, with a fatal, deliberate halt if that allocation fails at boot.
- Correctly-formed WAV header generation and multipart/form-data upload streamed directly over the TLS socket (no intermediate full-body buffer).
- Line-by-line HTTP response parsing (status + headers) with a `Content-Length`-aware, chunked read of the body.
- Raw PCM playback over I2S with software volume scaling and clipping protection.
- Distinct hand-drawn OLED faces per state, with descriptive `Serial` logging on every failure path (per the changelog's stated goals).

---

## 10. Build / flash notes

1. Arduino IDE (or arduino-cli) with the **ESP32 board package** installed — confirm which exact board variant matches your hardware (see [§6.1](#61-board-ambiguity--important)); the pin choices require GPIO 6–9 to be free, which rules out original ESP32 WROOM/WROVER modules.
2. Install libraries: `Adafruit GFX Library`, `Adafruit SSD1306` (via Library Manager). `WiFi`, `WiFiClientSecure`, `HTTPClient`, `Wire`, and `driver/i2s.h` ship with the ESP32 core.
3. Edit the **USER CONFIG** block at the top of `obscura_nesh_fixed.ino` (WiFi credentials, `SERVER_URL`, `STUDENT_ID`, `STREAM`/`SUBJECT`/`MEDIUM`, `SPEAKER_VOLUME`) before flashing.
4. Flash, then open Serial Monitor at **115200 baud** to see boot/connection/interaction logs.
5. Wire hardware per [§2](#2-wiring--pinout); press the button to trigger a 6-second recording.
