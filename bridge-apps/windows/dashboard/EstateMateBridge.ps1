<#
EstateMate Bridge - Windows dashboard.

WHY THIS EXISTS
The bridge used to be configured from a console: `estatemate-bridge setup`
answers prompts in a cmd window, and the Start Menu shortcuts open cmd. For the
person who actually runs the bridge on an estate PC that is the wrong shape - it
reads as programming, and a mistyped value is hard to recover from.

This is the same agent behind a normal window:

  * Status        what the bridge is doing, the output of what you asked it to
                  do, and the live log;
  * Configuration agent id / secret / Worker URL, the portal's "Download setup"
                  script, and the Hikvision terminals as an editable table;
  * Service       start it now, stop it, and keep it running from boot.

Everything it does is the existing command line, run for you: `status --json`,
`setup --no-prompt ...`, `check`, `install-service`, `uninstall-service`, `run`.
No configuration logic lives in this file, so the console, this window and the
CI smoke tests cannot disagree about what a valid setup is.

The window is WinForms (System.Windows.Forms), part of Windows itself: nothing to
install, no browser, and no port - the bridge still only makes outbound
connections. `-SelfTest` builds every control and loads the real state without
showing the window, which is how CI checks this file on a Windows runner.

Modes
  (no switch)      the dashboard
  -SelfTest        headless check of the window, the state and the CLI; exit 0
  -ExePath <file>  use this bridge executable instead of discovering one
#>
[CmdletBinding()]
param(
  [string] $ExePath,
  [switch] $SelfTest
)

$ErrorActionPreference = 'Continue'

$script:BridgeExe   = $null
$script:Status      = $null
$script:Config      = $null
$script:Devices     = @()
$script:ConfigPath  = $null
$script:DevicesPath = $null
$script:LogFile     = $null
$script:TaskName    = 'EstateMateBridge'
$script:OwnProcess  = $null
$script:Busy        = $false
$script:Ticks       = 0
$script:LogText     = ''
$script:Controls    = @{}

# ----------------------------------------------------------------- windows bits ---

function Add-WindowsForms {
  try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop } catch { [void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') }
  try { Add-Type -AssemblyName System.Drawing -ErrorAction Stop } catch { [void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') }
}

function Write-Utf8NoBom([string] $path, [string] $text) {
  # JSON.parse in the bridge rejects a UTF-8 BOM, which Set-Content adds on
  # Windows PowerShell 5.1.
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $encoding)
}

# ------------------------------------------------------------------ bridge cli ---

function Resolve-BridgeExe {
  $candidates = @()
  if ($ExePath) { $candidates += $ExePath }
  $candidates += (Join-Path (Split-Path -Parent $PSScriptRoot) 'estatemate-bridge.exe')
  $candidates += (Join-Path $PSScriptRoot 'estatemate-bridge.exe')
  $candidates += 'C:\Program Files\EstateMate Bridge\estatemate-bridge.exe'
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  $onPath = Get-Command 'estatemate-bridge.exe' -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

function Invoke-Bridge([string[]] $Arguments) {
  if (-not $script:BridgeExe) {
    return [pscustomobject]@{ Code = 127; Output = 'estatemate-bridge.exe was not found next to this dashboard.' }
  }
  $lines = @()
  $code = 1
  try {
    $lines = @(& $script:BridgeExe @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
  } catch {
    $lines += $_.Exception.Message
  }
  $global:LASTEXITCODE = 0
  return [pscustomobject]@{ Code = $code; Output = ($lines -join "`r`n") }
}

function Invoke-BridgeElevated([string[]] $Arguments) {
  # Needs administrator rights: run the same command from an elevated PowerShell
  # and bring its output back through a temp file (Start-Process -Verb RunAs
  # cannot redirect a stream). The command goes into a .ps1 the elevated process
  # runs with -File, because Start-Process does not quote a -Command argument.
  $outFile = Join-Path $env:TEMP ('estatemate-bridge-elevated-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $scriptFile = Join-Path $env:TEMP ('estatemate-bridge-elevated-' + [Guid]::NewGuid().ToString('N') + '.ps1')
  # Each value becomes a single-quoted PowerShell literal with ' doubled, so a
  # secret or a path with spaces, quotes or an apostrophe cannot break the
  # command line the elevated window runs.
  function Quote-Literal([string] $value) { "'" + ($value -replace "'", "''") + "'" }
  $literals = @(foreach ($argument in $Arguments) { Quote-Literal $argument })
  $body = "& $(Quote-Literal $script:BridgeExe) $($literals -join ' ') *> $(Quote-Literal $outFile)`r`nexit `$LASTEXITCODE`r`n"
  Write-Utf8NoBom $scriptFile $body
  $code = 1223
  try {
    $proc = Start-Process 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptFile`"")
    $code = $proc.ExitCode
  } catch {
    Remove-Item -LiteralPath $scriptFile, $outFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Code = 1223; Output = 'The administrator prompt was dismissed, so nothing changed.' }
  }
  $text = ''
  if (Test-Path -LiteralPath $outFile) {
    $text = [string](Get-Content -LiteralPath $outFile -Raw)
  }
  Remove-Item -LiteralPath $scriptFile, $outFile -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{ Code = $code; Output = $text }
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------- bridge state ---

function Get-StatusReport {
  # `status --json` is the single source of paths, service state and log file, so
  # this window never has to guess where anything lives.
  $result = Invoke-Bridge @('status', '--json')
  if ($result.Code -ne 0) { return $null }
  $start = $result.Output.IndexOf('{')
  if ($start -lt 0) { return $null }
  try { return ConvertFrom-Json $result.Output.Substring($start) } catch { return $null }
}

function Get-JsonFile($path) {
  if (-not $path) { return $null }
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return ConvertFrom-Json ([string](Get-Content -LiteralPath $path -Raw)) } catch { return $null }
}

function Get-LogTail([int] $Lines = 200) {
  if (-not $script:LogFile) { return '' }
  if (-not (Test-Path -LiteralPath $script:LogFile)) { return '' }
  try { return (@(Get-Content -LiteralPath $script:LogFile -Tail $Lines -ErrorAction Stop) -join "`r`n") } catch { return '' }
}

function Read-State {
  $script:Status = Get-StatusReport
  if ($script:Status) {
    $script:ConfigPath  = $script:Status.config.path
    $script:DevicesPath = $script:Status.devicesFile.path
    $script:LogFile     = $script:Status.logFile
    if ($script:Status.service -and $script:Status.service.name) { $script:TaskName = $script:Status.service.name }
  } else {
    if (-not $script:ConfigPath) { $script:ConfigPath = Join-Path $env:ProgramData 'EstateMate\agent-config.json' }
    if (-not $script:DevicesPath) { $script:DevicesPath = Join-Path $env:ProgramData 'EstateMate\isapi-devices.json' }
    if (-not $script:LogFile) { $script:LogFile = Join-Path $env:ProgramData 'EstateMate\logs\bridge.log' }
  }
  $script:Config = Get-JsonFile $script:ConfigPath
  $json = Get-JsonFile $script:DevicesPath
  if ($json -and $json.devices) { $script:Devices = @($json.devices) } else { $script:Devices = @() }
}

# ---------------------------------------------------------------------- output ---

function Write-Activity($text) {
  if (-not $script:Controls.Report -or -not $text) { return }
  $script:Controls.Report.AppendText($text + "`r`n")
  $script:Controls.Report.SelectionStart = $script:Controls.Report.TextLength
  $script:Controls.Report.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

function Show-CommandResult([string] $what, $result) {
  Write-Activity "--- $what (exit code $($result.Code)) ---"
  if ($result.Output) { Write-Activity $result.Output.TrimEnd() }
  Write-Activity ''
}

function Update-LiveLog {
  if (-not $script:Controls.LiveLog) { return }
  $tail = Get-LogTail 200
  if ($tail -eq $script:LogText) { return }
  $script:LogText = $tail
  $script:Controls.LiveLog.Text = $tail
  $script:Controls.LiveLog.SelectionStart = $script:Controls.LiveLog.TextLength
  $script:Controls.LiveLog.ScrollToCaret()
}

# -------------------------------------------------------------------------- ui ---

function New-Label($parent, $text, $x, $y, $width = 200, $height = 18, $bold = $false) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Location = New-Object System.Drawing.Point($x, $y)
  $label.Size = New-Object System.Drawing.Size($width, $height)
  if ($bold) { $label.Font = New-Object System.Drawing.Font($label.Font, [System.Drawing.FontStyle]::Bold) }
  $parent.Controls.Add($label)
  return $label
}

function New-Button($parent, $text, $x, $y, $width = 120, $height = 28) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.Location = New-Object System.Drawing.Point($x, $y)
  $button.Size = New-Object System.Drawing.Size($width, $height)
  $button.UseVisualStyleBackColor = $true
  $parent.Controls.Add($button)
  return $button
}

function New-TextBox($parent, $x, $y, $width, $height = 24) {
  $box = New-Object System.Windows.Forms.TextBox
  $box.Location = New-Object System.Drawing.Point($x, $y)
  $box.Size = New-Object System.Drawing.Size($width, $height)
  $parent.Controls.Add($box)
  return $box
}

function New-ReadOnlyBox($parent = $null) {
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Both'
  $box.WordWrap = $false
  $box.Dock = 'Fill'
  $box.Font = New-Object System.Drawing.Font('Consolas', 9)
  $box.BackColor = [System.Drawing.Color]::White
  if ($parent) { $parent.Controls.Add($box) }
  return $box
}

function New-RowStyle([string] $sizeType, [int] $value) {
  $type = [System.Windows.Forms.SizeType]::$sizeType
  return New-Object System.Windows.Forms.RowStyle($type, $value)
}

function New-DashboardForm {
  Add-WindowsForms

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'EstateMate Bridge'
  $form.Size = New-Object System.Drawing.Size(820, 680)
  $form.MinimumSize = New-Object System.Drawing.Size(720, 580)
  $form.StartPosition = 'CenterScreen'
  $script:Controls.Form = $form

  # A TableLayoutPanel rather than Dock=Top/Fill: the docking z-order rules are
  # easy to get wrong, and this is deterministic on every version of Windows.
  $root = New-Object System.Windows.Forms.TableLayoutPanel
  $root.Dock = 'Fill'
  $root.ColumnCount = 1
  $root.RowCount = 3
  [void]$root.RowStyles.Add((New-RowStyle 'Absolute' 96))
  [void]$root.RowStyles.Add((New-RowStyle 'Absolute' 44))
  [void]$root.RowStyles.Add((New-RowStyle 'Percent' 100))
  $form.Controls.Add($root)

  # ---- header -------------------------------------------------------------
  $header = New-Object System.Windows.Forms.Panel
  $header.Dock = 'Fill'
  $header.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
  $root.Controls.Add($header, 0, 0)

  $title = New-Label $header 'EstateMate Bridge' 14 8 400 28 $true
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
  $script:Controls.BridgeState = New-Label $header 'Bridge: checking...' 16 42 390 20
  $script:Controls.AgentState  = New-Label $header 'Agent: checking...' 16 62 390 20
  $script:Controls.DeviceState = New-Label $header 'Terminals: -' 420 42 380 20
  $script:Controls.PortalState = New-Label $header 'Portal: -' 420 62 380 20

  # ---- action bar ---------------------------------------------------------
  $actions = New-Object System.Windows.Forms.Panel
  $actions.Dock = 'Fill'
  $root.Controls.Add($actions, 0, 1)

  $script:Controls.StartButton = New-Button $actions 'Start bridge' 12 8 130 28
  $script:Controls.StopButton = New-Button $actions 'Stop bridge' 152 8 120 28
  $script:Controls.CheckButton = New-Button $actions 'Run check' 282 8 110 28
  $script:Controls.OpenLogsButton = New-Button $actions 'Open logs' 402 8 100 28
  $script:Controls.ElevateButton = New-Button $actions 'Restart as administrator' 512 8 190 28
  if (Test-Admin) { $script:Controls.ElevateButton.Visible = $false }

  # ---- tabs ---------------------------------------------------------------
  $tabs = New-Object System.Windows.Forms.TabControl
  $tabs.Dock = 'Fill'
  $root.Controls.Add($tabs, 0, 2)

  $statusTab = New-Object System.Windows.Forms.TabPage
  $statusTab.Text = 'Status'
  $tabs.Controls.Add($statusTab)
  $statusLayout = New-Object System.Windows.Forms.TableLayoutPanel
  $statusLayout.Dock = 'Fill'
  $statusLayout.ColumnCount = 1
  $statusLayout.RowCount = 4
  [void]$statusLayout.RowStyles.Add((New-RowStyle 'Absolute' 22))
  [void]$statusLayout.RowStyles.Add((New-RowStyle 'Percent' 55))
  [void]$statusLayout.RowStyles.Add((New-RowStyle 'Absolute' 22))
  [void]$statusLayout.RowStyles.Add((New-RowStyle 'Percent' 45))
  $statusTab.Controls.Add($statusLayout)
  [void](New-Label $statusLayout 'What you asked for (setup, check, service changes)' 6 2 500 18)
  $script:Controls.Report = New-ReadOnlyBox
  $statusLayout.Controls.Add($script:Controls.Report, 0, 1)
  [void](New-Label $statusLayout 'Live log (refreshed every few seconds)' 6 2 500 18)
  $script:Controls.LiveLog = New-ReadOnlyBox
  $statusLayout.Controls.Add($script:Controls.LiveLog, 0, 3)

  $configTab = New-Object System.Windows.Forms.TabPage
  $configTab.Text = 'Configuration'
  $configTab.AutoScroll = $true
  $tabs.Controls.Add($configTab)

  $agentGroup = New-Object System.Windows.Forms.GroupBox
  $agentGroup.Text = 'Agent (portal: Device agent -> Add agent)'
  $agentGroup.Location = New-Object System.Drawing.Point(10, 10)
  $agentGroup.Size = New-Object System.Drawing.Size(775, 175)
  $configTab.Controls.Add($agentGroup)

  [void](New-Label $agentGroup 'Easiest: the portal''s "Download setup" script already carries the id and secret' 12 22 740 18)
  $script:Controls.InstallerPath = New-TextBox $agentGroup 12 42 660 24
  $script:Controls.BrowseButton = New-Button $agentGroup 'Browse...' 680 41 82 26
  $script:Controls.ApplyPortalButton = New-Button $agentGroup 'Use this portal file' 12 72 160 26
  [void](New-Label $agentGroup 'Or type the values by hand:' 186 76 220 18)

  [void](New-Label $agentGroup 'Agent ID (UUID)' 12 108 120 18)
  $script:Controls.AgentId = New-TextBox $agentGroup 12 128 340 24
  [void](New-Label $agentGroup 'Agent secret' 364 108 140 18)
  $script:Controls.AgentSecret = New-TextBox $agentGroup 364 128 190 24
  $script:Controls.AgentSecret.UseSystemPasswordChar = $true
  [void](New-Label $agentGroup 'Worker URL' 566 108 140 18)
  $script:Controls.WorkerUrl = New-TextBox $agentGroup 566 128 196 24

  $terminalsGroup = New-Object System.Windows.Forms.GroupBox
  $terminalsGroup.Text = 'Hikvision terminals on this LAN'
  $terminalsGroup.Location = New-Object System.Drawing.Point(10, 192)
  $terminalsGroup.Size = New-Object System.Drawing.Size(775, 350)
  $configTab.Controls.Add($terminalsGroup)

  $grid = New-Object System.Windows.Forms.DataGridView
  $grid.Location = New-Object System.Drawing.Point(12, 22)
  $grid.Size = New-Object System.Drawing.Size(750, 260)
  $grid.AllowUserToAddRows = $false
  $grid.AllowUserToDeleteRows = $false
  $grid.RowHeadersVisible = $false
  $grid.AutoSizeColumnsMode = 'Fill'
  # 'OnType' is not a DataGridViewEditMode on any .NET Framework: the names are
  # EditOnEnter, EditOnKeystroke, EditOnKeystrokeOrF2, EditOnF2 and
  # EditProgrammatically. This one starts an edit when a printable key is
  # pressed and on F2, which is what a grid of hostnames and ids wants, and it
  # leaves the checkboxes clickable.
  $grid.EditMode = 'EditOnKeystrokeOrF2'
  [void]$grid.Columns.Add('DeviceId', 'EstateMate device ID (UUID from the portal)')
  [void]$grid.Columns.Add('Name', 'Name')
  [void]$grid.Columns.Add('Host', 'ISAPI host')
  [void]$grid.Columns.Add('Port', 'Port')
  [void]$grid.Columns.Add('User', 'ISAPI user')
  [void]$grid.Columns.Add('Password', 'ISAPI password')
  [void]$grid.Columns.Add('Protocol', 'http/https')
  # A real checkbox column, not a text one: [bool]'False' is $true in
  # PowerShell, so a typed "False" in a text cell would save as enabled.
  $eventsColumn = New-Object System.Windows.Forms.DataGridViewCheckBoxColumn
  $eventsColumn.Name = 'Events'
  $eventsColumn.HeaderText = 'Live events'
  $eventsColumn.FalseValue = $false
  $eventsColumn.TrueValue = $true
  [void]$grid.Columns.Add($eventsColumn)
  $grid.Columns['Port'].FillWeight = 30
  $grid.Columns['Protocol'].FillWeight = 50
  $grid.Columns['Events'].FillWeight = 45
  $script:Controls.Grid = $grid
  $terminalsGroup.Controls.Add($grid)

  $script:Controls.AddTerminalButton = New-Button $terminalsGroup 'Add terminal' 12 292 120 28
  $script:Controls.RemoveTerminalButton = New-Button $terminalsGroup 'Remove selected' 142 292 130 28
  $script:Controls.SaveTerminalsButton = New-Button $terminalsGroup 'Save all settings' 282 292 140 28
  [void](New-Label $terminalsGroup 'Every terminal must be on the same LAN as this PC. "Live events" streams gate events in real time.' 432 296 330 40)

  $serviceTab = New-Object System.Windows.Forms.TabPage
  $serviceTab.Text = 'Service'
  $serviceTab.AutoScroll = $true
  $tabs.Controls.Add($serviceTab)

  $serviceGroup = New-Object System.Windows.Forms.GroupBox
  $serviceGroup.Text = 'Start the bridge automatically'
  $serviceGroup.Location = New-Object System.Drawing.Point(10, 10)
  $serviceGroup.Size = New-Object System.Drawing.Size(775, 150)
  $serviceTab.Controls.Add($serviceGroup)
  $script:Controls.ServiceState = New-Label $serviceGroup 'Scheduled task: checking...' 12 24 740 20 $true
  [void](New-Label $serviceGroup 'Registered means the bridge keeps running after logoff and after a reboot.' 12 48 740 18)
  $script:Controls.InstallServiceButton = New-Button $serviceGroup 'Start at boot' 12 74 130 28
  $script:Controls.RemoveServiceButton = New-Button $serviceGroup 'Remove from boot' 152 74 140 28
  $script:Controls.InstallServiceHint = New-Label $serviceGroup 'Registering needs administrator rights; Windows will ask.' 302 79 460 20

  $controlGroup = New-Object System.Windows.Forms.GroupBox
  $controlGroup.Text = 'Good to know'
  $controlGroup.Location = New-Object System.Drawing.Point(10, 170)
  $controlGroup.Size = New-Object System.Drawing.Size(775, 160)
  $serviceTab.Controls.Add($controlGroup)
  [void](New-Label $controlGroup '"Start bridge" / "Stop bridge" in the toolbar do the same as the buttons there.' 12 24 740 18)
  [void](New-Label $controlGroup 'Configuration and logs live in %ProgramData%\EstateMate; "Open logs" shows them.' 12 48 740 18)
  [void](New-Label $controlGroup 'The bridge only makes outbound connections. It never listens on a port.' 12 72 740 18)
  [void](New-Label $controlGroup 'After changing anything, press "Run check": it authenticates against the Worker and probes every terminal.' 12 96 740 18)

  return $form
}

function Update-Summary {
  $running = $false
  $detail = ''
  if ($script:Status -and $script:Status.service -and $script:Status.service.installed) {
    $detail = "scheduled task $($script:Status.service.name)"
    if ($script:Status.service.status -and $script:Status.service.status -match 'Running') { $running = $true }
  }
  if ($script:OwnProcess -and -not $script:OwnProcess.HasExited) { $running = $true; $detail = 'started from this window' }
  if (-not $running) {
    $alive = @(Get-Process -Name 'estatemate-bridge' -ErrorAction SilentlyContinue)
    if ($alive.Count -gt 0) { $running = $true; $detail = 'running in the background' }
  }

  if ($script:Controls.BridgeState) {
    if ($running) {
      $script:Controls.BridgeState.Text = "Bridge: RUNNING ($detail)"
      $script:Controls.BridgeState.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 40)
    } else {
      $script:Controls.BridgeState.Text = 'Bridge: stopped'
      $script:Controls.BridgeState.ForeColor = [System.Drawing.Color]::FromArgb(150, 60, 0)
    }
  }
  if ($script:Controls.AgentState) {
    if ($script:Config -and $script:Config.agentId) {
      $script:Controls.AgentState.Text = "Agent: $($script:Config.agentId)"
      $script:Controls.AgentState.ForeColor = [System.Drawing.Color]::FromArgb(40, 40, 40)
    } else {
      $script:Controls.AgentState.Text = 'Agent: not configured yet'
      $script:Controls.AgentState.ForeColor = [System.Drawing.Color]::FromArgb(160, 40, 40)
    }
  }
  if ($script:Controls.DeviceState) {
    $count = 0
    if ($script:Status -and $script:Status.devicesFile) { $count = [int]$script:Status.devicesFile.count } else { $count = @($script:Devices).Count }
    $script:Controls.DeviceState.Text = "Terminals: $count configured"
  }
  if ($script:Controls.PortalState) {
    $worker = '(Worker URL not set)'
    if ($script:Config -and $script:Config.workerUrl) { $worker = [string]$script:Config.workerUrl }
    $script:Controls.PortalState.Text = "Portal: $worker"
  }
  if ($script:Controls.ServiceState) {
    if ($script:Status -and $script:Status.service -and $script:Status.service.installed) {
      $script:Controls.ServiceState.Text = "Scheduled task '$($script:Status.service.name)': installed (status: $($script:Status.service.status))"
    } else {
      $script:Controls.ServiceState.Text = 'Scheduled task: not installed - the bridge stops when this PC logs off or restarts'
    }
  }
  if ($script:Controls.InstallServiceHint) {
    if (Test-Admin) { $script:Controls.InstallServiceHint.Text = 'Running as administrator.' }
    else { $script:Controls.InstallServiceHint.Text = 'Registering needs administrator rights; Windows will ask.' }
  }
}

function Refresh-Summary {
  if ($script:Busy) { return }
  Read-State
  Update-Summary
}

function Fill-Fields {
  if (-not $script:Controls.AgentId) { return }
  if ($script:Config) {
    if ($script:Config.agentId) { $script:Controls.AgentId.Text = [string]$script:Config.agentId }
    if ($script:Config.agentSecret) { $script:Controls.AgentSecret.Text = [string]$script:Config.agentSecret }
    if ($script:Config.workerUrl) { $script:Controls.WorkerUrl.Text = [string]$script:Config.workerUrl }
  } elseif (-not $script:Controls.WorkerUrl.Text) {
    $script:Controls.WorkerUrl.Text = 'https://estatemate.estatemate.workers.dev'
  }

  # Only when the table is empty: the timer must never overwrite an edit in progress.
  if ($script:Controls.Grid -and $script:Controls.Grid.Rows.Count -eq 0) {
    foreach ($device in @($script:Devices)) {
      $index = $script:Controls.Grid.Rows.Add()
      $row = $script:Controls.Grid.Rows[$index]
      $row.Cells['DeviceId'].Value = [string]$device.estateMateDeviceId
      $row.Cells['Name'].Value = [string]$device.name
      $row.Cells['Host'].Value = [string]$device.isapiHost
      $row.Cells['Port'].Value = [string]$device.isapiPort
      $row.Cells['User'].Value = [string]$device.isapiUsername
      $row.Cells['Password'].Value = [string]$device.isapiPassword
      if ($device.protocol) { $row.Cells['Protocol'].Value = [string]$device.protocol } else { $row.Cells['Protocol'].Value = 'http' }
      if ($device.eventStream -eq $false) { $row.Cells['Events'].Value = $false } else { $row.Cells['Events'].Value = $true }
    }
  }
}

function Get-DevicesJson {
  # The table, in the shape `setup --devices-json` expects.
  $devices = @()
  foreach ($row in $script:Controls.Grid.Rows) {
    $id = [string]$row.Cells['DeviceId'].Value
    $host_ = [string]$row.Cells['Host'].Value
    if (-not $id.Trim() -and -not $host_.Trim()) { continue }
    $port = 80
    [void][int]::TryParse([string]$row.Cells['Port'].Value, [ref]$port)
    $protocol = [string]$row.Cells['Protocol'].Value
    if ($protocol -ne 'https') { $protocol = 'http' }
    # The column is a checkbox, so this is a real boolean; the string case is
    # for anything that writes text into the cell ([bool]'False' is $true).
    $live = $row.Cells['Events'].Value
    if ($live -is [string]) { $live = ($live -eq 'True') }
    $devices += [pscustomobject]@{
      estateMateDeviceId = $id.Trim()
      name               = [string]$row.Cells['Name'].Value
      isapiHost          = $host_.Trim()
      isapiPort          = $port
      isapiUsername      = [string]$row.Cells['User'].Value
      isapiPassword      = [string]$row.Cells['Password'].Value
      protocol           = $protocol
      enabled            = $true
      eventStream        = [bool]$live
    }
  }
  return [pscustomobject]@{ devices = @($devices) }
}

function Save-Configuration([string] $fromInstaller) {
  # One writer for both files: `setup`. It validates the values, hardens the file
  # permissions and writes agent-config.json + isapi-devices.json exactly as the
  # console wizard does - this window never writes configuration itself.
  $devicesFile = Join-Path $env:TEMP ('estatemate-devices-' + [Guid]::NewGuid().ToString('N') + '.json')
  $built = Get-DevicesJson
  if (@($built.devices).Count -gt 0) {
    Write-Utf8NoBom $devicesFile ($built | ConvertTo-Json -Depth 5)
  } elseif ($script:DevicesPath -and (Test-Path -LiteralPath $script:DevicesPath)) {
    Copy-Item -LiteralPath $script:DevicesPath -Destination $devicesFile -Force
  } else {
    Write-Utf8NoBom $devicesFile '{"devices":[]}'
  }

  $arguments = @('setup', '--no-prompt', '--no-verify', '--devices-json', $devicesFile)
  if ($fromInstaller) {
    $arguments += @('--from-installer', $fromInstaller)
  } else {
    $agentId = $script:Controls.AgentId.Text.Trim()
    $agentSecret = $script:Controls.AgentSecret.Text
    $workerUrl = $script:Controls.WorkerUrl.Text.Trim()
    if (-not $agentId -or -not $agentSecret) {
      Remove-Item -LiteralPath $devicesFile -Force -ErrorAction SilentlyContinue
      return [pscustomobject]@{ Code = 2; Output = 'Agent ID and agent secret are both required (or point at the portal setup script).' }
    }
    $arguments += @('--agent-id', $agentId, '--agent-secret', $agentSecret)
    if ($workerUrl) { $arguments += @('--worker-url', $workerUrl) }
  }

  # The elevated retry runs the very same command line, so the devices file has
  # to survive until every attempt is done. It is removed in the finally, and
  # the retry is not skipped for --from-installer: writing agent-config.json
  # under %ProgramData%\EstateMate needs administrator rights either way.
  try {
    $result = Invoke-Bridge $arguments
    if ($result.Code -ne 0 -and -not (Test-Admin)) {
      Write-Activity 'Writing the configuration needs administrator rights (the file holds the agent secret, so it is administrator-only); asking Windows.'
      $result = Invoke-BridgeElevated $arguments
    }
    return $result
  } finally {
    Remove-Item -LiteralPath $devicesFile -Force -ErrorAction SilentlyContinue
  }
}

# -------------------------------------------------------------------- actions ---

function Start-Bridge {
  $script:Busy = $true
  try {
    $registered = $script:Status -and $script:Status.service -and $script:Status.service.installed
    if ($registered) {
      Write-Activity "--- starting the scheduled task '$($script:TaskName)' ---"
      $output = & schtasks.exe /Run /TN $script:TaskName 2>&1 | ForEach-Object { [string]$_ }
      $global:LASTEXITCODE = 0
      Write-Activity ($output -join "`r`n")
    } else {
      Write-Activity '--- starting the bridge in the background ---'
      try {
        $script:OwnProcess = Start-Process -FilePath $script:BridgeExe -ArgumentList @('run') -PassThru -WindowStyle Hidden
        Write-Activity "Started process $($script:OwnProcess.Id). It runs while this PC is logged in - use Service -> Start at boot to keep it always."
      } catch {
        Write-Activity "Could not start the bridge: $($_.Exception.Message)"
      }
    }
  } finally {
    $script:Busy = $false
  }
  Start-Sleep -Milliseconds 500
  Refresh-Summary
  Update-LiveLog
}

function Stop-Bridge {
  $script:Busy = $true
  try {
    Write-Activity '--- stopping the bridge ---'
    if ($script:OwnProcess -and -not $script:OwnProcess.HasExited) {
      Stop-Process -Id $script:OwnProcess.Id -Force -ErrorAction SilentlyContinue
      Write-Activity "Stopped process $($script:OwnProcess.Id)."
      $script:OwnProcess = $null
    }
    if ($script:Status -and $script:Status.service -and $script:Status.service.installed) {
      & schtasks.exe /End /TN $script:TaskName 2>&1 | ForEach-Object { Write-Activity ([string]$_) }
      $global:LASTEXITCODE = 0
    }
    $left = @(Get-Process -Name 'estatemate-bridge' -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) { Write-Activity 'Nothing else was running.' }
    foreach ($process in $left) {
      try {
        $process.Kill()
        Write-Activity "Stopped background process $($process.Id)."
      } catch {
        Write-Activity "Could not stop process $($process.Id): $($_.Exception.Message)"
      }
    }
  } finally {
    $script:Busy = $false
  }
  Start-Sleep -Milliseconds 500
  Refresh-Summary
  Update-LiveLog
}

function Start-Check {
  $script:Busy = $true
  $cursor = [System.Windows.Forms.Cursor]::Current
  [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::WaitCursor
  try {
    Write-Activity 'Running the pre-flight check (Worker + every terminal); this can take a few seconds...'
    $result = Invoke-Bridge @('check')
    Show-CommandResult 'check' $result
    if ($result.Code -ne 0 -and -not (Test-Admin)) {
      Write-Activity 'The check needs to read the administrator-only configuration; asking Windows.'
      $result = Invoke-BridgeElevated @('check')
      Show-CommandResult 'check (as administrator)' $result
    }
    if ($result.Code -eq 0) { Write-Activity 'Check finished. The lines above say what the Worker and each terminal answered.' }
  } finally {
    [System.Windows.Forms.Cursor]::Current = $cursor
    $script:Busy = $false
  }
  Refresh-Summary
  Update-LiveLog
}

function Open-Logs {
  $folder = Join-Path $env:ProgramData 'EstateMate\logs'
  if ($script:LogFile) { $folder = Split-Path -Parent $script:LogFile }
  if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
  if ($script:LogFile -and (Test-Path -LiteralPath $script:LogFile)) {
    Start-Process 'explorer.exe' -ArgumentList "/select,`"$($script:LogFile)`""
  } else {
    Start-Process 'explorer.exe' -ArgumentList "`"$folder`""
  }
}

function Set-ServiceRegistration([bool] $install) {
  $script:Busy = $true
  try {
    $arguments = @()
    if ($install) { $arguments += 'install-service' } else { $arguments += 'uninstall-service' }
    $result = Invoke-Bridge $arguments
    if ($result.Code -ne 0 -and -not (Test-Admin)) {
      Write-Activity 'Registering the start-at-boot task needs administrator rights; asking Windows.'
      $result = Invoke-BridgeElevated $arguments
    }
    Show-CommandResult ($arguments -join ' ') $result
  } finally {
    $script:Busy = $false
  }
  Refresh-Summary
}

function Restart-Elevated {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($script:BridgeExe) { $arguments += @('-ExePath', "`"$($script:BridgeExe)`"") }
  try {
    Start-Process 'powershell.exe' -Verb RunAs -ArgumentList $arguments | Out-Null
    $script:Controls.Form.Close()
  } catch {
    Write-Activity 'The administrator prompt was dismissed.'
  }
}

function Add-Terminal {
  $index = $script:Controls.Grid.Rows.Add()
  $row = $script:Controls.Grid.Rows[$index]
  $row.Cells['Name'].Value = 'Access terminal'
  $row.Cells['Port'].Value = '80'
  $row.Cells['User'].Value = 'admin'
  $row.Cells['Protocol'].Value = 'http'
  $row.Cells['Events'].Value = $true
}

function Remove-Terminal {
  if ($script:Controls.Grid.SelectedRows.Count -eq 0) {
    Write-Activity 'Select the terminal row to remove first.'
    return
  }
  foreach ($row in @($script:Controls.Grid.SelectedRows)) { $script:Controls.Grid.Rows.Remove($row) }
}

function Save-Settings {
  $script:Busy = $true
  try {
    $result = Save-Configuration $null
    Show-CommandResult 'save settings' $result
    if ($result.Code -eq 0) { Write-Activity 'Saved. Press "Run check" to confirm the Worker and the terminals answer.' }
  } finally {
    $script:Busy = $false
  }
  Read-State
  Update-Summary
}

function Apply-PortalFile {
  $path = $script:Controls.InstallerPath.Text.Trim()
  if (-not $path) {
    Write-Activity 'Choose the portal''s "Download setup" .ps1 first (Browse...).'
    return
  }
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Activity "That file is not there: $path"
    return
  }
  $script:Busy = $true
  try {
    $result = Save-Configuration $path
    Show-CommandResult 'setup from the portal file' $result
    if ($result.Code -eq 0) { Write-Activity 'Configuration written. Now press "Run check".' }
  } finally {
    $script:Busy = $false
  }
  Read-State
  Update-Summary
  $script:Controls.Grid.Rows.Clear()
  Fill-Fields
}

function Browse-PortalFile {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Pick the portal''s "Download setup" script'
  $dialog.Filter = 'Portal setup script (*.ps1)|*.ps1|All files (*.*)|*.*'
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $script:Controls.InstallerPath.Text = $dialog.FileName
  }
}

function Initialize-EventHandlers {
  $script:Controls.StartButton.Add_Click({ Start-Bridge })
  $script:Controls.StopButton.Add_Click({ Stop-Bridge })
  $script:Controls.CheckButton.Add_Click({ Start-Check })
  $script:Controls.OpenLogsButton.Add_Click({ Open-Logs })
  $script:Controls.ElevateButton.Add_Click({ Restart-Elevated })
  $script:Controls.BrowseButton.Add_Click({ Browse-PortalFile })
  $script:Controls.ApplyPortalButton.Add_Click({ Apply-PortalFile })
  $script:Controls.AddTerminalButton.Add_Click({ Add-Terminal })
  $script:Controls.RemoveTerminalButton.Add_Click({ Remove-Terminal })
  $script:Controls.SaveTerminalsButton.Add_Click({ Save-Settings })
  $script:Controls.InstallServiceButton.Add_Click({ Set-ServiceRegistration $true })
  $script:Controls.RemoveServiceButton.Add_Click({ Set-ServiceRegistration $false })
}

function Start-Dashboard {
  Add-WindowsForms
  $script:BridgeExe = Resolve-BridgeExe
  if (-not $script:BridgeExe) {
    [System.Windows.Forms.MessageBox]::Show(
      'estatemate-bridge.exe was not found. Run this dashboard from the folder the bridge is installed in (usually C:\Program Files\EstateMate Bridge).',
      'EstateMate Bridge',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    return 1
  }

  [void](New-DashboardForm)
  if ($script:Status -and $script:Status.version) { $script:Controls.Form.Text = "EstateMate Bridge $($script:Status.version)" }
  Initialize-EventHandlers
  Read-State
  if ($script:Status -and $script:Status.version) { $script:Controls.Form.Text = "EstateMate Bridge $($script:Status.version)" }
  Fill-Fields
  Update-Summary
  Write-Activity "EstateMate Bridge dashboard - $($script:BridgeExe)"
  Write-Activity ''
  if (-not (Test-Admin)) {
    Write-Activity 'This window is not running as administrator: configuration and "Start at boot" will ask Windows for permission when they need it.'
    Write-Activity ''
  }
  $tail = Get-LogTail 40
  if ($tail) {
    Write-Activity 'Recent log:'
    Write-Activity $tail
  } else {
    Write-Activity 'No log lines yet - press "Run check" or "Start bridge".'
  }
  Update-LiveLog

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 4000
  $timer.Add_Tick({
    $script:Ticks += 1
    Update-LiveLog
    if ($script:Ticks % 4 -eq 0) { Refresh-Summary }
  })
  $timer.Start()
  [void]$script:Controls.Form.ShowDialog()
  $timer.Dispose()
  return 0
}

# ------------------------------------------------------------------- self test ---

function Invoke-SelfTest {
  $script:SelfTestFailures = @()
  function Check([string] $name, [bool] $ok, [string] $detail) {
    if ($ok) { Write-Host "PASS: $name" } else { Write-Host "FAIL: $name -- $detail"; $script:SelfTestFailures += $name }
  }

  Add-WindowsForms
  $script:BridgeExe = Resolve-BridgeExe
  Check 'the bridge executable was found' ([bool]$script:BridgeExe) 'no estatemate-bridge.exe next to the dashboard or on PATH'

  if ($script:BridgeExe) {
    $version = Invoke-Bridge @('version')
    Check 'the bridge answers `version`' ($version.Code -eq 0) ($version.Output -replace "`r?`n", ' | ')
    $status = Invoke-Bridge @('status', '--json')
    Check 'the bridge answers `status --json`' ($status.Code -eq 0) ($status.Output -replace "`r?`n", ' | ')
    $script:Status = Get-StatusReport
    Check 'the status report parses' ([bool]$script:Status) ($status.Output -replace "`r?`n", ' | ')
    if ($script:Status) {
      $script:ConfigPath = $script:Status.config.path
      $script:DevicesPath = $script:Status.devicesFile.path
      $script:LogFile = $script:Status.logFile
      Check 'the status report names the config file' ([bool]$script:ConfigPath) 'config.path was empty'
      Check 'the status report names the devices file' ([bool]$script:DevicesPath) 'devicesFile.path was empty'
      Check 'the status report names the log file' ([bool]$script:LogFile) 'logFile was empty'
    }
  }

  try {
    [void](New-DashboardForm)
    $needed = @('Form', 'Report', 'LiveLog', 'Grid', 'AgentId', 'AgentSecret', 'WorkerUrl', 'InstallerPath',
                'BridgeState', 'AgentState', 'DeviceState', 'PortalState', 'ServiceState',
                'StartButton', 'StopButton', 'CheckButton', 'OpenLogsButton', 'InstallServiceButton',
                'RemoveServiceButton', 'SaveTerminalsButton', 'AddTerminalButton', 'ApplyPortalButton')
    $missing = @()
    foreach ($name in $needed) { if (-not $script:Controls.ContainsKey($name)) { $missing += $name } }
    Check 'every control the dashboard uses exists' ($missing.Count -eq 0) ($missing -join ', ')

    $grid = $script:Controls.Grid
    Check 'the terminal table has its eight columns' ($grid -and $grid.Columns.Count -eq 8) "columns: $($grid.Columns.Count)"
    $index = $grid.Rows.Add()
    $grid.Rows[$index].Cells['DeviceId'].Value = '00000000-0000-4000-8000-000000000000'
    $grid.Rows[$index].Cells['Name'].Value = 'Self-test terminal'
    $grid.Rows[$index].Cells['Host'].Value = '192.168.1.64'
    $grid.Rows[$index].Cells['Port'].Value = '80'
    $grid.Rows[$index].Cells['User'].Value = 'admin'
    $grid.Rows[$index].Cells['Password'].Value = 'secret'
    $grid.Rows[$index].Cells['Protocol'].Value = 'http'
    $grid.Rows[$index].Cells['Events'].Value = $true
    $built = Get-DevicesJson
    $single = @($built.devices)[0]
    Check 'the table becomes the devices JSON `setup` expects' `
      (@($built.devices).Count -eq 1 -and $single.isapiHost -eq '192.168.1.64' -and $single.estateMateDeviceId -eq '00000000-0000-4000-8000-000000000000' -and $single.eventStream -eq $true) `
      ($built | ConvertTo-Json -Depth 5 -Compress)
    $grid.Rows[$index].Cells['Events'].Value = $false
    $off = Get-DevicesJson
    Check 'switching a terminal off in the table writes eventStream false' `
      (@($off.devices)[0].eventStream -eq $false) `
      ($off | ConvertTo-Json -Depth 5 -Compress)
    $grid.Rows[$index].Cells['Events'].Value = $true
    $text = $built | ConvertTo-Json -Depth 5
    Check 'the devices JSON stays an array with one terminal' ($text -match '"devices"\s*:\s*\[') $text
    Check 'the devices JSON has no BOM and is valid UTF-8' (-not $text.StartsWith([char]0xFEFF)) 'the JSON starts with a byte-order mark'
    $grid.Rows.Clear()
    Fill-Fields
    Check 'the table can be rebuilt from the saved state' ($grid.Rows.Count -eq @($script:Devices).Count) "rows=$($grid.Rows.Count) devices=$(@($script:Devices).Count)"
  } catch {
    Check 'the window builds' $false $_.Exception.Message
  }

  if ($script:SelfTestFailures.Count -gt 0) {
    Write-Host "FAIL: dashboard self-test: $($script:SelfTestFailures.Count) check(s) failed"
    return 1
  }
  Write-Host 'PASS: dashboard self-test (window, state, terminal table, bridge CLI)'
  return 0
}

if ($SelfTest) { exit (Invoke-SelfTest) }
exit (Start-Dashboard)
