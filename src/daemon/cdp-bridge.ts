/**
 * Otter CDP Bridge × Extension Page-Agent Core
 *
 * Kết hợp toàn bộ lõi điều khiển trang mạnh mẽ của Chrome Extension (Alibaba Page-Agent DOM,
 * Shadow DOM + iframe, React/Lexical typing, W3C Pointer click, Facebook Feed/Comments/Messenger,
 * Group/Media Post, Muse AI, Visual Activation HUD) trực tiếp vào Chrome DevTools Protocol (CDP):
 * - Tự động nạp `window.__otterCore` ngay khi CDP mở/kết nối tab (qua Page.addScriptToEvaluateOnNewDocument)
 *   -> Không cần cài Chrome Extension!
 * - Kết hợp sức mạnh phần cứng chỉ CDP mới có:
 *   1. `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` (sự kiện thật `isTrusted: true`)
 *   2. `DOM.setFileInputFiles` (tải ảnh/video trực tiếp từ ổ đĩa, không cần Base64)
 *   3. Chạy được cả Chrome desktop (có HUD trực quan) lẫn headless trên VPS Linux.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { findChromeExecutable } from "./chrome-profile";
import { getOtterDir } from "./db";
import {
  OTTER_CORE_VERSION,
  OTTER_PAGE_CORE_SCRIPT,
  isFacebookPostMismatch,
} from "./cdp-page-core";

export interface CdpTab {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

type CdpSendFn = (method: string, params?: any, timeoutMs?: number) => Promise<any>;

export class CdpBridge {
  private defaultPort: number;
  private controlledTabId: string | null = null;
  private preloadedTabIds = new Set<string>();
  private spawnedChrome: ChildProcess | null = null;

  constructor(defaultPort = 9222) {
    this.defaultPort = process.env.OTTER_CDP_PORT ? Number(process.env.OTTER_CDP_PORT) : defaultPort;
  }

  getPort(): number {
    return this.defaultPort;
  }

  setPort(port: number): void {
    this.defaultPort = port;
  }

  /**
   * Kiểm tra xem cổng CDP có đang mở và sẵn sàng không
   */
  async isAvailable(port?: number, _profileId?: string): Promise<boolean> {
    const targetPort = port || this.defaultPort;
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}

    if (!port) {
      const candidatePorts = [
        process.env.OTTER_CDP_PORT ? Number(process.env.OTTER_CDP_PORT) : null,
        Number(process.env.CDP_PORT) || null,
        32934,
      ].filter(Boolean) as number[];

      for (const p of candidatePorts) {
        if (p === targetPort) continue;
        try {
          const res = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            this.defaultPort = p;
            return true;
          }
        } catch {}
      }

      // Thử dò cổng từ GPM Login Profile đang mở
      try {
        const gpmPort = process.env.OTTER_GPM_PORT ? Number(process.env.OTTER_GPM_PORT) : 9495;
        const profRes = await fetch(`http://127.0.0.1:${gpmPort}/api/v1/profiles?page=1&page_size=20`, {
          signal: AbortSignal.timeout(1500),
        });
        if (profRes.ok) {
          const profData = (await profRes.json()) as any;
          const profiles = profData?.data?.data || profData?.data || [];
          for (const p of profiles) {
            try {
              const startRes = await fetch(`http://127.0.0.1:${gpmPort}/api/v1/profiles/start/${p.id}`, {
                signal: AbortSignal.timeout(1000),
              });
              if (startRes.ok) {
                const sData = (await startRes.json()) as any;
                const testPort = Number(sData.data?.remote_debugging_port);
                if (testPort) {
                  const testRes = await fetch(`http://127.0.0.1:${testPort}/json/version`, {
                    signal: AbortSignal.timeout(800),
                  });
                  if (testRes.ok) {
                    console.log(`[CDP Bridge] Tự phát hiện cổng CDP từ GPM Profile "${p.name}": Port ${testPort}`);
                    this.defaultPort = testPort;
                    return true;
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    return false;
  }

  /**
   * Tự động khởi động profile GPM Login nếu cổng CDP chưa mở
   */
  async ensureProfileRunning(profileId?: string, port?: number): Promise<boolean> {
    const targetPort = port || this.defaultPort;
    if (await this.isAvailable(targetPort)) return true;

    const targetProfile = profileId || process.env.OTTER_GPM_PROFILE_ID || "64b20c37-715c-4f4c-897c-fbbac828e8bf";
    const gpmPort = process.env.OTTER_GPM_PORT ? Number(process.env.OTTER_GPM_PORT) : 9495;

    try {
      const res = await fetch(
        `http://127.0.0.1:${gpmPort}/api/v1/profiles/start/${targetProfile}?remote_debugging_port=${targetPort}`,
        { signal: AbortSignal.timeout(12000) }
      );
      const data = (await res.json()) as any;
      if (data.success || data.message === "ProfileInUse") {
        await new Promise((r) => setTimeout(r, 2000));
        return await this.isAvailable(targetPort);
      }
    } catch {}

    return false;
  }

  /**
   * Lấy danh sách tất cả các tab đang mở
   */
  async getTabs(port?: number): Promise<CdpTab[]> {
    const targetPort = port || this.defaultPort;
    if (!(await this.isAvailable(targetPort))) {
      await this.ensureProfileRunning(undefined, targetPort);
    }
    const res = await fetch(`http://127.0.0.1:${targetPort}/json`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Không thể lấy danh sách tab từ CDP port ${targetPort}`);
    return (await res.json()) as CdpTab[];
  }

  /**
   * Tìm tab mục tiêu: ưu tiên urlPattern -> controlledTabId -> tab page đầu tiên
   */
  async findTargetTab(urlPattern?: string, port?: number): Promise<CdpTab> {
    const tabs = await this.getTabs(port);
    const pageTabs = tabs.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);

    if (pageTabs.length === 0) {
      throw new Error("Không tìm thấy tab trang web (type=page) nào đang mở trong trình duyệt CDP.");
    }

    if (urlPattern) {
      const q = urlPattern.toLowerCase();
      const matched = pageTabs.find(
        (t) => t.url.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)
      );
      if (matched) return matched;
    }

    if (this.controlledTabId) {
      const sticky = pageTabs.find((t) => t.id === this.controlledTabId);
      if (sticky) return sticky;
    }

    this.controlledTabId = pageTabs[0].id;
    return pageTabs[0];
  }

  /**
   * Mở 1 phiên WebSocket CDP duy nhất để thực thi nhiều lệnh liên tiếp (nhanh gấp 3-5x).
   */
  async withSession<T>(wsUrl: string, fn: (send: CdpSendFn) => Promise<T>, defaultTimeoutMs = 25000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let ws: WebSocket;
      let nextId = 1;
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>();

      const failAll = (err: any) => {
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        pending.clear();
      };

      const send: CdpSendFn = (method: string, params: any = {}, timeoutMs = defaultTimeoutMs) => {
        return new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return rej(new Error(`WebSocket CDP chưa mở khi gọi '${method}'`));
          }
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`Lệnh CDP '${method}' quá hạn sau ${timeoutMs / 1000}s`));
          }, timeoutMs);
          pending.set(id, { resolve: res, reject: rej, timer });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (err) {
            clearTimeout(timer);
            pending.delete(id);
            rej(err);
          }
        });
      };

      const connectTimer = setTimeout(() => {
        try { ws?.close(); } catch {}
        reject(new Error("Kết nối WebSocket CDP quá hạn sau 8s"));
      }, 8000);

      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(connectTimer);
        reject(err);
        return;
      }

      ws.onopen = () => {
        clearTimeout(connectTimer);
        fn(send)
          .then((result) => {
            try { ws.close(); } catch {}
            resolve(result);
          })
          .catch((err) => {
            try { ws.close(); } catch {}
            reject(err);
          });
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          if (data.id && pending.has(data.id)) {
            const p = pending.get(data.id)!;
            pending.delete(data.id);
            clearTimeout(p.timer);
            if (data.error) {
              p.reject(new Error(`Lỗi CDP: ${data.error.message || JSON.stringify(data.error)}`));
            } else {
              p.resolve(data.result);
            }
          }
        } catch {}
      };

      ws.onerror = () => {
        clearTimeout(connectTimer);
        const err = new Error("Lỗi kết nối WebSocket CDP");
        failAll(err);
        reject(err);
      };

      ws.onclose = () => {
        clearTimeout(connectTimer);
        if (pending.size > 0) {
          failAll(new Error("WebSocket CDP đã đóng trước khi nhận phản hồi"));
        }
      };
    });
  }

  /**
   * Gửi một lệnh CDP đơn lẻ qua WebSocket
   */
  async sendCommand(wsUrl: string, method: string, params: any = {}, timeoutMs = 20000): Promise<any> {
    return this.withSession(wsUrl, (send) => send(method, params, timeoutMs), timeoutMs);
  }

  /**
   * Chạy biểu thức JavaScript trong ngữ cảnh MAIN world của tab
   */
  async evaluateJs(wsUrl: string, expression: string, awaitPromise = true, timeoutMs = 20000): Promise<any> {
    const res = await this.sendCommand(
      wsUrl,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Lỗi JS thực thi trên trang: ${desc}`);
    }
    return res?.result?.value;
  }

  private async evalInSession(send: CdpSendFn, expression: string, awaitPromise = true, timeoutMs = 25000): Promise<any> {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, timeoutMs);
    if (res?.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Lỗi JS thực thi trên trang: ${desc}`);
    }
    return res?.result?.value;
  }

  /**
   * Nạp tự động Otter Page-Agent Core (`window.__otterCore`) vào tab CDP:
   * - Đăng ký `Page.addScriptToEvaluateOnNewDocument` để MỌI lần điều hướng / F5 đều có sẵn core ngay từ đầu.
   * - Đảm bảo trang hiện tại cũng đã có `window.__otterCore` ngay lập tức (idempotent).
   */
  async ensureCoreInSession(send: CdpSendFn, tabId: string): Promise<void> {
    if (!this.preloadedTabIds.has(tabId)) {
      try {
        await send("Page.enable", {}, 5000);
        await send("Page.addScriptToEvaluateOnNewDocument", { source: OTTER_PAGE_CORE_SCRIPT }, 5000);
        this.preloadedTabIds.add(tabId);
      } catch {}
    }
    const loaded = await this.evalInSession(
      send,
      `Boolean(window.__otterCore && window.__otterCore.version === ${JSON.stringify(OTTER_CORE_VERSION)})`,
      false,
      5000
    ).catch(() => false);
    if (!loaded) {
      await this.evalInSession(send, OTTER_PAGE_CORE_SCRIPT, false, 10000);
    }
  }

  /**
   * Nạp sẵn Otter Page-Agent Core vào tất cả các tab page đang mở ngay khi CDP vừa kết nối/khởi chạy.
   */
  async preloadCoreOnAllTabs(port?: number): Promise<number> {
    try {
      const tabs = await this.getTabs(port);
      const pageTabs = tabs.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      let count = 0;
      for (const tab of pageTabs) {
        try {
          await this.withSession(tab.webSocketDebuggerUrl!, async (send) => {
            await this.ensureCoreInSession(send, tab.id);
          });
          count++;
        } catch {}
      }
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Chờ trang hoàn tất tải (document.readyState === 'complete' hoặc 'interactive')
   */
  private async waitForPageReady(wsUrl: string, timeoutMs = 12000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluateJs(wsUrl, "document.readyState", false, 2000);
        if (state === "complete") return;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private shouldAutoHud(): boolean {
    const env = (process.env.OTTER_CDP_HUD || "").trim().toLowerCase();
    if (env === "0" || env === "false" || env === "off") return false;
    if (env === "1" || env === "true" || env === "on") return true;
    // Tự động bật HUD trực quan trên desktop có màn hình; tắt khi chạy headless Linux
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    return process.env.OTTER_CDP_HEADLESS !== "1";
  }

  /**
   * Mở URL mới hoặc điều hướng tab đang điều khiển (tự nạp sẵn Otter Core ngay khi load!)
   */
  async openUrl(url: string, port?: number): Promise<{ ok: boolean; tabId: string; title: string; url: string }> {
    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl) && !/^chrome:\/\//i.test(targetUrl) && !/^about:/i.test(targetUrl)) {
      targetUrl = "https://" + targetUrl;
    }

    const targetPort = port || this.defaultPort;
    let targetTab: CdpTab | null = null;
    try {
      targetTab = await this.findTargetTab(undefined, targetPort);
    } catch {}

    if (targetTab && targetTab.webSocketDebuggerUrl) {
      this.controlledTabId = targetTab.id;
      await this.withSession(targetTab.webSocketDebuggerUrl, async (send) => {
        await this.ensureCoreInSession(send, targetTab!.id);
        await send("Page.navigate", { url: targetUrl });
      });
      await this.waitForPageReady(targetTab.webSocketDebuggerUrl, 10000);
      await new Promise((r) => setTimeout(r, 400));

      const meta = await this.withSession(targetTab.webSocketDebuggerUrl, async (send) => {
        await this.ensureCoreInSession(send, targetTab!.id);
        if (this.shouldAutoHud()) {
          await this.evalInSession(send, "window.__otterCore.injectHud(false)", false, 4000).catch(() => {});
        }
        return this.evalInSession(send, "({ title: document.title, url: location.href })", false, 4000);
      }).catch(() => ({ title: targetTab!.title, url: targetUrl }));

      return {
        ok: true,
        tabId: targetTab.id,
        title: meta?.title || targetTab.title,
        url: meta?.url || targetUrl,
      };
    }

    const newTabRes = await fetch(`http://127.0.0.1:${targetPort}/json/new?${encodeURIComponent(targetUrl)}`, {
      method: "PUT",
    });
    const newTab = (await newTabRes.json()) as CdpTab;
    this.controlledTabId = newTab.id;
    if (newTab.webSocketDebuggerUrl) {
      await this.waitForPageReady(newTab.webSocketDebuggerUrl, 10000);
      await this.withSession(newTab.webSocketDebuggerUrl, async (send) => {
        await this.ensureCoreInSession(send, newTab.id);
        if (this.shouldAutoHud()) {
          await this.evalInSession(send, "window.__otterCore.injectHud(false)", false, 4000).catch(() => {});
        }
      }).catch(() => {});
    }
    return {
      ok: true,
      tabId: newTab.id,
      title: newTab.title,
      url: newTab.url || targetUrl,
    };
  }

  /**
   * Đọc cấu trúc trang với lõi Alibaba Page-Agent đầy đủ (Shadow DOM + iframe + Visual Badges + FB/Messenger)
   */
  async readPage(urlPattern?: string, port?: number): Promise<any> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    const res = await this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      if (this.shouldAutoHud()) {
        await this.evalInSession(send, "window.__otterCore.injectHud(false)", false, 4000).catch(() => {});
      }
      return this.evalInSession(
        send,
        `window.__otterCore.readPage({ showBadges: ${this.shouldAutoHud()} })`,
        false,
        15000
      );
    });

    return { ...res, tabId: tab.id, coreVersion: OTTER_CORE_VERSION };
  }

  /**
   * Click kết hợp 2 tầng:
   * - Tầng 1 (CDP Hardware): Input.dispatchMouseEvent (mouseMoved -> mousePressed -> mouseReleased, isTrusted=true)
   * - Tầng 2 (Extension W3C Core): Fallback chuỗi 9 sự kiện Pointer/Mouse + elementFromPoint nếu ngoài viewport
   */
  async click(index: number, urlPattern?: string, port?: number): Promise<{ ok: boolean; message: string }> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      const prep = await this.evalInSession(send, `window.__otterCore.prepClick(${Number(index)})`, false, 8000);
      if (!prep?.ok) {
        throw new Error(prep?.error || `Không tìm thấy phần tử index [${index}]`);
      }

      if (prep.inViewport) {
        try {
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: prep.x, y: prep.y, button: "none" });
          await send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: prep.x,
            y: prep.y,
            button: "left",
            clickCount: 1,
          });
          await send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: prep.x,
            y: prep.y,
            button: "left",
            clickCount: 1,
          });
          return {
            ok: true,
            message: `Đã click phần cứng CDP (isTrusted) vào [${index}] <${prep.tag}> "${prep.text}" thành công`,
          };
        } catch {
          // Fallback sang W3C Click của Extension Core nếu CDP Input lỗi
        }
      }

      const fallback = await this.evalInSession(send, `window.__otterCore.w3cClick(${Number(index)})`, false, 8000);
      if (!fallback?.ok) throw new Error(fallback?.message || `Click thất bại tại index [${index}]`);
      return fallback;
    });
  }

  /**
   * Nhập văn bản kết hợp Extension Core (React 17/18 Native Setter + Meta Lexical + ContentEditable)
   * và CDP Hardware Enter (`Input.dispatchKeyEvent`, isTrusted=true).
   */
  async type(
    index: number,
    text: string,
    pressEnter = false,
    urlPattern?: string,
    port?: number
  ): Promise<{ ok: boolean; message: string }> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      const res = await this.evalInSession(
        send,
        `window.__otterCore.typeElement(${Number(index)}, ${JSON.stringify(text)}, ${Boolean(pressEnter)})`,
        false,
        10000
      );
      if (!res?.ok) throw new Error(res?.message || `Nhập văn bản thất bại tại index [${index}]`);

      if (pressEnter) {
        try {
          await send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
          await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        } catch {}
      }

      return { ok: true, message: res.message };
    });
  }

  async select(index: number, option: string, urlPattern?: string, port?: number): Promise<{ ok: boolean; message: string }> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      const res = await this.evalInSession(
        send,
        `window.__otterCore.selectOption(${Number(index)}, ${JSON.stringify(option)})`,
        false,
        8000
      );
      if (!res?.ok) throw new Error(res?.message || `Chọn tùy chọn thất bại tại index [${index}]`);
      return res;
    });
  }

  async scroll(direction: "up" | "down", amount = 800, urlPattern?: string, port?: number): Promise<any> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(
        send,
        `window.__otterCore.scrollPage(${JSON.stringify(direction)}, ${Number(amount) || 800})`,
        true,
        10000
      );
    });
  }

  async back(urlPattern?: string, port?: number): Promise<{ ok: boolean; message: string }> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    await this.evaluateJs(tab.webSocketDebuggerUrl, "window.history.back()", false);
    return { ok: true, message: "Đã quay lại trang trước qua CDP" };
  }

  async listTabs(port?: number): Promise<{ ok: boolean; tabs: any[] }> {
    const tabs = await this.getTabs(port);
    const pages = tabs
      .filter((t) => t.type === "page")
      .map((t, idx) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        isControlled: this.controlledTabId ? t.id === this.controlledTabId : idx === 0,
        active: idx === 0,
      }));
    return { ok: true, tabs: pages };
  }

  async closeTab(tabId?: string | number, port?: number): Promise<{ ok: boolean; message: string }> {
    const targetPort = port || this.defaultPort;
    const targetId = tabId ? String(tabId) : (await this.findTargetTab(undefined, targetPort)).id;
    const res = await fetch(`http://127.0.0.1:${targetPort}/json/close/${targetId}`, { method: "PUT" });
    this.preloadedTabIds.delete(targetId);
    if (this.controlledTabId === targetId) this.controlledTabId = null;
    return {
      ok: res.ok,
      message: res.ok ? `Đã đóng tab [${targetId}] qua CDP thành công` : `Không thể đóng tab [${targetId}] qua CDP`,
    };
  }

  async switchTab(tabId: string | number, port?: number): Promise<{ ok: boolean; message: string }> {
    const targetPort = port || this.defaultPort;
    const idStr = String(tabId);
    const res = await fetch(`http://127.0.0.1:${targetPort}/json/activate/${idStr}`, { method: "PUT" });
    if (res.ok) this.controlledTabId = idStr;
    return {
      ok: res.ok,
      message: res.ok ? `Đã kích hoạt tab [${idStr}] qua CDP thành công` : `Không thể kích hoạt tab [${idStr}] qua CDP`,
    };
  }

  async closeMessengerDocks(port?: number): Promise<any> {
    const tab = await this.findTargetTab("facebook.com", port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(send, "window.__otterCore.closeMessengerDocks()", false, 8000);
    });
  }

  async readComments(currentUserName?: string, postUrl?: string, port?: number): Promise<any> {
    let tab = await this.findTargetTab("facebook.com", port);
    if (postUrl && postUrl.trim() && isFacebookPostMismatch(tab.url || "", postUrl)) {
      await this.openUrl(postUrl, port);
      await new Promise((r) => setTimeout(r, 1500));
      tab = await this.findTargetTab("facebook.com", port);
    }
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    const res = await this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(
        send,
        `window.__otterCore.readComments(${JSON.stringify(currentUserName || "")})`,
        false,
        15000
      );
    });
    if (res) res.tabId = tab.id;
    return res;
  }

  async readFeed(port?: number): Promise<any> {
    const tab = await this.findTargetTab("facebook.com", port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    const res = await this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(send, "window.__otterCore.readFeed()", false, 15000);
    });
    if (res) res.tabId = tab.id;
    return res;
  }

  async reactFacebook(
    index?: number,
    author?: string,
    reaction: "like" | "love" | "care" | "haha" | "wow" | "sad" | "angry" = "like",
    port?: number
  ): Promise<any> {
    const tab = await this.findTargetTab("facebook.com", port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(
        send,
        `window.__otterCore.reactFacebook(${index ? Number(index) : "null"}, ${JSON.stringify(author || null)}, ${JSON.stringify(reaction || "like")})`,
        true,
        15000
      );
    });
  }

  async commentFacebook(
    params: { commentIndex?: number; author?: string; commentText: string },
    port?: number
  ): Promise<any> {
    const tab = await this.findTargetTab("facebook.com", port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(
        send,
        `window.__otterCore.commentFacebook(${params.commentIndex ? Number(params.commentIndex) : "null"}, ${JSON.stringify(params.author || null)}, ${JSON.stringify(params.commentText)})`,
        true,
        25000
      );
    }, 30000);
  }

  async postToFacebookGroup(params: { groupUrl: string; content: string }, port?: number): Promise<any> {
    const targetUrl = params.groupUrl.trim();
    let tab = await this.findTargetTab("facebook.com", port).catch(() => null);
    const normTarget = targetUrl.replace(/\/$/, "");
    const normCur = (tab?.url || "").trim().replace(/\/$/, "");
    if (!tab || !normCur.includes(normTarget)) {
      await this.openUrl(targetUrl, port);
      await new Promise((r) => setTimeout(r, 2000));
      tab = await this.findTargetTab("facebook.com", port);
    }
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab!.id);
      await this.evalInSession(send, "window.__otterCore.closeMessengerDocks()", false, 5000).catch(() => {});
      const openRes = await this.evalInSession(send, "window.__otterCore.openFbComposer(false)", true, 15000);
      if (!openRes?.ok) return { ok: false, verified: false, message: openRes?.message || "Không mở được khung soạn bài nhóm" };
      return this.evalInSession(send, `window.__otterCore.finishFbPost(${JSON.stringify(params.content)}, false)`, true, 30000);
    }, 35000);
  }

  /**
   * Đăng bài kèm Ảnh / Video lên Facebook sử dụng CDP `DOM.setFileInputFiles` trực tiếp từ ổ đĩa
   * (nhanh hơn nhiều so với Base64 và hỗ trợ video dung lượng lớn).
   */
  async postMediaToFacebook(
    params: {
      targetType: "profile" | "group" | "page";
      targetUrl?: string;
      mediaPath?: string;
      mediaType?: "video" | "image" | "none";
      caption: string;
    },
    port?: number
  ): Promise<any> {
    let destUrl = (params.targetUrl || "").trim();
    if (!destUrl) {
      destUrl = params.targetType === "group" ? "https://www.facebook.com/groups/feed/" : "https://www.facebook.com/";
    }
    if (!/^https?:\/\//i.test(destUrl)) destUrl = `https://${destUrl}`;

    let tab = await this.findTargetTab("facebook.com", port).catch(() => null);
    const normTarget = destUrl.replace(/\/$/, "");
    const normCur = (tab?.url || "").trim().replace(/\/$/, "");
    if (!tab || !normCur.includes(normTarget)) {
      await this.openUrl(destUrl, port);
      await new Promise((r) => setTimeout(r, 2000));
      tab = await this.findTargetTab("facebook.com", port);
    }
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");

    const resolvedMedia = params.mediaPath ? path.resolve(params.mediaPath) : "";
    const hasMedia = Boolean(resolvedMedia && fs.existsSync(resolvedMedia));

    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab!.id);
      await this.evalInSession(send, "window.__otterCore.closeMessengerDocks()", false, 5000).catch(() => {});

      const openRes = await this.evalInSession(
        send,
        `window.__otterCore.openFbComposer(${hasMedia})`,
        true,
        15000
      );
      if (!openRes?.ok) {
        return { ok: false, verified: false, message: openRes?.message || "Không mở được khung soạn bài Facebook" };
      }

      if (hasMedia && openRes.hasFileInput) {
        // Dùng CDP DOM.setFileInputFiles nạp file trực tiếp từ ổ đĩa (không cần Base64)
        await send("DOM.enable", {}, 5000);
        const doc = await send("DOM.getDocument", { depth: 1 }, 5000);
        const query = await send(
          "DOM.querySelector",
          { nodeId: doc.root.nodeId, selector: 'input[type="file"][data-otter-file-target="1"]' },
          5000
        );
        if (query?.nodeId) {
          await send("DOM.setFileInputFiles", { nodeId: query.nodeId, files: [resolvedMedia] }, 15000);
        }
      }

      return this.evalInSession(
        send,
        `window.__otterCore.finishFbPost(${JSON.stringify(params.caption)}, ${hasMedia})`,
        true,
        70000
      );
    }, 75000);
  }

  /**
   * Giao nhiệm vụ cho Muse AI trên web (muse.ai) qua CDP
   */
  async askMuse(
    task: string,
    options?: { newThread?: boolean; timeoutMs?: number; closeTabOnDone?: boolean },
    port?: number
  ): Promise<{ ok: boolean; replyText: string; attachments: any[]; tabId?: string; error?: string }> {
    const targetPort = port || this.defaultPort;
    const timeout = options?.timeoutMs || 180000;
    const deadline = Date.now() + timeout;

    const tabs = await this.getTabs(targetPort);
    let museTab = tabs.find((t) => t.type === "page" && t.url?.includes("muse.ai") && t.webSocketDebuggerUrl);
    let created = false;

    if (!museTab) {
      const r = await fetch(`http://127.0.0.1:${targetPort}/json/new?${encodeURIComponent("https://muse.ai/thread/new")}`, {
        method: "PUT",
      });
      museTab = (await r.json()) as CdpTab;
      created = true;
      if (museTab.webSocketDebuggerUrl) await this.waitForPageReady(museTab.webSocketDebuggerUrl, 15000);
    } else if (options?.newThread && museTab.webSocketDebuggerUrl) {
      await this.sendCommand(museTab.webSocketDebuggerUrl, "Page.navigate", { url: "https://muse.ai/thread/new" });
      await this.waitForPageReady(museTab.webSocketDebuggerUrl, 15000);
    }

    if (!museTab?.webSocketDebuggerUrl) {
      return { ok: false, replyText: "", attachments: [], error: "Không thể mở tab muse.ai qua CDP" };
    }

    const wsUrl = museTab.webSocketDebuggerUrl;
    const tabId = museTab.id;

    try {
      // Chờ trang Muse sẵn sàng
      const readyDeadline = Date.now() + 25000;
      let ready = false;
      while (Date.now() < readyDeadline) {
        const status = await this.withSession(wsUrl, async (send) => {
          await this.ensureCoreInSession(send, tabId);
          return this.evalInSession(send, "window.__otterCore.museCheckReady()", false, 5000);
        });
        if (status === "login_required") {
          return { ok: false, replyText: "", attachments: [], error: "Tài khoản Muse chưa đăng nhập trên Chrome CDP." };
        }
        if (status === "ready") {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      if (!ready) return { ok: false, replyText: "", attachments: [], error: "Trang Muse chưa sẵn sàng sau 25s." };

      const sendRes = await this.withSession(wsUrl, async (send) => {
        await this.ensureCoreInSession(send, tabId);
        return this.evalInSession(send, `window.__otterCore.museSend(${JSON.stringify(task)})`, true, 10000);
      });
      if (!sendRes?.ok) return { ok: false, replyText: "", attachments: [], error: sendRes?.error || "Gửi prompt vào Muse thất bại" };

      const { oldBubbleCount = 0, oldLastText = "" } = sendRes;
      let lastText = "";
      let stableCount = 0;
      let hasStarted = false;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const state = await this.withSession(wsUrl, async (send) => {
          await this.ensureCoreInSession(send, tabId);
          return this.evalInSession(send, "window.__otterCore.musePoll()", false, 8000);
        }).catch(() => null);
        if (!state) continue;
        if (state.isOutOfCredits) return { ok: false, replyText: "", attachments: [], error: "Tài khoản Muse đã hết hạn ngạch." };

        if (!hasStarted && (state.hasStop || state.bubbleCount > oldBubbleCount || (state.text && state.text !== oldLastText))) {
          hasStarted = true;
        }
        if (hasStarted) {
          if (state.text === lastText && state.text.length > 0) {
            stableCount++;
            const finished = (!state.hasStop && (stableCount >= 2 || (state.attachments?.length || 0) > 0)) || stableCount >= 5;
            if (finished) {
              const finalAtts = state.attachments || [];
              for (const a of finalAtts) {
                if (!a.url) continue;
                const extracted = await this.withSession(wsUrl, async (send) => {
                  await this.ensureCoreInSession(send, tabId);
                  return this.evalInSession(send, `window.__otterCore.museExtractBlob(${JSON.stringify(a.url)})`, true, 30000);
                }).catch(() => null);
                if (extracted?.base64) {
                  a.base64 = extracted.base64;
                  a.mime = extracted.mime;
                  a.size = extracted.size;
                }
              }
              return { ok: true, replyText: state.text, attachments: finalAtts, tabId };
            }
          } else {
            lastText = state.text;
            stableCount = 0;
          }
        }
      }
      return { ok: false, replyText: lastText, attachments: [], error: `Quá thời gian chờ (${Math.round(timeout / 1000)}s) phản hồi từ Muse.` };
    } finally {
      if (options?.closeTabOnDone && created) {
        await this.closeTab(tabId, targetPort).catch(() => {});
      }
    }
  }

  /**
   * Bật / tắt Visual Activation HUD + Live Hover Inspector trên tab CDP hiện tại
   */
  async injectHud(toggle = false, urlPattern?: string, port?: number): Promise<any> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(send, `window.__otterCore.injectHud(${Boolean(toggle)})`, false, 6000);
    });
  }

  /**
   * Thực thi JS tùy ý trên tab CDP
   */
  async evaluateOnTab(script: string, urlPattern?: string, port?: number): Promise<any> {
    const tab = await this.findTargetTab(urlPattern, port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab không có webSocketDebuggerUrl hợp lệ");
    return this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      const value = await this.evalInSession(send, script, true, 25000);
      return { ok: true, result: value, tabId: tab.id };
    });
  }

  /**
   * Đo đạc độ trễ phản hồi của CDP (Benchmark latency)
   */
  async benchmark(rounds = 3, port?: number): Promise<{ available: boolean; averageLatencyMs: number; error?: string }> {
    const targetPort = port || this.defaultPort;
    if (!(await this.isAvailable(targetPort))) {
      return { available: false, averageLatencyMs: -1, error: `Cổng CDP ${targetPort} không phản hồi` };
    }

    try {
      const tab = await this.findTargetTab(undefined, targetPort);
      if (!tab.webSocketDebuggerUrl) return { available: false, averageLatencyMs: -1, error: "Không có WebSocket URL" };

      const latencies: number[] = [];
      await this.withSession(tab.webSocketDebuggerUrl, async (send) => {
        await this.ensureCoreInSession(send, tab.id);
        for (let i = 0; i < rounds; i++) {
          const start = performance.now();
          await this.evalInSession(send, "1 + 1", false, 3000);
          latencies.push(performance.now() - start);
        }
      });

      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      return { available: true, averageLatencyMs: avg };
    } catch (err: any) {
      return { available: false, averageLatencyMs: -1, error: err.message };
    }
  }

  /**
   * Chèn tin nhắn vào ô nhập của ChatGPT Web qua CDP (không cần Extension).
   */
  async injectChatMessage(text: string, autoSubmit = true, port?: number): Promise<{ ok: boolean; message: string }> {
    const tab = await this.findTargetTab("chatgpt.com", port);
    if (!tab.webSocketDebuggerUrl) throw new Error("Tab ChatGPT không có webSocketDebuggerUrl hợp lệ");

    const res = await this.withSession(tab.webSocketDebuggerUrl, async (send) => {
      await this.ensureCoreInSession(send, tab.id);
      return this.evalInSession(
        send,
        `window.__otterCore.injectChatMessage(${JSON.stringify(text)}, ${Boolean(autoSubmit)})`,
        true,
        12000
      );
    });
    if (!res?.ok) throw new Error(res?.error || "Chèn tin nhắn vào ChatGPT thất bại");
    return {
      ok: true,
      message: autoSubmit
        ? "Đã chèn và gửi tin nhắn vào ChatGPT qua CDP Core thành công"
        : "Đã chèn tin nhắn vào ô soạn thảo ChatGPT qua CDP Core (chưa gửi)",
    };
  }

  /**
   * Đảm bảo có Chrome mở cổng CDP và tự động nạp sẵn Otter Core vào tất cả tab ngay khi load!
   */
  async ensureCdpChrome(port?: number): Promise<boolean> {
    const targetPort = port || this.defaultPort;
    if (await this.isAvailable(targetPort)) {
      void this.preloadCoreOnAllTabs(targetPort);
      return true;
    }
    if (await this.ensureProfileRunning(undefined, targetPort)) {
      void this.preloadCoreOnAllTabs(targetPort);
      return true;
    }

    const chromePath = findChromeExecutable();
    if (!chromePath) {
      console.warn("[CDP Bridge] Không tìm thấy Chrome/Chromium để tự khởi động CDP.");
      return false;
    }

    const profileDir = path.join(getOtterDir(), "cdp-profile");
    fs.mkdirSync(profileDir, { recursive: true });

    const headlessEnv = process.env.OTTER_CDP_HEADLESS;
    const headless =
      headlessEnv === "1" ||
      (headlessEnv !== "0" &&
        process.platform === "linux" &&
        !process.env.DISPLAY &&
        !process.env.WAYLAND_DISPLAY);

    const args = [
      `--remote-debugging-port=${targetPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ];

    try {
      console.log(
        `[CDP Bridge] Đang tự khởi động Chrome CDP (cổng ${targetPort}, profile ${profileDir}${headless ? ", headless" : ""})...`
      );
      const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      this.spawnedChrome = child;
    } catch (err: any) {
      console.warn(`[CDP Bridge] Không khởi động được Chrome: ${err.message}`);
      return false;
    }

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.isAvailable(targetPort)) {
        const preloaded = await this.preloadCoreOnAllTabs(targetPort);
        console.log(`[CDP Bridge] Đã nạp sẵn Otter Page-Agent Core (${OTTER_CORE_VERSION}) vào ${preloaded} tab.`);
        return true;
      }
    }
    console.warn(`[CDP Bridge] Chrome đã spawn nhưng cổng ${targetPort} chưa sẵn sàng sau 10 giây.`);
    return false;
  }

  /**
   * Unified dispatcher — đầy đủ 100% hành động của Extension BrowserController chạy trực tiếp trên CDP!
   */
  async execute(action: string, params: any = {}): Promise<any> {
    switch (action) {
      case "open":
        return this.openUrl(params.url);
      case "read_page":
        return this.readPage(params.urlPattern);
      case "click":
        return this.click(params.index, params.urlPattern);
      case "type":
        return this.type(params.index, params.text, params.pressEnter, params.urlPattern);
      case "select":
        return this.select(params.index, params.option, params.urlPattern);
      case "scroll":
        return this.scroll(params.direction || "down", params.amount, params.urlPattern);
      case "back":
        return this.back(params.urlPattern);
      case "list_tabs":
        return this.listTabs();
      case "switch_tab":
        return this.switchTab(params.tabId);
      case "close_tab":
        return this.closeTab(params.tabId);
      case "inject_chat_message":
        return this.injectChatMessage(params.text ?? params.message ?? "", params.autoSubmit !== false);
      case "evaluate_js":
        return this.evaluateOnTab(params.script || params.code || "", params.urlPattern);
      case "close_messenger_docks":
        return this.closeMessengerDocks();
      case "read_comments":
        return this.readComments(params.currentUserName, params.postUrl);
      case "read_feed":
        return this.readFeed();
      case "fb_react":
        return this.reactFacebook(params.index, params.author, params.reaction);
      case "fb_comment":
        return this.commentFacebook({
          commentIndex: params.commentIndex,
          author: params.author,
          commentText: params.commentText,
        });
      case "fb_post_to_group":
        return this.postToFacebookGroup({
          groupUrl: params.groupUrl,
          content: params.content,
        });
      case "fb_post_media":
        return this.postMediaToFacebook({
          targetType: params.targetType || "profile",
          targetUrl: params.targetUrl,
          mediaPath: params.mediaPath,
          mediaType: params.mediaType,
          caption: params.caption,
        });
      case "ask_muse":
        return this.askMuse(params.task, {
          newThread: params.newThread,
          timeoutMs: params.timeoutMs,
          closeTabOnDone: params.closeTabOnDone,
        });
      case "inject_hud":
        return this.injectHud(Boolean(params.toggle), params.urlPattern);
      case "reload_extension":
        this.preloadedTabIds.clear();
        const count = await this.preloadCoreOnAllTabs();
        return {
          ok: true,
          message: `Đã nạp lại Otter Page-Agent Core (${OTTER_CORE_VERSION}) vào ${count} tab Chrome CDP (không cần Extension).`,
        };
      default:
        throw new Error(`Hành động '${action}' chưa được hỗ trợ bởi CDP Bridge.`);
    }
  }
}

export const cdpBridge = new CdpBridge();
