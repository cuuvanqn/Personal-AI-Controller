/**
 * A2A test client — drives a remote A2A server (e.g. the MXH backend)
 * using the pure client in src/daemon/a2a-client.ts.
 *
 * Usage:
 *   MXH_A2A_BASE_URL=http://<mxh-host>:<port> \
 *   MXH_BOT_TOKEN=<bot-token> \
 *   bun run scripts/a2a-test-client.ts ["message text"]
 *
 * Env:
 *   MXH_A2A_BASE_URL   Base URL of the remote A2A agent (required).
 *                      The client appends /.well-known/agent-card.json and /a2a.
 *   MXH_BOT_TOKEN      Bearer token for the remote agent (required).
 *                      Read from env only — never hardcode, never print.
 *   MXH_CONVERSATION_ID Conversation/group id passed via message metadata
 *                      (default: "503").
 *   A2A_POLL_SECONDS   How long to poll tasks/get (default: 60).
 *
 * Flow: GET Agent Card -> SendMessage -> poll GetTask until terminal or
 * timeout -> print the final task state. Exits non-zero on any failure.
 * NOTE: this sends a real message to the target conversation, so the
 * default text is tagged [TEST A2A].
 */
import {
  A2aError,
  getAgentCard,
  getTask,
  isA2aTerminalState,
  sendMessage,
  textMessage,
} from "../src/daemon/a2a-client";

const baseUrl = process.env.MXH_A2A_BASE_URL;
const token = process.env.MXH_BOT_TOKEN;
const conversationId = process.env.MXH_CONVERSATION_ID ?? "503";
const pollSeconds = Number(process.env.A2A_POLL_SECONDS ?? "60");

if (!baseUrl) {
  console.error("Missing env: MXH_A2A_BASE_URL (e.g. http://<mxh-host>:4001)");
  process.exit(2);
}
if (!token) {
  console.error("Missing env: MXH_BOT_TOKEN");
  process.exit(2);
}
if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
  console.error("Invalid env: A2A_POLL_SECONDS must be a positive number");
  process.exit(2);
}

const text = process.argv[2] ?? "[TEST A2A] Ping from Otter A2A test client — please ignore.";

function fail(err: unknown): never {
  if (err instanceof A2aError) {
    console.error(`[FAIL] A2A error code=${err.code} http=${err.httpStatus ?? "?"}: ${err.message}`);
  } else {
    console.error(`[FAIL] ${(err as any)?.message ?? err}`);
  }
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`[A2A test] baseUrl=${baseUrl} conversationId=${conversationId} token=<provided via env>`);
try {
  const card = await getAgentCard(baseUrl);
  console.log(`[A2A test] Agent Card: name=${card.name} version=${card.version}`);
  console.log(`[A2A test] skills=${card.skills.map((s) => s.id).join(",")}`);
  console.log(`[A2A test] capabilities streaming=${card.capabilities.streaming} pushNotifications=${card.capabilities.pushNotifications}`);

  const sent = await sendMessage(
    baseUrl,
    {
      message: textMessage(text, { metadata: { conversationId } }),
      metadata: { conversationId },
    },
    token,
  );
  if (!("task" in sent)) {
    console.log(`[A2A test] Direct message response (no task): ${JSON.stringify(sent.message).slice(0, 500)}`);
    process.exit(0);
  }
  const taskId = sent.task.id;
  console.log(`[A2A test] Task created: id=${taskId} state=${sent.task.status.state}`);

  const deadline = Date.now() + pollSeconds * 1000;
  let lastState = sent.task.status.state;
  for (;;) {
    if (isA2aTerminalState(lastState)) break;
    if (Date.now() >= deadline) break;
    await sleep(5000);
    const current = await getTask(baseUrl, taskId, token);
    if (current.status.state !== lastState) {
      console.log(`[A2A test] Task ${taskId}: ${lastState} -> ${current.status.state}`);
      lastState = current.status.state;
    }
  }

  const final = await getTask(baseUrl, taskId, token);
  console.log(`[A2A test] Final: id=${final.id} state=${final.status.state} contextId=${final.contextId}`);
  if (isA2aTerminalState(final.status.state)) {
    console.log("[A2A test] DONE (terminal state reached)");
  } else {
    console.log(`[A2A test] TIMEOUT after ${pollSeconds}s (still ${final.status.state})`);
    process.exit(3);
  }
} catch (err) {
  fail(err);
}
