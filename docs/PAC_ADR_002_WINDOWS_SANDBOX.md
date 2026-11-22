# PAC ADR-002 — Windows security backend selection and staged proof

Date: 2026-11-22
Status: PROPOSED — requires native Windows build and measured OS enforcement before release.

## Key critique of the previous design

- The one-request Bun worker process is an IPC and reliability boundary, **not a security boundary**: the inherited Windows access token can still read owner-accessible resources if a bug allows it.
- A type-safe JSON schema and path canonicalization reduce attack surface, but neither prevents hardlink aliases, NTFS alternate data streams (ADS), race-to-swap of junctions, nor hostile native DLL/module loads.
- Security features cannot be enabled purely because a unit test is green. Require an OS-denied file access against a path that the normal user CAN access.
- AppContainer and restricted tokens are **not interchangeable**: choosing one solely because it has more restrictions may break Bun initialization, module resolution, OS IPC, or the user's Windows edition. Use evidence to choose.
- Job Objects manage process lifetime/resources. They are not an independent filesystem permission boundary.
- Windows Sandbox is **not supported on Home**. A Home-compatible local backend is required; VM/Hyper-V is optional for special testing, not the default.

## Verified Microsoft documentation used in the decision

- AppContainer / LPAC implementation: https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- AppContainer isolation: https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- Restricted Tokens: https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens
- CreateProcessAsUser permission requirements: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw
- Job Objects: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Windows Sandbox supported editions: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/

## Architecture choice: two experiments, one production backend

**Track A (preferred proof):** Native Windows launcher using a fixed, signed/staged executable and a zero-optional-capability AppContainer profile. Work out executable/dll and sandboxed workspace ACLs, verify SID and capability set. Test network is denied via actual outbound socket attempt; do not rely on a documentation assumption. Test that the normal owner can read a private sentinel file while the sandboxed worker cannot.

**Track B (compatibility fallback):** Restricted primary token + explicit restricting SIDs, low integrity, strict per-workspace ACL and Job Object limits. Requires documented creation permissions and possibly a broker service; never silently fall back to unrestricted CreateProcess. Evaluate security coverage separately from A. Do not treat a low-integrity token by itself as a network ban.

**Selection gate:** Choose A only if Bun/native library loading, IPC, ACL and OS-denial assertions pass on supported Windows Home and Pro. Otherwise trial B. If neither passes, remain lab-only and offer no privileged desktop access.

## PAC process architecture

```
Owner UI (untrusted agent tasks)
    -> authorization broker (local owner consent, time-limited capability, audit)
    -> native launcher (fixed worker executable, verified hash/signature)
    -> restricted security identity + Job Object
    -> explicitly granted read-only NTFS workspace
    -> tightly bounded authenticated IPC
```

No model-supplied executable path, command, shell, environment override, Windows account, workspace root, or token mutation. Model output is task data only.

## Risks and acceptance tests

| Attack/failure | Defensive layer | Required independent proof |
|---|---|---|
| Hardlinks/ADS/device aliases | conservative input parser; reject nlink>1; OS identity | Try hidden links/streams and verify denied reads |
| Symlink/junction/TOCTOU | handle-based opening + reparse-point policy; ACL | Swap directory junction between check/open under stress |
| Unauthorized owner-profile read | AppContainer/restricted token + ACL | Worker read denied even with bypassed TS path validator |
| Network exfiltration | explicit OS network capability/policy | Real socket attempt blocked |
| Child escape or runaway output | Job Object, no handles, time/output quotas | Fork/timeout/memory abuse does not outlive broker |
| DLL search-order injection | signed and fixed binary, safe DLL search, immutable install dir | Tampered dependency cannot execute |
| IPC confusion/replay | local peer identity/pipe DACL, one-use nonce, expiry | Wrong peer/replayed request denied |
| Fail-open on unsupported host | sandbox selection logic fails closed | Deliberately break backend; owner token never used |
| Windows Home support | test without Windows Sandbox/Hyper-V dependency | Full negative test suite on Windows 11 Home disposable account |

## Efficiency optimization (after security proof)

- Start with **single-use read-only worker**, one task at a time. Avoid persistent background service and privileged admin install initially.
- If process spawn overhead is measurable, a pre-warmed pool may be considered ONLY with per-session identity and permission revocation proven; no pooling before isolated-worker security tests.
- Browser/CUA need separate capability domains and potentially a distinct interactive process. Do not let file-worker privileges expand to screenshots or keystrokes.
- Coding agent runs remotely on a disposable runner with explicit task budget; do not reuse local workstation credentials.
- Separate development build artifact, signed release package and local installer. Never infer Windows operational readiness from `bun build` alone.

## Immediate development implication

This branch adds conservative Windows path alias guards and hardlink tests. Those tests make unsafe file aliases harder to exploit but **do not replace the native backend**. Next code PR should implement a minimal Windows-native token/SID probe (no direct AI integration), then an ACL-backed denied-read integration test. A full product install remains blocked until that proof and independent review.

Definition of done: CI records Windows worker token identity, disallowed access denied by the **OS** even if task parser is bypassed, and no uncontrolled network/child processes, followed by Home/Pro smoke tests.
