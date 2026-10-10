' EstateMate desktop app (Windows). Opens the estate portal in its own
' application window: no address bar or tabs, and a separate browser profile
' so the sign-in is kept apart from everyday browsing. Uses Microsoft Edge
' (installed with Windows 10/11), then Google Chrome, and finally the default
' browser when neither is present. The portal address is read from
' estatemate-url.txt, which the installer writes next to this file.
Option Explicit

Dim sh, fso, here, url, profile, candidates, i

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

url = Trim(ReadFirstLine(here & "\estatemate-url.txt"))
If url = "" Then
  MsgBox "EstateMate is not configured: estatemate-url.txt is missing. Reinstall the EstateMate app.", 16, "EstateMate"
  WScript.Quit 1
End If

profile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\EstateMate\Window"

candidates = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe")

For i = 0 To UBound(candidates)
  If fso.FileExists(candidates(i)) Then
    sh.Run """" & candidates(i) & """ --app=""" & url & """ --user-data-dir=""" & profile & """ --no-first-run", 1, False
    WScript.Quit 0
  End If
Next

' No Chromium-based browser found: fall back to the default browser.
sh.Run url, 1, False

Function ReadFirstLine(path)
  ReadFirstLine = ""
  If fso.FileExists(path) Then
    Dim f
    Set f = fso.OpenTextFile(path, 1)
    If Not f.AtEndOfStream Then ReadFirstLine = f.ReadLine
    f.Close
  End If
End Function
