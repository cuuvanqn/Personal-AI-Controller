# PAC Windows sandbox design review — comparative study (22 Nov 2026)

**Status:** Architecture decision record / security review. No unreviewed upstream code copied. Previous versions of PAC remain Draft PRs. This file describes a proposal, not an implemented sandbox.

## References studied

| Repository | What PAC should learn | What PAC must NOT assume |
|---|---|---|
| [Microsoft SandboxSecurityTools](https://github.com/microsoft/SandboxSecurityTools) | AppContainer/LPAC launcher as test reference; verify restricted identity on Windows | Security test tooling is not a turnkey safe PAC launcher |
| [OpenAI Codex](https://github.com/openai/codex/tree/main/codex-rs/mxc-sandbox) | OS-backed Windows sandbox + explicit filesystem/permission policy | Do not copy an entire evolving runtime or presume all Windows editions behave identically |
| [OpenHands sandbox-server](https://github.com/OpenHands/sandbox-server) | Separate agent/control plane from execution environment | A sandboxed agent implementation does not confer safety on a Windows desktop host |
| [Microsoft Playwright](https://github.com/microsoft/playwright) | Disposable browser contexts, independent storage/cookies, test isolation | Browser-context separation is NOT OS-level isolation or a permissions firewall |
| [Microsoft hcsshim](https://github.com/microsoft/hcsshim) | Task/sandbox lifecycle separation; Windows isolation interfaces | Windows containers/Hyper-V are not the lightweight default for a personal Windows laptop |
| [RunFence](https://github.com/runfence/RunFence) | Dedicated Windows identity per workload and user-oriented confinement | A separate identity alone does not block all egress or desktop interactions |

These are architectural lessons, not a security endorsement or a transplant of upstream implementation. Before adopting code, record license, release version, threat model and an independent review.

## Key negative finding in current PAC prototype

`callLabWorker()` in the inherited PR #13 used `process.execPath` and a fixed child entry, but inherited **the caller's Windows token**. The separate child could still access resources granted to the owner account if its validation logic was bypassed. File-path checks alone are vulnerable to races and Windows hard links. The current work adds an **accidental-use lab gate** and streaming output bounds. Environment flags do not create a security boundary, and a process that can already run as the owner can still set them.

## Proposed PAC-specific architecture

```
owner's UI (untrusted task text)
  -> gateway (validate caller, task scope, expiry, owner consent, audit)
  -> Windows native broker (verify signed local capability, fixed executable)
  -> AppContainer/LPAC or restricted-token process + Job Object
  -> workspace ACL grant only (read initially), deny other data by OS
  -> one-use IPC response with byte cap, deadline, cancellation
```

**Security principle:** the native broker, not the AI model and not TypeScript path filtering, owns the security identity and resource policy. The worker must fail closed whenever restricted process creation, ACL preparation, network confinement or identity attestation fails.

### Windows backend strategy

1. **Preferred experiment: AppContainer/LPAC, zero optional capabilities**, a fixed profile per PAC worker type; minimal file ACL grant to disposable workspace. Evaluate packaged/unpackaged Bun compatibility and OS support first. Do not assume stdin/anonymous pipes and library loading work without test.
2. **Fallback experiment: restricted token (minimum privileges, low integrity) with Windows Job Object**, plus a dedicated local user if needed. Explicitly test hard-link, alternate data streams, device paths, junctions and network restrictions. Never silently fall back to the owner's normal identity.
3. **Last-resort isolation: Windows Sandbox / Hyper-V/VM** on supported systems only. Windows Sandbox availability depends on edition; not the default for Windows Home.
4. **If no backend passes required tests:** PAC remains read-only in its lab prototype, with no interactive desktop access.

### Broker protocol and capabilities

- Authentication at local IPC endpoint with restrictive pipe security descriptor, client identity check, per-task nonce, narrow operation and workspace grant.
- Short-lived capability, single-use semantics, revocation and bounded concurrency. Never trust a client-supplied executable, root path, environment, process arguments, or destination account.
- Do not give model, PR text, repository content or webpages a way to mint capabilities.
- Initial operations: `inspect_file`, `read_text`, `list_directory` only. Write/code execution, browser automation and CUA require separate capability classes and negative tests.
- OS-level deny rule for user-profile files, browser databases, passwords, payment/POS data and network by default. Screenshot/keyboard injection need separately approved interactive-session broker.
- Child process assigned to Job Object prior to untrusted execution; memory, CPU, process count and kill-on-close limits. No inheritable broad handles.
- Idempotent cleanup: close pipe, process and job; revoke file access; persist audit event without contents of private files.
- Avoid logs that contain tokens, screenshots, personal data or full path names.

## CI and lab acceptance matrix

| Proof | Windows CI (disposable) | Windows Home local lab | Production |
|---|---|---|---|
| Parent/child JSON IPC | Existing tests | Later | Not yet |
| Non-lab worker refusal | This PR | Later | Required |
| Child runs under distinct/restricted identity | Not yet | Required | Required |
| ACL prevents reading known-denied file | Not yet | Required | Required |
| Network egress blocked at OS boundary | Not yet | Required | Required |
| Symlink/junction/hardlink/ADS escape | Partial path test | Required | Required |
| Job timeout/child kill/resource controls | Limited timeout | Required | Required |
| Named pipe ACL and peer verification | Not yet | Required | Required |
| Browser profile separation | Not yet | Required | Required |
| Clean install/restore/remove | Not yet | Required | Required |

Do not mark a Windows build production-ready from TypeScript unit tests alone.

## Rollout and integration order

A. Land *reviewed* CI/security hardening and remove unsafe legacy entrypoints, retaining old functionality only when routed through validated broker.

B. Implement a **Windows-native sandbox helper** on a development branch. Compile on Windows, check security token identity/SID, demonstrate OS-denied file access even if TypeScript checks are bypassed; fail closed on unsupported features.

C. Add secure local IPC and broker/consent interface; no remote control in this phase.

D. Integrate the three read-only tools under an explicit workspace grant on a disposable Windows user profile. Review end-to-end including timeouts, cancellation and audit.

E. Add isolated browser automation and coding agent as separate capability classes. Automatic GitHub code editing remains on disposable hosted runners with scoped repository token and budget, never on the owner's POS machine.

## Decision

**Do not ship PAC as an always-on desktop controller yet.** The correct product differentiator is a verified, small, Windows-native permission broker rather than another unrestricted Otter wrapper. Treat CI green as evidence for limited tested invariants, not certification.
