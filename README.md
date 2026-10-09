# km003c-web — POWER-Z on browser

Talk to ChargerLab POWER-Z KM002C/KM003C (`VID 0x5FC9 / PID 0x0061/0x0063`) without the
Windows-only `Mtools.exe` from the manufacturer, directly in browser using WinUSB.

Needs Chrome/Chromium/Edge, sadly firefox doesn't support WebUSB.

**[Try it here](https://jfessard.github.io/km003c-web/)**

![km003c-web live view](docs/screenshot.png)

## Layout

```
index.html            Single-file browser app: tiles, graph, contract, sniffer, debug
71-powerz.rules     Linux udev rule for 5FC9:0061/0063
docs/PROTOCOL.md      Byte maps, init sequence, R3.2 PDO layouts, quirks
docs/screenshot.png   Live view screenshot (shown above)
```

## Browser app (Chromium, single static file)

Live: https://jfessard.github.io/km003c-web/ — or open `index.html` directly (`file://`).

- **Live meters** — VBUS/IBUS/PWR tiles with current direction, up to 10×/s, or 1000SPS in proprietary mode.
- **Live graph** — V/A/W plus optional CC lines, hover values, zoom, CSV export, 1000 SPS streaming mode.
- **Active PDO contract** — show PDOs without disturbing charging (wire snoop at charger plug-in + VBUS matching).
- **Charge PDO contract** — read charger PDO table over serial (manual query, and restores the PDO)

## Not supported

- Offline logs stored on the device (no downloads yet, but the protocol has been documented).
- Firmware updates / DFU.
- Changing charger or dongle settings.
- Non-Chromium browsers (no WebUSB/Serial/HID in Firefox/Safari).

## Devices

- KM002C = `0x0061` Fully tested.
- KM003C = `0x0063` Single-shot and 1000 SPS stream startup confirmed on macOS.
  Streaming authentication
  uses the KM003C raw result/level bits; KM002C uses a different bit shift.
  All discovery filters are VID-only (`0x5FC9`). Treat the SUB
  tile (CC2/D+/D-) as suspect on KM003C (ADC offsets moved across
  firmwares) — VBUS/IBUS are the safe core.

On macOS, use Chrome/Chromium/Edge with WebUSB; no serial port grant is needed
for live meters or streaming. After a USB timeout, the app closes the handle to
cancel pending transfers. Press START to re-attach.

## Protocol regression checks

Run `node tests/stream.test.js` to check model-specific authentication, fragmented
and empty USB transfers, request spacing, timeout recovery, mode switching,
startup cancellation, session reset ordering, and stream teardown.
Run `node tests/graph.test.js` to check mixed sample densities, peak preservation,
bounded drawing work, stable graph axes, and cursor-centered zoom.
Run `node tests/data.test.js` to check PDM cleanup, fragmented serial replies,
PDO snapshot numbering, and stream timestamps across gaps and counter wrap.

## Credits

- Protocol groundwork by [okhsunrog](https://github.com/okhsunrog):
  [`km003c-rs`](https://github.com/okhsunrog/km003c-rs) (auth keys, packet framing,
  AdcQueue) and [`km003c-protocol-research`](https://github.com/okhsunrog/km003c-protocol-research)
  (full RE'd protocol reference, special functions, PD analysis...)
- [`Pekaso/KM003C-Analyzer`](https://github.com/Pekaso/KM003C-Analyzer) — PD 3.2 decode tree (control/data/extended, SPR/EPR, PPS/AVS, RDO, VDM + JSON DP/TBT3 defs)
