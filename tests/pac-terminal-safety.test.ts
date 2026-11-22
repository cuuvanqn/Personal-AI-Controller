import { describe, expect, it } from "bun:test";
import { createTerminalSession, sendTerminalInput, executeCommand } from "../src/daemon/terminal";

describe("PAC legacy shell quarantine", () => {
  it("denies arbitrary commands without executing their content", async () => {
    const outcome = await executeCommand("echo THIS_MUST_NOT_RUN");
    expect(outcome.exitCode).toBe(126);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("disabled");
  });

  it("creates inert terminal sessions with no spawned process", async () => {
    const session = createTerminalSession("pac-sandbox-test", ["powershell.exe"], "ignored");
    expect(session.inputAllowed).toBe(false);
    expect(session.proc).toBeUndefined();
    expect(await sendTerminalInput(session.id, "echo no\\n")).toBe(false);
  });
});
