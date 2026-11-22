// Offline check of the custom keys module (plugin/Corsair_Vanguard_Air_99_Keys.js) through the plugin, with a fake
// SignalRGB device that holds a small key setup in fake keyboard files.
// Usage: node tools/plugin-test/keys.mjs
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = path.join(here, "..", "..", "plugin", "Corsair_Vanguard_Air_99.js");

// ---------------- fake keyboard files ----------------
const le = v => [v & 0xFF, v >> 8 & 0xFF];
const files = new Map();
const profile = () => [0, 0, 1, 2, 3, 4, ...le(28004), 0, 0, 0, 0, 0, 0, ...le(28006), 0, 0, ...le(28010), ...new Array(20).fill(0)];
files.set(15, [0, 0, ...le(1), ...le(28000)]);
files.set(28000, profile());
const map = new Array(141).fill(0x3f);
map[2 + 58] = 0x06;   // F1: main (and Ctrl/Alt/Shift) remapped
map[2 + 7] = 0x3d;    // D: FN layer remapped only
map[2 + 9] = 0x3e;    // F: main remapped, Ctrl/Alt/Shift keep the built-in function
map[2 + 10] = 0x3e;   // G: same
files.set(28006, map);
const assign = (key, flags, file, options) => [key, 1, ...le(flags), ...le(file), ...le(options)];
files.set(28004, [45, 0, 0, 0, ...assign(58, 0, 31000, 0x41), ...assign(7, 1, 31001, 0x41), ...assign(9, 0, 31002, 1), ...assign(10, 0, 31003, 0x41)]);
files.set(31000, [0x6E, 0x07, 1, 0, 0, 0, 0, 0, 1, 58]);           // keys: F1
files.set(31001, [0x6E, 0x07, 3, 0, 0, 0, 0, 0, ...le(233)]);       // media: volume up
const macro = events => [0xAC, 0x30, ...le(events.length / 8), ...new Array(12).fill(0), ...events];
files.set(31002, macro([1, 4, 12, 30, 2, 4, 0, 0]));                // A down, wait 30 ms, A up (play once)
files.set(31003, macro([1, 5, 12, 250, 12, 250, 2, 5]));            // B down, wait 500 ms, B up (while held)
files.set(28010, [22, 0, ...le(2), 13, 255, 255, 255, 255, 0,      // mode 1: volume
	0, 255, 0, 255, 255, 2, 0, 0, ...le(1), ...le(31000), 2, 0, ...le(1), ...le(31001)]); // mode 2: right = F1, press = vol up

// ---------------- fake SignalRGB ----------------
let iface = 2, lastSize = 0, now = 1000;
const opens = [], notes = [], sent = [], buffers = new Map();
const realNow = Date.now;
Date.now = () => now;
globalThis.LightingMode = "Forced"; globalThis.forcedColor = "#009bde"; globalThis.debugLedId = -1; globalThis.customKeys = "Off";
globalThis.keyboard = { sendHid(vk, o) { sent.push(`${vk.toString(16)}${o.released ? "^" : "v"}`); } };
let last;
globalThis.device = {
	set_endpoint(i) { iface = i; }, clearReadBuffer() {}, pause() {}, addFeature() {}, log(m) { console.log("  log:", m); },
	color() { return [1, 2, 3]; }, getLastReadSize() { return lastSize; },
	write(p) { if(iface !== 2) throw new Error("command written while the notification channel is selected"); last = p.slice(); },
	read() {
		if(iface === 3) { const r = notes.shift(); lastSize = r ? 65 : 0; return r ?? []; }
		const p = last, cmd = p[4], r = new Array(1025).fill(0);
		r[4] = cmd; r[3] = cmd === 0x1B ? 0 : 1;
		if(cmd === 0x1B && p[5] === 1) r[10] = 1;
		if(cmd === 0x02 && p[5] === 3) r[6] = 2;
		if(cmd === 0x0D && p[6] !== 0x22) {
			const id = p[6] | p[7] << 8;
			opens.push(id);
			if(files.has(id)) buffers.set(p[5], { d: files.get(id), at: 0 }); else r[5] = 2;
		}
		if(cmd === 0x09) { const n = buffers.get(p[5]).d.length; r[8] = n & 0xFF; r[9] = n >> 8; }
		if(cmd === 0x08) { const b = buffers.get(p[5]); const c = b.d.slice(b.at, b.at + 1019); b.at += 1019; c.forEach((v, i) => { r[6 + i] = v; }); }
		return r;
	},
};

const keysDown = new Set();
const keyReport = () => { const r = new Array(65).fill(0); r[4] = 2; for(const k of keysDown) r[5 + (k >> 3)] |= 1 << (k & 7); notes.push(r); };
const press = (...k) => { k.forEach(x => keysDown.add(x)); keyReport(); };
const lift = (...k) => { k.forEach(x => keysDown.delete(x)); keyReport(); };
const dial = clicks => { const r = new Array(65).fill(0); r[4] = 5; r[5] = 0x60; [clicks & 0xFF, clicks >> 8 & 0xFF, clicks >> 16 & 0xFF, clicks >> 24 & 0xFF].forEach((v, i) => { r[7 + i] = v; }); notes.push(r); };

const mod = await import(url.pathToFileURL(src).href);
let fail = 0;
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if(!c) fail++; };
const frame = () => { sent.length = 0; mod.Render(); return sent.join(" "); };

mod.Initialize();
check(mod.ControllableParameters().some(p => p.property === "customKeys" && p.default === "Off"), "Custom keys setting exists, off by default");
check(mod.Validate({ interface: 3, usage: 2, usage_page: 0xFF42 }), "the notification channel is accepted");

press(58);
check(frame() === "" && opens.length === 0, "off: nothing read, nothing sent");
lift(58); frame();

customKeys = "On";
check(frame() === "" && opens.includes(28004) && opens.includes(28010), "on: reads the setup; F1 pressed while off isn't played");

press(58); check(frame() === "70v", "F1 remapped to F1: F1 down");
lift(58); check(frame() === "70^", "F1 up on release");
press(4); check(frame() === "", "a key that isn't remapped is left to the keyboard");
lift(4); frame();
press(7); check(frame() === "", "D's main layer isn't remapped: nothing");
lift(7); frame();
press(122, 7); check(frame() === "afv", "FN + D: volume up down");
lift(7); check(frame() === "af^", "and up");
lift(122); frame();
press(107, 9); check(frame() === "", "Alt + F with Alt left at the built-in function: the keyboard's job");
lift(107, 9); frame();
press(9); check(frame() === "41v", "F plays its macro: A down");
lift(9); check(frame() === "", "play once keeps going after release");
now += 30; check(frame() === "41^", "A up after the 30 ms wait");
press(10); check(frame() === "42v", "G (while held): B down");
now += 100; lift(10); check(frame() === "42^", "letting go stops it early and lets B go");

dial(2); check(frame() === "afv af^ afv af^", "dial mode 1: two clicks right = two volume up taps");
dial(-1); check(frame() === "aev ae^", "one click left = volume down");
press(129); check(frame() === "adv", "dial press = mute");
lift(129); check(frame() === "ad^", "mute up");
press(122, 129); check(frame() === "", "FN + dial press: next mode");
lift(122, 129); frame();
dial(1); check(frame() === "70v 70^", "dial mode 2: custom turn right = F1 tap");
press(129); check(frame() === "afv", "custom press = volume up down");

files.set(28000, profile().map((v, i) => i === 2 ? 9 : v)); // DeckMapper applied: new cookie
opens.length = 0; now += 5000; frame();
check(opens.includes(28004), "a new profile cookie reloads the keys");
check(sent.includes("af^"), "reloading lets go of what was held");

press(58); frame();
sent.length = 0; mod.Shutdown(false);
check(sent.includes("70^") && sent.includes("af^"), "Shutdown lets go of every held key");

Date.now = realNow;
process.exit(fail ? 1 : 0);
