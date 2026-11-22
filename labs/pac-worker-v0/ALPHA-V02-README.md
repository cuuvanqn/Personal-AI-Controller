# PAC Alpha Lab v0.2 — Windows graphical preview

## What this is

A **native Windows desktop interface** for the read-only PAC lab worker. Double-click **PAC-Alpha-Lab.exe** inside the extracted ZIP. No command-line, GitHub login, network connection, installation or administrator privilege is required.

IMPORTANT: This is an experimental feature preview with **no Windows OS sandbox yet**. Run it only in a disposable Windows VM or isolated test account. Do not run on your POS server, work PC profile, or with real personal data. The EXEs inherit the user account's permissions; a lab mode flag is not a sandbox.

## Interface (Vietnamese)

- **1. Đọc nội dung** — reads an automatically generated sample file
- **2. Xem thuộc tính** — inspects only that sample file
- **3. Liệt kê thư mục** — lists only the generated sample workspace
- **4. Kiểm tra an toàn** — runs allowed/read-only and denied command/path tests
- **Dừng tác vụ** — terminates a running worker process
- **Đóng** — exits and deletes the temporary sample workspace

The interface does not provide a file picker, path input, web connection, shell, GitHub credentials, POS access or remote server. It generates a temporary fixture under the isolated Windows test account and removes the fixture on exit.

## Test and verification

On GitHub Actions, Windows CI compiles:
- pac-worker-lab.exe using pinned Bun 1.4
- PAC-Alpha-Lab.exe using the installed .NET Framework C# compiler

It runs the worker smoke tests plus PAC-Alpha-Lab.exe --self-test without displaying the GUI, which verifies the actual compiled GUI launcher can communicate with the compiled worker and detect rejected shell/path attempts.

Run the graphical interface by double-clicking PAC-Alpha-Lab.exe. For the standalone lab, a desktop with .NET Framework 4.8 and Windows 10/11 is expected (Windows Home is not separately verified).

## Safety and release gates

Do NOT treat a passing GUI self-test as proof of isolation. The native restricted-process OS security workflow remains independent and release-blocking; it currently returns ERROR_ACCESS_DENIED (5) before the child process launches. The UI preview cannot read any user-selected files and does not connect to the PAC daemon or AI.

Before any real workspace support, require an OS-isolated worker that demonstrates denied owner-only file access even when application path validation is bypassed, authenticated IPC with capability grants, network deny proof, Job Object controls, and a clean Windows Home installation test.

## If Windows warns about the executable

Do not override antivirus, UAC, execution policy or SmartScreen merely to run this experimental unsigned ZIP. Leave it in the disposable test environment and wait for a reviewed/signed release. The ZIP artifact on GitHub is short-retention and must match the reviewed source commit.

## Next milestone

Replace the lab-only current-user child with a separate Windows security identity (AppContainer or restricted standard account) **without expanding the UI's read-only operation set**. Keep the GUI protocol unchanged so its simple interface survives the security backend upgrade.
