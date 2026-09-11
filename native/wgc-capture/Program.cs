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

    public static async Task<int> Main(string[] args)
    {
        if (args.Length != 2 || !long.TryParse(args[0], out var hwndValue) || string.IsNullOrWhiteSpace(args[1]))
        {
            Console.Error.WriteLine("usage: dsh-pc-pilot-wgc <hwnd> <png-path>");
            return 2;
        }

        try
        {
            var item = CreateItem(new IntPtr(hwndValue));
            using var device = D3D11.D3D11CreateDevice(DriverType.Hardware, DeviceCreationFlags.BgraSupport, FeatureLevel.Level_11_0);
            using var dxgi = device.QueryInterface<IDXGIDevice>();
            var nativeDevice = IntPtr.Zero;
            var deviceHr = Native.CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out nativeDevice);
            if (deviceHr < 0) Marshal.ThrowExceptionForHR(deviceHr);
            // FromAbi wraps the IInspectable returned by the native bridge. The WinRT
            // projection owns that reference for the lifetime of this short-lived helper.
            var d3d = WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(nativeDevice);
            using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(d3d, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
            using var session = pool.CreateCaptureSession(item);
            session.StartCapture();

            Direct3D11CaptureFrame? frame = null;
            var timer = Stopwatch.StartNew();
            while (frame is null && timer.ElapsedMilliseconds < 2500)
            {
                frame = pool.TryGetNextFrame();
                if (frame is null) Thread.Sleep(16);
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
                var fullPath = Path.GetFullPath(args[1]);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
                File.WriteAllBytes(fullPath, bytes);
                Console.WriteLine($"{bitmap.PixelWidth} {bitmap.PixelHeight}");
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
