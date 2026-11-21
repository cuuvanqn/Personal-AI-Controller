/**
 * Otter → Antigravity qua CDP (task #16)
 *
 * Tích hợp CDP của app Antigravity desktop (Electron 44.9.1 / Chrome 152) vào
 * Otter, theo phân tích tại /home/nam/docs/antigravity-cdp-analysis.md
 * (15/11/2026, Antigravity 2.32.1, đã verify live nhiều thao tác).
 *
 * Phạm vi v1 (theo §10 của file phân tích):
 *  - launcher: tìm app đang chạy (DevToolsActivePort / /json/version),
 *    chưa chạy thì spawn exe kèm --remote-debugging-port=<cổng>
 *  - discovery: GET /json/list -> chọn Hub target (https://127.0.0.1...)
 *  - session: WebSocket CDP bền vững (Runtime.evaluate, Page.*, Input.*, DOM.*)
 *  - hub: thao tác mức cao — ensureSignedIn, dismissOverlays, newConversation,
 *    selectProject, selectModel, setPermissions, sendMessage, readConversation,
 *    waitForIdle, getState, attachFile, screenshot, runTask
 *
 * NGOÀI PHẠM VI v1 (để v2, xem §7–§8 của file phân tích):
 *  - auth OAuth (click Continue with Google, hook xdg-open, replay callback)
 *  - gọi thẳng API language server từ ngoài trang (Connect/gRPC-Web)
 *
 * Quy tắc an toàn (§9–§10):
 *  - mỗi thao tác xong phải verify bằng DOM; fail thì chụp screenshot +
 *    dump innerText để debug rồi mới báo lỗi
 *  - KHÔNG gọi /auth/callback (chỉ v2, và chỉ đúng 1 lần replay có code thật)
 *  - KHÔNG đọc/ghi trực tiếp file token của app — chỉ điều khiển qua CDP/UI
 *  - tạo New Project qua UI chưa làm được (§13.3) — báo rõ, không giả vờ xong
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ANTIGRAVITY_DEFAULT_CDP_PORT = 9222;
export const ANTIGRAVITY_HUB_URL_PREFIX = "https://127.0.0.1";

/**
 * Selector đã verify live trên Antigravity 2.32.1 (§4 file phân tích).
 * Thứ tự bền: data-testid -> aria-label -> text -> vị trí (§13.7).
 */
export const AGY_SELECTORS = {
  composer: '[aria-label="Message input"]',
  sendButton: 'BUTTON[aria-label="Send message"][data-testid="send-button"]',
  stopButton: 'BUTTON[aria-label="Stop execution"]',
  newConversation: 'BUTTON[aria-label="New Conversation"]',
  newConversationAlt: 'A[data-testid="new-conversation-button"]',
  projectTrigger: 'BUTTON[data-testid="project-selector-trigger"]',
  modelTrigger: 'BUTTON[data-testid="model-selector-trigger"]',
  permissionsTrigger: 'BUTTON[data-testid="permissions-selector-trigger"]',
  addContext: 'BUTTON[aria-label="Add context"]',
  automationsButton: 'BUTTON[data-testid="automations-button"]',
  menuItem: '[role="menuitem"], [role="option"]',
  fileInput: 'input[type="file"]',
} as const;

export type AntigravityErrorCode =
  | "NOT_RUNNING"
  | "NO_HUB_TARGET"
  | "NOT_SIGNED_IN"
  | "SELECTOR_NOT_FOUND"
  | "ACTION_FAILED"
  | "TIMEOUT"
  | "MODEL_UNAVAILABLE"
  | "PROJECT_NOT_FOUND"
  | "LAUNCH_FAILED";

export class AntigravityError extends Error {
  readonly code: AntigravityErrorCode;
  screenshotBase64?: string;
  pageText?: string;

  constructor(code: AntigravityErrorCode, message: string) {
    super(message);
    this.name = "AntigravityError";
    this.code = code;
  }

  /** Gắn bằng chứng debug (§10: fail thì chụp màn hình + dump innerText). */
  attachDebug(screenshotBase64?: string, pageText?: string): void {
    this.screenshotBase64 = screenshotBase64;
    this.pageText = pageText;
  }
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface ConversationTurn {
  role: "user" | "agent";
  text: string;
}

export interface ConversationRead {
  turns: ConversationTurn[];
  lastAnswer: string;
  rawText: string;
  url: string;
}

export interface AntigravityState {
  url: string;
  signedIn: boolean;
  running: boolean;
  model: string | null;
  project: string | null;
  permissions: string | null;
}

export interface AntigravityTaskOptions {
  project?: string;
  model?: string;
  permissions?: "Request Review" | "Turbo";
  /** Mở lại conversation cũ theo uuid thay vì tạo mới. */
  conversationId?: string;
  attachFiles?: string[];
  waitTimeoutMs?: number;
  /** Mặc định true: tạo New Conversation trước khi gửi. */
  newConversation?: boolean;
}

export interface AntigravityTaskResult {
  answer: string;
  turns: ConversationTurn[];
  conversationUrl: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Discovery: tìm cổng CDP + chọn Hub target
// ---------------------------------------------------------------------------

/** userData mặc định: Linux ~/.config/Antigravity, Windows %APPDATA%\Antigravity. */
export function defaultUserDataDir(): string | null {
  if (process.env.ANTIGRAVITY_USER_DATA_DIR) return process.env.ANTIGRAVITY_USER_DATA_DIR;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? join(appData, "Antigravity") : null;
  }
  return join(homedir(), ".config", "Antigravity");
}

/**
 * Đọc cổng CDP từ file DevToolsActivePort (§1.2): dòng 1 là cổng, dòng 2 là
 * browser target id. Trả null nếu app chưa chạy / chưa có file.
 */
export function discoverCdpPort(userDataDir?: string): number | null {
  const dir = userDataDir ?? defaultUserDataDir();
  if (!dir) return null;
  const file = join(dir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  const first = readFileSync(file, "utf8").split("\n")[0]?.trim();
  const port = first ? Number(first) : NaN;
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * Chọn Hub target trong /json/list (§2): type == "page" và url bắt đầu
 * https://127.0.0.1. Ưu tiên conversation (/c/<uuid>), rồi Hub chính (/),
 * cuối cùng mới onboarding (để ensureSignedIn báo rõ là chưa đăng nhập).
 */
export function findHubTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter(
    (t) => t.type === "page" && t.url.startsWith(ANTIGRAVITY_HUB_URL_PREFIX) && t.webSocketDebuggerUrl,
  );
  if (pages.length === 0) return null;
  return (
    pages.find((t) => /\/c\/[0-9a-f-]{8,}/i.test(t.url)) ??
    pages.find((t) => !t.url.includes("/onboarding")) ??
    pages[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Session: WebSocket CDP bền vững (§14 — khác CdpBridge vốn mở WS mới mỗi lệnh)
// ---------------------------------------------------------------------------

export interface CdpSessionOptions {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AntigravityCdpSession {
  readonly target: CdpTarget;
  readonly cdpPort: number;
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, PendingCall>();
  private handlers = new Map<string, (params: unknown) => void>();
  private commandTimeoutMs: number;

  private constructor(ws: WebSocket, target: CdpTarget, cdpPort: number, commandTimeoutMs: number) {
    this.ws = ws;
    this.target = target;
    this.cdpPort = cdpPort;
    this.commandTimeoutMs = commandTimeoutMs;
    this.ws.addEventListener("message", (ev) => this.handleMessage(ev.data));
    this.ws.addEventListener("close", () =>
      this.rejectAll(new AntigravityError("NOT_RUNNING", "WebSocket CDP tới Hub đã đóng")),
    );
    this.ws.addEventListener("error", () =>
      this.rejectAll(new AntigravityError("NOT_RUNNING", "WebSocket CDP tới Hub bị lỗi")),
    );
  }

  /** Kết nối: GET /json/list -> chọn Hub -> mở WS -> Runtime.enable + Page.enable. */
  static async connect(
    cdpPort = ANTIGRAVITY_DEFAULT_CDP_PORT,
    opts: CdpSessionOptions = {},
  ): Promise<AntigravityCdpSession> {
    const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    let targets: CdpTarget[];
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(connectTimeoutMs),
      });
      if (!res.ok) {
        throw new AntigravityError(
          "NOT_RUNNING",
          `CDP port ${cdpPort} không trả /json/list (HTTP ${res.status}) — app Antigravity chưa chạy?`,
        );
      }
      targets = (await res.json()) as CdpTarget[];
    } catch (err) {
      if (err instanceof AntigravityError) throw err;
      throw new AntigravityError(
        "NOT_RUNNING",
        `Không nối được CDP port ${cdpPort}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const hub = findHubTarget(targets);
    if (!hub || !hub.webSocketDebuggerUrl) {
      throw new AntigravityError(
        "NO_HUB_TARGET",
        "Không thấy trang Hub (app chưa đăng nhập? kiểm tra /onboarding trong app)",
      );
    }
    const ws = new WebSocket(hub.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new AntigravityError("TIMEOUT", `Kết nối WebSocket CDP quá hạn (${connectTimeoutMs}ms)`));
      }, connectTimeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new AntigravityError("NOT_RUNNING", "Không mở được WebSocket CDP tới Hub"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onErr);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onErr);
    });
    const session = new AntigravityCdpSession(ws, hub, cdpPort, opts.commandTimeoutMs ?? 20000);
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    return session;
  }

  /** Đăng ký nghe event CDP (vd Network.responseReceived) — dùng cho v2. */
  on(method: string, fn: (params: unknown) => void): void {
    this.handlers.set(method, fn);
  }

  private handleMessage(data: unknown): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    try {
      const text = typeof data === "string" ? data : String(data);
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const call = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) {
        call.reject(new AntigravityError("ACTION_FAILED", `Lỗi CDP: ${JSON.stringify(msg.error)}`));
      } else {
        call.resolve(msg.result);
      }
      return;
    }
    if (msg.method && this.handlers.has(msg.method)) {
      this.handlers.get(msg.method)!(msg.params);
    }
  }

  private rejectAll(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    const id = ++this.nextId;
    const timeout = timeoutMs ?? this.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AntigravityError("TIMEOUT", `Lệnh CDP '${method}' quá hạn sau ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Chạy JS trong trang Hub (Runtime.evaluate, returnByValue + awaitPromise). */
  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r?.exceptionDetails) {
      const desc =
        r.exceptionDetails.exception?.description ??
        r.exceptionDetails.text ??
        JSON.stringify(r.exceptionDetails).slice(0, 300);
      throw new AntigravityError("ACTION_FAILED", `Lỗi JS trên trang Hub: ${desc}`);
    }
    return r?.result?.value as T;
  }

  /** Chụp màn hình Hub (Page.captureScreenshot) — trả base64 PNG. */
  async screenshot(): Promise<string> {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (!r?.data) throw new AntigravityError("ACTION_FAILED", "Page.captureScreenshot không trả về ảnh");
    return r.data as string;
  }

  /**
   * Đính kèm file vào composer (§13.8): DOM.setFileInputFiles lên input file ẩn.
   * Lưu ý: sau khi gắn, composer không hiện chip tên file — kiểm tra bằng log
   * sau khi gửi, đừng kiểm tra bằng innerText của composer.
   */
  async attachFile(filePath: string): Promise<void> {
    await this.send("DOM.enable");
    const doc = await this.send("DOM.getDocument", { depth: -1 });
    const rootId = doc?.root?.nodeId;
    if (!rootId) throw new AntigravityError("ACTION_FAILED", "DOM.getDocument không trả về root");
    const q = await this.send("DOM.querySelector", { nodeId: rootId, selector: AGY_SELECTORS.fileInput });
    if (!q?.nodeId) {
      throw new AntigravityError("SELECTOR_NOT_FOUND", "Không thấy input[type=file] ẩn trong Hub");
    }
    await this.send("DOM.setFileInputFiles", { files: [filePath], nodeId: q.nodeId });
  }

  async pressKey(key: string, code: string, keyCode: number): Promise<void> {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }

  /** Đóng menu đang mở (§5.13). */
  async pressEscape(): Promise<void> {
    await this.pressKey("Escape", "Escape", 27);
  }

  close(): void {
    this.rejectAll(new AntigravityError("NOT_RUNNING", "Session CDP đã đóng"));
    try {
      this.ws.close();
    } catch {
      // đã đóng rồi thì thôi
    }
  }
}

// ---------------------------------------------------------------------------
// Launcher: tìm app đang chạy, chưa chạy thì mở lên (§1)
// ---------------------------------------------------------------------------

export interface AntigravityLaunchOptions {
  cdpPort?: number;
  binaryPath?: string;
  userDataDir?: string;
  waitTimeoutMs?: number;
}

export class AntigravityLauncher {
  private spawnError: Error | null = null;

  /** App có sống không: /json/version phải trả User-Agent chứa "Antigravity". */
  async isRunning(cdpPort = ANTIGRAVITY_DEFAULT_CDP_PORT): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { Browser?: string; "User-Agent"?: string };
      const ua = `${data.Browser ?? ""} ${data["User-Agent"] ?? ""}`;
      return ua.includes("Antigravity");
    } catch {
      return false;
    }
  }

  /**
   * Đảm bảo app đang chạy rồi trả về cổng CDP. Ưu tiên cổng trong
   * DevToolsActivePort (app đã chạy sẵn), chưa chạy thì spawn app mới.
   */
  async ensureRunning(opts: AntigravityLaunchOptions = {}): Promise<number> {
    const port = opts.cdpPort ?? discoverCdpPort(opts.userDataDir) ?? ANTIGRAVITY_DEFAULT_CDP_PORT;
    if (await this.isRunning(port)) return port;
    this.spawnApp(port, opts);
    const waitTimeoutMs = opts.waitTimeoutMs ?? 30000;
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      // spawnError được reset trong spawnApp (không gán null ở đây để TS
      // khỏi thu hẹp property về null — error handler bất đồng bộ gán lại nó).
      const spawnErr = this.spawnError;
      if (spawnErr) {
        throw new AntigravityError("LAUNCH_FAILED", `Không mở được Antigravity: ${spawnErr.message}`);
      }
      if (await this.isRunning(port)) return port;
      await sleep(1000);
    }
    throw new AntigravityError(
      "LAUNCH_FAILED",
      `Đã mở Antigravity nhưng CDP port ${port} không phản hồi sau ${Math.round(waitTimeoutMs / 1000)}s (kiểm tra log app)`,
    );
  }

  private spawnApp(port: number, opts: AntigravityLaunchOptions): ChildProcess {
    // Reset lỗi spawn cũ của lần gọi trước (đặt ở đây, không đặt trong
    // ensureRunning, để TS không thu hẹp property về null ở vòng poll).
    this.spawnError = null;
    const binary = opts.binaryPath ?? process.env.ANTIGRAVITY_BIN ?? defaultBinaryPath();
    if (!binary || !existsSync(binary)) {
      throw new AntigravityError(
        "LAUNCH_FAILED",
        `Không thấy binary Antigravity (đặt ANTIGRAVITY_BIN hoặc cài app trước). Đường dẫn đã thử: ${binary ?? "(trống)"}`,
      );
    }
    const args = [`--remote-debugging-port=${port}`];
    if (opts.userDataDir) {
      args.push(`--user-data-dir=${opts.userDataDir}`);
    }
    let cmd = binary;
    let spawnArgs = args;
    if (process.platform === "linux") {
      // Cần màn hình ảo khi không có DISPLAY; --no-sandbox khi chạy root (§1.1).
      if (!process.env.DISPLAY) {
        cmd = "xvfb-run";
        spawnArgs = ["-a", "-s", "-screen 0 1280x800x24", binary, ...args];
      }
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        spawnArgs = [...spawnArgs, "--no-sandbox"];
      }
    }
    const child = spawn(cmd, spawnArgs, { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      this.spawnError = err;
    });
    child.unref();
    return child;
  }
}

/** Đường dẫn binary mặc định (§1.1–§1.2); không có thì trả null để báo lỗi rõ. */
export function defaultBinaryPath(): string | null {
  if (process.env.ANTIGRAVITY_BIN) return process.env.ANTIGRAVITY_BIN;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const candidates = [
      localAppData ? join(localAppData, "Programs", "Antigravity", "Antigravity.exe") : null,
      programFiles ? join(programFiles, "Antigravity", "Antigravity.exe") : null,
    ].filter((p): p is string => p !== null && existsSync(p));
    return candidates[0] ?? null;
  }
  const linuxPath = join(homedir(), "workspace", "downloads", "antigravity-linux", "Antigravity-x64", "antigravity");
  return existsSync(linuxPath) ? linuxPath : null;
}

export const antigravityLauncher = new AntigravityLauncher();

// ---------------------------------------------------------------------------
// Hub: thao tác mức cao (§10 hub.ts)
// ---------------------------------------------------------------------------

/**
 * Parse Conversation Log (§6): innerText có cấu trúc
 * "You said / <lệnh> / just now / Agent said / <trả lời> / just now ...".
 * Bỏ dòng thời gian tương đối ("just now", "3m"...) ở cuối mỗi lượt.
 */
export function parseConversation(bodyText: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const re = /(You said|Agent said)\n([\s\S]*?)(?=\n(?:You said|Agent said)\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    const role = m[1] === "You said" ? "user" : "agent";
    const lines = (m[2] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    while (lines.length > 0 && /^(just now|\d+[mh])$/.test(lines[lines.length - 1]!)) {
      lines.pop();
    }
    const text = lines.join("\n").trim();
    if (text) turns.push({ role, text });
  }
  return turns;
}

/** Câu trả lời mới nhất của agent (lượt agent cuối cùng). */
export function lastAnswer(bodyText: string): string {
  const turns = parseConversation(bodyText);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "agent") return turns[i]!.text;
  }
  return "";
}

export class AntigravityHub {
  constructor(private session: AntigravityCdpSession) {}

  private evl<T>(expression: string): Promise<T> {
    return this.session.evaluate<T>(expression);
  }

  /** Đọc trạng thái hiện tại: url, đã đăng nhập, agent đang chạy, model/dự án/quyền. */
  async getState(): Promise<AntigravityState> {
    const url = await this.evl<string>("location.href");
    const running = await this.isRunning();
    const readTriggerLabel = async (selector: string): Promise<string | null> =>
      this.evl<string | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : null; })()`,
      );
    const stripPrefix = (label: string | null, prefix: RegExp): string | null => {
      if (!label) return null;
      return label.replace(prefix, "").trim() || null;
    };
    const modelLabel = await readTriggerLabel(AGY_SELECTORS.modelTrigger);
    const projectLabel = await readTriggerLabel(AGY_SELECTORS.projectTrigger);
    const permLabel = await readTriggerLabel(AGY_SELECTORS.permissionsTrigger);
    return {
      url,
      signedIn: !url.includes("/onboarding"),
      running,
      model: stripPrefix(modelLabel, /^Select model, current:\s*/i),
      project: stripPrefix(projectLabel, /^Select project, current:\s*/i),
      permissions: stripPrefix(permLabel, /^Agent permissions preset selector, current:\s*/i),
    };
  }

  /** App phải đăng nhập sẵn (§9): còn /onboarding thì dừng, báo user đăng nhập. */
  async ensureSignedIn(): Promise<void> {
    const url = await this.evl<string>("location.href");
    if (url.includes("/onboarding")) {
      throw new AntigravityError(
        "NOT_SIGNED_IN",
        "Antigravity chưa đăng nhập (Hub đang ở /onboarding). Báo user đăng nhập trong app trước — Otter không tự đăng nhập ở v1.",
      );
    }
    const hasComposer = await this.evl<boolean>(
      `!!document.querySelector(${JSON.stringify(AGY_SELECTORS.composer)})`,
    );
    if (!hasComposer) {
      throw new AntigravityError(
        "NOT_SIGNED_IN",
        "Không thấy ô nhập lệnh — có thể app chưa đăng nhập hoặc Hub chưa tải xong.",
      );
    }
  }

  /** Bấm Dismiss/Skip trên các dialog chào mừng (§4.5). Best-effort, không lỗi nếu không có. */
  async dismissOverlays(): Promise<void> {
    await this.evl(
      `(() => { const btns = [...document.querySelectorAll('[role="dialog"] button')]; const t = btns.find(b => /^(dismiss|skip)$/i.test((b.innerText || '').trim())); if (t) { t.click(); return true; } return false; })()`,
    );
    await sleep(500);
  }

  private async clickBySelector(selector: string, what: string): Promise<void> {
    const ok = await this.evl<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`,
    );
    if (!ok) throw new AntigravityError("SELECTOR_NOT_FOUND", `Không tìm thấy: ${what} (${selector})`);
  }

  private async readMenuItems(): Promise<string[]> {
    return this.evl<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(AGY_SELECTORS.menuItem)})].map(e => (e.innerText || '').trim()).filter(Boolean)`,
    );
  }

  private async clickMenuItem(label: string, what: string): Promise<void> {
    const found = await this.evl<boolean>(
      `(() => { const items = [...document.querySelectorAll(${JSON.stringify(AGY_SELECTORS.menuItem)})]; const el = items.find(e => (e.innerText || '').trim() === ${JSON.stringify(label)}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!found) {
      throw new AntigravityError("SELECTOR_NOT_FOUND", `Không thấy mục "${label}" trong menu ${what}`);
    }
  }

  /** Verify sau khi chọn: aria-label của trigger phải chứa tên vừa chọn. */
  private async verifyTrigger(selector: string, prefix: RegExp, expected: string, what: string): Promise<void> {
    const label = await this.evl<string | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.getAttribute('aria-label') || '').trim() : null; })()`,
    );
    const current = label ? label.replace(prefix, "").trim() : "";
    if (!current.toLowerCase().includes(expected.toLowerCase())) {
      throw new AntigravityError(
        "ACTION_FAILED",
        `Chọn ${what} thất bại: đang là "${current || "(không đọc được)"}", muốn "${expected}"`,
      );
    }
  }

  /** Mở conversation mới: click New Conversation, đợi URL thành /c/<uuid> (§5.7). */
  async newConversation(): Promise<string> {
    const clicked = await this.evl<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(AGY_SELECTORS.newConversation)}) || document.querySelector(${JSON.stringify(AGY_SELECTORS.newConversationAlt)}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!clicked) {
      throw new AntigravityError("SELECTOR_NOT_FOUND", "Không thấy nút New Conversation");
    }
    const url = await this.waitFor(
      () => this.evl<string>("location.href"),
      (u) => /\/c\/[0-9a-f-]{8,}/i.test(u),
      10000,
      "URL không đổi sang /c/<uuid> sau khi bấm New Conversation",
    );
    await this.waitForComposer(10000);
    return url;
  }

  /** Mở lại conversation cũ theo uuid (§6). */
  async openConversation(conversationId: string): Promise<void> {
    const url = await this.evl<string>("location.href");
    const base = url.split("/c/")[0]!.replace(/\/$/, "");
    await this.session.send("Page.navigate", { url: `${base}/c/${conversationId}` });
    await this.waitForComposer(15000);
  }

  /** Chọn dự án theo tên (§4.3, §5.9). */
  async selectProject(name: string): Promise<void> {
    if (/^new project$/i.test(name.trim())) {
      // §13.3: tạo New Project qua UI chưa làm được — báo rõ thay vì giả vờ xong.
      throw new AntigravityError(
        "ACTION_FAILED",
        "Tạo New Project qua UI chưa làm được (§13.3). Dùng đường API CreateProject ở v2, hoặc tạo tay trong app trước.",
      );
    }
    await this.clickBySelector(AGY_SELECTORS.projectTrigger, "nút chọn dự án");
    await sleep(800);
    const items = await this.readMenuItems();
    const match =
      items.find((t) => t === name) ?? items.find((t) => t.toLowerCase().includes(name.toLowerCase()));
    if (!match) {
      await this.session.pressEscape();
      throw new AntigravityError(
        "PROJECT_NOT_FOUND",
        `Không thấy dự án "${name}" trong menu (có: ${items.join(", ") || "(trống)"})`,
      );
    }
    await this.clickMenuItem(match, "dự án");
    await sleep(500);
    await this.verifyTrigger(
      AGY_SELECTORS.projectTrigger,
      /^Select project, current:\s*/i,
      name,
      "dự án",
    );
  }

  /** Chọn model theo tên (§4.3, §5.8); bỏ qua model Unavailable. */
  async selectModel(name: string): Promise<void> {
    await this.clickBySelector(AGY_SELECTORS.modelTrigger, "nút chọn model");
    await sleep(800);
    const items = await this.readMenuItems();
    const match =
      items.find((t) => t === name) ?? items.find((t) => t.toLowerCase().includes(name.toLowerCase()));
    if (!match) {
      await this.session.pressEscape();
      throw new AntigravityError(
        "MODEL_UNAVAILABLE",
        `Không thấy model "${name}" trong menu (có: ${items.join(", ") || "(trống)"})`,
      );
    }
    if (/unavailable/i.test(match)) {
      await this.session.pressEscape();
      throw new AntigravityError("MODEL_UNAVAILABLE", `Model "${name}" đang Unavailable trong app`);
    }
    await this.clickMenuItem(match, "model");
    await sleep(500);
    await this.verifyTrigger(AGY_SELECTORS.modelTrigger, /^Select model, current:\s*/i, name, "model");
  }

  /** Chọn preset quyền: Request Review (mặc định) hoặc Turbo (§4.3, §5.10). */
  async setPermissions(preset: "Request Review" | "Turbo"): Promise<void> {
    await this.clickBySelector(AGY_SELECTORS.permissionsTrigger, "nút chọn quyền");
    await sleep(800);
    await this.clickMenuItem(preset, "quyền");
    await sleep(500);
    await this.verifyTrigger(
      AGY_SELECTORS.permissionsTrigger,
      /^Agent permissions preset selector, current:\s*/i,
      preset,
      "quyền",
    );
  }

  /**
   * Gửi lệnh: gõ vào composer contenteditable bằng execCommand('insertText')
   * (React chỉ nhận cách này, §4.1) rồi bấm Send; verify lệnh xuất hiện trong log.
   */
  async sendMessage(text: string): Promise<void> {
    if (!text.trim()) throw new AntigravityError("ACTION_FAILED", "Không gửi lệnh rỗng");
    const typed = await this.evl<string>(
      `(() => { const ed = document.querySelector(${JSON.stringify(AGY_SELECTORS.composer)}); if (!ed) return "NO COMPOSER"; ed.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); ed.dispatchEvent(new InputEvent('input', { bubbles: true })); return "ok"; })()`,
    );
    if (typed !== "ok") {
      throw new AntigravityError("SELECTOR_NOT_FOUND", `Không gõ được lệnh vào composer: ${typed}`);
    }
    const sent = await this.evl<string>(
      `(() => { const b = document.querySelector(${JSON.stringify(AGY_SELECTORS.sendButton)}); if (!b || b.disabled) return "NO SEND BTN"; b.click(); return "ok"; })()`,
    );
    if (sent !== "ok") {
      throw new AntigravityError(
        "ACTION_FAILED",
        `Không bấm được nút Send: ${sent} (có thể agent đang chạy — đợi nó xong rồi gửi lại)`,
      );
    }
    await this.waitFor(
      () => this.evl<string>("document.body.innerText"),
      (t) => t.includes(text.slice(0, 60)),
      10000,
      "Lệnh không xuất hiện trong Conversation Log sau khi bấm Send",
    );
  }

  /** Đọc toàn bộ Conversation Log rồi parse thành các lượt (§6). */
  async readConversation(): Promise<ConversationRead> {
    const rawText = await this.evl<string>("document.body.innerText");
    const url = await this.evl<string>("location.href");
    const turns = parseConversation(rawText);
    return { turns, lastAnswer: lastAnswer(rawText), rawText, url };
  }

  /** Agent đang chạy không: nút Send biến thành nút Stop (§6, §13.2). */
  async isRunning(): Promise<boolean> {
    return this.evl<boolean>(
      `!![...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === 'Stop execution')`,
    );
  }

  /** Dừng task giữa chừng (§13.2): bấm Stop rồi đợi nút Send quay lại. */
  async stop(): Promise<void> {
    const clicked = await this.evl<boolean>(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === 'Stop execution'); if (!b) return false; b.click(); return true; })()`,
    );
    if (!clicked) return; // không chạy thì thôi
    // §13.2: nút Send không quay lại ngay — đợi tối đa 15s.
    await this.waitFor(() => this.isRunning(), (r) => r === false, 15000, "Agent vẫn chạy sau khi bấm Stop");
  }

  /**
   * Đợi agent chạy xong: poll mỗi 3s, xử lý dialog phê duyệt nếu có
   * (Request Review, §13.8); xong khi nút về Send + innerText ổn định 2 lần.
   */
  async waitForIdle(timeoutMs = 300000): Promise<ConversationRead> {
    const t0 = Date.now();
    let lastText = "";
    let stable = 0;
    while (Date.now() - t0 < timeoutMs) {
      await this.approveIfWaiting();
      const running = await this.isRunning();
      const text = await this.evl<string>("document.body.innerText");
      if (!running && text === lastText) {
        if (++stable >= 2) return this.readConversation();
      } else {
        stable = 0;
      }
      lastText = text;
      await sleep(3000);
    }
    throw new AntigravityError(
      "TIMEOUT",
      `Chờ agent chạy xong quá hạn sau ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  /** Vòng xử lý dialog phê duyệt khi preset Request Review (§13.8). */
  async approveIfWaiting(): Promise<boolean> {
    const waiting = await this.evl<boolean>(`/Waiting for user input/.test(document.body.innerText)`);
    if (!waiting) return false;
    await this.evl(
      `(() => { const r = [...document.querySelectorAll('[role="radio"]')].find(e => (e.textContent||'').includes('Yes, allow this time')); if (r) r.click(); return !!r; })()`,
    );
    await sleep(800);
    await this.evl(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim().startsWith('Submit')); if (b) b.click(); return !!b; })()`,
    );
    await sleep(5000);
    return true;
  }

  /** Đính kèm file vào lệnh (§13.8). */
  async attachFile(filePath: string): Promise<void> {
    await this.session.attachFile(filePath);
  }

  async screenshot(): Promise<string> {
    return this.session.screenshot();
  }

  /** Chạy 1 task trọn vẹn theo luồng §10. */
  async runTask(text: string, opts: AntigravityTaskOptions = {}): Promise<AntigravityTaskResult> {
    try {
      await this.ensureSignedIn();
      await this.dismissOverlays();
      if (opts.conversationId) {
        await this.openConversation(opts.conversationId);
      } else if (opts.newConversation !== false) {
        await this.newConversation();
      }
      if (opts.project) await this.selectProject(opts.project);
      if (opts.model) await this.selectModel(opts.model);
      if (opts.permissions) await this.setPermissions(opts.permissions);
      for (const f of opts.attachFiles ?? []) await this.attachFile(f);
      await this.sendMessage(text);
      const done = await this.waitForIdle(opts.waitTimeoutMs ?? 300000);
      return { answer: done.lastAnswer, turns: done.turns, conversationUrl: done.url };
    } catch (err) {
      // §10: fail thì chụp screenshot + dump innerText để debug rồi mới báo lỗi.
      let shot: string | undefined;
      let pageText: string | undefined;
      try {
        shot = await this.screenshot();
      } catch {
        // chụp không được thì vẫn báo lỗi gốc
      }
      try {
        pageText = (await this.evl<string>("document.body.innerText")).slice(0, 4000);
      } catch {
        // đọc không được thì thôi
      }
      if (err instanceof AntigravityError) {
        err.attachDebug(shot, pageText);
        throw err;
      }
      const wrapped = new AntigravityError(
        "ACTION_FAILED",
        err instanceof Error ? err.message : String(err),
      );
      wrapped.attachDebug(shot, pageText);
      throw wrapped;
    }
  }

  private async waitFor<T>(
    fn: () => Promise<T>,
    ok: (v: T) => boolean,
    timeoutMs: number,
    msg: string,
  ): Promise<T> {
    const t0 = Date.now();
    let last: T;
    do {
      last = await fn();
      if (ok(last)) return last;
      await sleep(500);
    } while (Date.now() - t0 < timeoutMs);
    throw new AntigravityError("TIMEOUT", msg);
  }

  private async waitForComposer(timeoutMs: number): Promise<void> {
    await this.waitFor(
      () => this.evl<boolean>(`!!document.querySelector(${JSON.stringify(AGY_SELECTORS.composer)})`),
      (v) => v === true,
      timeoutMs,
      "Composer không xuất hiện sau khi điều hướng (trang chưa tải xong?)",
    );
  }
}

// ---------------------------------------------------------------------------
// Tiện ích: kết nối nhanh
// ---------------------------------------------------------------------------

/** Tìm app đang chạy (hoặc mở lên) rồi mở session Hub + trả AntigravityHub. */
export async function connectAntigravity(
  opts: AntigravityLaunchOptions & CdpSessionOptions = {},
): Promise<{ session: AntigravityCdpSession; hub: AntigravityHub; cdpPort: number }> {
  const cdpPort = await antigravityLauncher.ensureRunning(opts);
  const session = await AntigravityCdpSession.connect(cdpPort, opts);
  return { session, hub: new AntigravityHub(session), cdpPort };
}
