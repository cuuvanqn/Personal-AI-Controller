# PAC autonomous delivery model — implementation v0.1

## What is automated today
- GitHub Actions runs the security tests and policy checks for every PR into the tracked stack, and pushes to `main`.
- Both Windows and Ubuntu runners are used; all tests run without production secrets.
- A weekly schedule (`17 3 * * 1`, UTC) checks the **default branch only after this workflow is merged to main**.
- Each CI run uses `permissions: contents: read`, `timeout-minutes: 10`, `concurrency.cancel-in-progress: true`.
- Security policy guardrails block regressions such as automatic tunnel startup, OAuth auto-approval, unconstrained legacy terminal and reintroduction of vendor update/telemetry paths.
- Failures remain visible in workflow runs and PR checks. This workflow does **not** self-modify source or open Issues.

## Not automated yet
- AI writing or reviewing code on its own between user sessions.
- Automatic merge, Windows production install, access to the user's machine.
- CI-generated automatic code modifications or an approval-free loop.
- Standalone Windows low-privilege worker or restricted IPC. The current restricted engine is a read-only in-process prototype, not an OS security boundary.

## Design for future AI coding automation (separate opt-in phase)
1. Trigger on a specifically labelled GitHub Issue (e.g., `pac:agent-ready`) **only after the owner accepts an AI provider and budget**.
2. A controller validates repository, issue label, allowlisted paths and maximum attempts. Untrusted issue text is data, never instructions granting more privileges.
3. An agent runs in a disposable hosted environment, never on the live POS server or personal browser profile.
4. Controller provides only scoped tools and an isolated temporary branch. Never expose GitHub personal access tokens or production API keys to the model.
5. Agent drafts a patch, runs tests, checks budget and produces a Draft PR with evidence and changelog.
6. Code review and branch protection gate the merge. Never use `pull_request_target` to execute untrusted PR code with write tokens.
7. Constrain each issue to a fixed number of attempts and a per-task dollar cap. Persist audit events and stop on failures.

## Security and cost decisions
- Hosted GitHub Actions is a CI executor and *not* a free AI coding model.
- Do not enable automatic coding loops until the repository has an owner-approved provider, spend cap and permission boundaries.
- No self-hosted GitHub Actions runner on a personal/POS workstation.
- Keep workflows read-only; no broad `contents: write`, no artifact upload of local data, no production deployment.
- Avoid automatic scheduled CI on the current main until the stacked security PRs are reviewed and merged in order.

## Stacked PR hygiene
The current stack is: #1 -> #3 -> #4 -> #5 -> #6 -> #7 -> #8 -> this PR. These are draft changes; CI green is not a security certification.
Before merging, check review/diff, rebase or retarget where necessary and apply branch protections. No silent auto-merge.
