// Offline check of plugin/Corsair_Vanguard_Air_99.js with a fake SignalRGB `device`.
// Usage: node tools/plugin-test/run.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = path.join(here, "..", "..", "plugin", "Corsair_Vanguard_Air_99.js");
const sent = [];
let mode = 1, session = 0, dropSessionOnce = false;
globalThis.LightingMode = "Forced"; globalThis.forcedColor = "#009bde"; globalThis.debugLedId = -1;
globalThis.device = {
	set_endpoint() {}, clearReadBuffer() {}, pause() {}, log(m) { console.log("  log:", m); },
	color() { return [1, 2, 3]; },
	write(p, len) { if(len !== 1025) throw new Error("bad length"); sent.push(p.slice()); },
	read() {
		const p = sent[sent.length - 1], cmd = p[4], r = new Array(1025).fill(0);
		r[4] = cmd;
		if(cmd !== 0x1B && (p[3] !== session || dropSessionOnce)) { dropSessionOnce = false; r[2] = 0x0F; return r; }
		r[3] = session;
		if(cmd === 0x1B && p[5] === 1) { session = 1; r[10] = 1; }
		if(cmd === 0x01 && p[5] === 3) mode = p[7];
		if(cmd === 0x02 && p[5] === 3) r[6] = mode;
		return r;
	},
};
const mod = await import(url.pathToFileURL(src).href);
const hex = (a, n = 12) => a.slice(0, n).map(b => b.toString(16).padStart(2, "0")).join(" ");
let fail = 0; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if(!c) fail++; };

// Layout
const pos = mod.LedPositions(), names = mod.LedNames(), [w, h] = mod.Size();
const seen = new Map();
pos.forEach((p, i) => { const k = p.join(","); if(seen.has(k)) console.log(`  shared cell ${k}: ${seen.get(k)} + ${names[i]}`); seen.set(k, names[i]); });
check(pos.every(([x, y]) => x >= 0 && x < w && y >= 0 && y < h), `all ${pos.length} LEDs inside grid ${w}x${h}`);

// Initialize
mod.Initialize();
check(mode === 2, "Initialize puts the board in software mode");
const open = sent.find(p => p[4] === 0x0D);
check(open && hex(open, 8) === "00 00 01 01 0d 00 22 00", `open handle packet ${open && hex(open, 8)}`);

// Frame
sent.length = 0; mod.Render();
const f = sent[0];
check(f[4] === 0x06 && f[5] === 0 && (f[6] | f[7] << 8) === 431 && f[10] === 0x12 && f[11] === 0, `frame header ${hex(f, 12)}`);
check(f[12 + 41 * 3] === 0x00 && f[13 + 41 * 3] === 0x9b && f[14 + 41 * 3] === 0xde, "Esc (id 41) gets the forced colour");
check(f.length - 12 === 143 * 3, "frame carries 143 LEDs");

// Session lost (another app started its own session) -> restart and resend
sent.length = 0; dropSessionOnce = true; mod.Render();
check(sent.some(p => p[4] === 0x1B) && sent[sent.length - 1][4] === 0x06, "session loss: new session, frame resent");

// Another app switched to hardware mode -> plugin takes it back within 120 frames
mode = 1; for(let i = 0; i < 120; i++) mod.Render();
check(mode === 2, "mode reset behind our back is detected and fixed");

// Shutdown
mod.Shutdown(false);
check(mode === 1, "Shutdown returns the board to hardware mode");
process.exit(fail ? 1 : 0);
