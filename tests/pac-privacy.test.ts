import { describe, expect, test } from "bun:test";
import { getTelemetryUser, setTelemetryUser, sendTelemetryHeartbeat, startTelemetryHeartbeat, trackOtterDownload } from "../src/daemon/telemetry";
import { handleUpdateRoutes } from "../src/daemon/routes/update-routes";

describe("PAC privacy and safe updates", () => {
  test("vendor telemetry never calls a transport", async () => {
    let calls = 0;
    const blockedFetch = (async () => { calls++; throw new Error("must never be called"); }) as typeof fetch;
    setTelemetryUser({ email: "person@example.invalid" });
    expect(getTelemetryUser()).toBeNull();
    startTelemetryHeartbeat(1);
    expect(await sendTelemetryHeartbeat({ fetchImpl: blockedFetch })).toBe(false);
    expect(await trackOtterDownload({ component: "daemon", fetchImpl: blockedFetch })).toBe(false);
    expect(calls).toBe(0);
  });

  test("update check and binary replacement routes are rejected", async () => {
    for (const endpoint of ["/api/update/check", "/api/update/apply"]) {
      const url = new URL("http://localhost:1993" + endpoint);
      const response = await handleUpdateRoutes(new Request(url, { method: "POST" }), url);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
    }
  });
});
