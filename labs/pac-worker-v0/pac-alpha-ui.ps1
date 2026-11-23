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

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PAC Alpha | Worker Lab v0.1'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(830,570)
$form.MinimumSize = New-Object System.Drawing.Size(730,510)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.BackColor = [System.Drawing.Color]::FromArgb(246,248,252)

$heading = New-Object System.Windows.Forms.Label
$heading.Location = New-Object System.Drawing.Point(22,18)
$heading.Size = New-Object System.Drawing.Size(760,34)
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$heading.Text = 'PAC | Thử nghiệm Worker cục bộ'
$form.Controls.Add($heading)
$warning = New-Object System.Windows.Forms.Label
$warning.Location = New-Object System.Drawing.Point(22,58)
$warning.Size = New-Object System.Drawing.Size(770,64)
$warning.ForeColor = [System.Drawing.Color]::FromArgb(132,59,12)
$warning.Text = 'CHỈ DÙNG DỮ LIỆU MẪU trên máy thử nghiệm. Worker mang quyền Windows hiện tại, CHƯA có AppContainer / ACL sandbox. Không dùng trên máy POS hoặc dữ liệu cá nhân.'
$form.Controls.Add($warning)
$hint = New-Object System.Windows.Forms.Label
$hint.Location = New-Object System.Drawing.Point(22,128)
$hint.Size = New-Object System.Drawing.Size(770,34)
$hint.Text = 'Chỉ có ba thao tác đọc dữ liệu mẫu. Không thể chọn thư mục khác, ghi file hoặc chạy lệnh shell.'
$form.Controls.Add($hint)

function Add-PacButton($text, $x, $width) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x,175)
  $b.Size = New-Object System.Drawing.Size($width,44)
  $form.Controls.Add($b)
  return $b
}
$read = Add-PacButton 'Đọc file mẫu' 22 184
$inspect = Add-PacButton 'Thông tin file' 215 184
$list = Add-PacButton 'Danh sách file' 408 184
$stop = Add-PacButton 'DỪNG' 601 184
$stop.Enabled = $false
$stop.BackColor = [System.Drawing.Color]::FromArgb(255,229,225)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(22,234)
$status.Size = New-Object System.Drawing.Size(765,26)
$status.Text = 'Trạng thái: Sẵn sàng (ngoại tuyến)'
$form.Controls.Add($status)
$output = New-Object System.Windows.Forms.TextBox
$output.Location = New-Object System.Drawing.Point(22,272)
$output.Size = New-Object System.Drawing.Size(762,222)
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Vertical'
$output.Anchor = 'Top,Bottom,Left,Right'
$output.Font = New-Object System.Drawing.Font('Consolas', 10)
$output.Text = "PAC Worker Lab v0.1 – chỉ dữ liệu mẫu, tiến trình riêng, giới hạn 4 giây."
$form.Controls.Add($output)
$footer = New-Object System.Windows.Forms.Label
$footer.Location = New-Object System.Drawing.Point(22,507)
$footer.Size = New-Object System.Drawing.Size(765,25)
$footer.Anchor = 'Bottom,Left,Right'
$footer.Text = 'read_text / inspect_file / list_directory – không gửi dữ liệu lên mạng.'
$form.Controls.Add($footer)

$script:child = $null
$script:started = [DateTime]::MinValue
$script:operation = ''
$script:cancelled = $false
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
  $script:cancelled = $true
  $status.Text = 'Trạng thái: ' + $why
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
    $script:cancelled = $false
    $script:operation = $operation
    $status.Text = 'Trạng thái: Đang xử lý ' + $operation
    $output.Text = 'Worker đang xử lý ...'
    Set-PacBusy $true
  } catch {
    $output.Text = 'Không thể khởi chạy worker.'
    Stop-PacTask 'Lỗi khởi chạy'
  }
}
$read.Add_Click({ Start-PacTask 'read_text' 'hello.txt' })
$inspect.Add_Click({ Start-PacTask 'inspect_file' 'hello.txt' })
$list.Add_Click({ Start-PacTask 'list_directory' '.' })
$stop.Add_Click({ Stop-PacTask 'Đã dừng theo yêu cầu'; $output.Text = 'Worker đã dừng.' })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  if (-not $script:child) { return }
  if (-not $script:child.HasExited) {
    if (([DateTime]::UtcNow - $script:started).TotalMilliseconds -gt 4000) {
      Stop-PacTask 'Hết thời gian 4 giây'
      $output.Text = 'Task timed out. Worker đã dừng.'
    }
    return
  }
  try {
    if ($script:cancelled) { return }
    $wire = $script:child.StandardOutput.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($wire) -gt 32768) { throw 'Oversized response' }
    $result = $wire | ConvertFrom-Json
    if ($result.ok -eq $true) {
      $output.Text = $result.result | ConvertTo-Json -Depth 8
      $status.Text = 'Trạng thái: Hoàn tất ' + $script:operation
    } else {
      $output.Text = 'Worker từ chối: ' + [string]$result.error
      $status.Text = 'Trạng thái: Bị từ chối'
    }
  } catch {
    $output.Text = 'Phản hồi worker không hợp lệ'
    $status.Text = 'Trạng thái: Lỗi'
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
