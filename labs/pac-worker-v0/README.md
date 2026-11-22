# PAC Worker Lab v0.1 (experiment only)

This is **not a Windows sandbox**, not a PAC installer, and not safe for personal or POS data. The compiled Bun executable inherits the identity and permissions of its caller. No GUI, browser, terminal, network task or write operation is exposed. Its only purpose is to validate packaging and one-request JSON IPC using an expendable `hello.txt` fixture.

## Expected contents

- `pac-worker-lab.exe` — Bun-compiled single-request worker
- `run-demo.ps1` — creates a temporary sample workspace, reads only the sample fixture, cleans up
- `README.md` — these limitations

## Windows lab scope

Use only on a **disposable Windows VM or separate test account**; do not run on your POS server or personal profile. In a PowerShell session started in the extracted artifact directory, invoke `./run-demo.ps1` if local policy permits scripts. Do **not** disable the machine's PowerShell security policy or grant administrator permissions to run the demo. If scripts are blocked, stop rather than bypass controls.

The worker denies direct invocations unless `NODE_ENV=test` and `PAC_WORKER_LAB_MODE=1`, but those flags do not create a security boundary. Do not pass paths containing real user files.

## Acceptance

`PAC_LAB_V0_PASSED: fixture read via compiled worker executable` means the packaged binary and JSON IPC worked against its disposable fixture. It does not prove ACL confinement, restricted token/AppContainer, network denial, or Windows Home compatibility. Those are separate release gates in Issue #15.

## Build and provenance

Windows GitHub-hosted CI builds the executable from the PR source, runs the same smoke script, and uploads a short-retention artifact for review. Never trust or install a binary from an unreviewed source without checking the workflow and source revision.
