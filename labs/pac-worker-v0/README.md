# PAC Worker Lab v0.1 (experiment only)

This is **not a Windows sandbox**, not a PAC installer, and not safe for personal or POS data. The UI is a limited local Windows Forms sample, not a security boundary. The compiled Bun executable inherits the identity and permissions of its caller. No GUI, browser, terminal, network task or write operation is exposed. Its only purpose is to validate packaging and one-request JSON IPC using an expendable `hello.txt` fixture.

## Expected contents

- `pac-worker-lab.exe` — Bun-compiled single-request worker
- `run-demo.ps1` — creates a temporary sample workspace, reads only the sample fixture, cleans up
- `pac-alpha-ui.ps1` — optional Vietnamese Windows Forms lab interface (Windows PowerShell 5.1, STA)
- `MO-PAC-ALPHA.cmd` — double-click launcher that does NOT elevate or bypass execution policy
- `README.md` — these limitations

## Windows lab scope

Use only on a **disposable Windows VM or separate test account**; do not run on your POS server or personal profile. In a PowerShell session started in the extracted artifact directory, invoke `./run-demo.ps1` if local policy permits scripts. Do **not** disable the machine's PowerShell security policy or grant administrator permissions to run the demo. If scripts are blocked, stop rather than bypass controls.

The worker denies direct invocations unless `NODE_ENV=test` and `PAC_WORKER_LAB_MODE=1`, but those flags do not create a security boundary. Do not pass paths containing real user files.

## Acceptance

`PAC_LAB_V0_PASSED: fixture read via compiled worker executable` means the packaged binary and JSON IPC worked against its disposable fixture. It does not prove ACL confinement, restricted token/AppContainer, network denial, or Windows Home compatibility. Those are separate release gates in Issue #15.

## Build and provenance

Windows GitHub-hosted CI builds the executable from the PR source, runs the same smoke script, and uploads a short-retention artifact for review. Never trust or install a binary from an unreviewed source without checking the workflow and source revision.

## Alpha Lab GUI (sample-only)

On a **disposable Windows test account or VM**, extract all ZIP files to one directory. Double-click `MO-PAC-ALPHA.cmd` to open the Vietnamese Windows Forms UI. It has three pre-programmed operations: read sample `hello.txt`, inspect it, and list temporary sample files. Results, errors, running status and a Stop control are visible. It creates a disposable temporary workspace and deletes it when the window closes.

The PowerShell GUI itself is not exercised interactively in headless GitHub Actions. CI checks **PowerShell syntax**, verifies the compiled worker EXE independently, and packages the script. Manual GUI/UI responsiveness testing in a disposable Windows desktop is still pending.

Do not use Run as administrator. No Internet access or remote port is needed by the intended GUI workflow. If script execution is blocked by Windows policy, leave that policy in place; do not use ExecutionPolicy Bypass or turn off antivirus. This sample has no authority to grant worker access to your personal files.

## Why this is not Alpha v0.2 acceptance

It has no OS-enforced low-privilege worker identity, authenticated native broker, signed installer, release distribution, browser automation or coding agent. The same-account Bun child can potentially access the same files as its parent if exploited. Native restricted primary-token process tests still fail and remain a release blocker. The GUI is only a usability pilot for the three read-only sample operations.
