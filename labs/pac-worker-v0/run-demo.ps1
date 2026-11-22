# PAC Worker Lab v0.1 — disposable test only. NOT an OS sandbox.
# Run only in isolated Windows test account / disposable VM.
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'pac-worker-lab.exe'
if (!(Test-Path $exe)) { throw 'Missing pac-worker-lab.exe' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('pac-lab-' + [Guid]::NewGuid().ToString('N'))
New-Item -Path $root -ItemType Directory -Force | Out-Null
try {
  [IO.File]::WriteAllText((Join-Path $root 'hello.txt'), 'PAC lab first run', [Text.UTF8Encoding]::new($false))
  $env:NODE_ENV = 'test'
  $env:PAC_WORKER_LAB_MODE = '1'
  $raw = '{"operation":"read_text","relativePath":"hello.txt"}' | & $exe $root
  if ($LASTEXITCODE -ne 0) { throw 'Worker process failed' }
  $reply = $raw | ConvertFrom-Json
  if (!$reply.ok -or $reply.result.text -ne 'PAC lab first run') {
    # Printed content is the generated test fixture only, never private user data.
    Write-Host ('PAC_LAB_DIAG: ok=' + $reply.ok + ' error=' + $reply.error +
      ' textLength=' + ([string]$reply.result.text).Length)
    throw 'Worker IPC/read-only smoke test failed'
  }

  # Negative proof: a model cannot turn this read-only worker into shell.
  $forbidden = '{"operation":"execute_terminal_command","command":"whoami"}' | & $exe $root | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $forbidden.ok -or $forbidden.error -ne 'OPERATION_DENIED') {
    throw 'PAC lab failed command-denial test'
  }
  # Negative proof: traversal outside the workspace is not accepted.
  $escaped = '{"operation":"read_text","relativePath":"../outside.txt"}' | & $exe $root | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $escaped.ok) { throw 'PAC lab failed path-traversal test' }
  # Negative proof: compiled worker CLI must refuse when lab flag is absent.
  $env:PAC_WORKER_LAB_MODE = '0'
  $notAuthorized = '{"operation":"read_text","relativePath":"hello.txt"}' | & $exe $root | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $notAuthorized.ok -or $notAuthorized.error -ne 'OS_SANDBOX_NOT_CONFIGURED') {
    throw 'PAC lab failed runtime lab-mode refusal'
  }
  $env:PAC_WORKER_LAB_MODE = '1'
  Write-Host 'PAC_LAB_NEGATIVE_TESTS_PASSED: command denied; traversal denied; unapproved mode denied'
  Write-Host 'PAC_LAB_V0_PASSED: fixture read via compiled worker executable'
} finally {
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  Remove-Item Env:PAC_WORKER_LAB_MODE -ErrorAction SilentlyContinue
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
