# USB descriptor (USBTreeView)

Device `USB\VID_5FC9&PID_0061\000363` — ChargerLab `POWER-Z KM002C`,
USB 2.1 FullSpeed, bus-powered 200mA, 1 config, 4 interfaces.

## Endpoints (connection info)

```
Pipe[0] EP 1 IN  Bulk      64B   (IF0 WinUSB IN)
Pipe[1] EP 1 OUT Bulk      64B   (IF0 WinUSB OUT)
Pipe[2] EP 5 IN  Interrupt 64B   (IF1 HID IN)
Pipe[3] EP 5 OUT Interrupt 64B   (IF1 HID OUT)
Pipe[4] EP 2 IN  Interrupt 16B   (IF2 CDC notify)
Pipe[5] EP 3 IN  Bulk      64B   (IF3 CDC data IN)
Pipe[6] EP 3 OUT Bulk      64B   (IF3 CDC data OUT)
```

## IF0 — WinUSB (WebUSB target)

Vendor `FF/FF/00`, `POWER-Z KM002C`, EP `0x81 IN / 0x01 OUT` Bulk.
Driver `WinUSB.SYS`, `GUID_DEVINTERFACE_WINUSB`.
Simple-ADC: OUT 4B `0C 00 02 00`, IN 64B.

## IF1 — HID (WebHID target)

HID 1.11, vendor `FF00/0001`, EP `0x85 IN / 0x05 OUT` Interrupt,
`InputReport 65B / OutputReport 65B` (ReportID 0 + 64B payload).
Same 4B command, padded to 64B (`hiddemo.cpp:my_hid_get_data` sends
`sizeof(tbuf)=64`).

## IF2+3 — CDC-ACM (WebSerial target)

IAD `02/02/01`, IF2 `02/02/01` + EP `0x82 IN` notify,
IF3 `0A/00/00` + EP `0x83 IN / 0x03 OUT` Bulk.
Driver `usbser.sys` -> `COM5`. Baud ignored.

## BOS

Only MS OS 2.0 platform cap (`D8DD60DF-4589...`, Win 6.3+,
`wMSOSDescSetTotalLength 0xAA`, `bMS_VendorCode 0x17`).
No WebUSB platform cap (`3408b638-...`), so no Chrome landing-page
notification — manual `requestDevice({vendorId:0x5FC9})` still works
(Chrome doc: "WebUSB can work with many devices without firmware
modifications").

## MsgHeader (4B, little-endian, from API docx + hiddemo.cpp)

```c
union {
  uint32_t object;
  struct { uint32_t type:7; uint32_t extend:1; uint32_t id:8;
           uint32_t :1;     uint32_t att:15; } ctrl;   // requests
  struct { uint32_t type:7; uint32_t extend:1; uint32_t id:8;
           uint32_t :6;     uint32_t obj:10; } data;
  struct { uint32_t att:15; uint32_t next:1;
           uint32_t chunk:6; uint32_t size:10; } header; // replies
};
enum { CMD_SYNC=1, CONNECT=2, DISCONNECT=3, RESET=4, ACCEPT=5, REJECT=6,
       FINISHED=7, JUMP_APROM=8, JUMP_DFU=9, GET_STATUS=0x0A, ERROR=0x0B,
       GET_DATA=0x0C, GET_FILE=0x0D, START_GRAPH=0x0E, STOP_GRAPH=0x0F,
       ENABLE_PD=0x10, DISABLE_PD=0x11, MEM_READ=0x44, STREAM_AUTH=0x4C,
       HEAD=64, PUT_DATA=65 };
enum { ATT_ADC=0x001, ATT_ADC_QUEUE=0x002, ATT_ADC_QUEUE_10K=0x004,
       ATT_SETTINGS=0x008, ATT_PD_PACKET=0x010, ATT_PD_STATUS=0x020,
       ATT_QC_PACKET=0x040, ATT_TICK=0x080, LOG_META=0x200 };
```

## AdcData (44B @ +8, little-endian)

```
+8  Vbus i32 uV | +12 Ibus i32 uA (signed; negative = male→female flow) | +16 Vbus_avg | +20 Ibus_avg
+24 Vbus_ori_avg | +28 Ibus_ori_avg | +32 Temp i16 (1/128 C)
+34 Vcc1 u16 0.1mV | +36 Vcc2 | +38 Vdp | +40 Vdm | +42 Vdd | +44 Rate:2
```

Linux `powerz.c` scaling: V/I `/1000` to mV/mA, CC/Dx `/10` to 0.1mV→mV,
`temp = byte1*2000 + byte0*1000/128` mC. `km003c-rs/src/adc.rs` has the
newer 44B layout incl. averaged CC2/D+/D-.

## Streaming (verified against a KM002C idle capture)

* Polling `GET_DATA/ATT_ADC` = single-shot (OUT `0C 00 02 00`; capture
  shows ids 10..51 incrementing, id 0 also works).
* Combined `GET_DATA(ADC|PdPacket)` `att=0x011` returns ADC+PD in one 68B
  poll — ideal for tiles + sniffer in a single loop.
* `START_GRAPH(rate 0..3 = 2/10/50/1000 SPS)` + `AdcQueue` 20B samples
  `(seq u16, marker u16, vbus i32 uV, ibus i32 uA, cc1/cc2/vdp/vdm u16)`
  — see `km003c-rs/src/adcqueue.rs`.
* Newer firmwares offer CDC `0x02/0x03` auto-upload framing (per the vendor
  doc bundle's ADC-data command PDF).

## Verified init sequence (KM002C capture, device addr 4, IF0 bulk)

Offline decode of a charge capture (`GET_DATA`/`PUT_DATA` pairs):

```
OUT CONNECT id=1                    -> IN ACCEPT id=1
OUT MEM_READ id=2..5 (+32B payload) -> IN MEM_READ confirm 20B + 64B AES chunk each
OUT STREAM_AUTH id=6 (+32B)         -> IN STREAM_AUTH 36B
OUT GET_DATA id=7 att=SETTINGS      -> IN PUT_DATA 188B (device info)
OUT GET_DATA id=8 att=LOG_META      -> IN PUT_DATA 8B (empty, no offline logs)
OUT STOP_GRAPH id=9                 -> IN ACCEPT id=9
OUT GET_DATA id=10..51 att=ADC      -> IN PUT_DATA 52B each (idle ~0.035V, no load)
OUT START_GRAPH id=52 rate=3        -> (1000 SPS)
OUT GET_DATA id=53.. att=ADC_QUEUE / combined att=3 -> IN large AdcQueue bursts
OUT STOP_GRAPH id=182               -> back to ADC polling
```

Notes:

* KM002C uses `STREAM_AUTH (0x4C)` like KM003C with identical keys
  (verified by decrypting capture payloads):
  MEM `Lh2yfB7n6X7d9a5Z`, auth enc `Fa0b4tA25f4R038a`,
  auth dec `FX0b4tA25f4R038a`. Addrs: `0x420/0x4420/0x3000C00/0x40010450`.
* `MEM_READ (0x44)` payloads/responses are AES-encrypted; confirmation 20B
  (`c4...`) + 64B data chunk. Do not treat bytes 2-3 as `att`.
* Idle ADC in this capture: VBUS ~0.035V (meter USB-powered, nothing in-line),
  `temp_raw=-32768 (0x8000)` = invalid, CC/D± ~0.04V.
* PD sniffer needs `ENABLE_PD` first: `10 <tid> 02 00` → ACCEPT, then
  `GET_DATA PD_PACKET = 0C <tid> 20 00` (`att=0x010`; byte order matters —
  `[0C,tid,00,20]` requests SETTINGS instead).
* Open PDM session holds the PD engine: bulk PD queries return REJECT
  until `pdm close`. `pd pdo` also drops pass-through charging while active.
  (Exit releases the engine but does NOT renegotiate — re-plug after.)
* Bulk RESET(0x04) → REJECT on KM002C; STOP_GRAPH → REJECT when idle;
  CONNECT → ACCEPT. No usable bulk reboot (observed 2026-10-09).
* Re-CONNECT with a session still open → ERROR; stale queue bytes in the
  pipe read back as garbage types. Recover: endpoint reset (clearHalt) +
  STOP_GRAPH → DISCONNECT → CONNECT, with replies checked.
* Serial console ignores `help`/`reboot` (no reply at all) — no serial
  reboot path on this fw. After a held-PDM 5V/0V flap, recovery = Exit PDM
  + re-plug (dongle yank only power-cycles; same effect + USB pain).
* Old text renderer chokes on PPS/APDO Source_Caps (`pdo:4,<binary>`,
  max 0W). Binary `pdo:N,` words + wire sniffer decode them instead.
  Blob content framing still unverified (misframed bytes decode to
  impossible PDOs like 0.2V/3.2V×0A — page hex-dumps + validates, drops
  incoherent messages). Console prints `cc disconnect` / `cc1 attach`
  presence events, seen in PDM `entry pd` mode (unknown in normal mode).
* Space `STREAM_AUTH` requests at least 1s apart. Collect all 36B of the
  response, including its encrypted echo, across transfers. Continue reading
  past zero-length packets without resending the command; a parsed level 0
  is a real refusal. MEM_READ similarly collects exactly 20B confirmation
  plus the requested ciphertext rounded to 16B.
* `STREAM_AUTH` response bytes 2-3 are a **special raw word**. KM003C:
  `4C 00 01 02` refuses; `4C 00 03 02` grants level 1. Decode result bit 0
  and level bits 1-2 directly from the raw word, without the normal control
  attribute shift. The reported KM003C/macOS HWID reply was already a grant;
  applying the KM002C shift incorrectly read it as level 0.
* KM002C omits the result flag and shifts the level field: refused =
  `4C 00 02 02`, granted = `4C 00 04 02` (raw level bits 2-3). HWID alone
  was refused; the `0x3000C00` calibration credential grants level 1.
* `clearHalt` does not cancel a hung WebUSB read on macOS. On timeout,
  close the handle and finish closing before re-attaching. Timeouts start
  when a queued USB job actually runs. Await STOP_GRAPH/DISCONNECT teardown
  before a new stream or single-shot loop begins.

## USB PD R3.2 PDO layouts (cf. `usbpd` crate `source_capabilities.rs`)

```
kind = word >> 30
00 Fixed:    V = bits10-19 ×50mV, Imax = bits0-9 ×10mA (bit23 = EPR capable)
01 Battery:  maxV = bits20-29 ×50mV, minV = bits10-19 ×50mV, Pmax = bits0-9 ×250mW
10 Variable: maxV = bits20-29 ×50mV, minV = bits10-19 ×50mV, Imax = bits0-9 ×10mA
11 APDO, supply = bits28-29:
   00 SPR PPS: maxV = bits17-24 ×100mV, minV = bits8-15 ×100mV, Imax = bits0-6 ×50mA
   01 EPR AVS: maxV = bits17-25 ×100mV, minV = bits8-15 ×100mV, PDP = bits0-7 ×1W
Msg header: type = bits0-3 (1 = Source_Cap, 2 = Request), rev = bits6-7
(0 = 1.0, 1 = 2.0, 2 = 3.x), DataObjs = bits12-14.
RDO contract: requested PDO# = bits28-30 (1-based).
```

Verified examples: 87W brick = PD2.0 `[5V/3A, 9V/3A, 15V/3A, 20V/4.35A]`,
phone requested PDO2 (9V). Google 18W = PD3.0 `[5V/3A, 9V/2A,
PPS 3.3-5.9V/3A, PPS 3.3-11V/2A]` (PD3.0 18W brick).

## Open work

* Browser AdcQueue streaming: shipped behind the live-card mode select —
  CONNECT → `MEM_READ` HWID → `STREAM_AUTH` → `START_GRAPH` →
  `GET_DATA ADC_QUEUE`; pure-JS AES-128-ECB (tables generated from GF math)
  with a runtime self-test (FIPS vector + known packet + roundtrip).
  Verified live on KM002C: auth level 1 via `0x3000C00` calibration
  credential, ~1020 eff SPS, 0 dropped; session hygiene (verified teardown,
  clearHalt, DISCONNECT-before-CONNECT) was required to get there.
  KM003C stream startup also confirmed live on macOS after fixing the raw
  authentication result decoding; its HWID credential grants level 1 directly.
* att=0x020 PdTrace layout still unknown (never captured).
