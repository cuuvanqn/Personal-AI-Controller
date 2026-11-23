# PAC Alpha Lab v0.1 - GUI for disposable Windows test account ONLY.
# This demonstration is NOT an OS sandbox, installer or production controller.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1 on a disposable Windows machine' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Use Windows PowerShell -STA' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$exe = Join-Path $PSScriptRoot 'pac-worker-lab.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Missing pac-worker-lab.exe' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('pac-alpha-lab-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'hello.txt'), 'PAC Alpha sample only', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $root 'notes.txt'), 'This is disposable test data.', [Text.UTF8Encoding]::new($false))

$form = New-Object Windows.Forms.Form
$form.Text = 'PAC Alpha | Worker Lab v0.1'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object Drawing.Size(830,570)
$form.MinimumSize = New-Object Drawing.Size(730,510)
$form.Font = New-Object Drawing.Font('Segoe UI', 10)
$form.BackColor = [Drawing.Color]::FromArgb(246,248,252)

$heading = New-Object Windows.Forms.Label
$heading.Location = New-Object Drawing.Point(22,18)
$heading.Size = New-Object Drawing.Size(760,34)
$heading.Font = New-Object Drawing.Font('Segoe UI', 16, [Drawing.FontStyle]::Bold)
$heading.Text = 'PAC | Thu nghiem Worker cuc bo'
$form.Controls.Add($heading)
$warning = New-Object Windows.Forms.Label
$warning.Location = New-Object Drawing.Point(22,58)
$warning.Size = New-Object Drawing.Size(770,64)
$warning.ForeColor = [Drawing.Color]::FromArgb(132,59,12)
$warning.Text = 'CHI DUNG DU LIEU MAU tren may thu nghiem. Worker ke thua quyen tai khoan Windows, CHUA co AppContainer / ACL sandbox. Khong dung tren may POS hoac du lieu ca nhan.'
$form.Controls.Add($warning)
$hint = New-Object Windows.Forms.Label
$hint.Location = New-Object Drawing.Point(22,128)
$hint.Size = New-Object Drawing.Size(770,34)
$hint.Text = 'Chi 3 thao tac doc. Khong the chon thu muc khac, ghi file hay chay lenh shell.'
$form.Controls.Add($hint)

function Add-PacButton($text, $x, $width) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object Drawing.Point($x,175)
  $b.Size = New-Object Drawing.Size($width,44)
  $form.Controls.Add($b)
  return $b
}
$read = Add-PacButton 'Doc file mau' 22 184
$inspect = Add-PacButton 'Thong tin file' 215 184
$list = Add-PacButton 'Danh sach file' 408 184
$stop = Add-PacButton 'DUNG' 601 184
$stop.Enabled = $false
$stop.BackColor = [Drawing.Color]::FromArgb(255,229,225)

$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(22,234)
$status.Size = New-Object Drawing.Size(765,26)
$status.Text = 'Trang thai: San sang (offline)'
$form.Controls.Add($status)
$output = New-Object Windows.Forms.TextBox
$output.Location = New-Object Drawing.Point(22,272)
$output.Size = New-Object Drawing.Size(762,222)
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Vertical'
$output.Anchor = 'Top,Bottom,Left,Right'
$output.Font = New-Object Drawing.Font('Consolas', 10)
$output.Text = "PAC Worker Lab v0.1 - sample files only. Independent child process; 4-second timeout."
$form.Controls.Add($output)
$footer = New-Object Windows.Forms.Label
$footer.Location = New-Object Drawing.Point(22,507)
$footer.Size = New-Object Drawing.Size(765,25)
$footer.Anchor = 'Bottom,Left,Right'
$footer.Text = 'read_text / inspect_file / list_directory | No data leaves the lab.'
$form.Controls.Add($footer)

$script:child = $null
$script:started = [DateTime]::MinValue
$script:operation = ''
function Set-PacBusy([bool]$busy) {
  $read.Enabled = -not $busy
  $inspect.Enabled = -not $busy
  $list.Enabled = -not $busy
  $stop.Enabled = $busy
}
function Stop-PacTask([string]$why) {
  if ($script:child -and -not $script:child.HasExited) {
    try { $script:child.Kill() } catch {}
  }
  $status.Text = 'Trang thai: ' + $why
  Set-PacBusy $false
}
function Start-PacTask([string]$operation, [string]$relative) {
  if ($script:child -and -not $script:child.HasExited) { return }
  try {
    $json = @{operation=$operation;relativePath=$relative} | ConvertTo-Json -Compress
    $settings = New-Object Diagnostics.ProcessStartInfo
    $settings.FileName = $exe
    $settings.Arguments = '"' + $root + '"'
    $settings.UseShellExecute = $false
    $settings.CreateNoWindow = $true
    $settings.RedirectStandardInput = $true
    $settings.RedirectStandardOutput = $true
    $settings.RedirectStandardError = $true
    $settings.EnvironmentVariables['NODE_ENV'] = 'test'
    $settings.EnvironmentVariables['PAC_WORKER_LAB_MODE'] = '1'
    $script:child = New-Object Diagnostics.Process
    $script:child.StartInfo = $settings
    if (-not $script:child.Start()) { throw 'Worker start failed' }
    $script:child.StandardInput.Write($json)
    $script:child.StandardInput.Close()
    $script:started = [DateTime]::UtcNow
    $script:operation = $operation
    $status.Text = 'Trang thai: Dang xu ly ' + $operation
    $output.Text = 'Worker is running ...'
    Set-PacBusy $true
  } catch {
    $output.Text = 'Worker could not start.'
    Stop-PacTask 'Loi khoi chay'
  }
}
$read.Add_Click({ Start-PacTask 'read_text' 'hello.txt' })
$inspect.Add_Click({ Start-PacTask 'inspect_file' 'hello.txt' })
$list.Add_Click({ Start-PacTask 'list_directory' '.' })
$stop.Add_Click({ Stop-PacTask 'Da dung theo yeu cau'; $output.Text = 'Worker terminated.' })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  if (-not $script:child) { return }
  if (-not $script:child.HasExited) {
    if (([DateTime]::UtcNow - $script:started).TotalMilliseconds -gt 4000) {
      Stop-PacTask 'Het thoi gian 4 giay'
      $output.Text = 'Task timed out. Worker terminated.'
    }
    return
  }
  try {
    $wire = $script:child.StandardOutput.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($wire) -gt 32768) { throw 'Oversized response' }
    $result = $wire | ConvertFrom-Json
    if ($result.ok -eq $true) {
      $output.Text = $result.result | ConvertTo-Json -Depth 8
      $status.Text = 'Trang thai: Hoan tat ' + $script:operation
    } else {
      $output.Text = 'Worker refused: ' + [string]$result.error
      $status.Text = 'Trang thai: Bi tu choi'
    }
  } catch {
    $output.Text = 'Invalid worker response'
    $status.Text = 'Trang thai: Loi'
  } finally {
    $script:child.Dispose()
    $script:child = $null
    Set-PacBusy $false
  }
})
$timer.Start()
$form.Add_FormClosing({
  $timer.Stop()
  if ($script:child) {
    try { if (-not $script:child.HasExited) { $script:child.Kill() } } catch {}
    try { $script:child.Dispose() } catch {}
  }
  try { [IO.Directory]::Delete($root, $true) } catch {}
})
try { [void]$form.ShowDialog() }
finally {
  $timer.Stop()
  $timer.Dispose()
  $form.Dispose()
  try { if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) } } catch {}
}
