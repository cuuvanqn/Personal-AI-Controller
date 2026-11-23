# PAC Alpha Lab v0.3 — Native AppContainer UI (experimental)

## What changed

The Windows interface now **requires** a separate Native AppContainer Broker for all file tasks. The GUI no longer launches the read-only Bun worker directly with its own Windows identity, and **does not fall back** to an unconfined worker when broker startup fails. This is a significant improvement over v0.2, but **not a production-ready PAC**.

## Use (disposable Windows test machine/account only)

Extract the entire ZIP, keep its three EXEs together, and double-click **PAC-Alpha-Lab.exe**. You do not need to type commands, grant administrator rights, install a service or set up a database.

The interface is in Vietnamese, offering these buttons:
- **Đọc nội dung** — read a fixed sample file from the broker-created AppContainer profile
- **Xem thuộc tính** — inspect its size
- **Liệt kê thư mục** — list the broker's sample workspace
- **Kiểm tra an toàn** — check allowed operations, invalid command/path denial, AppContainer token identity and NTFS access denial of an owner-only sibling file
- **Dừng tác vụ** — stop the broker; its Job Object kills the sandboxed worker
- **Đóng** — close the interface

The UI accepts **no arbitrary file path or command**. The native broker uses fixed operation modes; it creates temporary samples and AppContainer profiles, and destroys them after a normally completed task. It has no network, browser or shell operation API.

## Files in the package

- PAC-Alpha-Lab.exe — native Windows Forms interface (.NET Framework)
- PAC-AppContainer-Broker.exe — fixed-operation native Win32 AppContainer launcher and Job Object guardian
- pac-worker-lab.exe — Bun-compiled read-only task engine in the AppContainer
- BUILD-MANIFEST.txt — source SHA and executable SHA256 checksums
- run-demo.ps1 — legacy v0.1 worker test (not required to open the GUI)
- ALPHA-V03-README.md — this document

## Verified vs not verified

The CI integration aims to prove:
- Child process has an AppContainer token, with **zero requested optional capabilities**.
- Allowed file in sandbox profile is readable, owner-only file in the same folder returns ACCESS_DENIED at Windows OS level.
- Bun runs inside AppContainer through explicitly inherited, bounded, single-request IPC pipes.
- A Windows Job Object kills child processes when its broker exits.
- A compiled Windows GUI issues fixed operations through the native broker and passes a headless GUI integration self-test.

The following **remain unverified** and BLOCK real user-data support:
- Windows 11 Home on an independent local machine (GitHub-hosted runner is not that test).
- Full independent egress-denial verification for the Bun process (IPv4/IPv6, external TCP, UDP and DNS). A separate native AppContainer probe now verifies **one** host-loopback TCP connection cannot be established against a listener reachable by the owner both before and after. A timeout is observational non-connectivity, not identified WFP filter attribution.
- Application signing, immutable installation directory, secure updater and uninstall/profile cleanup after power loss or force-kill.
- Arbitrary user-selected workspaces with reliable Windows-native no-reparse-point / file-handle containment and race defense.
- Audited authenticated IPC for non-lab tasks and permissions/consent UI.
- Browser, CUA, code execution, AI tool grants and remote access.

**Important:** Stopping/killing the broker ends the Job Object child but can leave a disposable AppContainer profile behind. A recoverable profile-cleanup mechanism is necessary before any general distribution. Normal task completion attempts profile cleanup.

Do not disable antivirus/SmartScreen/UAC just to run these unsigned experiments; use only a disposable lab PC/VM or wait for an officially reviewed package.

## Architecture

PAC Alpha GUI -> fixed native broker -> AppContainer (no optional capabilities) -> Bun read-only worker -> temporary NTFS ACL-protected sample.

No direct worker fallback. No local HTTP service. No remote endpoint. No admin rights requested.

## Development

Source and CI tests are in Draft PRs. The previous restricted primary-token backend still returns Win32 error 5 on hosted runners. It is retained as an explicitly triggered **legacy diagnostic only** and is never a fallback if AppContainer fails. See `docs/PAC_ADR_003_APPCONTAINER_ALPHA_BACKEND.md`.

The GUI now limits the native broker's stdout to 32 KiB **while it is being read** rather than buffering an arbitrary amount before validation. This is defense-in-depth for a broken broker; it does not grant new capabilities.
