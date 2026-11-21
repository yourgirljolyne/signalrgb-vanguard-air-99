using System.Buffers.Binary;
using System.Security.Cryptography;
using Air99Probe;

// Air 99 lighting probe (Bragi v1.5, command channel MI_02 usage page 0xFF42 usage 1).
// Every run is logged to ..\..\logs so results can be shared.
//
//   info                         read-only: mode, brightness, layout, firmware, LightingController open/describe
//   frame <leds> <r> <g> <b> <ms>  software mode, ONE colour frame to endpoint 0x22, hold, back to hardware mode
//   props                        read every property 0-511 in hardware and software mode, show differences
//   stream <leds> <n> <ms>       software mode, n frames (teal x5, red x5, ...), back to hardware mode
//   restore                      fresh connection: unbind buffers 0/1, hardware mode
//
// Nothing here writes to flash. If a step times out, the probe reconnects and restores hardware mode.

const ushort Vid = 0x1B1C, Pid = 0x2B21;
const byte CmdSet = 1, CmdGet = 2, CmdUnbind = 5, CmdWriteBegin = 6, CmdDescribe = 9, CmdOpen = 13, CmdSession = 27;
const ushort PropBrightness = 2, PropMode = 3, PropFirmware = 0x13, PropLayout = 0x41;
const byte EpLightingController = 0x22, DataTypeLightingController = 0x12;

var logDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "logs"));
if (!Directory.Exists(logDir)) logDir = AppContext.BaseDirectory;
var logPath = Path.Combine(logDir, $"probe-{DateTime.Now:yyyyMMdd-HHmmss}-{(args.Length > 0 ? args[0] : "info")}.txt");
using var log = new StreamWriter(logPath) { AutoFlush = true };
void Log(string s) { Console.WriteLine(s); log.WriteLine(s); }
Log($"Air99Probe {string.Join(' ', args)}  {DateTime.Now:yyyy-MM-dd HH:mm:ss}");

var phase = args.Length > 0 ? args[0] : "info";
var link = Link.Connect(Log);
try
{
    switch (phase)
    {
        case "info":
            await link.Get("mode", PropMode);
            await link.Get("brightness", PropBrightness);
            await link.Get("layout (1 ANSI, 2 ISO)", PropLayout);
            await link.Get("firmware", PropFirmware);
            if ((await link.Cmd("open buf 1 on 0x22", CmdOpen, 1, EpLightingController, 0))?[4] == 0)
            {
                await link.Cmd("describe buf 1", CmdDescribe, 1);
                await link.Cmd("unbind buf 1", CmdUnbind, 1, 1);
            }
            break;

        case "frame":
        {
            int leds = int.Parse(args[1]);
            byte r = byte.Parse(args[2]), g = byte.Parse(args[3]), b = byte.Parse(args[4]);
            int holdMs = int.Parse(args[5]);
            var data = new byte[2 + leds * 3];
            data[0] = DataTypeLightingController;
            for (int i = 0; i < leds; i++) { data[2 + i * 3] = r; data[3 + i * 3] = g; data[4 + i * 3] = b; }
            if (data.Length > link.ReportLength - 9) throw new Exception("frame larger than one packet; not supported in this probe");

            bool ok = false;
            try
            {
                await link.Get("mode before", PropMode);
                if (await link.Cmd("set mode 2 (software)", CmdSet, Prop(PropMode, 2)) == null) return;
                if ((await link.Cmd("open buf 0 on 0x22", CmdOpen, 0, EpLightingController, 0))?[4] != 0) return;
                var p = new byte[5 + data.Length];
                BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(1), (uint)data.Length);
                data.CopyTo(p, 5);
                Log($"frame: {leds} LEDs, {data.Length} bytes, colour {r},{g},{b}");
                var reply = await link.Cmd("write begin (frame)", CmdWriteBegin, p);
                if (reply == null) return;
                Log($"holding {holdMs} ms - look at the keyboard");
                await Task.Delay(holdMs);
                ok = await link.Cmd("unbind buf 0", CmdUnbind, 1, 0) != null
                     && await link.Cmd("set mode 1 (hardware)", CmdSet, Prop(PropMode, 1)) != null;
                await link.Get("mode after", PropMode);
                await link.Get("brightness after", PropBrightness);
            }
            finally
            {
                if (!ok) { Log("!! a step failed or timed out; reconnecting to restore hardware mode"); link.Dispose(); link = Link.Connect(Log); await Restore(link); }
            }
            break;
        }

        case "props":
        {
            // Read every property 0..511 in hardware mode, then in software mode, and print the ones that exist or differ.
            async Task<Dictionary<int, uint>> Dump()
            {
                var d = new Dictionary<int, uint>();
                for (int id = 0; id < 512; id++)
                {
                    var r = await link.RawQuiet(2, (byte)id, (byte)(id >> 8));
                    if (r != null && r[4] == 0) d[id] = BinaryPrimitives.ReadUInt32LittleEndian(r.AsSpan(5));
                }
                return d;
            }
            var hw = await Dump();
            bool ok = false;
            try
            {
                await link.Cmd("set mode 2 (software)", CmdSet, Prop(PropMode, 2));
                var sw = await Dump();
                ok = await link.Cmd("set mode 1 (hardware)", CmdSet, Prop(PropMode, 1)) != null;
                Log($"{hw.Count} properties readable in hardware mode, {sw.Count} in software mode");
                foreach (var id in hw.Keys.Union(sw.Keys).Order())
                {
                    string a = hw.TryGetValue(id, out var x) ? x.ToString() : "-", b = sw.TryGetValue(id, out var y) ? y.ToString() : "-";
                    Log($"  prop {id,3} (0x{id:X3})  hw {a,12}  sw {b,12}{(a != b ? "   <-- differs" : "")}");
                }
            }
            finally { if (!ok) { link.Dispose(); link = Link.Connect(Log); await Restore(link); } }
            await link.Get("mode after", PropMode);
            break;
        }

        case "stream":
        {
            // stream <leds> <frames> <intervalMs>: alternating teal / red frames, one reply read per frame, stop on first problem.
            int leds = int.Parse(args[1]), frames = int.Parse(args[2]), interval = int.Parse(args[3]);
            bool ok = false;
            try
            {
                if (await link.Cmd("set mode 2 (software)", CmdSet, Prop(PropMode, 2)) == null) return;
                if ((await link.Cmd("open buf 0 on 0x22", CmdOpen, 0, EpLightingController, 0))?[4] != 0) return;
                for (int f = 0; f < frames; f++)
                {
                    (byte r, byte g, byte b) c = (f / 5) % 2 == 0 ? ((byte)0, (byte)155, (byte)222) : ((byte)255, (byte)0, (byte)0);
                    var data = new byte[2 + leds * 3];
                    data[0] = DataTypeLightingController;
                    for (int i = 0; i < leds; i++) { data[2 + i * 3] = c.r; data[3 + i * 3] = c.g; data[4 + i * 3] = c.b; }
                    var p = new byte[5 + data.Length];
                    BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(1), (uint)data.Length);
                    data.CopyTo(p, 5);
                    var reply = await link.Cmd($"frame {f + 1}/{frames} {(c.r == 0 ? "teal" : "red")}", CmdWriteBegin, p);
                    if (reply == null || reply[4] != 0) return;
                    await Task.Delay(interval);
                }
                ok = await link.Cmd("unbind buf 0", CmdUnbind, 1, 0) != null
                     && await link.Cmd("set mode 1 (hardware)", CmdSet, Prop(PropMode, 1)) != null;
                await link.Get("mode after", PropMode);
            }
            finally
            {
                if (!ok) { Log("!! a step failed or timed out; reconnecting to restore hardware mode"); link.Dispose(); link = Link.Connect(Log); await Restore(link); }
            }
            break;
        }

        case "restore":
            await Restore(link);
            break;
    }
}
finally { await link.Close(); Log($"log: {logPath}"); }

static byte[] Prop(ushort id, uint v) { var p = new byte[6]; BinaryPrimitives.WriteUInt16LittleEndian(p, id); BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(2), v); return p; }

async Task Restore(Link l)
{
    await l.Cmd("unbind buf 0", CmdUnbind, 1, 0);
    await l.Cmd("unbind buf 1", CmdUnbind, 1, 1);
    await l.Cmd("set mode 1 (hardware)", CmdSet, Prop(PropMode, 1));
    var m = await l.Get("mode", PropMode);
    Log(m == 1 ? "restored: keyboard is in hardware mode" : "!! could not confirm hardware mode - unplug and replug the cable");
}

sealed class Link : IDisposable
{
    private readonly HidDevice _dev;
    private readonly Action<string> _log;
    private byte _session;
    public int ReportLength => _dev.OutputReportLength - 1;

    private Link(HidDevice dev, Action<string> log) { _dev = dev; _log = log; }

    public static Link Connect(Action<string> log)
    {
        var dev = HidDevice.Open(0x1B1C, 0x2B21, 0xFF42, 0x01) ?? throw new Exception("Air 99 command channel not found (is the cable plugged in?)");
        var l = new Link(dev, log);
        var payload = new byte[6]; payload[0] = 1; RandomNumberGenerator.Fill(payload.AsSpan(1, 4));
        var r = l.Raw("start session", 0, 27, payload).GetAwaiter().GetResult();
        l._session = r != null && r.Length > 9 ? r[9] : (byte)0;
        log($"session {l._session}");
        return l;
    }

    public Task<byte[]?> Cmd(string label, byte cmd, params byte[] payload) => Raw(label, _session, cmd, payload);

    /// <summary>Same as Cmd but without logging (for bulk property reads).</summary>
    public async Task<byte[]?> RawQuiet(byte cmd, params byte[] payload)
    {
        var p = new byte[4 + payload.Length];
        p[1] = 1; p[2] = _session; p[3] = cmd;
        payload.CopyTo(p, 4);
        using var cts = new CancellationTokenSource(1500);
        try { await _dev.WriteAsync(p, cts.Token); return await _dev.ReadAsync(cts.Token); }
        catch (OperationCanceledException) { return null; }
    }

    public async Task<uint?> Get(string label, ushort id)
    {
        var r = await Cmd($"get {label}", 2, (byte)id, (byte)(id >> 8));
        if (r == null || r[4] != 0) return null;
        uint v = BinaryPrimitives.ReadUInt32LittleEndian(r.AsSpan(5));
        _log($"    = {v}");
        return v;
    }

    private async Task<byte[]?> Raw(string label, byte session, byte cmd, byte[] payload)
    {
        var p = new byte[4 + payload.Length];
        p[1] = 1; p[2] = session; p[3] = cmd;
        payload.CopyTo(p, 4);
        using var cts = new CancellationTokenSource(1500);
        try
        {
            await _dev.WriteAsync(p, cts.Token);
            var r = await _dev.ReadAsync(cts.Token);
            string status = r.Length > 4 ? (r[1] == 0x0F ? "NO SESSION" : r[4] == 0 ? "ok" : $"status {r[4]}") : "?";
            _log($"{label,-26} {status,-10} {BitConverter.ToString(r, 0, Math.Min(12, r.Length))}");
            return r;
        }
        catch (OperationCanceledException) { _log($"{label,-26} TIMEOUT (write or read did not complete in 1.5 s)"); return null; }
    }

    public async Task Close()
    {
        try { await Raw("stop session", _session, 27, [2, 0, 0, 0, 0, _session]); } catch { }
        Dispose();
    }

    public void Dispose() => _dev.Dispose();
}
