/**
 * PAC: vendor telemetry permanently disabled in the application layer.
 * Kept as a compatibility shim for legacy imports until callers are migrated.
 * Neither these functions nor their arguments make network requests.
 */
export interface TelemetryUser {
  uid?: string | null;
  email?: string | null;
  displayName?: string | null;
}

export function getTelemetryUser(): TelemetryUser | null {
  return null;
}

export function setTelemetryUser(_user: TelemetryUser | null): void {
  // PAC does not store or transmit vendor telemetry identities.
}

export async function sendTelemetryHeartbeat(_opts: {
  source?: string;
  clearIdentity?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<boolean> {
  return false;
}

export function startTelemetryHeartbeat(_intervalMs?: number): void {
  // Intentionally no-op. Never schedules telemetry.
}

export async function trackOtterDownload(_payload: {
  component: string;
  platform?: string;
  version?: string | null;
  source?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  return false;
}
