/**
 * MCP tools: Otter Meta Unified Toolset — gọi các cầu nối Meta CLI
 * (facebook-cli, hatch_messenger_cli, instagram-cli, threads-cli,
 * meta-ads-cli) qua Reverse RPC server trên localhost.
 *
 * Kiến trúc (Phase #22/#23, xem notes/quy-trinh-cau-noi-*.md):
 * - Mỗi dịch vụ có 1 RPC server trên Hatch (127.0.0.1:18088..18092),
 *   forward qua SSH tunnel về 127.0.0.1 của máy nam, xác thực bằng
 *   token riêng (chmod 600) cho từng dịch vụ.
 * - Otter (chạy trên máy nam) gọi thẳng vào 127.0.0.1:<port>/run —
 *   nhanh (<1ms), token chỉ đọc từ file cục bộ, không lộ qua wire
 *   ngoài tunnel SSH đã mã hóa.
 *
 * Module này chạy được cả trên máy nam (production) lẫn máy Hatch
 * (dev): token file được dò theo thứ tự — biến môi trường
 * META_RPC_<SVC>_TOKEN_FILE, rồi ~/.config/<svc>-rpc/token (Hatch),
 * rồi ~/.<svc>_rpc_token (nam).
 *
 * LƯU Ý BẢO MẬT: các tool ghi (post create, send...) thực thi ngay
 * qua RPC, không có thẻ xác nhận như khi chạy CLI trực tiếp. Chỉ
 * gọi khi người dùng đã yêu cầu rõ ràng.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function text(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function err(message: string): { content: [{ type: "text"; text: string }]; isError: boolean } {
  return { content: [{ type: "text", text: message }], isError: true };
}

type MetaService = "fb" | "msg" | "ig" | "igmsg" | "th" | "thmsg" | "ads";

interface ServiceConfig {
  /** Cổng RPC trên localhost. */
  port: number;
  /** Tên header xác thực. */
  header: string;
  /** Tên CLI (chỉ dùng cho cli-rpc-server chung 18090..18092). */
  cli?: string;
  /** Prefix biến môi trường, vd META_RPC_FB. */
  envPrefix: string;
  /** Các đường dẫn token file sẽ thử theo thứ tự. */
  tokenFiles: string[];
}

function home(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

const META_SERVICES: Record<MetaService, ServiceConfig> = {
  fb: {
    port: 18088,
    header: "X-FB-RPC-Token",
    envPrefix: "META_RPC_FB",
    tokenFiles: ["~/.config/fb-rpc/token", "~/.fb_rpc_token"],
  },
  msg: {
    port: 18089,
    header: "X-MSG-RPC-Token",
    envPrefix: "META_RPC_MSG",
    tokenFiles: ["~/.config/msg-rpc/token", "~/.msg_rpc_token"],
  },
  ig: {
    port: 18090,
    header: "X-RPC-Token",
    cli: "instagram-cli",
    envPrefix: "META_RPC_IG",
    tokenFiles: ["~/.config/ig-rpc/token", "~/.ig_rpc_token"],
  },
  igmsg: {
    port: 18090,
    header: "X-RPC-Token",
    cli: "instagram-messages-cli",
    envPrefix: "META_RPC_IG",
    tokenFiles: ["~/.config/ig-rpc/token", "~/.ig_rpc_token"],
  },
  th: {
    port: 18091,
    header: "X-RPC-Token",
    cli: "threads-cli",
    envPrefix: "META_RPC_TH",
    tokenFiles: ["~/.config/th-rpc/token", "~/.th_rpc_token"],
  },
  thmsg: {
    port: 18091,
    header: "X-RPC-Token",
    cli: "threads-messages-cli",
    envPrefix: "META_RPC_TH",
    tokenFiles: ["~/.config/th-rpc/token", "~/.th_rpc_token"],
  },
  ads: {
    port: 18092,
    header: "X-RPC-Token",
    cli: "meta-ads-cli",
    envPrefix: "META_RPC_ADS",
    tokenFiles: ["~/.config/ads-rpc/token", "~/.ads_rpc_token"],
  },
};

function resolveTokenFile(cfg: ServiceConfig): string | null {
  const envFile = process.env[`${cfg.envPrefix}_TOKEN_FILE`];
  const candidates = envFile ? [envFile, ...cfg.tokenFiles] : cfg.tokenFiles;
  for (const candidate of candidates) {
    const full = home(candidate);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // thử đường dẫn tiếp theo
    }
  }
  return null;
}

function resolvePort(cfg: ServiceConfig): number {
  const envPort = Number(process.env[`${cfg.envPrefix}_PORT`] || "");
  return Number.isFinite(envPort) && envPort > 0 ? envPort : cfg.port;
}

export interface MetaRpcResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  service?: MetaService;
  ms?: number;
}

/**
 * Gọi 1 lệnh Meta CLI qua RPC bridge. Trả về kết quả chuẩn hóa.
 * `command` là subcommand đầu tiên (vd "me", "threads"), `args` là
 * các tham số còn lại. `stdin` dùng cho lệnh đọc nội dung qua stdin
 * (vd messenger `send --text-stdin`).
 */
export async function callMetaRpc(
  service: MetaService,
  command: string,
  args: string[] = [],
  stdin?: string,
): Promise<MetaRpcResult> {
  const started = Date.now();
  const cfg = META_SERVICES[service];
  if (!cfg) return { ok: false, error: `unknown service: ${service}` };
  if (!command || typeof command !== "string") {
    return { ok: false, error: "command is required" };
  }
  const tokenFile = resolveTokenFile(cfg);
  if (!tokenFile) {
    return {
      ok: false,
      error:
        `meta rpc token file not found for ${service} ` +
        `(tried ${cfg.tokenFiles.join(", ")}; set ${cfg.envPrefix}_TOKEN_FILE)`,
    };
  }
  let token: string;
  try {
    token = fs.readFileSync(tokenFile, "utf-8").trim();
  } catch (e) {
    return { ok: false, error: `cannot read token file ${tokenFile}: ${e}` };
  }
  if (!token) return { ok: false, error: `empty token file ${tokenFile}` };

  const port = resolvePort(cfg);
  const body: Record<string, unknown> = { args: [command, ...args] };
  if (cfg.cli) body.cli = cfg.cli;
  if (stdin !== undefined) body.stdin = stdin;

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [cfg.header]: token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (e) {
    return {
      ok: false,
      error: `cannot reach meta rpc ${service} on 127.0.0.1:${port}: ${e}`,
      ms: Date.now() - started,
    };
  }
  const ms = Date.now() - started;
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: `meta rpc ${service} returned non-JSON (http ${res.status})`, ms };
  }
  if (!res.ok) {
    return { ok: false, error: payload?.error || `meta rpc ${service} http ${res.status}`, ms };
  }
  const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
  let data: unknown = stdout;
  try {
    data = stdout ? JSON.parse(stdout) : null;
  } catch {
    // stdout không phải JSON thì giữ nguyên dạng text
  }
  return {
    ok: true,
    data,
    stdout,
    stderr: typeof payload?.stderr === "string" ? payload.stderr : "",
    exit_code: typeof payload?.exit_code === "number" ? payload.exit_code : 0,
    service,
    ms,
  };
}

const serviceEnum = z.enum(["fb", "msg", "ig", "igmsg", "th", "thmsg", "ads"]);

export function registerMetaTools(mcp: McpServer, onActivity?: (event: any) => void): void {
  const emit = (event: any) => {
    try {
      onActivity?.(event);
    } catch {
      // không để activity làm vỡ tool
    }
  };

  // --- Lớp Generic ---
  mcp.tool(
    "meta_cli_exec",
    "Gọi 1 lệnh Meta CLI qua cầu nối Reverse RPC (facebook-cli, hatch_messenger_cli, instagram-cli, threads-cli, meta-ads-cli). Dùng khi không có tool chuyên biệt. Lệnh ghi (đăng bài, gửi tin...) thực thi ngay, không có thẻ xác nhận — chỉ gọi khi người dùng đã yêu cầu rõ ràng.",
    {
      service: serviceEnum.describe(
        'Dịch vụ: "fb" (Facebook), "msg" (Messenger), "ig" (Instagram), "igmsg" (nhắn IG), "th" (Threads), "thmsg" (nhắn Threads), "ads" (Meta Ads)',
      ),
      command: z.string().describe("Subcommand đầu tiên, vd \"me\", \"threads\", \"accounts\", \"status\""),
      args: z.array(z.string()).optional().describe("Các tham số còn lại, vd [\"--limit\", \"5\"]"),
      stdin: z.string().optional().describe("Nội dung stdin (cho lệnh đọc qua --text-stdin như messenger send)"),
    },
    async ({ service, command, args, stdin }) => {
      const result = await callMetaRpc(service, command, args ?? [], stdin);
      emit({ type: "meta_cli_exec", service, command, ok: result.ok, ms: result.ms });
      if (!result.ok) return err(result.error || "meta_cli_exec failed");
      return text(result);
    },
  );

  // --- Facebook ---
  mcp.tool(
    "meta_fb_me",
    "Xem tài khoản Facebook đang đăng nhập (facebook-cli me).",
    {},
    async () => {
      const result = await callMetaRpc("fb", "me");
      if (!result.ok) return err(result.error || "meta_fb_me failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_fb_feed",
    "Đọc bảng tin Facebook (facebook-cli feed newsfeed).",
    {
      type: z.enum(["newsfeed", "friends"]).optional().describe("Loại feed (mặc định newsfeed)"),
      limit: z.number().int().min(1).max(20).optional().describe("Số bài tối đa (mặc định 5)"),
    },
    async ({ type, limit }) => {
      const result = await callMetaRpc("fb", "feed", [type ?? "newsfeed", "--limit", String(limit ?? 5)]);
      if (!result.ok) return err(result.error || "meta_fb_feed failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_fb_groups_search",
    "Tìm nhóm Facebook theo từ khóa (facebook-cli groups search).",
    {
      query: z.string().describe("Từ khóa tìm nhóm, vd \"muse\""),
    },
    async ({ query }) => {
      const result = await callMetaRpc("fb", "groups", ["search", "--query", query]);
      if (!result.ok) return err(result.error || "meta_fb_groups_search failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_fb_post_create",
    "Đăng 1 bài lên trang cá nhân Facebook (facebook-cli post create). CHỈ đăng trang cá nhân, KHÔNG đăng được lên nhóm. Lệnh ghi — thực thi ngay, không có thẻ xác nhận.",
    {
      text: z.string().describe("Nội dung bài đăng"),
      privacy: z.enum(["public", "friends", "only_me"]).optional().describe("Quyền riêng tư (mặc định theo CLI)"),
    },
    async ({ text: postText, privacy }) => {
      const args = ["create", "-m", postText];
      if (privacy) args.push("-p", privacy);
      const result = await callMetaRpc("fb", "post", args);
      if (!result.ok) return err(result.error || "meta_fb_post_create failed");
      return text(result);
    },
  );

  // --- Instagram ---
  mcp.tool(
    "meta_ig_accounts",
    "Liệt kê tài khoản Instagram đã kết nối (instagram-cli accounts).",
    {},
    async () => {
      const result = await callMetaRpc("ig", "accounts");
      if (!result.ok) return err(result.error || "meta_ig_accounts failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_ig_posts",
    "Xem bài đăng Instagram của 1 tài khoản (instagram-cli posts).",
    {
      accountId: z.string().describe("ID tài khoản IG (lấy từ meta_ig_accounts)"),
      username: z.string().optional().describe("Username IG (nếu CLI yêu cầu)"),
    },
    async ({ accountId, username }) => {
      const args = ["posts", "--account-id", accountId];
      if (username) args.push("--username", username);
      const result = await callMetaRpc("ig", args[0], args.slice(1));
      if (!result.ok) return err(result.error || "meta_ig_posts failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_ig_inbox",
    "Đọc hộp thư Instagram (instagram-messages-cli inbox). Cần kết nối lại Instagram Messages nếu báo chưa kết nối.",
    {
      accountId: z.string().describe("ID tài khoản IG (lấy từ meta_ig_accounts)"),
      folder: z.enum(["INBOX", "SPAM", "PENDING"]).optional().describe("Thư mục (mặc định INBOX)"),
    },
    async ({ accountId, folder }) => {
      const result = await callMetaRpc("igmsg", "inbox", [
        "--account-id",
        accountId,
        "--folder",
        folder ?? "INBOX",
      ]);
      if (!result.ok) return err(result.error || "meta_ig_inbox failed");
      return text(result);
    },
  );

  // --- Threads ---
  mcp.tool(
    "meta_th_accounts",
    "Liệt kê tài khoản Threads đã kết nối (threads-cli accounts).",
    {},
    async () => {
      const result = await callMetaRpc("th", "accounts");
      if (!result.ok) return err(result.error || "meta_th_accounts failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_th_profile",
    "Xem profile Threads (threads-cli profile).",
    {
      accountId: z.string().optional().describe("ID tài khoản Threads (nếu cần)"),
    },
    async ({ accountId }) => {
      const args = accountId ? ["profile", "--account-id", accountId] : ["profile"];
      const result = await callMetaRpc("th", args[0], args.slice(1));
      if (!result.ok) return err(result.error || "meta_th_profile failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_th_post",
    "Đăng 1 bài lên Threads (threads-cli post). Lệnh ghi — thực thi ngay, không có thẻ xác nhận.",
    {
      text: z.string().describe("Nội dung bài đăng Threads"),
      accountId: z.string().optional().describe("ID tài khoản Threads (nếu cần)"),
    },
    async ({ text: postText, accountId }) => {
      const args = ["post", "--text", postText];
      if (accountId) args.push("--account-id", accountId);
      const result = await callMetaRpc("th", args[0], args.slice(1));
      if (!result.ok) return err(result.error || "meta_th_post failed");
      return text(result);
    },
  );

  // --- Meta Ads ---
  mcp.tool(
    "meta_ads_status",
    "Kiểm tra kết nối Meta Ads (meta-ads-cli status).",
    {},
    async () => {
      const result = await callMetaRpc("ads", "status");
      if (!result.ok) return err(result.error || "meta_ads_status failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_ads_list_tools",
    "Liệt kê các tool Meta Ads có sẵn (meta-ads-cli list-tools).",
    {},
    async () => {
      const result = await callMetaRpc("ads", "list-tools");
      if (!result.ok) return err(result.error || "meta_ads_list_tools failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_ads_call_tool",
    "Gọi 1 tool Meta Ads với tham số JSON (meta-ads-cli call-tool).",
    {
      toolName: z.string().describe("Tên tool Ads (lấy từ meta_ads_list_tools)"),
      args: z.record(z.unknown()).optional().describe("Tham số JSON cho tool"),
    },
    async ({ toolName, args }) => {
      const result = await callMetaRpc("ads", "call-tool", [
        toolName,
        "--args",
        JSON.stringify(args ?? {}),
      ]);
      if (!result.ok) return err(result.error || "meta_ads_call_tool failed");
      return text(result);
    },
  );

  // --- Messenger ---
  mcp.tool(
    "meta_msg_chats",
    "Liệt kê đoạn chat Messenger (hatch_messenger_cli threads).",
    {
      limit: z.number().int().min(1).max(30).optional().describe("Số đoạn tối đa (mặc định 10)"),
      unread: z.boolean().optional().describe("Chỉ đoạn chưa đọc"),
    },
    async ({ limit, unread }) => {
      const args = ["threads", "--limit", String(limit ?? 10)];
      if (unread) args.push("--unread");
      const result = await callMetaRpc("msg", args[0], args.slice(1));
      if (!result.ok) return err(result.error || "meta_msg_chats failed");
      return text(result);
    },
  );

  mcp.tool(
    "meta_msg_send",
    "Gửi 1 tin nhắn Messenger (hatch_messenger_cli send). Lệnh ghi — thực thi ngay, không có thẻ xác nhận. Không gửi cho người trong danh sách loại trừ của auto-reply trừ khi người dùng chỉ định rõ.",
    {
      recipientId: z.string().optional().describe("FBID người nhận (dùng khi chưa có đoạn chat)"),
      conversationId: z.string().optional().describe("ID đoạn chat (cid...) — ưu tiên dùng cái này khi đã có đoạn chat"),
      text: z.string().describe("Nội dung tin nhắn"),
    },
    async ({ recipientId, conversationId, text: msgText }) => {
      if (!recipientId && !conversationId) {
        return err("meta_msg_send cần recipientId hoặc conversationId");
      }
      const args = ["send"];
      if (conversationId) args.push("--cid", conversationId);
      else if (recipientId) args.push("--to", recipientId);
      args.push("--text-stdin");
      const result = await callMetaRpc("msg", args[0], args.slice(1), msgText);
      if (!result.ok) return err(result.error || "meta_msg_send failed");
      return text(result);
    },
  );
}
