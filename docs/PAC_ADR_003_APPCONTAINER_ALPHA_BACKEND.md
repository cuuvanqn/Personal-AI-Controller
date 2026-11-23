# PAC ADR-003 — AppContainer is the active Windows Alpha sandbox backend

Status: **Selected for disposable Alpha Lab only**, NOT approved for personal/POS data.
Date: 2026-11-23
Scope: PAC Alpha v0.3 Windows worker with GUI -> fixed native broker -> AppContainer Bun worker.

## The real root cause of the red native workflow

There were **two distinct Windows sandbox experiments** in the same workflow:

1. Legacy `CreateRestrictedToken` + `CreateProcessAsUserW` / `CreateProcessWithTokenW` experiment. It continues to return Win32 `ERROR_ACCESS_DENIED (5)`. Preflight verified primary token, process-token handle rights, EXE readable/executable, `SEC_IMAGE` mapping and desktop access. It is **not** an operating backend and **must not** be a fallback. Code retained for explicitly requested diagnostics only.
2. Working `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` AppContainer backend. It **has** launched an independent Win32 native probe and the real Bun worker with zero requested optional capabilities; a genuine Windows NTFS owner-only read is denied while the AppContainer-granted sibling file is readable. The fixed broker uses pipes, request limits and a Job Object before resuming the child. The GUI Alpha v0.3 directs its sample operations through this broker.

The AppContainer job regressed after adding a TCP loopback check: on Windows hosted runner, the child returned `WSAETIMEDOUT` instead of the single expected `WSAEACCES`. Microsoft documents WFP default-block *packet drops* for applications lacking network/loopback capabilities. The test was too narrowly specified, not proof that the child could connect.

## Revised test contract

The native AppContainer network test now:
- creates a **real** TCP listener restricted to `127.0.0.1` and an ephemeral port;
- establishes a positive owner TCP connection before attempting the child operation;
- launches a **real zero-optional-capability AppContainer** child with existing identity, ACL and Job Object checks;
- permits only a socket `WSAEACCES` or a bounded `WSAETIMEDOUT` as an **observed non-connection**;
- checks that **no AppContainer connection** was accepted;
- requires a second positive owner TCP connection to the exact same listener after the child finishes;
- fails on a successful child connection, connection refusal, arbitrary socket error, missing listener or process failure.

**Proof achieved:** IPv4 loopback TCP could not be established to this particular live host listener in a disposable CI test. **Not proved:** exact WFP filter responsible, IPv6, UDP, external egress, DNS, loopback exemption state on a future Windows installation, or absolute network isolation. A WFP per-AppContainer policy trace or broader deny-by-default network test is required before production release.

## What CI must prove on every relevant PR

- Windows/Ubuntu Bun tests and policy scans, including native desktop guard
- AppContainer child independently attests its restricted token
- AppContainer can read a specifically granted fixture and cannot read an owner-only sibling fixture
- Job Object containment and no unrestricted-token fallback
- Real Bun worker IPC with bounded fixed JSON operations
- Native WinForms GUI `--self-test` passes with **native broker**, not direct same-token worker
- Network listener controls pass for the native AppContainer probe

The **unused legacy restricted-token process** remains a manually invocable failure diagnostic. It is deliberately absent from the normal pull-request release path because a selected backend need not depend on every failed alternative. Do not suppress or misrepresent the historical failure.

## Alpha package / Windows Home restrictions

The downloaded ZIP is an **unsigned lab preview**. It must not be installed into a privileged directory, connected to live user files, or executed as administrator. File staging occurs inside a disposable AppContainer data folder; worker process is OS-isolated for the tested resources only. GUI/native broker still execute as the current user and are not themselves isolated.

Before release: test on a Windows 11 Home **disposable account** and Pro; measure profile deletion/cleanup on crash and task cancellation; verify no unwanted spawned children/handles, WFP IPv4/IPv6/UDP/DNS policy, tamper-proof signed binaries and an immutable installation directory, and proper IPC peer/consent policy. No general file picker, coding agent, browser, remote access, CUA or POS integration until these pass.

## Architecture decision

**Choose AppContainer as the single active Alpha backend.** The legacy restricted-token experiment is retained for diagnosis and reproducibility but is neither required for nor used by the AppContainer lab. This reduces duplicated Windows CI effort and avoids hiding a real failing experiment behind an automatic fallback. The next goal is a **reviewed and signed local broker with real Windows Home acceptance**, not more unconditional agent tools.

## Primary references

- Microsoft: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall
- Microsoft: https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- Microsoft: https://learn.microsoft.com/en-us/windows/win32/api/netfw/nf-netfw-networkisolationdiagnoseconnectfailureandgetinfo
