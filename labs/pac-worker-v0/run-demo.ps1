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
    throw 'Worker IPC/read-only smoke test failed'
  }
  Write-Host 'PAC_LAB_V0_PASSED: fixture read via compiled worker executable'
} finally {
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  Remove-Item Env:PAC_WORKER_LAB_MODE -ErrorAction SilentlyContinue
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
