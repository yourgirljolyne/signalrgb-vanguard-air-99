// Corsair VANGUARD AIR 99 (wired) - VID 0x1B1C, PID 0x2B21
//
// Live per-key lighting for SignalRGB. Written as a community plugin; protocol notes and
// test logs that back every choice here are in docs/air99-lighting-protocol.md.
//
// How this board differs from the Vanguard 96 plugin (0x2B0D):
//   - It ignores the Bragi v1 header [0x08, cmd]. It needs the v1.5 header
//     [sub 0, 0x01, session, cmd] and a host session (command 0x1B) first.
//   - Lighting is the same LightingController scheme: software mode (prop 3 = 2),
//     handle 0 on endpoint 0x22, data [0x12, 0x00, R,G,B per LED id].
//   - A single frame is accepted but never shown; the board only displays a steady stream.
//   - More than ~143 LEDs in one write locked the command channel until replug, so the frame
//     is sized to the highest LED id (142) + 1.
//
// USB: MI_02 usage page 0xFF42 usage 0x01 = commands (1025-byte reports), MI_03 usage 0x02 = notifications.
// Nothing in this plugin writes to flash: hardware brightness, profiles and effects are left alone.

export function Name() { return "Corsair Vanguard Air 99"; }
export function VendorId() { return 0x1B1C; }
export function ProductId() { return 0x2B21; }
export function Publisher() { return "YourGirlJolyne"; }
export function Documentation() { return "troubleshooting/corsair"; }
export function Size() { return [GRID_WIDTH, GRID_HEIGHT]; }
export function DefaultPosition() { return [10, 100]; }
export function DefaultScale() { return 8.0; }
export function DeviceType() { return "keyboard"; }
export function SubdeviceController() { return false; }
export function ImageUrl() { return "https://assets.signalrgb.com/devices/brands/corsair/keyboards/k65-plus.png"; }
export function LedNames() { return vLedNames; }
export function LedPositions() { return vLedPositions; }

/* global
LightingMode:readonly
forcedColor:readonly
debugLedId:readonly
*/
export function ControllableParameters() {
	return [
		{"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", description: "Canvas uses the active effect, Forced sets one colour", "type":"combobox", "values":["Canvas", "Forced"], "default":"Canvas"},
		{"property":"forcedColor", "group":"lighting", "label":"Forced Color", description: "The colour used when Lighting Mode is Forced", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
		{"property":"debugLedId", "group":"lighting", "label":"Debug: light one LED id (-1 = off)", description: "Mapping aid. Lights only this raw LED id, white.", "min":"-1", "max":"142", "type":"number", "default":"-1"},
	];
}

export function Validate(endpoint) {
	return endpoint.interface === 2 && endpoint.usage === 0x0001 && endpoint.usage_page === 0xFF42;
}

const COMMAND_INTERFACE = 2;
const REPORT_LENGTH = 1025;     // fixed for MI_02; do not read it from getHidInfo
const LED_SLOTS = 143;          // LED ids 0..142 (highest id in Web Hub's list for this board)
const MODE_CHECK_FRAMES = 120;  // re-check the operating mode about every 2 s

let bragi;
let frameCounter = 0;

export function Initialize() {
	device.set_endpoint(COMMAND_INTERFACE, 0x0001, 0xFF42);
	bragi = new Bragi15();
	bragi.startLighting();
}

export function Render() {
	if(!bragi) {
		return;
	}

	if(++frameCounter % MODE_CHECK_FRAMES === 0 && bragi.getProperty(B.PROP_MODE) !== B.MODE_SOFTWARE) {
		// Another app (e.g. a file write from TrackDeck / SlotDeck / DeckMapper or Web Hub) put the board back
		// in hardware mode. Take it again.
		device.log("Air 99: operating mode changed behind our back, re-entering software mode");
		bragi.startLighting();
	}

	if(!bragi.sendFrame(buildFrame())) {
		bragi.startLighting();
	}
}

export function Shutdown(SystemSuspending) {
	if(!bragi) {
		return;
	}

	// Back to the keyboard's own stored lighting.
	bragi.stopLighting();
}

function buildFrame() {
	const rgb = new Array(LED_SLOTS * 3).fill(0);

	if(debugLedId >= 0) {
		rgb[debugLedId * 3] = 255;
		rgb[debugLedId * 3 + 1] = 255;
		rgb[debugLedId * 3 + 2] = 255;

		return rgb;
	}

	for(let i = 0; i < vLedMap.length; i++) {
		const pos = vLedPositions[i];
		const col = LightingMode === "Forced" ? hexToRgb(forcedColor) : device.color(pos[0], pos[1]);
		const id = vLedMap[i];
		rgb[id * 3] = col[0];
		rgb[id * 3 + 1] = col[1];
		rgb[id * 3 + 2] = col[2];
	}

	return rgb;
}

function hexToRgb(hex) {
	const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);

	return r ? [parseInt(r[1], 16), parseInt(r[2], 16), parseInt(r[3], 16)] : [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Bragi v1.5 with host session (the header Corsair Web Hub uses for this board)
// request:  [report 0, sub 0, 0x01, session, command, payload...]
// reply:    [report 0, ?, 0x00 or 0x0F (no session), session, command echo, status, data...]
// ---------------------------------------------------------------------------
const B = Object.freeze({
	CMD_SET: 0x01,
	CMD_GET: 0x02,
	CMD_CLOSE: 0x05,
	CMD_WRITE: 0x06,
	CMD_OPEN: 0x0D,
	CMD_SESSION: 0x1B,
	PROP_MODE: 0x03,
	MODE_HARDWARE: 1,
	MODE_SOFTWARE: 2,
	EP_LIGHTING_CONTROLLER: 0x22,
	DATA_TYPE_LIGHTING_CONTROLLER: 0x12,
	LIGHTING_HANDLE: 0x00,
});

function okReply(reply, cmd) {
	return reply.length > 5 && reply[2] === 0x00 && reply[4] === cmd && reply[5] === 0x00;
}

class Bragi15 {
	constructor() {
		this.session = 0;
	}

	startSession() {
		const rnd = [1, 2, 3, 4].map(() => Math.floor(Math.random() * 256));
		const reply = this.raw(B.CMD_SESSION, [0x01, ...rnd, 0x00], 0);
		this.session = reply.length > 10 ? reply[10] : 0;
		device.log(`Air 99: session ${this.session}`);
	}

	stopSession() {
		this.raw(B.CMD_SESSION, [0x02, 0, 0, 0, 0, this.session]);
	}

	/** Sends one command, reads its reply. Restarts the session once if the board says it has none. */
	command(cmd, payload) {
		let reply = this.raw(cmd, payload);

		if(reply.length > 2 && reply[2] === 0x0F) {
			this.startSession();
			reply = this.raw(cmd, payload);
		}

		return reply;
	}

	raw(cmd, payload, session = this.session) {
		device.clearReadBuffer();
		device.write([0x00, 0x00, 0x01, session, cmd, ...payload], REPORT_LENGTH);

		return device.read([0x00], REPORT_LENGTH, 50);
	}

	getProperty(id) {
		const reply = this.command(B.CMD_GET, [id & 0xFF, id >> 8]);

		return okReply(reply, B.CMD_GET) ? reply[6] | reply[7] << 8 | reply[8] << 16 | reply[9] << 24 : -1;
	}

	setProperty(id, value) {
		const reply = this.command(B.CMD_SET, [id & 0xFF, id >> 8, value & 0xFF, value >> 8 & 0xFF, value >> 16 & 0xFF, value >> 24 & 0xFF]);

		return okReply(reply, B.CMD_SET);
	}

	startLighting() {
		this.startSession();
		this.raw(B.CMD_CLOSE, [0x01, B.LIGHTING_HANDLE]); // clean slate; fails harmlessly if not open
		this.setProperty(B.PROP_MODE, B.MODE_SOFTWARE);
		const reply = this.command(B.CMD_OPEN, [B.LIGHTING_HANDLE, B.EP_LIGHTING_CONTROLLER, 0x00]);
		device.log(`Air 99: lighting handle ${okReply(reply, B.CMD_OPEN) ? "open" : "failed, status " + reply[5]}`);
	}

	stopLighting() {
		this.raw(B.CMD_CLOSE, [0x01, B.LIGHTING_HANDLE]);
		this.setProperty(B.PROP_MODE, B.MODE_HARDWARE);
		this.stopSession();
	}

	/** One frame = one write packet: handle, u32 length, [0x12, 0x00, RGB...]. Returns false on any error. */
	sendFrame(rgb) {
		const data = [B.DATA_TYPE_LIGHTING_CONTROLLER, 0x00, ...rgb];
		const n = data.length;
		const reply = this.command(B.CMD_WRITE, [B.LIGHTING_HANDLE, n & 0xFF, n >> 8 & 0xFF, n >> 16 & 0xFF, n >> 24 & 0xFF, ...data]);

		return okReply(reply, B.CMD_WRITE);
	}
}

// ---------------------------------------------------------------------------
// Layout. Key ids = LED ids (HID usages, plus Corsair ids for modifiers 105-111, FN 122,
// Game 130, S1-S6 131-136, Copilot 137, Stream Deck key 138). Positions come from
// DeckMapper's Air 99 layout (Web Hub kb2B21 view) in key units, rounded to the grid.
// LEDs 124 and 139-142 are listed by Web Hub but not placed yet (use the debug slider).
// ---------------------------------------------------------------------------
const vLedNames = [];
const vLedPositions = [];
const vLedMap = [];
let GRID_WIDTH = 0;
let GRID_HEIGHT = 0;

(function buildLayout() {
	const ROW = [0, 1, 2, 3, 4, 5];
	const keys = [];
	const add = (id, name, x, row, w = 1) => keys.push({ id, name, cx: x + w / 2, row });
	const addRow = (x, row, list) => { for(const [name, id, w] of list) { add(id, name, x, row, w); x += w; } };

	for(let i = 0; i < 6; i++) { add(131 + i, "S" + (i + 1), 0, ROW[i]); }

	const x0 = 1.5;
	add(41, "Esc", x0, 0);

	for(let i = 0; i < 12; i++) { add(58 + i, "F" + (i + 1), x0 + 1.5 + i + Math.floor(i / 4) * 0.25, 0); }

	add(130, "Game Mode", x0 + 14.25, 0);
	add(138, "Stream Deck Key", x0 + 15.25, 0);
	add(76, "Del", x0 + 16.25, 0);

	addRow(x0, 1, [["`", 53, 1], ["1", 30, 1], ["2", 31, 1], ["3", 32, 1], ["4", 33, 1], ["5", 34, 1], ["6", 35, 1], ["7", 36, 1],
		["8", 37, 1], ["9", 38, 1], ["0", 39, 1], ["-_", 45, 1], ["=+", 46, 1], ["Backspace", 42, 2]]);
	addRow(x0, 2, [["Tab", 43, 1.5], ["Q", 20, 1], ["W", 26, 1], ["E", 8, 1], ["R", 21, 1], ["T", 23, 1], ["Y", 28, 1], ["U", 24, 1],
		["I", 12, 1], ["O", 18, 1], ["P", 19, 1], ["[", 47, 1], ["]", 48, 1], ["\\", 49, 1.5]]);
	addRow(x0, 3, [["CapsLock", 57, 1.75], ["A", 4, 1], ["S", 22, 1], ["D", 7, 1], ["F", 9, 1], ["G", 10, 1], ["H", 11, 1], ["J", 13, 1],
		["K", 14, 1], ["L", 15, 1], [";", 51, 1], ["'", 52, 1], ["ISO_#", 50, 1], ["Enter", 40, 1.25]]);
	addRow(x0, 4, [["Left Shift", 106, 1.25], ["ISO_<", 100, 1], ["Z", 29, 1], ["X", 27, 1], ["C", 6, 1], ["V", 25, 1], ["B", 5, 1], ["N", 17, 1], ["M", 16, 1],
		[",", 54, 1], [".", 55, 1], ["/", 56, 1], ["Right Shift", 110, 1.75], ["Up Arrow", 82, 1]]);
	addRow(x0, 5, [["Left Ctrl", 105, 1.25], ["Left Win", 108, 1.25], ["Left Alt", 107, 1.25], ["Space", 44, 6.25], ["Right Alt", 111, 1], ["Fn", 122, 1],
		["Copilot", 137, 1], ["Left Arrow", 80, 1], ["Down Arrow", 81, 1], ["Right Arrow", 79, 1]]);

	add(74, "Home", x0 + 15, 1);
	add(75, "PgUp", x0 + 15, 2);
	add(78, "PgDn", x0 + 15, 3);
	add(77, "End", x0 + 15, 4);

	const n = x0 + 16.75;
	addRow(n, 1, [["NumLock", 83, 1], ["Num /", 84, 1], ["Num *", 85, 1], ["Num -", 86, 1]]);
	addRow(n, 2, [["Num 7", 95, 1], ["Num 8", 96, 1], ["Num 9", 97, 1]]);
	addRow(n, 3, [["Num 4", 92, 1], ["Num 5", 93, 1], ["Num 6", 94, 1]]);
	addRow(n, 4, [["Num 1", 89, 1], ["Num 2", 90, 1], ["Num 3", 91, 1]]);
	addRow(n, 5, [["Num 0", 98, 2], ["Num .", 99, 1]]);
	add(87, "Num +", n + 3, 2);
	add(88, "Num Enter", n + 3, 4);

	for(const k of keys) {
		vLedNames.push(k.name);
		vLedPositions.push([Math.floor(k.cx), k.row]);
		vLedMap.push(k.id);
		GRID_WIDTH = Math.max(GRID_WIDTH, Math.floor(k.cx) + 1);
		GRID_HEIGHT = Math.max(GRID_HEIGHT, k.row + 1);
	}
})();
