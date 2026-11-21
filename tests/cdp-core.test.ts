import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CdpBridge, readDefaultChromeActivePort } from "../src/daemon/cdp-bridge";
import { OTTER_CORE_VERSION, isFacebookPostMismatch } from "../src/daemon/cdp-page-core";

describe("CDP Extension Core (Unit + Live Chrome CDP)", () => {
  test("readDefaultChromeActivePort parses valid, invalid, and missing DevToolsActivePort", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "otter-cdp-port-"));
    try {
      expect(readDefaultChromeActivePort(tmp)).toBeNull();

      fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "not-a-port\n/devtools/browser/xyz\n");
      expect(readDefaultChromeActivePort(tmp)).toBeNull();

      fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "9333\n/devtools/browser/abc-123\n");
      expect(readDefaultChromeActivePort(tmp)).toEqual({
        port: 9333,
        wsPath: "/devtools/browser/abc-123",
        browserWsUrl: "ws://127.0.0.1:9333/devtools/browser/abc-123",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("DevToolsActivePort browser-level WS reuses 1 persistent socket with flatten session multiplexing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "otter-cdp-bws-"));
    let wsConnections = 0;
    const seenMethods: Array<{ method: string; sessionId?: string }> = [];
    let coreLoadedOnTab = false;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/devtools/browser/mock-guid" && srv.upgrade(req)) {
          return undefined;
        }
        return new Response("HTTP /json disabled on Chrome 144+", { status: 404 });
      },
      websocket: {
        open() {
          wsConnections++;
        },
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          seenMethods.push({ method: msg.method, sessionId: msg.sessionId });

          if (msg.method === "Target.getTargets") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  targetInfos: [
                    { targetId: "T-FB", type: "page", title: "Facebook", url: "https://www.facebook.com/" },
                    { targetId: "T-2", type: "page", title: "Docs", url: "https://example.com/" },
                  ],
                },
              })
            );
            return;
          }
          if (msg.method === "Target.attachToTarget") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { sessionId: `S-${msg.params.targetId}` },
              })
            );
            return;
          }
          if (msg.method === "Target.activateTarget" || msg.method === "Target.closeTarget") {
            ws.send(JSON.stringify({ id: msg.id, result: { success: true } }));
            return;
          }
          if (msg.method === "Page.enable" || msg.method === "Page.addScriptToEvaluateOnNewDocument" || msg.method === "Input.dispatchMouseEvent") {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
            return;
          }
          if (msg.method === "Runtime.evaluate") {
            const expr: string = msg.params?.expression || "";
            if (expr.includes("window.__otterCore.version ===")) {
              ws.send(JSON.stringify({ id: msg.id, result: { result: { value: coreLoadedOnTab } } }));
              return;
            }
            if (expr.includes("OTTER_CORE_VERSION") || expr.includes("window.__otterCore =")) {
              coreLoadedOnTab = true;
              ws.send(JSON.stringify({ id: msg.id, result: { result: { value: true } } }));
              return;
            }
            if (expr.includes("window.__otterCore.readPage")) {
              ws.send(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    result: {
                      value: { title: "Facebook", url: "https://www.facebook.com/", elementsCount: 42, elements: [] },
                    },
                  },
                })
              );
              return;
            }
            if (expr.includes("window.__otterCore.prepClick")) {
              ws.send(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    result: { value: { ok: true, inViewport: true, x: 100, y: 200, tag: "button", text: "Like" } },
                  },
                })
              );
              return;
            }
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true } } } }));
          }
        },
      },
    });

    const bridge = new CdpBridge(59999, tmp);
    try {
      fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), `${server.port}\n/devtools/browser/mock-guid\n`);

      // 1. isAvailable() must use TCP probe ONLY (0 WebSocket connections -> no Chrome Allow popup!)
      expect(await bridge.isAvailable()).toBe(true);
      expect(wsConnections).toBe(0);

      // 2. listTabs, readPage, click, switchTab, closeTab all share 1 persistent WebSocket!
      const tabs = await bridge.listTabs();
      expect(tabs.ok).toBe(true);
      expect(tabs.tabs.length).toBe(2);

      const page = await bridge.readPage("facebook.com");
      expect(page.title).toBe("Facebook");
      expect(page.elementsCount).toBe(42);
      expect(page.tabId).toBe("T-FB");

      const clicked = await bridge.click(1, "facebook.com");
      expect(clicked.ok).toBe(true);
      expect(clicked.message).toContain("isTrusted");

      const switched = await bridge.switchTab("T-2");
      expect(switched.ok).toBe(true);

      const closed = await bridge.closeTab("T-2");
      expect(closed.ok).toBe(true);

      // Verify single persistent WebSocket & flattened sessionId multiplexing
      expect(wsConnections).toBe(1);
      expect(seenMethods.some((m) => m.method === "Target.attachToTarget" && !m.sessionId)).toBe(true);
      expect(seenMethods.some((m) => m.method === "Page.addScriptToEvaluateOnNewDocument" && m.sessionId === "S-T-FB")).toBe(true);
      expect(seenMethods.some((m) => m.method === "Input.dispatchMouseEvent" && m.sessionId === "S-T-FB")).toBe(true);
      expect(seenMethods.some((m) => m.method === "Target.activateTarget")).toBe(true);
      expect(seenMethods.some((m) => m.method === "Target.closeTarget")).toBe(true);
    } finally {
      bridge.close();
      server.stop(true);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("isFacebookPostMismatch detects home/profile redirect vs real post URL", () => {
    expect(
      isFacebookPostMismatch("https://www.facebook.com/", "https://www.facebook.com/share/p/17tu5cAG8h/")
    ).toBe(true);
    expect(
      isFacebookPostMismatch(
        "https://www.facebook.com/groups/12345/posts/99999/",
        "https://www.facebook.com/groups/12345/posts/99999/"
      )
    ).toBe(false);
  });

  test("preloads window.__otterCore via CDP, runs Alibaba Page-Agent readPage, hardware click, React typing, scroll & HUD", async () => {
    const bridge = new CdpBridge();
    const available = await bridge.isAvailable();
    if (!available) {
      console.warn("[cdp-core.test] Chrome CDP port not open — skipping live browser assertions");
      return;
    }

    // 1. Preload core on open tabs
    const preloadedCount = await bridge.preloadCoreOnAllTabs();
    expect(preloadedCount).toBeGreaterThanOrEqual(1);

    // 2. Open https://otter.gpt.io.vn/ — Page.addScriptToEvaluateOnNewDocument auto-loads __otterCore
    const opened = await bridge.openUrl("https://otter.gpt.io.vn/");
    expect(opened.ok).toBe(true);
    expect(opened.url).toContain("otter.gpt.io.vn");

    // 3. Verify all Extension Core APIs are preloaded inside window.__otterCore
    const coreCheck = await bridge.execute("evaluate_js", {
      script: `({
        version: window.__otterCore?.version,
        hasHud: !!document.getElementById('otter-activation-hud'),
        apis: Object.keys(window.__otterCore || {})
      })`,
    });
    expect(coreCheck.ok).toBe(true);
    expect(coreCheck.result.version).toBe(OTTER_CORE_VERSION);
    expect(coreCheck.result.apis).toContain("readPage");
    expect(coreCheck.result.apis).toContain("typeElement");
    expect(coreCheck.result.apis).toContain("readComments");
    expect(coreCheck.result.apis).toContain("readFeed");
    expect(coreCheck.result.apis).toContain("reactFacebook");
    expect(coreCheck.result.apis).toContain("commentFacebook");
    expect(coreCheck.result.apis).toContain("openFbComposer");
    expect(coreCheck.result.apis).toContain("finishFbPost");
    expect(coreCheck.result.apis).toContain("museSend");
    expect(coreCheck.result.apis).toContain("injectHud");

    // 4. Full Alibaba Page-Agent readPage (interactive elements + data-otter-index + badges)
    const page = await bridge.execute("read_page");
    expect(page.elementsCount).toBeGreaterThan(5);
    expect(page.coreVersion).toBe(OTTER_CORE_VERSION);

    // 5. Smart scroll
    const scrollRes = await bridge.execute("scroll", { direction: "down", amount: 500 });
    expect(scrollRes.ok).toBe(true);
    expect(typeof scrollRes.scrollHeight).toBe("number");

    // 6. Test React controlled TextInput bypass on the 229 tools search box!
    const pageAfterScroll = await bridge.execute("read_page");
    const searchInput = pageAfterScroll.elements.find(
      (e: any) => e.tagName === "input" && (e.placeholder || "").toLowerCase().includes("browser")
    );
    if (searchInput) {
      const typeRes = await bridge.execute("type", { index: searchInput.index, text: "vps", pressEnter: false });
      expect(typeRes.ok).toBe(true);
      const valCheck = await bridge.execute("evaluate_js", {
        script: `document.querySelector('[data-otter-index="${searchInput.index}"]')?.value`,
      });
      expect(valCheck.result).toBe("vps");
    }

    // 7. Benchmark single-session CDP latency
    const bench = await bridge.benchmark(3);
    expect(bench.available).toBe(true);
    expect(bench.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(bench.averageLatencyMs).toBeLessThan(100);
  }, 25000);
});
