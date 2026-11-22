import { describe, expect, test } from "bun:test";
import { checkPacPolicy, loadPacSources } from "../scripts/pac-policy-check";

describe("PAC security automation guardrails", () => {
  const good = loadPacSources();

  test("accepts the current hardened source baseline", () => {
    expect(checkPacPolicy(good)).toEqual([]);
  });

  test("rejects accidental re-enabling of a public tunnel", () => {
    const source = good["src/daemon/index.ts"];
    const modified = source.replace(
      "const shouldStartTunnel = tunnelExplicitlyOn && !tunnelDisabled;",
      "const shouldStartTunnel = true;"
    );
    expect(modified).not.toBe(source);
    const findings = checkPacPolicy({ ...good, "src/daemon/index.ts": modified });
    expect(findings.some(f => f.includes("Remote tunnel"))).toBe(true);
  });

  test("rejects OAuth trusted-origin auto-approval", () => {
    const source = good["src/daemon/routes/oauth-routes.ts"];
    const modified = source + "\nif (autoApprove && isTrustedRequest(req, url)) { /* regression */ }\n";
    const findings = checkPacPolicy({ ...good, "src/daemon/routes/oauth-routes.ts": modified });
    expect(findings.some(f => f.includes("OAuth"))).toBe(true);
  });

  test("rejects shell spawn added to legacy terminal", () => {
    const source = good["src/daemon/terminal.ts"];
    const modified = source + "\nspawn({ cmd: [\"powershell.exe\"] });\n";
    const findings = checkPacPolicy({ ...good, "src/daemon/terminal.ts": modified });
    expect(findings.some(f => f.includes("Legacy terminal"))).toBe(true);
  });

  test("rejects URL token authentication", () => {
    const source = good["src/daemon/security.ts"];
    const modified = source + "\nconst leakedToken = url.searchParams.get(\"token\");\n";
    const findings = checkPacPolicy({ ...good, "src/daemon/security.ts": modified });
    expect(findings.some(f => f.includes("API auth"))).toBe(true);
  });

  test("rejects unexpected command execution in read-only worker", () => {
    const source = good["src/daemon/pac-restricted-task-engine.ts"];
    const modified = source + "\nspawn({ cmd: [\"cmd.exe\"] });\n";
    const findings = checkPacPolicy({ ...good, "src/daemon/pac-restricted-task-engine.ts": modified });
    expect(findings.some(f => f.includes("Restricted task engine"))).toBe(true);
  });

  test("fails when a required source file is missing", () => {
    const { ["src/daemon/telemetry.ts"]: _removed, ...partial } = good;
    expect(checkPacPolicy(partial)).toContain("Missing file: src/daemon/telemetry.ts");
  });
});
