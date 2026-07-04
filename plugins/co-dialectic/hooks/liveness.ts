/**
 * Shared Co-Dialectic liveness evaluator.
 *
 * XOS-197: a session_start timestamp can be re-stamped by reload/login/plugin
 * lifecycle events before the model gets a chance to heartbeat on the next
 * turn. A fresh last_protocol_ts is therefore LIVE even if a newer
 * last_session_start_ts leapfrogged it; protocol-before-session is stale only
 * when the heartbeat is also outside the stale window.
 */

export const DEFAULT_STALE_SECS = 900;

export interface LivenessState {
  active?: unknown;
  installed_version?: unknown;
  version?: unknown;
  last_protocol_ts?: unknown;
  last_session_start_ts?: unknown;
}

export interface SharedLiveness {
  live: boolean;
  degraded: boolean;
  stale: boolean;
  skew: boolean;
  inactive: boolean;
  installedVersion: string;
  reasons: string[];
}

export type ActivePolicy = "boolean-only" | "boolean-or-string";

export function staleSecsFromEnv(): number {
  return staleSecsOrDefault(process.env.CODI_STALE_SECS);
}

export function staleSecsOrDefault(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? DEFAULT_STALE_SECS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALE_SECS;
}

export function stringOr(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function parseIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isActive(value: unknown, policy: ActivePolicy): boolean {
  if (value === true) return true;
  return policy === "boolean-or-string" && (value === "true" || value === "True");
}

export function evaluateSharedLiveness(
  state: LivenessState | null,
  installedVersion: string,
  now: Date = new Date(),
  staleSecs: number = staleSecsFromEnv(),
  activePolicy: ActivePolicy = "boolean-only",
): SharedLiveness {
  const reasons: string[] = [];
  const safeStaleSecs = staleSecsOrDefault(staleSecs);
  const staleWindowMs = safeStaleSecs * 1000;
  const nowMs = now.getTime();
  const protocolMs = parseIsoMillis(state?.last_protocol_ts);
  const sessionMs = parseIsoMillis(state?.last_session_start_ts);

  let stale = false;
  if (protocolMs === null) {
    stale = true;
    reasons.push("missing-last_protocol_ts");
  } else {
    const protocolAgeMs = nowMs - protocolMs;
    const protocolTooOld = protocolAgeMs > staleWindowMs;
    if (sessionMs !== null && protocolMs < sessionMs && protocolTooOld) {
      stale = true;
      reasons.push("protocol-before-session");
    } else if (protocolTooOld) {
      stale = true;
      reasons.push("protocol-too-old");
    }
  }

  // XOS-149: version mismatch is informational only, never a DEGRADED trigger.
  const stateAcknowledgedVersion = stringOr(state?.version, "");
  const skew = stateAcknowledgedVersion !== "" && stateAcknowledgedVersion !== installedVersion;

  const inactive = !isActive(state?.active, activePolicy);
  if (inactive) reasons.push("inactive");

  const degraded = stale || inactive;
  return {
    live: !degraded,
    degraded,
    stale,
    skew,
    inactive,
    installedVersion,
    reasons,
  };
}
