using System.Diagnostics;
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

[ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphicsCaptureItemInterop
{
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr result);
    [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr result);
}

static class Native
{
    [DllImport("combase.dll")] public static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string source, int length, out IntPtr hstring);
    [DllImport("combase.dll")] public static extern int WindowsDeleteString(IntPtr hstring);
    [DllImport("combase.dll")] public static extern int RoGetActivationFactory(IntPtr hstring, ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hwnd);
}

static class Program
{
    private static GraphicsCaptureItem CreateItem(IntPtr hwnd)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        var createHr = Native.WindowsCreateString(className, className.Length, out var hstring);
        if (createHr < 0) Marshal.ThrowExceptionForHR(createHr);
        try
        {
            var interopIid = typeof(IGraphicsCaptureItemInterop).GUID;
            var factoryHr = Native.RoGetActivationFactory(hstring, ref interopIid, out var factoryPtr);
            if (factoryHr < 0) Marshal.ThrowExceptionForHR(factoryHr);
            try
            {
                var interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factoryPtr);
                var itemIid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
                var itemHr = interop.CreateForWindow(hwnd, ref itemIid, out var itemPtr);
                if (itemHr < 0) Marshal.ThrowExceptionForHR(itemHr);
                try { return GraphicsCaptureItem.FromAbi(itemPtr); }
                finally { Marshal.Release(itemPtr); }
            }
            finally { Marshal.Release(factoryPtr); }
        }
        finally { Native.WindowsDeleteString(hstring); }
    }

    private static Vortice.Direct3D11.ID3D11Device? device;

    private static void EnsureDevice()
    {
        if (device is not null) return;
        device = D3D11.D3D11CreateDevice(DriverType.Hardware, DeviceCreationFlags.BgraSupport, FeatureLevel.Level_11_0);
    }

    private static IDirect3DDevice CreateWinRtDevice()
    {
        EnsureDevice();
        using var dxgi = device!.QueryInterface<IDXGIDevice>();
        var deviceHr = Native.CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var nativeDevice);
        if (deviceHr < 0) Marshal.ThrowExceptionForHR(deviceHr);
        return WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(nativeDevice);
    }

    private sealed class CaptureSlot : IDisposable
    {
        private readonly long hwndValue;
        private readonly GraphicsCaptureItem item;
        private readonly IDirect3DDevice d3d;
        private readonly Direct3D11CaptureFramePool pool;
        private readonly GraphicsCaptureSession session;
        private int width;
        private int height;
        private bool disposed;

        public DateTime LastUsedUtc { get; private set; } = DateTime.UtcNow;

        public CaptureSlot(long hwndValue)
        {
            this.hwndValue = hwndValue;
            var hwnd = new IntPtr(hwndValue);
            if (!Native.IsWindow(hwnd)) throw new ArgumentException("WGC target window no longer exists");

            item = CreateItem(hwnd);
            d3d = CreateWinRtDevice();
            width = item.Size.Width;
            height = item.Size.Height;
            if (width <= 0 || height <= 0) throw new InvalidOperationException("WGC target has invalid size");

            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                d3d,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                item.Size);
            session = pool.CreateCaptureSession(item);
            session.StartCapture();
        }

        private void RefreshSize()
        {
            var size = item.Size;
            if (size.Width <= 0 || size.Height <= 0) throw new InvalidOperationException("WGC target has invalid size");
            if (size.Width == width && size.Height == height) return;
            pool.Recreate(d3d, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
            width = size.Width;
            height = size.Height;
        }

        public async Task<(int Width, int Height)> CaptureAsync(string outputPath)
        {
            if (disposed) throw new ObjectDisposedException(nameof(CaptureSlot));
            if (!Native.IsWindow(new IntPtr(hwndValue))) throw new ArgumentException("WGC target window no longer exists");
            RefreshSize();

            Direct3D11CaptureFrame? frame = null;
            Direct3D11CaptureFrame? queued;
            while ((queued = pool.TryGetNextFrame()) is not null)
            {
                frame?.Dispose();
                frame = queued;
            }

            var timer = Stopwatch.StartNew();
            while (frame is null && timer.ElapsedMilliseconds < 2500)
            {
                frame = pool.TryGetNextFrame();
                if (frame is null) Thread.Sleep(8);
            }
            if (frame is null) throw new TimeoutException("WGC frame timeout");

            using (frame)
            using (var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface))
            using (var stream = new InMemoryRandomAccessStream())
            {
                var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
                encoder.SetSoftwareBitmap(bitmap);
                await encoder.FlushAsync();
                stream.Seek(0);
                using var reader = new DataReader(stream.GetInputStreamAt(0));
                var length = checked((uint)stream.Size);
                await reader.LoadAsync(length);
                var bytes = new byte[length];
                reader.ReadBytes(bytes);
                var fullPath = Path.GetFullPath(outputPath);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
                File.WriteAllBytes(fullPath, bytes);
                LastUsedUtc = DateTime.UtcNow;
                return (bitmap.PixelWidth, bitmap.PixelHeight);
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try { session.Dispose(); } catch { }
            try { pool.Dispose(); } catch { }
            try { (d3d as IDisposable)?.Dispose(); } catch { }
        }
    }

    private static readonly Dictionary<long, CaptureSlot> captureSlots = new();
    private static readonly TimeSpan captureSlotIdle = TimeSpan.FromSeconds(60);
    private const int MaxCaptureSlots = 8;

    private static void RemoveCaptureSlot(long hwndValue)
    {
        if (!captureSlots.Remove(hwndValue, out var slot)) return;
        slot.Dispose();
    }

    private static void PruneCaptureSlots()
    {
        var cutoff = DateTime.UtcNow - captureSlotIdle;
        foreach (var pair in captureSlots.ToArray())
        {
            if (!Native.IsWindow(new IntPtr(pair.Key)) || pair.Value.LastUsedUtc < cutoff)
                RemoveCaptureSlot(pair.Key);
        }
    }

    private static CaptureSlot GetCaptureSlot(long hwndValue)
    {
        if (!Native.IsWindow(new IntPtr(hwndValue)))
        {
            RemoveCaptureSlot(hwndValue);
            throw new ArgumentException("WGC target window no longer exists");
        }
        if (captureSlots.TryGetValue(hwndValue, out var existing)) return existing;
        while (captureSlots.Count >= MaxCaptureSlots)
        {
            var oldest = captureSlots.OrderBy(pair => pair.Value.LastUsedUtc).First();
            RemoveCaptureSlot(oldest.Key);
        }
        var created = new CaptureSlot(hwndValue);
        captureSlots[hwndValue] = created;
        return created;
    }

    private static async Task<(int Width, int Height)> CaptureOnceAsync(long hwndValue, string outputPath)
    {
        using var slot = new CaptureSlot(hwndValue);
        return await slot.CaptureAsync(outputPath);
    }

    private static async Task<int> RunServerAsync()
    {
        // PowerShell writes redirected stdin as UTF-8. Windows Console.InputEncoding
        // otherwise inherits the active code page (for example CP936), which turns
        // the first UTF-8 BOM into mojibake and corrupts non-ASCII temp paths.
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);

        try
        {
            string? line;
            while ((line = await Console.In.ReadLineAsync()) is not null)
            {
                line = line.TrimStart('\uFEFF');
                var parts = line.Split('\t', 2);
                if (parts.Length != 2 || !long.TryParse(parts[0], out var hwndValue) || string.IsNullOrWhiteSpace(parts[1]))
                {
                    Console.WriteLine("ERR invalid_request");
                    continue;
                }

                PruneCaptureSlots();
                try
                {
                    var slot = GetCaptureSlot(hwndValue);
                    var result = await slot.CaptureAsync(parts[1]);
                    Console.WriteLine($"OK {result.Width} {result.Height}");
                }
                catch (Exception error)
                {
                    RemoveCaptureSlot(hwndValue);
                    Console.WriteLine("ERR " + error.GetType().Name + " " + error.Message.Replace('\r', ' ').Replace('\n', ' '));
                }
            }
            return 0;
        }
        finally
        {
            foreach (var hwndValue in captureSlots.Keys.ToArray()) RemoveCaptureSlot(hwndValue);
        }
    }

    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--server") return await RunServerAsync();
        if (args.Length != 2 || !long.TryParse(args[0], out var hwndValue) || string.IsNullOrWhiteSpace(args[1]))
        {
            Console.Error.WriteLine("usage: dsh-pc-pilot-wgc <hwnd> <png-path> | --server");
            return 2;
        }

        try
        {
            var result = await CaptureOnceAsync(hwndValue, args[1]);
            Console.WriteLine($"{result.Width} {result.Height}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
