# signalrgb-vanguard-air-99

A community SignalRGB plugin for the **Corsair VANGUARD AIR 99** keyboard (USB `1B1C:2B21`), giving it live per-key lighting from SignalRGB effects in software mode. No iCUE needed.

It is built on what SignalRGB's own Corsair plugins already do; the Air 99 just needs a newer version of the protocol and has a couple of quirks. Everything that was found and tested, including what did not work, is written up in **[docs/air99-lighting-protocol.md](docs/air99-lighting-protocol.md)**.

Status: working on one wired ISO board with SignalRGB 2.5.86 on Windows 11. Not tested on other layouts. Wireless does not work (use the cable). A few non-key LEDs are not placed yet.

## Install

1. Copy [`plugin/Corsair_Vanguard_Air_99.js`](plugin/Corsair_Vanguard_Air_99.js) to `Documents\WhirlwindFX\Plugins\`.
2. Quit SignalRGB from its tray icon and start it again (it only looks for new plugins at startup).
3. The keyboard shows up as "Corsair Vanguard Air 99" and follows your effects.

To remove it, delete the file and restart SignalRGB. The keyboard goes back to its own stored lighting when SignalRGB lets go of it, or after a replug. The plugin never writes to the keyboard's flash: brightness, profiles and effects stored on the keyboard are left alone.

Device settings in SignalRGB:

- **Lighting Mode**: Canvas (the active effect) or Forced (one colour).
- **Debug: light one LED id**: lights only that LED id, white. Useful for mapping; -1 is off.

## Known limits

- Other apps that talk to the keyboard's command channel at the same time (for example Corsair Web Hub, or TrackDeck / SlotDeck / DeckMapper) can switch it back to hardware mode. The plugin takes it back within about 2 seconds, but the other app's own writes may fail, so close them while SignalRGB is running.
- LEDs 124 and 139-142 are listed by Corsair but not placed on the SignalRGB canvas yet.
- The device picture in SignalRGB is a placeholder.

## What is in here

| Folder | What it is |
|---|---|
| `plugin/` | The SignalRGB device plugin |
| `docs/` | Protocol notes and the test log |
| `logs/` | Raw output of the probe runs on the real keyboard |
| `tools/Air99Probe/` | Small C# (.NET 10) console tool used for those tests |
| `tools/plugin-test/` | Offline check of the plugin with a fake SignalRGB device: `node tools/plugin-test/run.mjs` |

## Thanks

To the SignalRGB team, whose open plugins (`Corsair_Vanguard_96.js` and the Corsair Bragi library) made this possible.

## License

MIT, see [LICENSE](LICENSE).
