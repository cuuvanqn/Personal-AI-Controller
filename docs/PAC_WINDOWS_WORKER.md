# PAC separate-process Windows worker — lab architecture (v0)

## Delivered in this draft
- A **one-shot child process** with a narrowly defined JSON-over-stdin/stdout protocol.
- Fixed operations: `read_text`, `inspect_file`, `list_directory`; no writes, arbitrary shell, browser, network operations or model code execution.
- A launcher with a fixed executable and entrypoint, fixed cleanish environment, 8 KiB input frame maximum, 32 KiB output guard, 3-second default timeout and process termination on completion.
- Workspace root supplied by a trusted launcher; relative paths only, with checks for existing symlink/junction components and canonical containment.
- Cross-platform tests using real child processes on GitHub-hosted Windows and Linux runners.

## Critical security boundary
This is **process isolation**, **not an independently restricted Windows security token**. The spawned child inherits the current Windows account's filesystem permissions. Disabling a shell and clearing environment variables do not prevent arbitrary permissions if the child is compromised. The current path checks also have time-of-check/time-of-use races. Do not connect it to real user data or expose it over an API yet.

## Next Windows architecture gate
1. Introduce a dedicated local user or native restricted/AppContainer token, with no administrative privileges and carefully scoped filesystem ACLs.
2. Launch the worker with the low-privilege token via a vetted Windows-native launcher. Never launch it under POS server/service privileged credentials.
3. Replace plain stdio in a long-running mode with a secure per-session named pipe where client and server identities are verified, proper pipe ACLs are enforced, and each request is bound to a capability grant.
4. Enforce policy in the broker **and** OS: workspace ACL, no access to user profile, browser cookies, network resources or banking data. Explicit capability expiry, cancellation, quotas and an owner-visible approval log.
5. Build integration tests that run a worker with a *real distinct Windows security identity*; verify identity/SID, permissions on denied folders, network restrictions, junction/TOCTOU escapes and cleanup.
6. Only after that gate is met, connect the broker to PAC dashboard and expose limited file tools. Desktop and shell must remain disabled.

## Failure modes considered
- **Prompt injection:** requests are fixed schema; instructions from webpages cannot change executable or args.
- **Large/untrusted input:** fixed request cap and bounded result output.
- **Worker hang:** launcher kills on timeout. Crash/malformed response returns a structured error.
- **Symlink/junction escape:** checked before access; not race-free, hence OS ACL gate required.
- **Data leakage:** no file path in error response; do not log task contents or return data to cloud without explicit approval.
- **Crash/restart:** one process per task; no persistent session.
- **Privilege escalation:** not prevented by process separation alone. No release until restricted token + Windows ACLs are actually tested.

## Acceptance level
Lab prototype only. Green CI is not a claim of Windows account separation, code signing, a production-ready installer or suitability for access to POS/personal files.
