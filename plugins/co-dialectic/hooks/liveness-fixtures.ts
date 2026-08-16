/**
 * liveness-fixtures.ts — the shared truth table for codi liveness.
 *
 * XOS-213. Liveness is decided in more than one place: `evaluateSharedLiveness`
 * in TypeScript, and a hand-written reimplementation in `statusline.sh` that
 * carried the comment "Keep this predicate in sync with hooks/liveness.ts".
 *
 * A comment is not a mechanism. This table is: every implementation is driven
 * over the SAME cases by xos-213-liveness-parity.test.ts and must agree. Adding
 * a case here automatically holds every implementation to it.
 *
 * Offsets are seconds relative to "now" at test time, because statusline.sh
 * reads the real clock (`date -u +%s`) and cannot be given an injected now.
 * Keep offsets far from the stale boundary so a sub-second skew between the
 * shell's clock read and the test's cannot flip a verdict.
 */

export type Classification = "LIVE" | "DEGRADED" | "UNINITIALIZED";

export interface LivenessFixture {
  name: string;
  /** Seconds before now. null = field absent entirely. */
  protocolAgo: number | null;
  promptAgo: number | null;
  sessionAgo: number | null;
  /** Written verbatim into state.json. `undefined` = key omitted. */
  active?: unknown;
  expect: Classification;
  why: string;
}

/** Stale window used by every parity case. Small so cases are crisp. */
export const FIXTURE_STALE_SECS = 60;

export const LIVENESS_FIXTURES: LivenessFixture[] = [
  {
    name: "heartbeat after prompt, hours elapsed, mid-tool-call",
    protocolAgo: 3600,
    promptAgo: 7200,
    sessionAgo: 7200,
    active: true,
    expect: "LIVE",
    why: "XOS-237: current-turn proof beats wall-clock age. This is the original bug — a busy session scored as dead.",
  },
  {
    name: "heartbeat before prompt and beyond the window",
    protocolAgo: 600,
    promptAgo: 300,
    sessionAgo: 900,
    active: true,
    expect: "DEGRADED",
    why: "The model has not run its protocols for the current turn and the heartbeat is old.",
  },
  {
    name: "heartbeat before prompt but inside the window",
    protocolAgo: 30,
    promptAgo: 10,
    sessionAgo: 300,
    active: true,
    expect: "LIVE",
    why: "Grace backstop still covers it; the turn may simply be in flight.",
  },
  {
    name: "no heartbeat at all",
    protocolAgo: null,
    promptAgo: 10,
    sessionAgo: 300,
    active: true,
    expect: "UNINITIALIZED",
    why: "Absent evidence is uninitialized, not degraded. Rendering these identically was a large share of the false alarms.",
  },
  {
    name: "no prompt, session newer than heartbeat, beyond window",
    protocolAgo: 600,
    promptAgo: null,
    sessionAgo: 300,
    active: true,
    expect: "DEGRADED",
    why: "XOS-197 legacy path: a SessionStart after the heartbeat, with the heartbeat stale.",
  },
  {
    name: "no prompt, heartbeat fresh, session newer",
    protocolAgo: 20,
    promptAgo: null,
    sessionAgo: 5,
    active: true,
    expect: "LIVE",
    why: "XOS-197: a fresh heartbeat survives a later reload/SessionStart re-stamp.",
  },
  {
    name: "no prompt, no session, heartbeat beyond window",
    protocolAgo: 600,
    promptAgo: null,
    sessionAgo: null,
    active: true,
    expect: "DEGRADED",
    why: "Nothing to be turn-relative against; the backstop is all that is left.",
  },
  {
    name: "explicit codi off",
    protocolAgo: 5,
    promptAgo: 10,
    sessionAgo: 60,
    active: false,
    expect: "DEGRADED",
    why: "active:false is the durable signal for an explicit `codi off`, regardless of heartbeat freshness.",
  },
  {
    name: "active absent entirely",
    protocolAgo: 5,
    promptAgo: 10,
    sessionAgo: 60,
    active: undefined,
    expect: "LIVE",
    why: "No active evidence is not evidence of inactivity. A brand-new session has not failed a protocol.",
  },
  {
    name: 'active as the STRING "true"',
    protocolAgo: 5,
    promptAgo: 10,
    sessionAgo: 60,
    active: "true",
    expect: "LIVE",
    why:
      "The three implementations disagreed here before XOS-213: status-liveness-check used boolean-or-string (LIVE), " +
      "user-prompt-submit used boolean-only (DEGRADED), and statusline.sh degraded only on the literal \"false\" (LIVE). " +
      "Unified on the tolerant reading: a legacy or hand-edited string must not manufacture a false DEGRADED.",
  },
  {
    name: 'active as the STRING "false"',
    protocolAgo: 5,
    promptAgo: 10,
    sessionAgo: 60,
    active: "false",
    expect: "DEGRADED",
    why: "The tolerant reading accepts true/\"true\"/\"True\" as active — everything else with evidence present is inactive.",
  },
  {
    name: "active as a non-boolean junk value",
    protocolAgo: 5,
    promptAgo: 10,
    sessionAgo: 60,
    active: 0,
    expect: "DEGRADED",
    why: "Corrupt state must not read as healthy. statusline.sh previously rendered this LIVE because it only tested for \"false\".",
  },
];
