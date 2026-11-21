# Corsair VANGUARD AIR 99: live lighting notes

Written so it can be handed to the SignalRGB plugin developers. Everything here was tested on a real keyboard unless marked *unverified*.

## In short

- Same USB layout as the Vanguard 96 (`0x2B0D`): MI_02 commands, MI_03 notifications.
- The board ignores the Bragi v1 header `[0x08, cmd]`. It answers the header `[0x00, 0x01, session, cmd]` (the same layout as the Galleon 100 SD's revision 2), but only after a host session is started (command `0x1B`). Without a session every reply has `0x0F` in byte 1.
- Lighting then works like SignalRGB's other LightingController boards: software mode (property 3 = 2), handle 0 on endpoint `0x22`, data `0x12 0x00` + R, G, B per LED id. Endpoint `0x01` is refused.
- A single frame is accepted but never shown; the board only displays a continuous stream.
- A 256-LED write locked the command channel until the cable was replugged. 143 LEDs (ids 0-142) works.
- Nothing needs to be written to flash. Hardware brightness can be left as it is.

## Built on SignalRGB's work

None of this would have been found without SignalRGB's own plugins. From `Corsair_Vanguard_96.js` and `Corsair_Bragi_Device.js` (SignalRGB 2.5.86) we took the overall approach: software mode, the LightingController endpoint and its data format, the handle handling, and the idea of probing which header revision a board speaks (`DetectProtocolVersion`, added for the Galleon 100 SD). The plugin in `plugin/` follows the structure of the Vanguard 96 plugin; its protocol code is written from scratch for the session-based header.

## Tested and not tested

| | |
|---|---|
| Tested | One wired board, ISO layout, firmware property `0x13` = `08 06 57 00`, SignalRGB 2.5.86 on Windows 11 |
| Not tested | ANSI and other layouts |
| Not working | Wireless: the SLIPSTREAM v2 receiver (`0x2B1B`) never answered on its vendor channel, with or without a session, so the cable is needed |
| Not placed yet | LEDs 124 and 139-142 (listed by Corsair Web Hub; probably not keys). The plugin's debug slider lights one id at a time to find them |
| Unknown | Device image (a placeholder is used); whether a shorter frame (e.g. 109 LEDs) also works |

## Device

| | |
|---|---|
| VID / PID | `0x1B1C` / `0x2B21` (wired). Corsair Web Hub product id `11041`, internal name "VANGUARD AIR 96" (Web Hub default profile) |
| Command channel | MI_02, usage page `0xFF42`, usage `0x01`, 1025-byte input and output reports (report id 0) |
| Notifications | MI_03, usage page `0xFF42`, usage `0x02`, 65-byte input, no output |
| Other interfaces | MI_00 mouse (dial), MI_01 keyboard / consumer collections |
| Firmware tested | property `0x13` reads `08 06 57 00` |

The USB layout matches the Vanguard 96 (`0x2B0D`) that SignalRGB 2.5.86 already ships a plugin for (`Corsair_Vanguard_96.js`).

## Packet format: v1.5 header and a session are required

The Air 99 **does not answer** the Bragi v1 header that the Vanguard 96 plugin uses (`[0x00, 0x08, cmd, ...]`): no reply at all to ping or GET property.

It needs the v1.5 header that Corsair Web Hub uses for this product:

```
request:  [reportId 0] [sub-device 0] [0x01] [session id] [command] [payload...]
response:                [?] [0x0F = no session / 0x00] [session] [command echo] [status] [data...]
```

Without a session the device answers with byte 1 = `0x0F`. Start one with command `0x1B` (27): payload `01, 4 random bytes, 00`; the session id is at response byte 9. Stop with `0x1B`, payload `02, 00 00 00 00, session`.

Commands used (same ids as the existing ModernCorsairProtocol class):

| id | name | payload (after header) |
|---|---|---|
| `0x01` | set property | prop u16 LE, value u32 LE |
| `0x02` | get property | prop u16 LE → value u32 at response byte 5 |
| `0x05` | close handle | `01, handle` |
| `0x06` | write endpoint (first packet) | handle, total length u32 LE, data |
| `0x07` | write endpoint (continue) | handle, data |
| `0x09` | check / describe handle | handle |
| `0x0D` | open endpoint | handle, endpoint u16 LE |
| `0x12` | ping | - |

## Properties read on the test board

| prop | value | meaning |
|---|---|---|
| `0x03` mode | 1 | hardware (self operated); 2 = software (host controlled) |
| `0x02` brightness | 800 | 80 %, stored in flash, so we leave it alone |
| `0x41` layout | 2 | ISO |

## Endpoints

| endpoint | open result |
|---|---|
| `0x01` Lighting (planar) | refused, status 6 |
| `0x22` LightingController (interleaved RGB) | opens in both modes, describe returns 0 / 16 |

So the Air 99, like the Vanguard 96, uses the LightingController scheme: data starts with `0x12 0x00`, then 3 bytes (R, G, B) per LED index.

## LED ids (from Web Hub's default profile, *unverified on hardware*)

Key ids are USB HID usages (same code space as Web Hub key assignments). The lighting effect key list for this board is:

```
4-69, 74-100, 105-108, 110, 111, 122, 124, 130-142
```

`indicationLeds` per layout: ANSI `4-49, 51-69, 74-99, 105-108, 110, 111, 122, 124, 130-138`, ISO `4-69, 74-100, 105-108, 110, 111, 122, 124, 130-138`. 130 = Game mode key, 131-136 = side keys S1-S6, 137 = Copilot, 138 = Stream Deck key; 139-142 are probably non-key LEDs. Web Hub lists `ledCount: 108`.

## Test log

Raw output of tests 3 onwards is in `logs/`. Tests 1 and 2 ran on an earlier, throwaway version of the probe whose output was not saved; they are described here only.

1. **2026-11-21, read-only.** v1 header: no answer. v1.5 without session: `0x0F`. v1.5 with session: all gets answered; endpoint 0x01 refused, 0x22 opened and closed.
2. **2026-11-21, first colour test (failed).** Session, mode 2 accepted and read back, handle 0 opened on 0x22. Then frames of `0x12 0x00` + **256 LEDs** (770 bytes, one write packet) were sent every 30 ms. The first frame got no reply and from then on the command channel accepted no writes (interrupt OUT never completed), so hardware mode could not be restored. Unplugging and replugging the cable brought everything back to normal; nothing was lost. Most likely cause: 256 LEDs is more than the firmware's buffer (highest id is 142), *unverified*.
3. **2026-11-21, single frame, 143 LEDs.** Session, mode 2, handle 0 on 0x22, one write of `0x12 0x00` + 143 x (0, 155, 222) = 431 bytes, held 3 s, close handle, mode 1. Every step answered status 0; mode read back 1 and brightness 800 afterwards. So the 256-LED size is the likely cause of test 2. Visual result: **nothing changed**; the keyboard kept running its own hardware effect the whole time, also while in mode 2.
4. **2026-11-21, property dump.** Properties 0-511 read in mode 1 and mode 2: 83 readable in both. Only three differ: `0x03` (mode, 1 → 2), `0x40` (108 → 110) and `0x53` (4174 → 4178); the last two look like counters. No obvious "software lighting" switch. Web Hub's operating mode enum also lists 6 `LIMITED_HOST_CONTROLLER` and 7 `ESPORTS` (not tried).

5. **2026-11-21, stream test: works.** Same setup as test 3, but 20 frames of 143 LEDs, 150 ms apart (5 teal, 5 red, repeated), one reply read per frame. All answered status 0 and **the keys flashed teal and red**. Then close handle, mode 1, normal lighting back. Conclusion: the colour format is right; a single frame is not shown, the keyboard needs a continuous stream (SignalRGB sends one every render anyway). Brightness 800 was left as is, so 100 % hardware brightness is not needed.

6. **2026-11-21, plugin in SignalRGB 2.5.86: works.** `plugin/Corsair_Vanguard_Air_99.js` copied to `Documents\WhirlwindFX\Plugins`. SignalRGB only scans plugins at startup, so it needed a restart; the log then shows "Custom Plugin File Loaded" and the keyboard follows the SignalRGB canvas. The user reports it working perfectly. Still open: positions of LEDs 124 and 139-142, a real device image.

7. **2026-11-21, two programs at once (read-only).** Connection A started session 1 and opened buffer 1 on 0x22; connection B (a second handle to the same interface) started session 2. Results:
   - **Sessions coexist.** A's session 1 kept working after B started session 2 and after B stopped it.
   - **Every reply reaches every connection.** A saw B's replies and the other way round, so a client must match the command echo *and* the session byte (reply byte 2 after the report id) to find its own reply.
   - **Buffers / handles are shared by everyone, not per session.** B opened buffer 1 while A had it open and got status 0; B's close then closed it for A too. Two clients on the same buffer will silently take it from each other.
   Consequence: the plugin now uses **handle 3** for lighting. Corsair Web Hub only ever uses buffer 0 (its `Common_File_Index`), and so do other tools for files, so on handle 0 a lighting frame could be written into a file someone else just opened.
8. **2026-11-21, stream on handle 3.** Same as test 5 but on handle 3: all 20 frames status 0, mode 1 restored, and **the keys flashed teal and red**. Handle 3 works for lighting.

Comparison: SignalRGB's generic Bragi plugin drives the Galleon 100 SD (firmware 2.x, same header layout as the Air 99) with exactly mode 2 + `SetHWBrightness(1000)` + handle on 0x22 + frames every render, without a session.
