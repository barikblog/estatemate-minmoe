' Sornix EstateOS desktop app (Windows). Opens the estate portal in its own
' application window: no address bar or tabs, and a separate browser profile
' so the sign-in is kept apart from everyday browsing. Uses Microsoft Edge
' (installed with Windows 10/11), then Google Chrome, and finally the default
' browser when neither is present. The portal address is read from
' estatemate-url.txt, which the installer writes next to this file (the file
' name is unchanged from the EstateMate releases on purpose: an in-place
' upgrade keeps working, and this script is what reads it).
Option Explicit

Dim sh, fso, here, url, openUrl, profile, candidates, i

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

url = Trim(ReadFirstLine(here & "\estatemate-url.txt"))
If url = "" Then
  MsgBox "Sornix EstateOS is not configured: estatemate-url.txt is missing. Reinstall the Sornix EstateOS app.", 16, "Sornix EstateOS"
  WScript.Quit 1
End If

' The profile directory keeps its original name, so an in-place upgrade keeps
' the sign-in; only the visible product name changed.
profile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\EstateMate\Window"

' Tag the window as the desktop client. The portal reads this and tells the
' Worker where a password-reset request came from, so a screen that offers
' "forgot password" says the request was made from this PC. An address that
' already carries a query string keeps it.
openUrl = url
If InStr(openUrl, "client=desktop") = 0 Then
  If InStr(openUrl, "?") > 0 Then
    openUrl = openUrl & "&client=desktop"
  Else
    openUrl = openUrl & "?client=desktop"
  End If
End If

candidates = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe")

For i = 0 To UBound(candidates)
  If fso.FileExists(candidates(i)) Then
    sh.Run """" & candidates(i) & """ --app=""" & openUrl & """ --user-data-dir=""" & profile & """ --no-first-run", 1, False
    WScript.Quit 0
  End If
Next

' No Chromium-based browser found: fall back to the default browser.
sh.Run openUrl, 1, False

Function ReadFirstLine(path)
  ReadFirstLine = ""
  If fso.FileExists(path) Then
    Dim f
    Set f = fso.OpenTextFile(path, 1)
    If Not f.AtEndOfStream Then ReadFirstLine = f.ReadLine
    f.Close
  End If
End Function
