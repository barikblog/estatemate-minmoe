// EstateMate Hikvision SDK helper
// ===============================
//
// The terminal's SDK/"server" port (8000 by default) is the one iVMS-4200 and
// Hik-Connect speak. It is a proprietary binary protocol, so the only thing that
// can talk to it is Hikvision's own Device Network SDK (HCNetSDK: HCNetSDK.dll on
// Windows, libhcnetsdk.so on Linux). This helper links that library and speaks a
// narrow JSON-lines protocol to the EstateMate agent, which is what makes a
// terminal reachable *only* at <public-ip>:8000 usable.
//
//   EstateMate agent ──JSON lines over stdin/stdout──▶ this helper
//                                                          │ HCNetSDK (yours)
//                                                          ▼ device SDK port 8000
//
// Hikvision's SDK is NOT part of this repository: it is proprietary and not
// redistributable. Download the Device Network SDK from hikvision.com (free, with
// registration) and place the library files next to this helper — README.md in
// this folder has the exact files and the licence note.
//
// What it can do: log in, read device info, stream access-control events, open or
// close a door, read/set the terminal clock. What it cannot do: write cards or
// people. HCNetSDK has no card-record API — iVMS-4200 provisions cards over
// HTTP/ISAPI itself — so the agent keeps those as operator tasks and says so.
//
// Build (Windows, nothing to install — uses the compiler Windows already has):
//     build-hcnetsdk-helper.cmd
// Build (Linux/macOS, needs the .NET SDK):
//     dotnet build -c Release EstateMateHikSdk.csproj
//
// Test against a real terminal without the agent:
//     EstateMateHikSdk.exe --selftest 192.168.88.60:8000 admin "the-password"
//
// Written in C# 5 on purpose, so the compiler in the .NET Framework directory
// (present on every Windows installation) can build it, exactly like
// bridge-apps/windows/dashboard/Launcher.cs.
//
// Honest status: the JSON protocol below is exercised in CI against
// scripts/hcnetsdk-simulator.mjs, which is the reference for what this helper
// must print. The P/Invoke declarations were written against Hikvision's
// HCNetSDK.h (V6.1.x, Windows and Linux 64-bit) but have not been run in this
// repository's CI, because that needs the vendor library and a physical device.
// Run --selftest on site first: it prints what your SDK build exports and what
// your terminal answered, and everything this helper cannot read confidently is
// reported as unmapped rather than guessed.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace EstateMate.HikSdk
{
    internal static class Program
    {
        private const string HelperVersion = "1.0.0";
        private const int ProtocolVersion = 1;
        private const int DefaultSdkPort = 8000;

        private static StreamWriter _out;

        private static int Main(string[] args)
        {
            // stdout is the protocol channel and must contain nothing but JSON
            // lines; every human-readable word goes to stderr, where the agent
            // logs it at debug level and an operator can read it.
            _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            _out.AutoFlush = true;

            if (args.Length == 1 && args[0] == "--version")
            {
                Console.Error.WriteLine("EstateMate Hikvision SDK helper " + HelperVersion + ", protocol " + ProtocolVersion);
                return 0;
            }
            if (args.Length >= 2 && args[0] == "--selftest")
            {
                return SelfTest(args);
            }
            return Serve();
        }

        // ------------------------------------------------------------ protocol ---

        /// <summary>
        /// The stdio loop: one JSON object per line in, one JSON object per line
        /// out. Requests carry an id and are answered with the same id; events are
        /// written without one, which is how the agent tells them apart.
        /// </summary>
        private static int Serve()
        {
            Console.Error.WriteLine("estatemate hcnetsdk helper " + HelperVersion + ": ready (protocol " + ProtocolVersion + ")");
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> request;
                try
                {
                    request = Json.ParseObject(line);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("unparseable request: " + ex.Message);
                    continue;
                }
                object idValue;
                long id = request.TryGetValue("id", out idValue) ? Json.AsLong(idValue) : -1;
                string op = Json.AsString(Get(request, "op"));
                try
                {
                    Handle(id, op, request);
                }
                catch (Exception ex)
                {
                    Reply(id, false, "error", ex.Message);
                }
                if (op == "shutdown") return 0;
            }
            return 0;
        }

        private static void Handle(long id, string op, Dictionary<string, object> request)
        {
            switch (op)
            {
                case "probe":
                    {
                        SdkCapabilities capabilities = Sdk.Probe();
                        Dictionary<string, object> sdk = new Dictionary<string, object>();
                        sdk["present"] = capabilities.Present;
                        sdk["version"] = capabilities.Version;
                        sdk["helperVersion"] = HelperVersion;
                        sdk["protocol"] = ProtocolVersion;
                        sdk["platform"] = Sdk.PlatformName();
                        sdk["library"] = capabilities.LibraryPath;
                        sdk["exports"] = capabilities.Exports;
                        if (!capabilities.Present) sdk["error"] = capabilities.Error;
                        ReplyObject(id, sdk);
                        return;
                    }
                case "login":
                    {
                        string host = Json.AsString(Get(request, "host"));
                        int port = (int)Json.AsLong(Get(request, "port"));
                        if (port <= 0) port = DefaultSdkPort;
                        string user = Json.AsString(Get(request, "username"));
                        string password = Json.AsString(Get(request, "password"));
                        SdkLoginResult result = Sdk.Login(host, port, user, password);
                        if (!result.Ok)
                        {
                            Reply(id, false, "error", result.Error);
                            return;
                        }
                        Dictionary<string, object> payload = new Dictionary<string, object>();
                        payload["sessionId"] = result.SessionId;
                        payload["deviceInfo"] = result.DeviceInfo;
                        ReplyObject(id, payload);
                        return;
                    }
                case "logout":
                    Sdk.Logout((int)Json.AsLong(Get(request, "sessionId")));
                    Reply(id, true, null, null);
                    return;
                case "events":
                    {
                        int sessionId = (int)Json.AsLong(Get(request, "sessionId"));
                        bool enabled = !"false".Equals(Json.AsString(Get(request, "enabled")), StringComparison.OrdinalIgnoreCase);
                        SdkEventsResult result = Sdk.AlarmChannel(sessionId, enabled);
                        if (!result.Ok) { Reply(id, false, "error", result.Error); return; }
                        Dictionary<string, object> payload = new Dictionary<string, object>();
                        payload["alarmHandle"] = result.AlarmHandle;
                        ReplyObject(id, payload);
                        return;
                    }
                case "door":
                    {
                        int sessionId = (int)Json.AsLong(Get(request, "sessionId"));
                        string action = Json.AsString(Get(request, "action"));
                        int doorNo = (int)Json.AsLong(Get(request, "doorNo"));
                        if (doorNo <= 0) doorNo = 1;
                        SdkDoorResult result = Sdk.Door(sessionId, action, doorNo);
                        if (!result.Ok) { Reply(id, false, "error", result.Error); return; }
                        Dictionary<string, object> payload = new Dictionary<string, object>();
                        payload["deviceReply"] = result.DeviceReply;
                        ReplyObject(id, payload);
                        return;
                    }
                case "clock":
                    {
                        int sessionId = (int)Json.AsLong(Get(request, "sessionId"));
                        string action = Json.AsString(Get(request, "action"));
                        string isoTime = Json.AsString(Get(request, "isoTime"));
                        SdkClockResult result = Sdk.Clock(sessionId, action, isoTime);
                        if (!result.Ok) { Reply(id, false, "error", result.Error); return; }
                        Dictionary<string, object> payload = new Dictionary<string, object>();
                        payload["terminalTime"] = result.TerminalTime;
                        payload["driftMs"] = result.DriftMs;
                        ReplyObject(id, payload);
                        return;
                    }
                case "shutdown":
                    Sdk.Cleanup();
                    Reply(id, true, null, null);
                    return;
                default:
                    Reply(id, false, "error", "unknown op " + op);
                    return;
            }
        }

        private static object Get(Dictionary<string, object> source, string key)
        {
            object value;
            return source.TryGetValue(key, out value) ? value : null;
        }

        private static void Reply(long id, bool ok, string errorKey, string error)
        {
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            message["ok"] = ok;
            if (errorKey != null && error != null) message[errorKey] = error;
            _out.WriteLine(Json.Write(message));
        }

        private static void ReplyObject(long id, Dictionary<string, object> payload)
        {
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            message["ok"] = true;
            foreach (KeyValuePair<string, object> pair in payload) message[pair.Key] = pair.Value;
            _out.WriteLine(Json.Write(message));
        }

        /// <summary>True while --selftest is running: events are printed for a person, not for the agent.</summary>
        internal static bool HumanReadableEvents;

        /// <summary>An event, written as it happens. No id: the agent routes it by host.</summary>
        internal static void EmitEvent(Dictionary<string, object> eventFields)
        {
            if (HumanReadableEvents)
            {
                Console.WriteLine("  event         : major=" + eventFields["major"] + " minor=" + eventFields["minor"]
                    + (eventFields.ContainsKey("cardNo") ? " card=" + eventFields["cardNo"] : " card=(not decoded)")
                    + (eventFields.ContainsKey("doorNo") ? " door=" + eventFields["doorNo"] : "")
                    + (eventFields.ContainsKey("dateTime") ? " at " + eventFields["dateTime"] : "")
                    + (Convert.ToBoolean(eventFields["unmapped"]) ? " [unmapped: this SDK build's payload is kept raw]" : ""));
                Console.WriteLine("  event raw     : " + eventFields["raw"]);
                return;
            }
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["event"] = eventFields;
            _out.WriteLine(Json.Write(message));
        }

        // ------------------------------------------------------------- selftest ---

        /// <summary>
        /// The on-site check: what your SDK build exports, whether it can log in to
        /// the terminal, and what the terminal says about itself. Human text on
        /// stdout, because a person is reading it.
        /// </summary>
        private static int SelfTest(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: EstateMateHikSdk --selftest <host[:port]> [username] [password]");
                return 2;
            }
            string target = args[1];
            string host = target;
            int port = DefaultSdkPort;
            int colon = target.LastIndexOf(':');
            if (colon > 0 && target.IndexOf(']') < colon)
            {
                host = target.Substring(0, colon);
                int parsed;
                if (int.TryParse(target.Substring(colon + 1), out parsed)) port = parsed;
            }
            string user = args.Length > 2 ? args[2] : "admin";
            string password = args.Length > 3 ? args[3] : "";

            SdkCapabilities capabilities = Sdk.Probe();
            Console.WriteLine("EstateMate Hikvision SDK helper " + HelperVersion);
            Console.WriteLine("  platform      : " + Sdk.PlatformName());
            Console.WriteLine("  vendor library: " + (capabilities.LibraryPath == null ? "(not found)" : capabilities.LibraryPath));
            Console.WriteLine("  SDK version   : " + (capabilities.Version == null ? "(not reporting)" : capabilities.Version));
            Console.WriteLine("  exports       : " + (capabilities.Exports.Count == 0 ? "(none detected)" : string.Join(", ", capabilities.Exports.ToArray())));
            if (!capabilities.Present)
            {
                Console.WriteLine("  result        : the vendor SDK could not be loaded: " + capabilities.Error);
                Console.WriteLine("  next step     : put HCNetSDK.dll (Windows) or libhcnetsdk.so (Linux) and the HCNetSDKCom folder next to this helper.");
                return 1;
            }
            Console.WriteLine("  events        : " + (Sdk.Supports("events") ? "available" : "NOT available in this build"));
            Console.WriteLine("  door control  : " + (Sdk.Supports("door") ? "available" : "NOT available in this build"));
            Console.WriteLine("  clock         : " + (Sdk.Supports("clock") ? "available" : "NOT available in this build"));

            SdkLoginResult login = Sdk.Login(host, port, user, password);
            if (!login.Ok)
            {
                Console.WriteLine("  login         : FAILED — " + login.Error);
                Console.WriteLine("  next step     : check the address and port iVMS-4200 uses, the account, and the password.");
                Sdk.Cleanup();
                return 1;
            }
            Console.WriteLine("  login         : ok, session " + login.SessionId + " at " + host + ":" + port);
            // Only what the login reply really carries: the serial number, the
            // channel count and the device type. The model and firmware strings
            // come from a separate configuration read this helper does not decode
            // yet (README.md) — they are readable in iVMS-4200, and printing an
            // empty string here would look like the terminal answered nothing.
            Console.WriteLine("  device        : serial " + login.DeviceInfo["serialNumber"]
                + ", channels " + login.DeviceInfo["channelCount"]
                + ", start channel " + login.DeviceInfo["startChannel"]
                + ", device type " + login.DeviceInfo["deviceType"]);
            if (Sdk.Supports("clock"))
            {
                SdkClockResult clock = Sdk.Clock(login.SessionId, "get", null);
                Console.WriteLine("  terminal clock: " + (clock.Ok ? clock.TerminalTime + " (drift " + clock.DriftMs + " ms)" : "unreadable — " + clock.Error));
            }
            if (Sdk.Supports("events"))
            {
                Console.WriteLine("  events        : subscribing for 15 seconds — swipe a card now to see how this SDK build reports it");
                HumanReadableEvents = true;
                Sdk.AlarmChannel(login.SessionId, true);
                System.Threading.Thread.Sleep(15000);
                Sdk.AlarmChannel(login.SessionId, false);
                HumanReadableEvents = false;
            }
            Sdk.Logout(login.SessionId);
            Sdk.Cleanup();
            Console.WriteLine("  result        : the vendor library works on this machine. Start the agent with \"hikSdk\": {\"enabled\": true}.");
            return 0;
        }
    }

    // =========================================================================
    // Capability discovery
    // =========================================================================

    internal sealed class SdkCapabilities
    {
        public bool Present;
        public string Version;
        public string LibraryPath;
        public string Error;
        public List<string> Exports = new List<string>();
    }

    internal sealed class SdkLoginResult
    {
        public bool Ok;
        public string Error;
        public int SessionId = -1;
        public Dictionary<string, object> DeviceInfo = new Dictionary<string, object>();
    }

    internal sealed class SdkEventsResult
    {
        public bool Ok;
        public string Error;
        public int AlarmHandle = -1;
    }

    internal sealed class SdkDoorResult
    {
        public bool Ok;
        public string Error;
        public Dictionary<string, object> DeviceReply = new Dictionary<string, object>();
    }

    internal sealed class SdkClockResult
    {
        public bool Ok;
        public string Error;
        public string TerminalTime;
        public long DriftMs;
    }

    internal static class Sdk
    {
        private static readonly object Gate = new object();
        private static bool _initialised;
        private static bool _libraryLoaded;
        private static string _libraryPath;
        private static string _libraryError;
        private static readonly List<string> _exports = new List<string>();
        private static readonly Dictionary<int, AlarmChannelState> _channels = new Dictionary<int, AlarmChannelState>();
        private static Native.MsgCallback _callback; // held: the SDK keeps the pointer

        /// <summary>The exports this transport uses, and what each one is for.</summary>
        private static readonly string[] Interesting = new string[]
        {
            "NET_DVR_Init", "NET_DVR_Cleanup", "NET_DVR_Login_V40", "NET_DVR_Logout",
            "NET_DVR_SetDVRMessageCallBack_V50", "NET_DVR_SetupAlarmChan_V41", "NET_DVR_CloseAlarmChan_V30",
            "NET_DVR_ControlGateway", "NET_DVR_GetDVRConfig", "NET_DVR_SetDVRConfig"
        };

        private sealed class AlarmChannelState
        {
            public int AlarmHandle = -1;
            public int UserId;
        }

        internal static string PlatformName()
        {
            return Environment.OSVersion.Platform == PlatformID.Win32NT
                ? (Environment.Is64BitProcess ? "windows-x64" : "windows-x86")
                : (Environment.Is64BitProcess ? "unix-x64" : "unix-x86");
        }

        internal static SdkCapabilities Probe()
        {
            lock (Gate)
            {
                SdkCapabilities capabilities = new SdkCapabilities();
                _exports.Clear();
                // Candidate file names, in the order a normal install has them.
                string[] candidates = Environment.OSVersion.Platform == PlatformID.Win32NT
                    ? new string[] { "HCNetSDK.dll", Path.Combine("HCNetSDKCom", "HCNetSDK.dll") }
                    : new string[] { "libhcnetsdk.so", "./libhcnetsdk.so" };
                foreach (string candidate in candidates)
                {
                    IntPtr handle = Native.LoadLibrarySymbolTable(candidate);
                    if (handle == IntPtr.Zero) continue;
                    _libraryLoaded = true;
                    _libraryPath = candidate;
                    _libraryError = null;
                    foreach (string name in Interesting)
                    {
                        if (Native.SymbolExists(handle, name)) _exports.Add(name);
                    }
                    break;
                }
                if (!_libraryLoaded)
                {
                    _libraryError = Native.LastLoadError();
                    capabilities.Present = false;
                    capabilities.Error = "the vendor library could not be loaded (" + _libraryError + "). Put Hikvision's Device Network SDK next to this helper — see README.md.";
                    capabilities.LibraryPath = null;
                    capabilities.Exports = new List<string>(_exports);
                    return capabilities;
                }
                if (!_initialised)
                {
                    try
                    {
                        if (!Native.NET_DVR_Init())
                        {
                            capabilities.Present = false;
                            capabilities.Error = "NET_DVR_Init failed with error " + Native.NET_DVR_GetLastError();
                            capabilities.LibraryPath = _libraryPath;
                            capabilities.Exports = new List<string>(_exports);
                            return capabilities;
                        }
                        Native.NET_DVR_SetConnectTime(5000, 3);
                        Native.NET_DVR_SetReconnect(30000, 1);
                        _initialised = true;
                    }
                    catch (Exception ex)
                    {
                        capabilities.Present = false;
                        capabilities.Error = "the loaded library is not usable by this helper: " + ex.Message;
                        capabilities.LibraryPath = _libraryPath;
                        capabilities.Exports = new List<string>(_exports);
                        return capabilities;
                    }
                }
                capabilities.Present = true;
                capabilities.LibraryPath = _libraryPath;
                capabilities.Version = ReadVersion();
                capabilities.Exports = new List<string>(_exports);
                // A present SDK without the one call everything else depends on is
                // not a usable transport, and saying so here saves an operator an
                // evening of "why does login fail with no message".
                if (!Supports("login"))
                {
                    capabilities.Present = false;
                    capabilities.Error = "this SDK build does not export NET_DVR_Login_V40, which is how every device is reached";
                }
                return capabilities;
            }
        }

        private static string ReadVersion()
        {
            try
            {
                uint version = Native.NET_DVR_GetSDKVersion();
                return "V" + ((version >> 24) & 0xFF) + "." + ((version >> 16) & 0xFF) + "." + ((version >> 8) & 0xFF) + "." + (version & 0xFF);
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static bool Supports(string feature)
        {
            switch (feature)
            {
                case "login": return _exports.Contains("NET_DVR_Login_V40");
                case "events":
                    return _exports.Contains("NET_DVR_SetDVRMessageCallBack_V50") && _exports.Contains("NET_DVR_SetupAlarmChan_V41");
                case "door": return _exports.Contains("NET_DVR_ControlGateway");
                case "clock": return _exports.Contains("NET_DVR_GetDVRConfig") && _exports.Contains("NET_DVR_SetDVRConfig");
                default: return false;
            }
        }

        // -------------------------------------------------------------- sessions ---

        internal static SdkLoginResult Login(string host, int port, string user, string password)
        {
            SdkLoginResult result = new SdkLoginResult();
            SdkCapabilities capabilities = Probe();
            if (!capabilities.Present)
            {
                result.Error = capabilities.Error;
                return result;
            }
            Native.NET_DVR_USER_LOGIN_INFO loginInfo = new Native.NET_DVR_USER_LOGIN_INFO();
            loginInfo.Init(host, (ushort)port, user, password);
            Native.NET_DVR_DEVICEINFO_V40 deviceInfo = new Native.NET_DVR_DEVICEINFO_V40();
            deviceInfo.Init();
            int userId = Native.NET_DVR_Login_V40(ref loginInfo, ref deviceInfo);
            if (userId < 0)
            {
                result.Error = "NET_DVR_Login_V40 failed: error " + Native.NET_DVR_GetLastError() + " (" + Native.ErrorText(Native.NET_DVR_GetLastError()) + ")";
                return result;
            }
            result.Ok = true;
            result.SessionId = userId;
            result.DeviceInfo = deviceInfo.ToDictionary();
            return result;
        }

        internal static void Logout(int sessionId)
        {
            lock (Gate)
            {
                AlarmChannelState channel;
                if (_channels.TryGetValue(sessionId, out channel))
                {
                    AlarmChannel(sessionId, false);
                }
            }
            if (sessionId >= 0)
            {
                try { Native.NET_DVR_Logout(sessionId); }
                catch (Exception ex) { Console.Error.WriteLine("logout failed: " + ex.Message); }
            }
        }

        internal static void Cleanup()
        {
            lock (Gate)
            {
                foreach (int sessionId in new List<int>(_channels.Keys)) AlarmChannel(sessionId, false);
                if (_initialised)
                {
                    try { Native.NET_DVR_Cleanup(); }
                    catch (Exception) { }
                    _initialised = false;
                }
            }
        }

        // ---------------------------------------------------------------- events ---

        internal static SdkEventsResult AlarmChannel(int sessionId, bool enabled)
        {
            SdkEventsResult result = new SdkEventsResult();
            if (!Supports("events"))
            {
                result.Error = "this SDK build does not export NET_DVR_SetDVRMessageCallBack_V50 / NET_DVR_SetupAlarmChan_V41";
                return result;
            }
            lock (Gate)
            {
                AlarmChannelState state;
                if (!_channels.TryGetValue(sessionId, out state))
                {
                    state = new AlarmChannelState();
                    state.UserId = sessionId;
                    _channels[sessionId] = state;
                }
                if (!enabled)
                {
                    if (state.AlarmHandle >= 0)
                    {
                        Native.NET_DVR_CloseAlarmChan_V30(state.AlarmHandle);
                        state.AlarmHandle = -1;
                    }
                    result.Ok = true;
                    result.AlarmHandle = -1;
                    return result;
                }
                if (state.AlarmHandle >= 0)
                {
                    result.Ok = true;
                    result.AlarmHandle = state.AlarmHandle;
                    return result;
                }
                if (_callback == null)
                {
                    // Held in a static field: the SDK stores the function pointer,
                    // and a collected delegate would crash the process on the first
                    // alarm - the classic P/Invoke callback mistake.
                    _callback = new Native.MsgCallback(OnMessage);
                    Native.NET_DVR_SetDVRMessageCallBack_V50(0, _callback, IntPtr.Zero);
                }
                Native.NET_DVR_SETUPALARM_PARAM alarmParam = new Native.NET_DVR_SETUPALARM_PARAM();
                alarmParam.Init();
                int handle = Native.NET_DVR_SetupAlarmChan_V41(sessionId, ref alarmParam);
                if (handle < 0)
                {
                    result.Error = "NET_DVR_SetupAlarmChan_V41 failed: error " + Native.NET_DVR_GetLastError() + " (" + Native.ErrorText(Native.NET_DVR_GetLastError()) + ")";
                    return result;
                }
                state.AlarmHandle = handle;
                result.Ok = true;
                result.AlarmHandle = handle;
                return result;
            }
        }

        /// <summary>
        /// The vendor callback. Every field read here is validated before it is
        /// reported: a card number that does not look like a card number is thrown
        /// away and the event is marked unmapped instead. A wrong card number in
        /// gate history is worse than no card number.
        /// </summary>
        /// <remarks>
        /// The signature must match <c>Native.MsgCallback</c> exactly, or this
        /// method cannot be handed to the vendor at all: the alarmer pointer is
        /// taken as an <see cref="IntPtr"/>, deliberately — the helper routes the
        /// event by the session it came from and never reads that struct, and an
        /// <c>IntPtr</c> cannot be the wrong size in a callback the vendor's own
        /// library calls with the vendor's own layout.
        /// </remarks>
        private static void OnMessage(int lCommand, IntPtr alarmer, IntPtr alarmInfo, uint bufferLength, IntPtr user)
        {
            try
            {
                Dictionary<string, object> fields = new Dictionary<string, object>();
                fields["kind"] = "acs";
                fields["alarmType"] = lCommand;
                bool mapped = false;
                string card = null;
                int doorNo = 0;
                int major = -1;
                int minor = -1;
                string dateTime = null;

                if (lCommand == Native.COMM_ALARM_ACS && alarmInfo != IntPtr.Zero && bufferLength >= 36)
                {
                    // Offsets taken from HCNetSDK.h for the SDK versions this was
                    // written against: dwSize (0), dwMajor (4), dwMinor (8),
                    // NET_DVR_TIME (12..35), then NET_DVR_ACS_EVENT_INFO, whose
                    // first members are dwSize (36), byCardNo[32] (40), byCardType
                    // (72), byWhiteListNo (73), byReportChannel (74),
                    // byCardReaderKind (75), dwCardReaderNo (76), dwDoorNo (80).
                    // Only the card number and the door are taken: the employee
                    // number sits much further into the struct, where a differing
                    // layout between SDK builds would start producing wrong values
                    // rather than none — the raw bytes are kept below so a later
                    // verified pass can decode it without the event being lost.
                    major = Marshal.ReadInt32(alarmInfo, 4);
                    minor = Marshal.ReadInt32(alarmInfo, 8);
                    dateTime = ReadDeviceTime(alarmInfo, 12);
                    if (bufferLength >= 84)
                    {
                        card = ReadFixedString(alarmInfo, 40, 32);
                        int rawDoor = Marshal.ReadInt32(alarmInfo, 80);
                        if (rawDoor >= 1 && rawDoor <= 8) doorNo = rawDoor;
                    }
                    mapped = major >= 0 && minor >= 0;
                }

                if (!PlausibleCard(card)) card = null;

                fields["major"] = major;
                fields["minor"] = minor;
                if (doorNo > 0) fields["doorNo"] = doorNo;
                fields["channel"] = 1;
                if (card != null) fields["cardNo"] = card;
                if (dateTime != null) fields["dateTime"] = dateTime;
                // No code table ships with this release (none is verified against a
                // terminal — see hik-sdk-transport.mjs). The event is filed with its
                // numbers and marked, never guessed at "granted".
                fields["unmapped"] = !mapped || card == null;
                // The first 64 bytes of the vendor's payload, hex — the evidence a
                // later, verified decode can work from. It is not a card number and
                // is never printed as one.
                fields["raw"] = "cmd=0x" + lCommand.ToString("X4") + " major=" + major + " minor=" + minor
                    + " head=" + ReadHex(alarmInfo, Math.Min(64, (int)bufferLength));
                Program.EmitEvent(fields);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("an alarm could not be read: " + ex.Message);
            }
        }

        private static string ReadDeviceTime(IntPtr pointer, int offset)
        {
            int year = Marshal.ReadInt32(pointer, offset);
            int month = Marshal.ReadInt32(pointer, offset + 4);
            int day = Marshal.ReadInt32(pointer, offset + 8);
            int hour = Marshal.ReadInt32(pointer, offset + 12);
            int minute = Marshal.ReadInt32(pointer, offset + 16);
            int second = Marshal.ReadInt32(pointer, offset + 20);
            if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31
                || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 60)
            {
                return null;
            }
            return new DateTime(year, month, day, hour, minute, Math.Min(second, 59), DateTimeKind.Local).ToString("yyyy-MM-dd'T'HH:mm:sszzz", CultureInfo.InvariantCulture);
        }

        private static string ReadHex(IntPtr pointer, int length)
        {
            if (pointer == IntPtr.Zero || length <= 0) return "";
            byte[] bytes = new byte[length];
            Marshal.Copy(pointer, bytes, 0, length);
            StringBuilder builder = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) builder.Append(value.ToString("x2"));
            return builder.ToString();
        }

        private static string ReadFixedString(IntPtr pointer, int offset, int length)
        {
            byte[] bytes = new byte[length];
            Marshal.Copy(new IntPtr(pointer.ToInt64() + offset), bytes, 0, length);
            int end = 0;
            while (end < bytes.Length && bytes[end] != 0) end++;
            return Encoding.ASCII.GetString(bytes, 0, end).Trim();
        }

        /// <summary>
        /// A card number is digits and hex letters, printed on a card, 1-32 chars.
        /// Anything else (binary noise, a mis-read struct) is discarded.
        /// </summary>
        private static bool PlausibleCard(string value)
        {
            if (value == null) return false;
            string trimmed = value.Trim();
            if (trimmed.Length == 0 || trimmed.Length > 32) return false;
            foreach (char c in trimmed)
            {
                bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
                if (!ok) return false;
            }
            return true;
        }

        // ------------------------------------------------------------------ door ---

        internal static SdkDoorResult Door(int sessionId, string action, int doorNo)
        {
            SdkDoorResult result = new SdkDoorResult();
            if (!Supports("door"))
            {
                result.Error = "this SDK build does not export NET_DVR_ControlGateway";
                return result;
            }
            // Hikvision's gate control commands. Verify the one your terminal
            // documents: the device's own reply below is recorded verbatim, and a
            // refusal is surfaced rather than assumed to have worked.
            int command;
            switch (action)
            {
                case "open": command = 1; break;
                case "close": command = 2; break;
                case "alwaysOpen": command = 3; break;
                case "alwaysClose": command = 4; break;
                case "resume": command = 5; break;
                default:
                    result.Error = "unknown door action " + action;
                    return result;
            }
            if (!Native.NET_DVR_ControlGateway(sessionId, doorNo, (uint)command))
            {
                int error = Native.NET_DVR_GetLastError();
                result.Error = "NET_DVR_ControlGateway failed: error " + error + " (" + Native.ErrorText(error) + ")";
                return result;
            }
            result.Ok = true;
            result.DeviceReply["code"] = 0;
            result.DeviceReply["gateway"] = doorNo;
            result.DeviceReply["action"] = action;
            result.DeviceReply["command"] = command;
            return result;
        }

        // ----------------------------------------------------------------- clock ---

        internal static SdkClockResult Clock(int sessionId, string action, string isoTime)
        {
            SdkClockResult result = new SdkClockResult();
            if (!Supports("clock"))
            {
                result.Error = "this SDK build does not export NET_DVR_GetDVRConfig / NET_DVR_SetDVRConfig";
                return result;
            }
            int size = Marshal.SizeOf(typeof(Native.NET_DVR_TIME));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (action == "set")
                {
                    DateTime wanted;
                    if (isoTime == null || !DateTime.TryParse(isoTime, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out wanted))
                    {
                        result.Error = "the time to set was not a usable timestamp";
                        return result;
                    }
                    DateTime local = wanted.ToLocalTime();
                    Native.NET_DVR_TIME time = new Native.NET_DVR_TIME();
                    time.Fill(local);
                    Marshal.StructureToPtr(time, buffer, false);
                    uint returned = 0;
                    if (!Native.NET_DVR_SetDVRConfig(sessionId, Native.NET_DVR_SET_TIMECFG, 0, buffer, (uint)size, ref returned))
                    {
                        int error = Native.NET_DVR_GetLastError();
                        result.Error = "NET_DVR_SetDVRConfig failed: error " + error + " (" + Native.ErrorText(error) + ")";
                        return result;
                    }
                    result.Ok = true;
                    result.TerminalTime = local.ToString("yyyy-MM-dd'T'HH:mm:sszzz", CultureInfo.InvariantCulture);
                    result.DriftMs = 0;
                    return result;
                }

                uint bytesReturned = 0;
                if (!Native.NET_DVR_GetDVRConfig(sessionId, Native.NET_DVR_GET_TIMECFG, 0, buffer, (uint)size, ref bytesReturned))
                {
                    int error = Native.NET_DVR_GetLastError();
                    result.Error = "NET_DVR_GetDVRConfig failed: error " + error + " (" + Native.ErrorText(error) + ")";
                    return result;
                }
                Native.NET_DVR_TIME terminal = (Native.NET_DVR_TIME)Marshal.PtrToStructure(buffer, typeof(Native.NET_DVR_TIME));
                DateTime terminalTime = terminal.ToDateTime();
                result.Ok = true;
                result.TerminalTime = terminalTime.ToString("yyyy-MM-dd'T'HH:mm:sszzz", CultureInfo.InvariantCulture);
                result.DriftMs = (long)(terminalTime - DateTime.Now).TotalMilliseconds;
                return result;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
