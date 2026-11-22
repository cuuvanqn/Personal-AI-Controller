import * as path from "node:path";
import { resolveVpsEngine } from "./vps";

export interface TerminalExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TerminalEvent {
  sequence: number;
  data: string;
  encoding: "utf-8" | "base64";
}

export interface TerminalSession {
  id: string;
  conversationId: string;
  shell: string;
  busy: boolean;
  inputAllowed: boolean;
  closed: boolean;
  events: TerminalEvent[];
  proc?: any;
  waiters: Array<(events: TerminalEvent[]) => void>;
}

const sessions = new Map<string, TerminalSession>();

export function getSessionsForConversation(conversationId: string): TerminalSession[] {
  const result: TerminalSession[] = [];
  for (const s of sessions.values()) {
    if (s.conversationId === conversationId && !s.closed) {
      result.push(s);
    }
  }
  // Nếu chưa có session nào, tự động tạo 1 terminal mặc định sẵn sàng nhận lệnh
  if (result.length === 0) {
    const defaultSession = createTerminalSession(conversationId);
    result.push(defaultSession);
  }
  return result;
}

export function getSession(sessionId: string): TerminalSession | undefined {
  return sessions.get(sessionId);
}

export function getLatestActiveSession(): TerminalSession | undefined {
  const all = Array.from(sessions.values()).filter(s => !s.closed);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/**
 * PAC security boundary: legacy persistent shell sessions are inert.
 * The imported Otter terminal must not spawn a process until a separate
 * restricted subprocess worker with an approval policy is implemented.
 */
export function createTerminalSession(
  conversationId: string,
  _customCmd?: string[],
  _initialBanner?: string
): TerminalSession {
  const id = crypto.randomUUID();
  const session: TerminalSession = {
    id,
    conversationId,
    shell: "PAC legacy shell disabled",
    busy: false,
    inputAllowed: false,
    closed: false,
    events: [{
      sequence: 1,
      data: "[PAC] Legacy terminal is disabled pending a restricted execution worker.\\r\\n",
      encoding: "utf-8"
    }],
    waiters: []
  };
  sessions.set(id, session);
  return session;
}

export function createVpsSshSession(
  conversationId: string,
  host: string,
  user: string = "root",
  key?: string,
  port: number = 22,
  password?: string
): TerminalSession {
  const payload = JSON.stringify({
    action: "shell",
    host,
    user,
    key,
    port,
    password
  });

  const engine = resolveVpsEngine(payload);
  const banner = `\x1b[36m[VPS SSH Persistent Session Opened (${engine.mode}): ${user}@${host}:${port}]\x1b[0m\r\nPhiên SSH đang kết nối liên tục (Keep-Alive). Bạn và AI có thể chat và gửi lệnh tiếp nối nhau.\r\n`;

  return createTerminalSession(conversationId, engine.cmd, banner);
}

export function appendTerminalOutput(sessionId: string, data: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const nextSeq = session.events.length > 0 
    ? session.events[session.events.length - 1].sequence + 1 
    : 1;

  const event: TerminalEvent = {
    sequence: nextSeq,
    data,
    encoding: "utf-8"
  };

  session.events.push(event);

  // Giữ tối đa 1000 events gần nhất
  if (session.events.length > 1000) {
    session.events.shift();
  }

  // Thông báo cho các long-poll waiters
  while (session.waiters.length > 0) {
    const waiter = session.waiters.shift();
    waiter?.([event]);
  }
}

export async function readTerminalOutput(
  sessionId: string,
  afterSequence: number,
  waitMs: number = 5000
): Promise<{
  sessionId: string;
  events: TerminalEvent[];
  busy: boolean;
  inputAllowed: boolean;
  closed: boolean;
}> {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      sessionId,
      events: [],
      busy: false,
      inputAllowed: false,
      closed: true
    };
  }

  const existing = session.events.filter(e => e.sequence > afterSequence);
  if (existing.length > 0) {
    return {
      sessionId,
      events: existing,
      busy: session.busy,
      inputAllowed: session.inputAllowed,
      closed: session.closed
    };
  }

  // Long polling chờ event mới
  const newEvents = await new Promise<TerminalEvent[]>((resolve) => {
    const timer = setTimeout(() => {
      const idx = session.waiters.indexOf(handler);
      if (idx !== -1) session.waiters.splice(idx, 1);
      resolve([]);
    }, Math.min(waitMs, 10000));

    const handler = (evts: TerminalEvent[]) => {
      clearTimeout(timer);
      resolve(evts);
    };

    session.waiters.push(handler);
  });

  return {
    sessionId,
    events: newEvents,
    busy: session.busy,
    inputAllowed: session.inputAllowed,
    closed: session.closed
  };
}

export async function sendTerminalInput(sessionId: string, text: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session || session.closed || !session.inputAllowed) return false;

  // Nếu session có tiến trình sống (persistent process), ghi trực tiếp vào stdin
  if (session.proc && session.proc.stdin) {
    try {
      session.proc.stdin.write(text);
      session.proc.stdin.flush();
      return true;
    } catch (err: any) {
      appendTerminalOutput(sessionId, `\r\nError writing to stdin: ${err.message}\r\n`);
      return false;
    }
  }

  // Fallback nếu không có persistent proc
  appendTerminalOutput(sessionId, text);

  // Nếu input kết thúc bằng phím Enter (\r hoặc \n), thực thi như một command
  if (text.includes("\r") || text.includes("\n")) {
    const cmd = text.trim();
    if (cmd) {
      session.busy = true;
      executeCommand(cmd).then(res => {
        session.busy = false;
        appendTerminalOutput(sessionId, `\r\n${res.stdout || res.stderr}\r\n`);
      }).catch(err => {
        session.busy = false;
        appendTerminalOutput(sessionId, `\r\nError: ${err.message}\r\n`);
      });
    }
  }

  return true;
}

/**
 * All legacy direct-command callers (MCP, REST, TTS, render and terminal
 * input fallback) converge here. Deny them until PAC has a separate,
 * OS-sandboxed allowlist executor. No shell is launched.
 */
export async function executeCommand(
  _cmd: string,
  _cwd?: string
): Promise<TerminalExecutionResult> {
  return {
    stdout: "",
    stderr: "PAC policy: arbitrary terminal commands are disabled",
    exitCode: 126
  };
}
