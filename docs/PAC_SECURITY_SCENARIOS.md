# PAC security scenarios and release gates (2026-11-22)

Status: work in progress; not a security certification or permission to install on a personal/production machine.

## Verified code findings and mitigations in draft branches

| ID | Scenario | Existing Otter path | Draft mitigation | Verification and remaining work |
|---|---|---|---|---|
| AUTH-01 | Localhost/LAN request obtains tool access with no credential | `src/daemon/security.ts` | Mandatory Bearer authentication independent of IP | PAC security tests; check every network-facing route and websocket handshake |
| AUTH-02 | Query-string token leaks to logs/referrers | `src/daemon/security.ts`, `src/daemon/index.ts` | Query token rejected, HTTP log query omitted | Negative tests; inspect secondary logs |
| AUTH-03 | Unauthenticated management/media endpoints | `src/daemon/index.ts` prior public-route bypass list | Narrow public route list | Integration test each route and confirm browser UX |
| OAUTH-01 | `auto_approve=1` bypasses owner consent from trusted network | `src/daemon/routes/oauth-routes.ts` | GET never mints auth code; explicit consent POST required | Unit regression; audit origin, state, PKCE, redirect and CSRF handling |
| PROC-01 | Arbitrary commands through tool/API | `src/daemon/terminal.ts`, `src/daemon/tools/terminal.ts`, `src/daemon/routes/activity-routes.ts` | Shared legacy command executor returns 126 | Test that no legacy command starts; **other process-spawning tools remain in scope** |
| PROC-02 | Interactive shell/VPS session obtains persistent command channel | `createTerminalSession` | Inert session, no shell process | Negative test for disabled input; audit all other SSH/VPS adapters |
| PRIV-01 | Telemetry egress to third party | `src/daemon/telemetry.ts` | No-op telemetry shim | Injected fetch test; external network inspection on Windows still required |
| UPDATE-01 | Vendor updater swaps executable | `src/daemon/updater.ts`, update route, startup scheduler | Scheduler off and update routes denied | Test route response; audit other updater callers/direct imports |
| NET-01 | Quick Tunnel opens remote access by default | `src/daemon/index.ts` | Loopback bind and explicit tunnel opt-in | OS-level port scan/Windows Firewall test before pilot |

## High-priority unresolved scenarios
1. **Direct subprocess bypass:** Search every `spawn`, `exec`, `Bun.spawn`, `uv run`, Python/Shell and CUA/VPS bridge path, not just `executeCommand`. Replace with a single separate least-privileged worker; allowlist only structured operations (no shell string). Block any command from model/web content by default.
2. **Browser extension/CDP risk:** AI must not inherit signed-in Chrome, cookies or passwords. Dedicated profile and explicit tab/domain allowlist; disable extension injection until audited.
3. **Sensitive file escape:** Protect against Windows reparse points/junctions, symbolic links, UNC paths, alternate data streams and TOCTOU. Path prefix comparison alone is insufficient; enforce file permissions in OS sandbox.
4. **OAuth server correctness:** Do not trust client-supplied forwarded host/proto in origin generation. Review nonce/state, code binding, PKCE and redirect URI validation; test CSRF and replay.
5. **WebSocket:** Verify HTTP auth applies to upgrade, reject untrusted browser origins, protect tool dispatch through socket, constrain message sizes and rate limits.
6. **Untrusted dependencies/binaries:** Inventory downloaded CLI executables, postinstall scripts, extension privileges and update paths; verify SHA256 and provenance before use.
7. **Data exfiltration via AI:** Tool results, screenshots, browser DOM, logs and source snippets may contain secrets. Redact/minimize before external model requests.
8. **Public GitHub CI exposure:** No credentials or production data in workflows; minimal token permissions; block unsafe PR workflows; no self-hosted runners; short retention for artifacts.
9. **Operational reliability:** Explicit per-action approval, irreversible-action block, dry-run, timeout, bounded agent loops, durable audit, emergency stop and rollback.
10. **Windows release integrity:** Fresh install in isolated Windows test account/VM, verify no outbound unexpected connections, uninstall/restore, test on Windows 11 Home and no admin elevation by default.

## Required gate before enabling command execution
- Central structured tool command schema (no arbitrary shell interpolation).
- Sandboxed worker OS account, isolated workspace, filesystem access limited by Windows ACLs.
- Explicit executable allowlist, argument schema, timeout, output cap, no ambient credentials and outbound deny by default.
- Negative tests for injection, path traversal, symlink escape, hostile repository scripts, command substitution and refusal on dangerous requests.
- Independent review of each adapter with evidence logged in its PR.

## Gate before a Windows build can be offered as safe
- All stacked PRs reviewed/merged sequentially; baseline CI passes on Linux and Windows.
- Automated integration test of daemon routes and browser channel, not just unit tests.
- Dynamic security checks on disposable Windows host. No connected POS or banking/browser credentials.
- Source/BOM provenance, signed or checksummed binary, rollback plan, full test report.
- Owner approval for deployment and access credentials.

## Delivery contract
Each draft PR must report **changed code**, **verified tests**, **unverified assumptions**, **known regressions**, and **next blockers**. No PR is a production release. Do not silently auto-merge or auto-deploy.
