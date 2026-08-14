/**
 * Shared Co-Dialectic liveness evaluator.
 *
 * XOS-237: liveness is turn-relative. Once Protocol 1 has run for the current
 * user turn, elapsed wall time cannot make a busy session look dead. The stale
 * window is only a backstop while the heartbeat still predates the prompt.
 * XOS-197 remains intact because a fresh heartbeat survives a later reload /
 * SessionStart marker.
 */

export const DEFAULT_STALE_SECS = 21_600;

export interface LivenessState {
  active?: unknown;
  installed_version?: unknown;
  version?: unknown;
  last_protocol_ts?: unknown;
  last_user_prompt_ts?: unknown;
  last_session_start_ts?: unknown;
}

export interface SharedLiveness {
  live: boolean;
  degraded: boolean;
  unknown: boolean;
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
  const promptMs = parseIsoMillis(state?.last_user_prompt_ts);
  const sessionMs = parseIsoMillis(state?.last_session_start_ts);

  let stale = false;
  let unknown = false;
  if (protocolMs === null) {
    unknown = true;
    reasons.push("missing-last_protocol_ts");
  } else {
    const protocolAgeMs = nowMs - protocolMs;
    const protocolTooOld = protocolAgeMs > staleWindowMs;
    if (promptMs !== null && protocolMs >= promptMs) {
      // Current-turn proof wins over wall-clock age: the model may be busy in
      // a long tool call, CI watch, deploy poll, or background task.
    } else if (promptMs !== null && protocolMs < promptMs && protocolTooOld) {
      stale = true;
      reasons.push("protocol-before-user-prompt");
    } else if (promptMs === null && sessionMs !== null && protocolMs < sessionMs && protocolTooOld) {
      stale = true;
      reasons.push("protocol-before-session");
    } else if (promptMs === null && protocolTooOld) {
      stale = true;
      reasons.push("protocol-too-old");
    }
  }

  // XOS-149: version mismatch is informational only, never a DEGRADED trigger.
  const stateAcknowledgedVersion = stringOr(state?.version, "");
  const skew = stateAcknowledgedVersion !== "" && stateAcknowledgedVersion !== installedVersion;

  // Absent state is UNKNOWN, not implicitly inactive. Only explicit non-active
  // evidence degrades; a brand-new session has not failed a protocol yet.
  const hasActiveEvidence = state !== null && state?.active !== undefined;
  const inactive = hasActiveEvidence && !isActive(state?.active, activePolicy);
  if (inactive) reasons.push("inactive");

  const degraded = stale || inactive;
  return {
    live: !degraded && !unknown,
    degraded,
    unknown,
    stale,
    skew,
    inactive,
    installedVersion,
    reasons,
  };
}
