// EstateMate Bridge dashboard launcher.
//
// This is the tile in the Start Menu: a GUI program (no console window) that
// starts Windows PowerShell, hidden, on EstateMateBridge.ps1 next to it. Nothing
// else - all of the dashboard lives in the script, so it can be read, edited and
// tested as text.
//
// Compile it with the Roslyn compiler (build-dashboard.cmd does exactly this):
//   csc.exe /nologo /target:winexe /out:EstateMateBridge.exe Launcher.cs
//
// Written in C# 5 so that the compiler in the .NET Framework directory, which
// every Windows installation already has, can build it as well.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("EstateMate Bridge")]
[assembly: System.Reflection.AssemblyProduct("EstateMate Bridge")]
[assembly: System.Reflection.AssemblyDescription("EstateMate Bridge dashboard")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace EstateMateBridge
{
    internal static class Program
    {
        private const string ScriptName = "EstateMateBridge.ps1";

        [STAThread]
        private static int Main(string[] args)
        {
            string script = FindScript();
            if (script == null)
            {
                MessageBox.Show(
                    ScriptName + " was not found next to this launcher.\r\n\r\n" +
                    "Install the bridge again from the installer kit, or run the launcher from the folder the bridge is installed in (usually C:\\Program Files\\EstateMate Bridge).",
                    "EstateMate Bridge",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 2;
            }

            string shell = FindPowerShell();
            if (shell == null)
            {
                MessageBox.Show(
                    "Windows PowerShell was not found in System32. Nothing here works without it; on a managed PC speak to whoever manages the machine.",
                    "EstateMate Bridge",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 3;
            }

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = shell;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\"" + Quote(args);
            if (args.Length > 0)
            {
                // Headless call (the self-test): keep the output for the caller.
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
            }

            try
            {
                Process child = Process.Start(info);
                if (args.Length == 0) { return 0; }

                string output = child.StandardOutput.ReadToEnd() + child.StandardError.ReadToEnd();
                child.WaitForExit();
                string log = Path.Combine(Path.GetTempPath(), "estatemate-dashboard-last-run.txt");
                try { File.WriteAllText(log, output); } catch { /* a CI detail, never a reason to fail */ }
                return child.ExitCode;
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "The dashboard could not be started:\r\n\r\n" + error.Message,
                    "EstateMate Bridge",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }
        }

        private static string FindScript()
        {
            List<string> candidates = new List<string>();
            string configured = Environment.GetEnvironmentVariable("ESTATEMATE_DASHBOARD_PS1");
            if (!string.IsNullOrEmpty(configured)) { candidates.Add(configured); }

            string directory = AppDomain.CurrentDomain.BaseDirectory;
            candidates.Add(Path.Combine(directory, ScriptName));
            candidates.Add(Path.Combine(Path.Combine(directory, "dashboard"), ScriptName));

            string parent = Path.GetFullPath(Path.Combine(directory, ".."));
            candidates.Add(Path.Combine(parent, ScriptName));
            candidates.Add(Path.Combine(Path.Combine(parent, "dashboard"), ScriptName));
            candidates.Add(Path.Combine(@"C:\Program Files\EstateMate Bridge", ScriptName));

            foreach (string candidate in candidates)
            {
                if (candidate != null && File.Exists(candidate)) { return candidate; }
            }
            return null;
        }

        private static string FindPowerShell()
        {
            string root = Environment.GetEnvironmentVariable("SystemRoot");
            if (string.IsNullOrEmpty(root)) { root = @"C:\Windows"; }
            string shell = Path.Combine(Path.Combine(Path.Combine(root, "System32"), "WindowsPowerShell"), Path.Combine("v1.0", "powershell.exe"));
            return File.Exists(shell) ? shell : null;
        }

        private static string Quote(string[] args)
        {
            if (args == null || args.Length == 0) { return string.Empty; }
            StringBuilder text = new StringBuilder();
            foreach (string argument in args)
            {
                text.Append(' ');
                if (argument.IndexOf(' ') >= 0 || argument.IndexOf('"') >= 0)
                {
                    text.Append('"').Append(argument.Replace("\"", "\\\"")).Append('"');
                }
                else
                {
                    text.Append(argument);
                }
            }
            return text.ToString();
        }
    }
}
