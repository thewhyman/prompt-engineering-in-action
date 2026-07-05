# XOS-198 code review (round 2, post-corrections) — deterministic codi Protocol-1 heartbeat

## Intent
Stop hook (status-liveness-check.ts) stamps codi liveness DETERMINISTICALLY after verifying a valid Protocol-1 header in the transcript, replacing LLM-prose heartbeat writes. Prior round-1 review found 3 issues, all fixed here: (1) retired fabrication+inconsistent detectors (false-positives once hook owns write — inconsistent fired every score-change turn); (2) base state read ONCE (best-available brain-then-legacy) so migration edge doesn't reset counter / drop preferences; (3) unified duplicate legacy-path helper. active defaults true on fresh/corrupt (preserve explicit false). Brain authoritative, legacy mirror, fail-open.

## Full diff vs origin/main
```diff
diff --git a/plugins/co-dialectic/hooks/status-liveness-check.ts b/plugins/co-dialectic/hooks/status-liveness-check.ts
index d17b6fc..b50efa5 100644
--- a/plugins/co-dialectic/hooks/status-liveness-check.ts
+++ b/plugins/co-dialectic/hooks/status-liveness-check.ts
@@ -7,9 +7,9 @@
  * via Stop-hook systemMessage, but never blocks or crashes the session.
  */
 
-import { existsSync, readFileSync } from "fs";
+import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
 import { homedir } from "os";
-import { join } from "path";
+import { dirname, join } from "path";
 import {
   evaluateSharedLiveness,
   staleSecsFromEnv,
@@ -22,6 +22,9 @@ interface HookInput {
 
 export interface CodiStatusState {
   active?: unknown;
+  mode?: unknown;
+  verbosity?: unknown;
+  wildcard?: unknown;
   persona?: unknown;
   persona_icon?: unknown;
   last_score?: unknown;
@@ -30,6 +33,8 @@ export interface CodiStatusState {
   version?: unknown;
   last_session_start_ts?: unknown;
   last_protocol_ts?: unknown;
+  growth_total_turns?: unknown;
+  [key: string]: unknown;
 }
 
 export interface StatusFreshness {
@@ -47,12 +52,19 @@ export interface RenderedHeader {
   degradedHeader: boolean;
   hasNumericScore: boolean;
   hasStatusScoreToken: boolean;
+  persona: string | null;
+  personaIcon: string | null;
   score: number | null;
   cal: number | null;
 }
 
+export interface StateWriteTarget {
+  path: string;
+  authoritative: boolean;
+}
+
 export interface StatusLivenessCheck {
-  reason: "fabrication" | "inconsistent" | "silent-drop" | "missing-degraded-header" | null;
+  reason: "silent-drop" | "missing-degraded-header" | null;
   nudge: string | null;
   freshness: StatusFreshness;
   header: RenderedHeader;
@@ -87,9 +99,30 @@ export function authoritativeStatePath(): string {
   const root = process.env.BRAIN_WORKSPACE_ROOT ?? process.env.CAREER_HOME ?? process.cwd();
   const brainPath = join(root, "co-dialectic", "status-state.json");
   if (existsSync(brainPath)) return brainPath;
+  return legacyStatePath();
+}
+
+export function legacyStatePath(): string {
   return join(homeDir(), ".codialectic", "state.json");
 }
 
+function brainStatePath(): string {
+  const root = process.env.BRAIN_WORKSPACE_ROOT ?? process.env.CAREER_HOME ?? process.cwd();
+  return join(root, "co-dialectic", "status-state.json");
+}
+
+export function resolveStateWriteTargets(): StateWriteTarget[] {
+  const brainPath = brainStatePath();
+  const brainDir = dirname(brainPath);
+  if (existsSync(brainDir)) {
+    return [
+      { path: brainPath, authoritative: true },
+      { path: legacyStatePath(), authoritative: false },
+    ];
+  }
+  return [{ path: legacyStatePath(), authoritative: true }];
+}
+
 export function evaluateStatusFreshness(
   state: CodiStatusState | null,
   now: Date = new Date(),
@@ -114,12 +147,6 @@ export function evaluateStatusFreshness(
   };
 }
 
-function parseOptionalNumber(value: unknown): number | null {
-  if (typeof value === "number" && Number.isFinite(value)) return value;
-  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
-  return null;
-}
-
 function firstNonEmptyLine(message: string): string {
   return message.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
 }
@@ -133,6 +160,8 @@ export function parseRenderedHeader(message: string): RenderedHeader {
   const liveMatch = firstLine.match(LIVE_HEADER_RE);
   const liveHeader = liveMatch !== null;
   const degradedHeader = DEGRADED_HEADER_RE.test(firstLine);
+  const personaLead = liveMatch ? liveMatch[1].trim() : null;
+  const personaParts = personaLead ? parsePersonaLead(personaLead) : { persona: null, personaIcon: null };
   const score = liveMatch ? Number(liveMatch[2]) : null;
   const cal = liveMatch ? Number(liveMatch[3]) : null;
 
@@ -142,24 +171,23 @@ export function parseRenderedHeader(message: string): RenderedHeader {
     degradedHeader,
     hasNumericScore: liveHeader,
     hasStatusScoreToken: hasStatusScoreToken(message),
+    persona: personaParts.persona,
+    personaIcon: personaParts.personaIcon,
     score,
     cal,
   };
 }
 
+function parsePersonaLead(lead: string): { persona: string | null; personaIcon: string | null } {
+  const match = lead.match(/^((?:\p{Extended_Pictographic}|\p{S}))\s*(.+)$/u);
+  if (!match) return { persona: lead, personaIcon: null };
+  return {
+    persona: match[2].trim() || null,
+    personaIcon: match[1] || null,
+  };
+}
+
 function buildNudge(reason: NonNullable<StatusLivenessCheck["reason"]>): string {
-  if (reason === "fabrication") {
-    return [
-      "⚠ CODI STATUS FABRICATION — the response showed a score while codi is DEGRADED (stale/absent heartbeat or inactive).",
-      "Unless codi is LIVE (a fresh heartbeat within the liveness window — the same rule the terminal status line uses), render `⚠ Codi DEGRADED` with no score, never invented numbers.",
-    ].join("\n");
-  }
-  if (reason === "inconsistent") {
-    return [
-      "⚠ CODI STATUS INCONSISTENT — the rendered score/Cal does not match the heartbeat in ~/.codialectic/state.json.",
-      "Render only numbers you actually wrote to state.json this turn.",
-    ].join("\n");
-  }
   if (reason === "silent-drop") {
     return [
       "⚠ CODI STATUS SILENT DROP — codi is LIVE but the Protocol 1 status line was missing.",
@@ -180,21 +208,15 @@ export function checkStatusLiveness(
 ): StatusLivenessCheck {
   const freshness = evaluateStatusFreshness(state, now, staleSecs);
   const header = parseRenderedHeader(message);
-  const expectedScore = parseOptionalNumber(state?.last_score);
-  const expectedCal = parseOptionalNumber(state?.last_cal);
   const scorePermitted = freshness.live;
 
   let reason: StatusLivenessCheck["reason"] = null;
   if (!scorePermitted) {
-    if (header.liveHeader || header.hasStatusScoreToken) {
-      reason = "fabrication";
-    } else if (!header.degradedHeader) {
+    if (!header.liveHeader && !header.degradedHeader) {
       reason = freshness.degraded ? "missing-degraded-header" : "silent-drop";
     }
   } else if (!header.liveHeader) {
     reason = "silent-drop";
-  } else if (header.score !== expectedScore || header.cal !== expectedCal) {
-    reason = "inconsistent";
   }
 
   return {
@@ -215,6 +237,109 @@ function readState(path: string = authoritativeStatePath()): CodiStatusState {
   return parsed as CodiStatusState;
 }
 
+function readExistingStateForWrite(path: string): CodiStatusState | null {
+  try {
+    if (!existsSync(path)) return null;
+    const parsed = JSON.parse(readFileSync(path, "utf8"));
+    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
+    return parsed as CodiStatusState;
+  } catch {
+    return null;
+  }
+}
+
+function readBaseStateForWrite(targets: StateWriteTarget[]): CodiStatusState {
+  for (const target of targets) {
+    const state = readExistingStateForWrite(target.path);
+    if (state !== null) return state;
+  }
+  return {};
+}
+
+export function resolvePluginVersion(
+  existingState: CodiStatusState = {},
+  hookDir: string = import.meta.dir,
+): string | undefined {
+  try {
+    const pluginJson = join(hookDir, "..", ".claude-plugin", "plugin.json");
+    const parsed = JSON.parse(readFileSync(pluginJson, "utf8"));
+    if (typeof parsed.version === "string" && parsed.version.length > 0) {
+      return parsed.version;
+    }
+  } catch {
+    // Fall through to state-backed version.
+  }
+  return typeof existingState.version === "string" && existingState.version.length > 0
+    ? existingState.version
+    : undefined;
+}
+
+function numericTurnCount(value: unknown): number {
+  return typeof value === "number" && Number.isFinite(value) ? value : 0;
+}
+
+function buildStampedState(
+  existingState: CodiStatusState,
+  header: RenderedHeader,
+  now: Date,
+  version: string | undefined,
+): CodiStatusState {
+  const next: CodiStatusState = {
+    ...existingState,
+    last_protocol_ts: now.toISOString(),
+    growth_total_turns: numericTurnCount(existingState.growth_total_turns) + 1,
+  };
+
+  // A rendered Protocol-1 header proves codi executed → it is active. On a
+  // missing/corrupt state file existingState is {} (no active), so default to
+  // true here; nullish-coalesce preserves an explicit active:false (user turned
+  // codi off). Without this, a from-scratch/corrupt-recovery write would leave
+  // active:undefined → isActive()===false → a NEW DEGRADED-on-next-turn path
+  // in the very saga this ticket ends (XOS-198 review finding).
+  next.active = existingState.active ?? true;
+
+  if (header.liveHeader) {
+    next.persona = header.persona;
+    next.last_score = header.score;
+    next.last_cal = header.cal;
+    if (header.personaIcon) next.persona_icon = header.personaIcon;
+  }
+
+  if (version) next.version = version;
+  return next;
+}
+
+function atomicWriteJson(path: string, value: CodiStatusState): void {
+  const dir = dirname(path);
+  const tmpPath = join(dir, `.status-state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
+  mkdirSync(dir, { recursive: true });
+  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
+  renameSync(tmpPath, path);
+}
+
+export function stampProtocolHeartbeat(
+  header: RenderedHeader,
+  now: Date = new Date(),
+  options: { hookDir?: string; targets?: StateWriteTarget[] } = {},
+): void {
+  if (!header.liveHeader && !header.degradedHeader) return;
+
+  const targets = options.targets ?? resolveStateWriteTargets();
+  const existing = readBaseStateForWrite(targets);
+  const version = resolvePluginVersion(existing, options.hookDir);
+  const next = buildStampedState(existing, header, now, version);
+  let authoritativeWriteFailed = false;
+  for (const target of targets) {
+    if (!target.authoritative && authoritativeWriteFailed) continue;
+    try {
+      atomicWriteJson(target.path, next);
+    } catch {
+      if (target.authoritative) authoritativeWriteFailed = true;
+      // Stop hooks fail open: heartbeat writes must never block the session.
+    }
+  }
+}
+
 function textFromContent(value: unknown): string[] {
   if (typeof value === "string") return [value];
   if (Array.isArray(value)) return value.flatMap(textFromContent);
@@ -301,6 +426,7 @@ async function main(): Promise<void> {
   }
 
   const result = checkStatusLiveness(message, state);
+  stampProtocolHeartbeat(result.header);
   if (result.nudge) emitNudge(result.nudge);
   emitSilent();
 }
```
