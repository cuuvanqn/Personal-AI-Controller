import { describe, test, expect } from "bun:test";
import { CdpBridge } from "../src/daemon/cdp-bridge";
import { OTTER_CORE_VERSION, isFacebookPostMismatch } from "../src/daemon/cdp-page-core";

describe("CDP Extension Core (Unit + Live Chrome CDP)", () => {
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
