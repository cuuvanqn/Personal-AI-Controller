# PAC Engineering Charter — v0.1

> Status: proposed, not a claim of security certification. The imported Otter v2.3.3 code remains untrusted until audited and hardened.

## Mission
Build a Windows-first, privately operated AI desktop controller based on selectively reviewed Otter components. GitHub repository stays public for source, documentation, and synthetic tests; real credentials, POS production records, and personal browser profiles must never enter the repository or cloud CI.

## Delivery model
- Work in short, independently reviewable PRs. The owner receives outcome-focused reports, not step-by-step UI instructions.
- Each PR states scope, risks, tests run, results, rollback and unresolved blockers. No "done" claim without recorded evidence.
- Preserve imported source license/attribution and upstream snapshot. No automatic upstream merges.
- Automated CI is allowed for read-only, disposable GitHub-hosted runners only. No self-hosted runner on a POS device.
- GitHub Actions is a CI executor, **not** an autonomous coding agent. AI authoring requires a separately configured agent and its own budget/credentials; avoid browser-session auto-approval loops.

## Phase gates
| Gate | Required evidence | Release decision |
|---|---|---|
| G0 Baseline | Reproducible dependency install, unit-test baseline, inventory of executables and outbound endpoints | No PAC install |
| G1 Security foundation | Mandatory authentication on local/LAN, deny-by-default permissions, no token in URL, telemetry disabled/removed, outbound network policy, negative tests | No desktop write |
| G2 Safe tools | Read-only file and code tools; independent path and symlink validation; no arbitrary shell; bounded outputs and timeouts | Limited test profile |
| G3 Controlled execution | Low-privilege worker, explicit allowlisted operations, human approval for high risk, audit logging, scoped browser profile | Lab-only automation |
| G4 Dev agent | Issue -> branch -> PR -> tests -> evidence; bounded attempts/cost; no auto-merge or production deploy | Owner approval |
| G5 Windows release | Signed / checksummed packaging, clean install/uninstall, crash recovery, restore test, full Windows acceptance tests | Pilot before production |

## Threat model (initial)
Protect local files, personal accounts, payment/POS data, secrets, command execution and repository integrity against prompt injection, hostile websites, malicious dependencies, compromised PRs, overprivileged tools, cross-account access and mistakes by agents.

## Security invariants
1. **No daemon reachable from public Internet by default**; no public tunnel.
2. Every tool request authenticated, including localhost and LAN; each client has revocable scoped authorization.
3. Localhost is not a trusted principal. CORS does not replace authentication.
4. No generic `powershell -Command <model text>`; sandbox/OS permissions enforce isolation, not only command regexes.
5. Deny file access beyond explicitly selected workspaces, including symlink/junction escape.
6. Browser automation uses a dedicated empty profile; never assume logged-in personal Chrome is safe.
7. No production POS access, banking secrets or real payment operations in automated test pipelines.
8. No automatic tool approval, remote code execution from webpage instructions, or unattended destructive actions.
9. Source imports and dependencies are pinned and audited; updates are manual/reviewed.
10. No data exfiltration or telemetry without explicit opt-in; cloud AI prompts must be redacted/minimized.

## Known imported-code gaps — not yet fixed
- `src/daemon/security.ts` permits tokenless trusted-network requests when no API key exists.
- `src/daemon/terminal.ts` has an arbitrary command execution path.
- `src/daemon/telemetry.ts` can send host/client metadata to an external service.
- `tests/security.test.ts` asserts some of the above legacy behaviors; it is a regression baseline, NOT a PAC security certification.
- Windows CUA, bundled binaries, installer scripts, dependency scripts and automatic updates require separate audits.

## Automation boundaries
Safe without owner: read public source, static audit, draft plan, write development branches, run tests on disposable runner, prepare draft PR and report findings.

Requires owner: merging/releasing, changing secrets, changing GitHub access policies, connecting local machines to tools, enabling cloud tunnels, spending money, approving external publication beyond ordinary public source changes, production deployment, destructive operations.

## Reporting format
**Delivered** (links, commits) / **Verified** (exact test run and outcome) / **Unverified** / **Risks** / **Only owner decisions**, if any.

## Next engineering work
1. Baseline CI (manual first), record test evidence.
2. Introduce PAC-specific failing tests asserting mandatory token for localhost/LAN.
3. Replace token/path/shell authorization architecture before exposing write-capable tools.
4. Design and implement minimal Windows lab controller.
