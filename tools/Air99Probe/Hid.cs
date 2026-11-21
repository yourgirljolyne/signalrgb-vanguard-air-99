using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Air99Probe;

/// <summary>Minimal Windows HID access via SetupAPI + hid.dll. No external packages.</summary>
public sealed class HidDevice : IDisposable
{
    public string Path { get; }
    public ushort UsagePage { get; }
    public ushort Usage { get; }
    public int InputReportLength { get; }   // includes the report-id byte
    public int OutputReportLength { get; }  // includes the report-id byte

    private readonly SafeFileHandle _handle;
    private readonly FileStream _stream;

    private HidDevice(string path, SafeFileHandle handle, HIDP_CAPS caps)
    {
        Path = path;
        _handle = handle;
        UsagePage = caps.UsagePage;
        Usage = caps.Usage;
        InputReportLength = caps.InputReportByteLength;
        OutputReportLength = caps.OutputReportByteLength;
        _stream = new FileStream(handle, FileAccess.ReadWrite, 0, isAsync: true);
    }

    /// <summary>Finds the HID interface with the given VID/PID and vendor usage page.</summary>
    public static HidDevice? Open(ushort vid, ushort pid, ushort usagePage, ushort usage)
    {
        string needle = $"vid_{vid:x4}&pid_{pid:x4}";
        foreach (var path in EnumerateHidPaths())
        {
            if (!path.Contains(needle, StringComparison.OrdinalIgnoreCase)) continue;

            var h = CreateFile(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero);
            if (h.IsInvalid) continue;

            if (!TryGetCaps(h, out var caps) || caps.UsagePage != usagePage || caps.Usage != usage)
            {
                h.Dispose();
                continue;
            }
            return new HidDevice(path, h, caps);
        }
        return null;
    }

    /// <summary>Lists every HID interface of a VID/PID with its usage page (for diagnostics).</summary>
    public static IEnumerable<(string path, ushort page, ushort usage, int inLen, int outLen)> Describe(ushort vid, ushort pid)
    {
        string needle = $"vid_{vid:x4}&pid_{pid:x4}";
        foreach (var path in EnumerateHidPaths())
        {
            if (!path.Contains(needle, StringComparison.OrdinalIgnoreCase)) continue;
            // Open with no access rights: enough to read caps even for keyboard/mouse collections.
            using var h = CreateFile(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (h.IsInvalid) continue;
            if (TryGetCaps(h, out var c))
                yield return (path, c.UsagePage, c.Usage, c.InputReportByteLength, c.OutputReportByteLength);
        }
    }

    /// <summary>Sends one packet (without report id). It is padded to the report length.</summary>
    public async Task WriteAsync(ReadOnlyMemory<byte> packet, CancellationToken ct)
    {
        var buf = new byte[OutputReportLength];
        buf[0] = 0; // report id
        packet.Span.Slice(0, Math.Min(packet.Length, buf.Length - 1)).CopyTo(buf.AsSpan(1));
        await _stream.WriteAsync(buf, ct);
    }

    /// <summary>Reads one input report and returns it without the report id byte.</summary>
    public async Task<byte[]> ReadAsync(CancellationToken ct)
    {
        var buf = new byte[InputReportLength];
        int n = await _stream.ReadAsync(buf, ct);
        return buf.AsSpan(1, Math.Max(0, n - 1)).ToArray();
    }

    public void Dispose()
    {
        _stream.Dispose();
        _handle.Dispose();
    }

    // ---------------- interop ----------------

    private static bool TryGetCaps(SafeFileHandle h, out HIDP_CAPS caps)
    {
        caps = default;
        if (!HidD_GetPreparsedData(h, out var pp)) return false;
        try { return HidP_GetCaps(pp, out caps) == HIDP_STATUS_SUCCESS; }
        finally { HidD_FreePreparsedData(pp); }
    }

    private static IEnumerable<string> EnumerateHidPaths()
    {
        HidD_GetHidGuid(out var guid);
        var set = SetupDiGetClassDevs(ref guid, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
        if (set == new IntPtr(-1)) throw new Win32Exception();
        var paths = new List<string>();
        try
        {
            var ifData = new SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf<SP_DEVICE_INTERFACE_DATA>() };
            for (uint i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, i, ref ifData); i++)
            {
                SetupDiGetDeviceInterfaceDetail(set, ref ifData, IntPtr.Zero, 0, out int size, IntPtr.Zero);
                var detail = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6); // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W
                    if (SetupDiGetDeviceInterfaceDetail(set, ref ifData, detail, size, out _, IntPtr.Zero))
                        paths.Add(Marshal.PtrToStringUni(detail + 4)!);
                }
                finally { Marshal.FreeHGlobal(detail); }
            }
        }
        finally { SetupDiDestroyDeviceInfoList(set); }
        return paths;
    }

    private const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3, FILE_FLAG_OVERLAPPED = 0x40000000;
    private const int DIGCF_PRESENT = 2, DIGCF_DEVICEINTERFACE = 0x10;
    private const int HIDP_STATUS_SUCCESS = 0x00110000;

    [StructLayout(LayoutKind.Sequential)]
    private struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    private struct HIDP_CAPS
    {
        public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
        public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices,
            NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices,
            NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
    }

    [DllImport("hid.dll")] private static extern void HidD_GetHidGuid(out Guid guid);
    [DllImport("hid.dll")] private static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr data);
    [DllImport("hid.dll")] private static extern bool HidD_FreePreparsedData(IntPtr data);
    [DllImport("hid.dll")] private static extern int HidP_GetCaps(IntPtr data, out HIDP_CAPS caps);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr enumerator, IntPtr parent, int flags);
    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, uint idx, ref SP_DEVICE_INTERFACE_DATA data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int size, out int required, IntPtr info);
    [DllImport("setupapi.dll")] private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
}
