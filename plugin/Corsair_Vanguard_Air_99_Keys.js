// Corsair VANGUARD AIR 99: optional custom-key playback for software mode.
//
// This file is separate on purpose. The lighting plugin (Corsair_Vanguard_Air_99.js) works without it; to drop it,
// delete this file and the lines marked "Custom keys module" in the plugin.
//
// Why it exists: in software mode (prop 3 = 2, which clean per-key lighting needs) the keyboard stops running its
// own key remaps, macros and dial modes. It reports every key's state on the notification channel instead
// (MI_03, usage page 0xFF42, usage 2) and leaves the rest to the PC, like iCUE does. Off by default, this module
// reads the remaps stored on the keyboard (made in Corsair Web Hub or DeckMapper) and plays them with
// keyboard.sendHid, so remapped keys keep working while SignalRGB lights the board.
//
// What is read (never written), all from the first profile in the profile list, like DeckMapper:
//   file 15            profile list: u16 header, u16 count, u16 profile file ids
//   profile file       u16 header, u32 cookie (2-5, bumped on every change), u16 pointers: assignments at 6,
//                      key mappings at 14, dial modes at 18
//   assignments (V2)   u16 45, u16, then per key: id u8, count u8, count x (layer flags u16, action file u16, options u16)
//                      layer flags: 0 main, 1 FN, 4 Ctrl, 8 Alt, 16 Shift
//   key mappings       u16 header, then one byte per key id: bit 0 main, 1 FN, 3 Ctrl, 4 Alt, 5 Shift
//                      "built-in function enabled". A cleared bit means the layer is remapped (or off).
//   action file        u16 1902, type (1 keys, 2 mouse, 3 media), u16, 3 zero bytes, then count + HID usages
//                      (keys), the button (mouse) or a u16 consumer usage (media)
//   macro file         u16 12460, u16 block count, 12 zero bytes, events in 8-byte blocks:
//                      1 key down, 2 key up, 12 wait (ms, u8), 7 wait (u16), 14 wait (u24), 0 = rest of block empty
//   dial modes         u16 header, u16 count, per mode: type u8, RGBA, n u8, n x (trigger u8, 0, options u16, file u16)
//                      triggers: 0 turn right, 1 turn left, 2 press
//
// Reports on the notification channel (as device.read returns them, report id first):
//   [0, 0, 0, 0, 2, bitmap...]       key state: bit n = key id n is down (FN = 122, dial press = 129)
//   [0, 0, 0, 0, 5, 0x60, 0, i32]    dial turn: signed click count, +1 per click right
// The type byte is found at index 4 or 2 on first sight (it moved between SignalRGB releases on other boards).
//
// Files are read on buffer 1 (Web Hub and the Deck apps use 0, the lighting plugin 3), once at start and again
// whenever the profile's cookie changes (checked every few seconds), so changes made in DeckMapper count right away.

const NOTIFY_INTERFACE = 3;
const COMMAND_INTERFACE = 2;
const NOTIFY_LENGTH = 65;
const FILE_BUFFER = 1;
const FN_KEY = 122, DIAL_PRESS_KEY = 129;
const COOKIE_CHECK_MS = 4000;

const CMD = Object.freeze({ CLOSE: 0x05, READ: 0x08, DESCRIBE: 0x09, OPEN: 0x0D });
const HEADER = Object.freeze({ REMAP: 1902, MACRO: 12460, ASSIGN_V2: 45 });
const LAYER = Object.freeze({ MAIN: 0, FN: 1, CTRL: 4, ALT: 8, SHIFT: 16 });

/** The SignalRGB settings this module adds. "Off" by default, so the plugin behaves exactly as without it. */
export function KeyParameters() {
	return [
		{"property":"customKeys", "group":"", "label":"Custom keys in software mode", description: "Plays the key remaps, macros and dial modes stored on the keyboard (Web Hub or DeckMapper) while SignalRGB has it in software mode. Turn this off if another program (Admiral, DeckMapper's key service) already does it.", "type":"combobox", "values":["Off", "On"], "default":"Off"},
	];
}

/** The notification channel, which the plugin must accept in Validate for this module to read it. */
export function IsKeyEndpoint(endpoint) {
	return endpoint.interface === NOTIFY_INTERFACE && endpoint.usage === 0x0002 && endpoint.usage_page === 0xFF42;
}

/**
 * Plays the keyboard's remaps from the PC. Call poll() once per frame; it does nothing while "Custom keys" is off.
 * Needs the plugin's Bragi object for command(cmd, payload) (returns the reply, report id first) and the
 * "keyboard" device feature for keyboard.sendHid.
 */
export class Air99KeyPlayer {
	constructor(bragi, log) {
		this.bragi = bragi;
		this.log = log;
		this.keys = new Map();       // key id -> { map, main, fn }
		this.dial = [];              // [{ type, actions: Map(trigger -> action) }]
		this.dialMode = 0;
		this.cookie = null;
		this.nextCookieCheck = 0;
		this.down = new Array(256).fill(false);
		this.held = new Map();       // key id -> what to release
		this.macros = [];            // running macros
		this.altHeldUntil = 0;       // switch-apps dial mode holds Alt
		this.typeAt = -1;            // where the report type byte is
		this.loadFailed = false;
		this.synced = false;         // reports that piled up while off are caught up on, not played
	}

	poll(enabled) {
		if(!enabled) {
			if(this.held.size || this.macros.length || this.altHeldUntil) { this.releaseAll(); }

			this.synced = false;

			return;
		}

		const now = Date.now();

		if(now >= this.nextCookieCheck) {
			this.nextCookieCheck = now + COOKIE_CHECK_MS;
			this.reloadIfChanged();
		}

		if(!this.synced) {
			// Reports kept coming while this was off (or before it started): take in where the keys are now
			// without acting, so nothing pressed earlier plays.
			this.readNotifications(true);
			this.synced = true;
		}

		this.readNotifications(false);
		this.runMacros(now);

		if(this.altHeldUntil && now >= this.altHeldUntil) { this.endSwitchApps(); }
	}

	stop() { this.releaseAll(); }

	// ---------------- reading the keyboard's setup ----------------

	reloadIfChanged() {
		const profile = this.readProfile();

		if(!profile) {
			if(!this.loadFailed) { this.log("Air 99 keys: no profile to read"); }

			this.loadFailed = true;

			return;
		}

		const cookie = profile.bytes.slice(2, 6).join(",");

		if(cookie === this.cookie) { return; }

		this.load(profile);
		this.cookie = cookie;
	}

	readProfile() {
		const list = this.readFile(15);

		if(!list || list.length < 6 || u16(list, 2) === 0) { return null; }

		const id = u16(list, 4);
		const bytes = this.readFile(id);

		return bytes && bytes.length >= 20 ? { id, bytes } : null;
	}

	load(profile) {
		const p = profile.bytes;
		const assign = this.readFile(u16(p, 6)) ?? [];
		const map = this.readFile(u16(p, 14)) ?? [];
		const actions = new Map(); // action file id -> parsed (each read once)
		const action = (fileId) => {
			if(!actions.has(fileId)) { actions.set(fileId, decodeAction(this.readFile(fileId))); }

			return actions.get(fileId);
		};

		const keys = new Map();

		if(assign.length >= 4 && u16(assign, 0) === HEADER.ASSIGN_V2) {
			for(let a = 4; a + 2 <= assign.length;) {
				const key = assign[a], n = assign[a + 1];
				a += 2;

				const entry = keys.get(key) ?? { map: map[2 + key] ?? 0x3f, main: null, fn: null };

				for(let j = 0; j < n && a + 6 <= assign.length; j++, a += 6) {
					const flags = u16(assign, a), file = u16(assign, a + 2), options = u16(assign, a + 4);

					if(flags !== LAYER.MAIN && flags !== LAYER.FN) { continue; }

					const act = action(file);

					if(act && act.kind === "macro") { act.whileHeld = (options & 64) !== 0; }

					if(flags === LAYER.MAIN) { entry.main = act; } else { entry.fn = act; }
				}
				keys.set(key, entry);
			}
		}

		const dial = [];
		const d = this.readFile(u16(p, 18));

		if(d && d.length >= 4) {
			let o = 4;

			for(let i = 0; i < u16(d, 2) && o + 6 <= d.length; i++) {
				const mode = { type: d[o], actions: new Map() };
				const n = d[o + 5];
				o += 6;

				for(let j = 0; j < n && o + 6 <= d.length; j++, o += 6) { mode.actions.set(d[o], action(u16(d, o + 4))); }

				dial.push(mode);
			}
		}

		this.releaseAll();
		this.keys = keys;
		this.dial = dial;

		if(this.dialMode >= dial.length) { this.dialMode = 0; }

		this.loadFailed = false;

		const remapped = [...keys.values()].filter(k => k.main || k.fn).length;
		this.log(`Air 99 keys: profile ${profile.id}, ${remapped} remapped keys, ${dial.length} dial modes`);
	}

	/** Reads one file on buffer 1. Returns its bytes, or null if it doesn't exist. */
	readFile(id) {
		if(!id) { return null; }

		const b = this.bragi;
		let reply = b.command(CMD.OPEN, [FILE_BUFFER, id & 0xFF, id >> 8]);

		if(statusOf(reply, CMD.OPEN) === 3) {
			b.command(CMD.CLOSE, [1, FILE_BUFFER]);
			reply = b.command(CMD.OPEN, [FILE_BUFFER, id & 0xFF, id >> 8]);
		}

		try {
			if(statusOf(reply, CMD.OPEN) !== 0) { return null; }

			reply = b.command(CMD.DESCRIBE, [FILE_BUFFER]);

			if(statusOf(reply, CMD.DESCRIBE) !== 0) { return null; }

			const size = reply[8] | reply[9] << 8 | reply[10] << 16 | reply[11] << 24;
			const out = [];

			while(out.length < size) {
				reply = b.command(CMD.READ, [FILE_BUFFER]);

				if(statusOf(reply, CMD.READ) !== 0 || reply.length <= 6) { break; }

				const chunk = reply.slice(6, 6 + Math.min(reply.length - 6, size - out.length));
				out.push(...chunk);
			}

			return out;
		} finally {
			b.command(CMD.CLOSE, [1, FILE_BUFFER]);
		}
	}

	// ---------------- reports ----------------

	readNotifications(catchUp) {
		try {
			device.set_endpoint(NOTIFY_INTERFACE, 0x0002, 0xFF42);

			for(let n = 0; n < 32; n++) {
				const r = device.read([0x00], NOTIFY_LENGTH, 0);

				if(device.getLastReadSize() === 0) { break; }

				if(catchUp) { this.catchUp(r); } else { this.onReport(r); }
			}
		} finally {
			device.set_endpoint(COMMAND_INTERFACE, 0x0001, 0xFF42);
		}
	}

	/** Only where the keys are, nothing played. */
	catchUp(r) {
		if(!this.findType(r) || r[this.typeAt] !== 2) { return; }

		for(let id = 0; id < 256; id++) { this.down[id] = (r[this.typeAt + 1 + (id >> 3)] & (1 << (id & 7))) !== 0; }
	}

	/** Finds where the report type byte is, on the first report seen. */
	findType(r) {
		if(this.typeAt >= 0) { return true; }

		this.typeAt = r[4] === 2 || r[4] === 5 ? 4 : r[2] === 2 || r[2] === 5 ? 2 : -1;

		if(this.typeAt >= 0) { this.log(`Air 99 keys: report type at byte ${this.typeAt}`); }

		return this.typeAt >= 0;
	}

	onReport(r) {
		if(!this.findType(r)) { return; }

		const t = this.typeAt, type = r[t];

		if(type === 2) {
			const now = new Array(256).fill(false);

			for(let id = 0; id < 256 && t + 1 + (id >> 3) < r.length; id++) { now[id] = (r[t + 1 + (id >> 3)] & (1 << (id & 7))) !== 0; }

			for(let id = 0; id < 256; id++) {
				if(now[id] === this.down[id]) { continue; }

				if(now[id]) { this.press(id, now); } else { this.release(id); }
			}
			this.down = now;
		} else if(type === 5 && r[t + 1] === 0x60 && r.length >= t + 7) {
			const clicks = r[t + 3] | r[t + 4] << 8 | r[t + 5] << 16 | r[t + 6] << 24; // signed

			if(clicks !== 0 && Math.abs(clicks) <= 64) {
				for(let i = 0; i < Math.abs(clicks); i++) { this.turn(clicks > 0); }
			}
		}
	}

	// ---------------- keys ----------------

	press(id, now) {
		if(id === DIAL_PRESS_KEY) { this.dialPress(now); return; }

		const k = this.keys.get(id);

		if(id === FN_KEY || !k) { return; }

		let act;

		if(now[FN_KEY]) {
			if(k.map & 0b10) { return; }       // FN layer not remapped: the keyboard's job

			act = k.fn;
		} else {
			if(k.map & 0b1) { return; }        // not remapped: the keyboard sends the key itself

			// A Ctrl/Alt/Shift layer left at its built-in function is the keyboard's job too.
			const ctrl = now[105] || now[109], alt = now[107] || now[111], shift = now[106] || now[110];

			if((ctrl && (k.map & 0b1000)) || (alt && (k.map & 0b10000)) || (shift && (k.map & 0b100000))) { return; }

			act = k.main;
		}

		const held = this.begin(act);

		if(held) { this.held.set(id, held); }
	}

	release(id) {
		const h = this.held.get(id);

		if(!h) { return; }

		this.held.delete(id);
		this.end(h);
	}

	/** Starts an action; returns what its release undoes (or null if it sends nothing). */
	begin(act) {
		if(!act) { return null; }

		if(act.kind === "keys" || act.kind === "media" || act.kind === "mouse") {
			for(const vk of act.vks) { sendVk(vk, false); }

			return { vks: act.vks };
		}

		if(act.kind === "macro") {
			const m = { steps: act.steps, i: 0, next: 0, down: new Set() };
			this.macros.push(m);
			this.runMacros(Date.now());

			return act.whileHeld ? { macro: m } : null; // play once: runs to the end on its own
		}

		return null;
	}

	end(h) {
		if(h.vks) { for(let i = h.vks.length - 1; i >= 0; i--) { sendVk(h.vks[i], true); } }

		if(h.macro) { this.stopMacro(h.macro); }
	}

	/** Macro steps run between frames: waits are checked against the clock on every poll. */
	runMacros(now) {
		for(const m of [...this.macros]) {
			while(m.i < m.steps.length && now >= m.next) {
				const s = m.steps[m.i++];

				if(s.wait) {
					m.next = now + s.wait;
				} else if(s.vk) {
					sendVk(s.vk, s.up);

					if(s.up) { m.down.delete(s.vk); } else { m.down.add(s.vk); }
				}
			}

			if(m.i >= m.steps.length) { this.stopMacro(m); }
		}
	}

	stopMacro(m) {
		for(const vk of m.down) { sendVk(vk, true); } // never leave a key stuck down

		m.down.clear();
		this.macros = this.macros.filter(x => x !== m);
	}

	releaseAll() {
		for(const h of this.held.values()) { this.end(h); }

		this.held.clear();

		for(const m of [...this.macros]) { this.stopMacro(m); }

		this.endSwitchApps();
		this.down.fill(false);
	}

	// ---------------- dial ----------------

	/**
	 * The keyboard doesn't report its dial mode and doesn't switch modes itself in software mode,
	 * so this keeps it: FN + dial press goes to the next mode.
	 */
	turn(right) {
		const mode = this.dial[this.dialMode];

		switch(mode ? mode.type : 13) {
		case 13: tap(right ? 0xAF : 0xAE); break;                         // volume
		case 8: tap(right ? 0xB0 : 0xB1); break;                          // change track
		case 3: case 9: case 10: tap(right ? 0x27 : 0x25); break;         // seek: arrow right / left
		case 7: case 12: chord(0x11, right ? 0xBB : 0xBD); break;         // zoom: Ctrl + = / Ctrl + -
		case 6: case 11: this.switchApps(right); break;                   // switch apps: Alt + Tab
		case 0: this.tapAction(mode.actions.get(right ? 0 : 1)); break;   // custom actions
		// Scrolling can't be sent from a plugin, and lighting brightness belongs to SignalRGB: nothing to do.
		}
	}

	dialPress(now) {
		if(now[FN_KEY]) {
			if(this.dial.length > 1) {
				this.dialMode = (this.dialMode + 1) % this.dial.length;
				this.endSwitchApps();
				this.log(`Air 99 keys: dial mode ${this.dialMode + 1} of ${this.dial.length}`);
			}

			return;
		}

		const mode = this.dial[this.dialMode];
		const type = mode ? mode.type : 13;

		if((type === 6 || type === 11) && this.altHeldUntil) { this.endSwitchApps(); return; } // pick the app

		const act =
			type === 13 ? { kind: "media", vks: [0xAD] } :
				type === 3 || type === 8 || type === 9 || type === 10 ? { kind: "media", vks: [0xB3] } :
					type === 7 || type === 12 ? { kind: "keys", vks: [0x11, 0x30] } :     // Ctrl + 0: back to 100 %
						type === 0 ? mode.actions.get(2) : null;
		const held = this.begin(act);

		if(held) { this.held.set(DIAL_PRESS_KEY, held); }
	}

	tapAction(act) {
		const h = this.begin(act);

		if(h && h.vks) { this.end(h); } // a click is a tap; macros run on their own
	}

	switchApps(right) {
		if(!this.altHeldUntil) { sendVk(0x12, false); }

		if(!right) { sendVk(0x10, false); }

		tap(0x09);

		if(!right) { sendVk(0x10, true); }

		this.altHeldUntil = Date.now() + 1000; // let go of Alt a second after the last click
	}

	endSwitchApps() {
		if(!this.altHeldUntil) { return; }

		this.altHeldUntil = 0;
		sendVk(0x12, true);
	}
}

// ---------------- decoding ----------------

function decodeAction(d) {
	if(!d || d.length < 2) { return null; }

	const header = u16(d, 0);

	if(header === HEADER.MACRO) { return decodeMacro(d); }

	if(header !== HEADER.REMAP || d.length < 10) { return null; }

	switch(d[2]) {
	case 1: {
		const vks = d.slice(9, 9 + d[8]).map(hidToVk).filter(v => v);

		return vks.length ? { kind: "keys", vks } : null;
	}
	case 2: {
		const vk = [0, 0x01, 0x02, 0x04, 0x05, 0x06][d[8]] ?? 0; // left, right, middle, back, forward

		return vk ? { kind: "mouse", vks: [vk] } : null;
	}
	case 3: {
		const vk = mediaToVk(u16(d, 8));

		return vk ? { kind: "media", vks: [vk] } : null;
	}
	default:
		return null; // internal functions, gamepad, text: nothing to send
	}
}

function decodeMacro(d) {
	if(d.length < 16) { return null; }

	const end = Math.min(d.length, 16 + u16(d, 2) * 8);
	const steps = [];

	for(let i = 16; i < end;) {
		const blockEnd = 16 + (Math.floor((i - 16) / 8) + 1) * 8;
		const t = d[i];

		if(t === 0) { i = blockEnd; continue; }

		if((t === 1 || t === 2) && i + 2 <= blockEnd) {
			const vk = hidToVk(d[i + 1]);

			if(vk) { steps.push({ vk, up: t === 2 }); }

			i += 2;
		} else if(t === 12 && i + 2 <= blockEnd) {
			steps.push({ wait: d[i + 1] }); i += 2;
		} else if(t === 7 && i + 3 <= blockEnd) {
			steps.push({ wait: u16(d, i + 1) }); i += 3;
		} else if(t === 14 && i + 4 <= blockEnd) {
			steps.push({ wait: d[i + 1] | d[i + 2] << 8 | d[i + 3] << 16 }); i += 4;
		} else if((t === 3 || t === 4 || t === 9 || t === 10) && i + 2 <= blockEnd) {
			i += 2; // mouse buttons and scrolling: the keyboard doesn't play them either
		} else if((t === 5 || t === 6) && i + 5 <= blockEnd) {
			i += 5; // mouse moves: same
		} else {
			return null; // random delays and packed moves (made in Web Hub): not played
		}
	}

	return { kind: "macro", steps, whileHeld: false };
}

/** HID keyboard usage to a Windows virtual key (what keyboard.sendHid takes). */
function hidToVk(h) {
	if(h >= 4 && h <= 29) { return 0x41 + h - 4; }          // A-Z

	if(h >= 30 && h <= 38) { return 0x31 + h - 30; }        // 1-9

	if(h >= 58 && h <= 69) { return 0x70 + h - 58; }        // F1-F12

	if(h >= 104 && h <= 115) { return 0x7C + h - 104; }     // F13-F24

	if(h >= 89 && h <= 97) { return 0x61 + h - 89; }        // Num 1-9

	return {
		39: 0x30, 40: 0x0D, 41: 0x1B, 42: 0x08, 43: 0x09, 44: 0x20, 45: 0xBD, 46: 0xBB, 47: 0xDB, 48: 0xDD, 49: 0xDC,
		51: 0xBA, 52: 0xDE, 53: 0xC0, 54: 0xBC, 55: 0xBE, 56: 0xBF, 57: 0x14, 70: 0x2C, 71: 0x91, 72: 0x13,
		73: 0x2D, 74: 0x24, 75: 0x21, 76: 0x2E, 77: 0x23, 78: 0x22, 79: 0x27, 80: 0x25, 81: 0x28, 82: 0x26,
		83: 0x90, 84: 0x6F, 85: 0x6A, 86: 0x6D, 87: 0x6B, 88: 0x0D, 98: 0x60, 99: 0x6E, 100: 0xE2, 101: 0x5D,
		224: 0xA2, 225: 0xA0, 226: 0xA4, 227: 0x5B, 228: 0xA3, 229: 0xA1, 230: 0xA5, 231: 0x5C,
	}[h] ?? 0;
}

/** Consumer-page usage (media keys) to a Windows virtual key. */
function mediaToVk(u) {
	return {
		205: 0xB3, 183: 0xB2, 182: 0xB1, 181: 0xB0, 233: 0xAF, 234: 0xAE, 226: 0xAD,
		0x192: 0xB7, 0x18A: 0xB4, 0x194: 0xB6, 0x223: 0xAC, 0x224: 0xA6, 0x225: 0xA7, 0x227: 0xA8, 0x221: 0xAA,
	}[u] ?? 0;
}

function sendVk(vk, up) { keyboard.sendHid(vk, { released: up }); }

function tap(vk) { sendVk(vk, false); sendVk(vk, true); }

function chord(mod, vk) { sendVk(mod, false); tap(vk); sendVk(mod, true); }

function u16(b, o) { return (b[o] ?? 0) | (b[o + 1] ?? 0) << 8; }

/** Status byte of a reply to cmd (report id first), or -1. */
function statusOf(reply, cmd) { return reply.length > 5 && reply[2] === 0x00 && reply[4] === cmd ? reply[5] : -1; }
