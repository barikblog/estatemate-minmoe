// Native bindings for Hikvision's Device Network SDK (HCNetSDK).
//
// Kept in its own file so the P/Invoke surface is auditable in one place: this is
// the only code in EstateMate that talks to vendor native code, and every symbol
// here is one this helper checked for at run time (`probe`) before using it.
//
// Reference: Hikvision's HCNetSDK.h and the "Device Network SDK Programming
// Manual" (Windows HCNetSDK.dll / Linux libhcnetsdk.so). The struct layouts below
// follow that header with the compiler's default packing, which is what the
// vendor library was built with. Two deliberate defences:
//
//   * Out-buffers (device info, alarm parameters) end with a generous reserve.
//     A struct *larger* than the vendor's is harmless — the SDK writes only its
//     own size — while a smaller one is memory corruption. `--layout` prints the
//     offsets and sizes this build actually uses, so they can be compared with
//     your HCNetSDK.h in a minute.
//   * Every field the event reader takes from the alarm payload is validated
//     before it is reported (card numbers must look like card numbers), so a
//     layout that differs in some SDK version degrades to "unmapped" instead of
//     filing a wrong card number as gate history.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace EstateMate.HikSdk
{
    internal static class Native
    {
        // On Windows the runtime resolves this to HCNetSDK.dll (case-insensitive
        // file system); on Linux to libhcnetsdk.so. Both must sit next to the
        // helper, with Hikvision's HCNetSDKCom folder beside them on Windows.
        internal const string Dll = "hcnetsdk";

        internal const int COMM_ALARM_ACS = 0x5002;
        internal const int NET_DVR_GET_TIMECFG = 118; // HCNetSDK.h; verify in --layout/--selftest
        internal const int NET_DVR_SET_TIMECFG = 119;

        // ---------------------------------------------------------- entry points ---

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_Init();

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_Cleanup();

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_SetConnectTime(uint waitTime, uint tryTimes);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_SetReconnect(uint interval, int enableReconnect);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern uint NET_DVR_GetLastError();

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern uint NET_DVR_GetSDKVersion();

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern int NET_DVR_Login_V40(ref NET_DVR_USER_LOGIN_INFO loginInfo, ref NET_DVR_DEVICEINFO_V40 deviceInfo);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_Logout(int userId);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_SetDVRMessageCallBack_V50(int index, MsgCallback callback, IntPtr user);

        // The alarmer argument is taken as an IntPtr rather than as a struct: the
        // helper does not read it, and an IntPtr cannot be the wrong size.
        internal delegate void MsgCallback(int lCommand, IntPtr alarmer, IntPtr alarmInfo, uint bufferLength, IntPtr user);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern int NET_DVR_SetupAlarmChan_V41(int userId, ref NET_DVR_SETUPALARM_PARAM setupParam);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_CloseAlarmChan_V30(int alarmHandle);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_ControlGateway(int userId, int gatewayIndex, uint command);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_GetDVRConfig(int userId, int command, int channel, IntPtr outBuffer, uint outBufferSize, ref uint bytesReturned);

        [DllImport(Dll, CallingConvention = CallingConvention.StdCall)]
        internal static extern bool NET_DVR_SetDVRConfig(int userId, int command, int channel, IntPtr inBuffer, uint inBufferSize, ref uint bytesReturned);

        // -------------------------------------------------------------- structures ---

        [StructLayout(LayoutKind.Sequential)]
        internal struct NET_DVR_TIME
        {
            public uint Year;
            public uint Month;
            public uint Day;
            public uint Hour;
            public uint Minute;
            public uint Second;

            internal void Fill(DateTime value)
            {
                Year = (uint)value.Year;
                Month = (uint)value.Month;
                Day = (uint)value.Day;
                Hour = (uint)value.Hour;
                Minute = (uint)value.Minute;
                Second = (uint)value.Second;
            }

            internal DateTime ToDateTime()
            {
                int second = (int)Math.Min(Second, 59u);
                if (Year < 2000 || Year > 2100 || Month < 1 || Month > 12 || Day < 1 || Day > 31
                    || Hour > 23 || Minute > 59)
                {
                    throw new InvalidOperationException("the terminal returned " + Year + "-" + Month + "-" + Day + " " + Hour + ":" + Minute + ":" + Second + ", which is not a date");
                }
                return new DateTime((int)Year, (int)Month, (int)Day, (int)Hour, (int)Minute, second, DateTimeKind.Local);
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        internal struct NET_DVR_USER_LOGIN_INFO
        {
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 129)] public byte[] DeviceAddress;
            public byte UseTransport;      // 0 = TCP
            public ushort Port;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] UserName;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] Password;
            public IntPtr LoginResultCallback;
            public IntPtr User;
            public int UseAsyncLogin;      // BOOL, 0 = synchronous
            public byte ProxyType;
            public byte UseUtcTime;
            public byte LoginMode;
            public byte UseHttps;
            public int ProxyId;
            public byte VerifyMode;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 119)] public byte[] Reserved;

            internal void Init(string host, ushort port, string userName, string password)
            {
                DeviceAddress = new byte[129];
                UserName = new byte[32];
                Password = new byte[16];
                Reserved = new byte[119];
                byte[] address = Encoding.ASCII.GetBytes(host ?? string.Empty);
                Array.Copy(address, DeviceAddress, Math.Min(address.Length, DeviceAddress.Length - 1));
                byte[] user = Encoding.ASCII.GetBytes(userName ?? string.Empty);
                Array.Copy(user, UserName, Math.Min(user.Length, UserName.Length - 1));
                byte[] secret = Encoding.ASCII.GetBytes(password ?? string.Empty);
                Array.Copy(secret, Password, Math.Min(secret.Length, Password.Length - 1));
                Port = port;
                UseTransport = 0;
                UseAsyncLogin = 0;
                UseHttps = 0;
                LoginResultCallback = IntPtr.Zero;
                User = IntPtr.Zero;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NET_DVR_DEVICEINFO_V30
        {
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 48)] public byte[] SerialNumber;
            public byte AlarmInPortNum;
            public byte AlarmOutPortNum;
            public byte DiskNum;
            public byte DvrType;
            public byte ChanNum;
            public byte StartChan;
            public byte AudioChanNum;
            public byte IpChanNum;
            public byte ZeroChanNum;
            public byte MainProto;
            public byte SubProto;
            public byte Support;
            public byte Support1;
            public byte Support2;
            public ushort DevType;
            public byte Support3;
            public byte MultiStreamProto;
            public byte StartDChan;
            public byte StartDTalkChan;
            public byte HighDChanNum;
            public byte Support4;
            public byte LanguageType;
            public byte VoiceInChanNum;
            public byte StartVoiceInChanNo;
            public byte Support5;
            public byte Support6;
            public byte MirrorChanNum;
            public ushort StartMirrorChanNo;
            public byte Support7;
            public byte Reserved;
        }

        /// <summary>
        /// The login out-buffer. The documented fields are followed by a large
        /// reserve on purpose: the SDK writes its own size, and a buffer smaller
        /// than the version on this machine would corrupt memory.
        /// </summary>
        [StructLayout(LayoutKind.Sequential)]
        internal struct NET_DVR_DEVICEINFO_V40
        {
            public NET_DVR_DEVICEINFO_V30 Device;
            public byte SupportLock;
            public byte RetryLoginTime;
            public byte PasswordLevel;
            public byte ProxyType;
            public uint SurplusLockTime;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public byte[] Reserved;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 1024)] public byte[] SafetyReserve;

            /// <summary>
            /// Only what this struct really carries, and only when it reads as
            /// text: the login reply has the serial number, the channel count and
            /// the device type. The model and firmware strings live behind a
            /// separate configuration read whose struct this helper does not
            /// decode yet — an operator sees them in iVMS-4200 or on the device's
            /// own web page, and the agent logs what it was given rather than a
            /// blank it made up.
            /// </summary>
            /// <summary>
            /// Allocates the fixed-size arrays before the SDK writes into them:
            /// a null ByValArray field is an error in the marshaller, not an
            /// empty buffer.
            /// </summary>
            internal void Init()
            {
                Device.SerialNumber = new byte[48];
                Reserved = new byte[256];
                SafetyReserve = new byte[1024];
            }

            internal Dictionary<string, object> ToDictionary()
            {
                Dictionary<string, object> info = new Dictionary<string, object>();
                info["serialNumber"] = ReadAscii(Device.SerialNumber);
                info["channelCount"] = (int)Device.ChanNum;
                info["startChannel"] = (int)Device.StartChan;
                info["deviceType"] = (int)Device.DvrType;
                return info;
            }

            private static string ReadAscii(byte[] bytes)
            {
                if (bytes == null) return "";
                int end = 0;
                while (end < bytes.Length && bytes[end] != 0) end++;
                string text = Encoding.ASCII.GetString(bytes, 0, end).Trim();
                if (text.Length == 0) return "";
                foreach (char c in text)
                {
                    if (c < 0x20 || c > 0x7E) return "";
                }
                return text;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NET_DVR_SETUPALARM_PARAM
        {
            public uint Size;
            public byte Level;
            public byte AlarmInfoType;
            public byte RetAlarmTypeV40;
            public byte RetDevInfoVersion;
            public byte RetVqdAlarmType;
            public byte FaceAlarmDetection;
            public byte Support;
            public byte BrokenNetHttp;
            public ushort TaskNo;
            public byte DeployType;
            public byte SubscribeMode;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 64)] public byte[] Reserved;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 512)] public byte[] SafetyReserve;

            internal void Init()
            {
                Reserved = new byte[64];
                SafetyReserve = new byte[512];
                try
                {
                    Size = (uint)Marshal.SizeOf(typeof(NET_DVR_SETUPALARM_PARAM));
                }
                catch (Exception)
                {
                    Size = 0;
                }
                Level = 1;          // highest-priority information
                AlarmInfoType = 1;  // alarm and event information
                RetAlarmTypeV40 = 1;
            }
        }

        // -------------------------------------------------- vendor error wording ---

        /// <summary>
        /// The vendor's own error numbers, for the handful an operator actually
        /// meets. Unknown numbers are printed as numbers: a wrong sentence would be
        /// worse than none.
        /// </summary>
        internal static string ErrorText(uint error)
        {
            switch (error)
            {
                case 1: return "the user name or password is incorrect";
                case 2: return "permission denied by the device";
                case 3: return "the SDK has not been initialised (NET_DVR_Init)";
                case 4: return "the channel is wrong or the device rejected the request";
                case 7: return "connecting to the device timed out";
                case 8: return "sending data failed";
                case 9: return "receiving data failed";
                case 10: return "receiving data timed out";
                case 21: return "the device is busy — try again later";
                case 23: return "the device does not support this operation";
                case 29: return "the device name is invalid";
                case 41: return "the device connection failed (the address or SDK port may be wrong)";
                case 46: return "the account is locked after repeated failed logins";
                case 73: return "the user name or password is incorrect";
                default: return "vendor error " + error;
            }
        }

        // ------------------------------------------------- load-time symbol checks ---

        [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Ansi)]
        private static extern IntPtr LoadLibrary(string fileName);

        [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Ansi)]
        private static extern IntPtr GetProcAddress(IntPtr module, string name);

        [DllImport("libdl.so.2", SetLastError = true)]
        private static extern IntPtr dlopen(string fileName, int flags);

        [DllImport("libdl.so.2", SetLastError = true)]
        private static extern IntPtr dlsym(IntPtr handle, string name);

        [DllImport("libc", SetLastError = true)]
        private static extern IntPtr dlerror();

        internal static bool IsWindows()
        {
            return Environment.OSVersion.Platform == PlatformID.Win32NT;
        }

        internal static IntPtr LoadLibrarySymbolTable(string fileName)
        {
            if (IsWindows()) return LoadLibrary(fileName);
            try
            {
                return dlopen(fileName, 2 /* RTLD_NOW */);
            }
            catch (Exception)
            {
                return IntPtr.Zero;
            }
        }

        internal static bool SymbolExists(IntPtr handle, string name)
        {
            if (handle == IntPtr.Zero) return false;
            if (IsWindows()) return GetProcAddress(handle, name) != IntPtr.Zero;
            try
            {
                return dlsym(handle, name) != IntPtr.Zero;
            }
            catch (Exception)
            {
                return false;
            }
        }

        internal static string LastLoadError()
        {
            if (IsWindows())
            {
                int code = Marshal.GetLastWin32Error();
                return "LoadLibrary failed with win32 error " + code;
            }
            try
            {
                IntPtr message = dlerror();
                if (message != IntPtr.Zero) return Marshal.PtrToStringAnsi(message);
            }
            catch (Exception) { }
            return "dlopen failed";
        }

    }
}
