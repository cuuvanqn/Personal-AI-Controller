/**
 * PAC automated regression gate.
 * Fail closed if previously removed unsafe entrypoints are reintroduced.
 * This is a targeted guardrail, not a complete source or runtime security audit.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type SourceSet = Record<string, string>;

const paths = {
  index: "src/daemon/index.ts",
  security: "src/daemon/security.ts",
  oauth: "src/daemon/routes/oauth-routes.ts",
  terminal: "src/daemon/terminal.ts",
  telemetry: "src/daemon/telemetry.ts",
  updater: "src/daemon/routes/update-routes.ts",
  restricted: "src/daemon/pac-restricted-task-engine.ts",
} as const;

export function checkPacPolicy(sources: SourceSet): string[] {
  const errors: string[] = [];
  const source = (file: string): string => {
    if (typeof sources[file] !== "string") {
      errors.push(`Missing file: ${file}`);
      return "";
    }
    return sources[file];
  };

  const index = source(paths.index);
  const security = source(paths.security);
  const oauth = source(paths.oauth);
  const terminal = source(paths.terminal);
  const telemetry = source(paths.telemetry);
  const updater = source(paths.updater);
  const restricted = source(paths.restricted);

  if (!/hostname:\s*["']127\.0\.0\.1["']/.test(index)) {
    errors.push("Daemon must bind loopback by default");
  }
  if (!/const shouldStartTunnel\s*=\s*tunnelExplicitlyOn\s*&&\s*!tunnelDisabled\s*;/.test(index)) {
    errors.push("Remote tunnel must require an explicit opt-in");
  }
  if (/^\s*startTelemetryHeartbeat\s*\(/m.test(index)) {
    errors.push("Automatic vendor telemetry was re-enabled");
  }
  if (/^\s*startUpdateScheduler\s*\(/m.test(index)) {
    errors.push("Automatic vendor update scheduler was re-enabled");
  }
  if (/console\.log\([^\n]*url\.search/.test(index)) {
    errors.push("HTTP logger may expose query parameters");
  }
  if (!/ensureAuthToken\(\);\s*const server = Bun\.serve/s.test(index)) {
    errors.push("Daemon must prepare its auth token before listening");
  }

  const auth = security.slice(security.indexOf("export function isRequestAuthorized("));
  if (!/authorization\s*=\s*req\.headers\.get\("authorization"\)/.test(auth) ||
      /searchParams\.get\(["']token["']\)/.test(auth)) {
    errors.push("API auth must require a header and reject URL tokens");
  }
  const safePath = security.slice(security.indexOf("export function assertSafePath("), security.indexOf("/**\n * Lấy mã xác thực"));
  if (!/realPathForAccess/.test(safePath) || /if\s*\(isFullAccessEnabled\(\)\)/.test(safePath)) {
    errors.push("Workspace must canonicalize paths and forbid Full Access bypass");
  }

  if (/if\s*\(autoApprove\s*&&/.test(oauth) || /searchParams\.get\(["']auto_approve["']\)/.test(oauth)) {
    errors.push("OAuth must never auto-approve based on local network origin");
  }

  if (/\bspawn\s*\(|\bexecSync\s*\(|\bexecFile\s*\(/.test(terminal)) {
    errors.push("Legacy terminal may not spawn processes");
  }
  if (!/exitCode:\s*126/.test(terminal) || !/inputAllowed:\s*false/.test(terminal)) {
    errors.push("Legacy terminal must remain disabled");
  }

  if (/\bfetch\s*\(|\bdoFetch\s*\(/.test(telemetry)) {
    errors.push("Vendor telemetry must not send network requests");
  }
  if (/\bapplyUpdate\s*\(|\bcheckForUpdate\s*\(/.test(updater)) {
    errors.push("Remote binary updater must remain disabled");
  }
  if (!/new Set\(\["inspect_file", "read_text", "list_directory"\]\)/.test(restricted) ||
      /\bspawn\s*\(|\bexecSync\s*\(|\bexecFile\s*\(/.test(restricted)) {
    errors.push("Restricted task engine must remain read-only and without a subprocess");
  }

  return errors;
}

export function loadPacSources(root: string = process.cwd()): SourceSet {
  const sources: SourceSet = {};
  for (const file of Object.values(paths)) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) sources[file] = fs.readFileSync(full, "utf8");
  }
  return sources;
}

if (import.meta.main) {
  const failures = checkPacPolicy(loadPacSources());
  if (failures.length) {
    console.error("PAC SECURITY POLICY FAILED:");
    failures.forEach((message, i) => console.error(`  ${i + 1}. ${message}`));
    process.exitCode = 1;
  } else {
    console.log("PAC security policy checks passed.");
  }
}
