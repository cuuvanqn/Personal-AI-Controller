/**
 * A2A (Agent2Agent) Protocol 1.0.0 — pure JSON-RPC 2.0 client over fetch.
 *
 * Deliberately imports NOTHING from the daemon (no db, no security, no
 * routes) so it can be tested standalone, e.g. `bun scripts/a2a-test-client.ts`.
 *
 * Normative references (a2a-protocol.org, spec 1.0.0):
 * - §5.3 Method Mapping: SendMessage / SendStreamingMessage / GetTask /
 *   ListTasks / CancelTask / SubscribeToTask (PascalCase; the 0.3 lowercase
 *   names message/send, tasks/get, ... were renamed in 1.0).
 * - §5.4 Error codes: TaskNotFound -32001, TaskNotCancelable -32002,
 *   PushNotificationNotSupported -32003, UnsupportedOperation -32004,
 *   ContentTypeNotSupported -32005, InvalidAgentResponse -32006,
 *   ExtendedAgentCardNotConfigured -32007, ExtensionSupportRequired -32008,
 *   VersionNotSupported -32009; standard JSON-RPC -32700/-32600/-32601/
 *   -32602/-32603 (§9.5).
 * - §5.5: enums serialize as ProtoJSON SCREAMING_SNAKE_CASE
 *   (TASK_STATE_SUBMITTED, ROLE_USER, ...); fields are camelCase.
 * - §9.2: clients send `A2A-Version: 1.0` on every request.
 * - §9.4.2: streaming responses are SSE; each `data:` line is a JSON-RPC
 *   response envelope whose `result` is a StreamResponse
 *   ({task} | {statusUpdate} | {artifactUpdate} | {message}).
 */

// ---------------------------------------------------------------------------
// Error codes (A2A 1.0.0 §5.4 + JSON-RPC 2.0 §9.5)
// ---------------------------------------------------------------------------

export const A2A_ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Server-defined range; used here for HTTP-level auth failures (401). */
  Unauthorized: -32000,
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  ExtendedAgentCardNotConfigured: -32007,
  ExtensionSupportRequired: -32008,
  VersionNotSupported: -32009,
} as const;

export const A2A_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Data model (A2A 1.0.0 §4, ProtoJSON: camelCase fields, SCREAMING enums)
// ---------------------------------------------------------------------------

export type A2aTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

export const A2A_TERMINAL_STATES: readonly A2aTaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];

export function isA2aTerminalState(state: A2aTaskState): boolean {
  return (A2A_TERMINAL_STATES as readonly string[]).includes(state);
}

export type A2aRole = "ROLE_USER" | "ROLE_AGENT";

/** A Part is discriminated by its member name in 1.0 (no `kind` field). */
export type A2aPart =
  | { text: string; metadata?: Record<string, unknown> }
  | { file: { name?: string; mimeType?: string; uri?: string; bytes?: string }; metadata?: Record<string, unknown> }
  | { data: Record<string, unknown>; metadata?: Record<string, unknown> };

export interface A2aMessage {
  messageId: string;
  role: A2aRole;
  parts: A2aPart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  state: A2aTaskState;
  timestamp?: string;
  message?: A2aMessage;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
}

export interface A2aPushNotificationConfig {
  url: string;
  /** Bearer token the server sends when POSTing to `url` (optional). */
  token?: string;
  authentication?: { schemes: string[]; credentials?: string };
}

export interface A2aSendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  pushNotificationConfig?: A2aPushNotificationConfig;
  blocking?: boolean;
}

export interface A2aSendMessageRequest {
  message: A2aMessage;
  configuration?: A2aSendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export type A2aSendMessageResponse = { task: A2aTask } | { message: A2aMessage };

export interface A2aTaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2aTaskStatus;
  final?: boolean;
}

export interface A2aTaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
}

export type A2aStreamResponse =
  | { task: A2aTask }
  | { statusUpdate: A2aTaskStatusUpdateEvent }
  | { artifactUpdate: A2aTaskArtifactUpdateEvent }
  | { message: A2aMessage };

export interface A2aGetTaskRequest {
  id: string;
  historyLength?: number;
}

export interface A2aListTasksRequest {
  contextId?: string;
  status?: A2aTaskState;
  pageSize?: number;
  pageToken?: string;
}

export interface A2aListTasksResponse {
  tasks: A2aTask[];
  totalSize: number;
  pageSize?: number;
  nextPageToken?: string;
}

export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2aAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string; tenant?: string }[];
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  capabilities: { streaming?: boolean; pushNotifications?: boolean; extendedAgentCard?: boolean };
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: Record<string, string[]>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  iconUrl?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class A2aError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly httpStatus?: number;

  constructor(code: number, message: string, opts?: { data?: unknown; httpStatus?: number }) {
    super(message);
    this.name = "A2aError";
    this.code = code;
    this.data = opts?.data;
    this.httpStatus = opts?.httpStatus;
  }
}

export class A2aHttpError extends A2aError {
  constructor(httpStatus: number, message: string) {
    super(A2A_ERROR_CODES.Unauthorized, message, { httpStatus });
    this.name = "A2aHttpError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function headers(authToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "A2A-Version": A2A_VERSION,
  };
  if (authToken) h["Authorization"] = `Bearer ${authToken}`;
  return h;
}

function errorFromEnvelope(env: any, fallbackHttpStatus?: number): A2aError {
  const err = env?.error ?? {};
  return new A2aError(
    typeof err.code === "number" ? err.code : A2A_ERROR_CODES.InternalError,
    typeof err.message === "string" ? err.message : "A2A request failed",
    { data: err.data, httpStatus: fallbackHttpStatus },
  );
}

async function parseJsonRpcResponse(res: Response): Promise<any> {
  const text = await res.text();
  let env: any = null;
  try {
    env = text ? JSON.parse(text) : null;
  } catch {
    throw new A2aError(A2A_ERROR_CODES.ParseError, `Invalid JSON in A2A response (HTTP ${res.status})`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok && !env?.error) {
    throw new A2aHttpError(res.status, `A2A request failed with HTTP ${res.status}`);
  }
  if (env?.error) throw errorFromEnvelope(env, res.status);
  if (!env || env.jsonrpc !== "2.0" || !("result" in env)) {
    throw new A2aError(A2A_ERROR_CODES.InvalidAgentResponse, "Malformed JSON-RPC response from A2A server", {
      httpStatus: res.status,
    });
  }
  return env.result;
}

async function rpcCall(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  authToken?: string,
): Promise<any> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/a2a`, {
    method: "POST",
    headers: headers(authToken),
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  return parseJsonRpcResponse(res);
}

/** Build a minimal user Message carrying plain text. */
export function textMessage(
  text: string,
  opts?: { contextId?: string; taskId?: string; messageId?: string; metadata?: Record<string, unknown> },
): A2aMessage {
  return {
    messageId: opts?.messageId ?? crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
    ...(opts?.contextId ? { contextId: opts.contextId } : {}),
    ...(opts?.taskId ? { taskId: opts.taskId } : {}),
    ...(opts?.metadata ? { metadata: opts.metadata } : {}),
  };
}

/** Concatenate the text parts of a Message (or Task status message). */
export function messageText(message: A2aMessage | undefined | null): string {
  if (!message) return "";
  return message.parts
    .map((p) => ("text" in p ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Client operations (A2A 1.0.0 §5.3 / §9.4)
// ---------------------------------------------------------------------------

/** GET the public Agent Card. No auth required. */
export async function getAgentCard(baseUrl: string): Promise<A2aAgentCard> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/.well-known/agent-card.json`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new A2aHttpError(res.status, `Agent Card fetch failed with HTTP ${res.status}`);
  return (await res.json()) as A2aAgentCard;
}

/** SendMessage — returns either a Task or a direct Message response. */
export async function sendMessage(
  baseUrl: string,
  request: A2aSendMessageRequest,
  authToken?: string,
): Promise<A2aSendMessageResponse> {
  return (await rpcCall(baseUrl, "SendMessage", request as unknown as Record<string, unknown>, authToken)) as A2aSendMessageResponse;
}

/** GetTask — fetch the current state of one task. */
export async function getTask(
  baseUrl: string,
  id: string,
  authToken?: string,
  historyLength?: number,
): Promise<A2aTask> {
  const params: A2aGetTaskRequest = { id, ...(historyLength !== undefined ? { historyLength } : {}) };
  return (await rpcCall(baseUrl, "GetTask", params as unknown as Record<string, unknown>, authToken)) as A2aTask;
}

/** ListTasks — list tasks with optional filters + pagination. */
export async function listTasks(
  baseUrl: string,
  params: A2aListTasksRequest = {},
  authToken?: string,
): Promise<A2aListTasksResponse> {
  return (await rpcCall(baseUrl, "ListTasks", params as unknown as Record<string, unknown>, authToken)) as A2aListTasksResponse;
}

/** CancelTask — request cancellation of a non-terminal task. */
export async function cancelTask(baseUrl: string, id: string, authToken?: string): Promise<A2aTask> {
  return (await rpcCall(baseUrl, "CancelTask", { id }, authToken)) as A2aTask;
}

/**
 * SendStreamingMessage — POST the message, then read the SSE stream.
 * Each `data:` line is a JSON-RPC envelope whose `result` is a
 * StreamResponse. Every event is passed to `onEvent` as it arrives and
 * also collected into the returned array. Throws A2aError on a
 * JSON-RPC error envelope (before or during the stream).
 */
export async function sendStreamingMessage(
  baseUrl: string,
  request: A2aSendMessageRequest,
  authToken?: string,
  onEvent?: (event: A2aStreamResponse) => void,
): Promise<A2aStreamResponse[]> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/a2a`, {
    method: "POST",
    headers: { ...headers(authToken), Accept: "text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "SendStreamingMessage", params: request }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("text/event-stream")) {
    // Pre-stream failure: the server answers with a plain JSON-RPC error.
    await parseJsonRpcResponse(res); // throws the decoded A2aError
    throw new A2aError(A2A_ERROR_CODES.InternalError, `Unexpected streaming response (HTTP ${res.status})`, {
      httpStatus: res.status,
    });
  }
  if (!res.body) throw new A2aError(A2A_ERROR_CODES.InvalidAgentResponse, "Streaming response has no body");

  const events: A2aStreamResponse[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleDataLine = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    let env: any;
    try {
      env = JSON.parse(payload);
    } catch {
      throw new A2aError(A2A_ERROR_CODES.ParseError, "Invalid JSON in SSE stream");
    }
    if (env?.error) throw errorFromEnvelope(env);
    if (env?.result) {
      events.push(env.result as A2aStreamResponse);
      onEvent?.(env.result as A2aStreamResponse);
    }
  };

  const drainBuffer = (final: boolean) => {
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) handleDataLine(line.slice(5).trim());
      }
    }
    if (final && buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data:")) handleDataLine(line.slice(5).trim());
      }
      buffer = "";
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drainBuffer(false);
    }
    buffer += decoder.decode();
    drainBuffer(true);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return events;
}
