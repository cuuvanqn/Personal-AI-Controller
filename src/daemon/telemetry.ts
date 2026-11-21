import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { OTTER_VERSION } from "./version";
import { getOtterDir } from "./db";
import { generateSupportCode } from "./license/support-code";

export interface TelemetryUser {
  uid?: string | null;
  email?: string | null;
  displayName?: string | null;
}

const TELEMETRY_BASE_URL = (
  process.env.OTTER_TELEMETRY_URL ||
  process.env.OTTER_LICENSE_URL ||
  "https://license.gpt.io.vn"
).replace(/\/+$/, "");

let cachedUser: TelemetryUser | null | undefined = undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function isTelemetryDisabled(): boolean {
  const v = (process.env.OTTER_TELEMETRY || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

function userFilePath(): string {
  return path.join(getOtterDir(), "telemetry-user.json");
}

export function getTelemetryUser(): TelemetryUser | null {
  if (cachedUser !== undefined) return cachedUser;
  try {
    const raw = fs.readFileSync(userFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.email || parsed.uid || parsed.displayName)) {
      cachedUser = {
        uid: parsed.uid || null,
        email: parsed.email || null,
        displayName: parsed.displayName || null,
      };
      return cachedUser;
    }
  } catch {}
  cachedUser = null;
  return null;
}

export function setTelemetryUser(user: TelemetryUser | null): void {
  cachedUser = user && (user.email || user.uid || user.displayName)
    ? {
        uid: user.uid || null,
        email: user.email || null,
        displayName: user.displayName || null,
      }
    : null;
  try {
    const p = userFilePath();
    if (cachedUser) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(cachedUser, null, 2), "utf-8");
    } else if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
    }
  } catch {}
}

export async function sendTelemetryHeartbeat(opts: {
  source?: string;
  clearIdentity?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<boolean> {
  if (isTelemetryDisabled()) return false;
  const doFetch = opts.fetchImpl || fetch;
  const user = opts.clearIdentity ? null : getTelemetryUser();

  try {
    const res = await doFetch(`${TELEMETRY_BASE_URL}/api/telemetry/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: generateSupportCode(),
        version: OTTER_VERSION,
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        source: opts.source || "daemon",
        uid: user?.uid || null,
        email: user?.email || null,
        display_name: user?.displayName || null,
        clear_identity: opts.clearIdentity === true,
      }),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function startTelemetryHeartbeat(intervalMs: number = 3 * 60 * 1000): void {
  if (isTelemetryDisabled() || heartbeatTimer) return;
  setTimeout(() => void sendTelemetryHeartbeat(), 5000);
  heartbeatTimer = setInterval(() => void sendTelemetryHeartbeat(), intervalMs);
}

export async function trackOtterDownload(payload: {
  component: string;
  platform?: string;
  version?: string | null;
  source?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (isTelemetryDisabled()) return false;
  const doFetch = payload.fetchImpl || fetch;
  try {
    const res = await doFetch(`${TELEMETRY_BASE_URL}/api/downloads/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        component: payload.component,
        platform: payload.platform || process.platform,
        version: payload.version || OTTER_VERSION,
        source: payload.source || "daemon",
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
