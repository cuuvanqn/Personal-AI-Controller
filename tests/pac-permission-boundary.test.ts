import { describe, expect, test } from "bun:test";
import { handleSystemRoutes } from "../src/daemon/routes/system-routes";
import { getDaemonRoute } from "../src/daemon/routes/lcg-routes";

async function request(path: string, method: string): Promise<Response> {
  const url = new URL("http://127.0.0.1:1993" + path);
  const response = await handleSystemRoutes(new Request(url, { method }), url, 1993);
  if (!response) throw new Error("System route did not respond");
  return response;
}

describe("PAC permission boundary at HTTP routes", () => {
  test("public health does not disclose machine or session metadata", async () => {
    const data = await (await request("/health", "GET")).json();
    expect(data).toEqual({ status: "ok" });
    const other = await (await request("/api/health", "GET")).json();
    expect(other).toEqual({ status: "ok" });
  });

  test("remote HTTP request cannot enable Full Access", async () => {
    const url = new URL("http://127.0.0.1:1993/api/system/security/full-access");
    const response = await handleSystemRoutes(new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true })
    }), url, 1993);
    expect(response?.status).toBe(403);
    expect((await request(url.pathname, "GET")).status).toBe(200);
    const state = await (await request(url.pathname, "GET")).json();
    expect(state.fullAccess).toBe(false);
    expect(state.homeDir).toBeUndefined();
  });

  test("remote picker routes do not extend workspace permissions", async () => {
    for (const key of ["SYS_FOLDER_PICKER", "SYS_FILE_PICKER"] as const) {
      const endpoint = getDaemonRoute(key);
      const result = await request(endpoint, "POST");
      expect(result.status).toBe(403);
    }
  });
});
