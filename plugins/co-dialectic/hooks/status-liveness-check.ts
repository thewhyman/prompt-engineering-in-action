#!/usr/bin/env bun
/**
 * status-liveness-check.ts — Co-Dialectic v4.27.0 Stop hook harness.
 *
 * Verifies the model-authored in-message Protocol 1 status header against the
 * hook-owned liveness rule used by hooks/statusline.sh. Surfaces a loud nudge
 * via Stop-hook systemMessage, but never blocks or crashes the session.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  evaluateSharedLiveness,
  staleSecsFromEnv,
  stringOr,
} from "./liveness.ts";

interface HookInput {
  transcript_path?: string;
}

export interface CodiStatusState {
  active?: unknown;
  persona?: unknown;
  persona_icon?: unknown;
  last_score?: unknown;
  last_cal?: unknown;
  installed_version?: unknown;
  version?: unknown;
  last_session_start_ts?: unknown;
  last_protocol_ts?: unknown;
}

export interface StatusFreshness {
  live: boolean;
  degraded: boolean;
  stale: boolean;
  skew: boolean;
  inactive: boolean;
  installedVersion: string;
}

export interface RenderedHeader {
  firstLine: string;
  liveHeader: boolean;
  degradedHeader: boolean;
  hasNumericScore: boolean;
  hasStatusScoreToken: boolean;
  score: number | null;
  cal: number | null;
}

export interface StatusLivenessCheck {
  reason: "fabrication" | "inconsistent" | "silent-drop" | "missing-degraded-header" | null;
  nudge: string | null;
  freshness: StatusFreshness;
  header: RenderedHeader;
  scorePermitted: boolean;
}

const HEADER_TIME_PATTERN = String.raw`(?:\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2})`;
const OPTIONAL_HEADER_TIME_PATTERN = String.raw`(?: · \[${HEADER_TIME_PATTERN}\])?`;
const ICON_PERSONA_LEAD_PATTERN = String.raw`(?=[^\x00-\x7F])(?:\p{Extended_Pictographic}|\p{S})[^·%\n]{0,119}`;
const DOMAIN_NAME_PERSONA_LEAD_PATTERN = String.raw`[\p{L}\p{M}][\p{L}\p{M}\p{N}'&/ -]{0,80} \([^)·%\n]{1,80}\)`;
const PERSONA_LEAD_PATTERN = String.raw`(?:${ICON_PERSONA_LEAD_PATTERN}|${DOMAIN_NAME_PERSONA_LEAD_PATTERN})`;
const LIVE_HEADER_RE = new RegExp(
  String.raw`^(${PERSONA_LEAD_PATTERN}) · (\d{1,3})% · Cal: (\d{1,3})%${OPTIONAL_HEADER_TIME_PATTERN}$`,
  "u",
);
const DEGRADED_HEADER_RE = new RegExp(
  String.raw`^⚠ Codi DEGRADED${OPTIONAL_HEADER_TIME_PATTERN}$`,
  "u",
);
const STATUS_SCORE_TOKEN_RE = new RegExp(
  String.raw`(?:^|\n)\s*\d{1,3}% · (?:Cal:(?: \d{1,3}%)?|\[${HEADER_TIME_PATTERN}\])|· \d{1,3}% · (?:Cal:(?: \d{1,3}%)?|\[${HEADER_TIME_PATTERN}\])`,
  "u",
);

function homeDir(): string {
  return process.env.HOME?.trim() || homedir();
}

export function authoritativeStatePath(): string {
  // Keep this resolution identical to statusline.sh and user-prompt-submit.ts:
  // brain-kernel workspace first, then legacy machine-local state.
  const root = process.env.BRAIN_WORKSPACE_ROOT ?? process.env.CAREER_HOME ?? process.cwd();
  const brainPath = join(root, "co-dialectic", "status-state.json");
  if (existsSync(brainPath)) return brainPath;
  return join(homeDir(), ".codialectic", "state.json");
}

export function evaluateStatusFreshness(
  state: CodiStatusState | null,
  now: Date = new Date(),
  staleSecs: number = staleSecsFromEnv(),
): StatusFreshness {
  const installedVersion = stringOr(state?.installed_version, "unknown");
  const liveness = evaluateSharedLiveness(
    state,
    installedVersion,
    now,
    staleSecs,
    "boolean-or-string",
  );

  return {
    live: liveness.live,
    degraded: liveness.degraded,
    stale: liveness.stale,
    skew: liveness.skew,
    inactive: liveness.inactive,
    installedVersion,
  };
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function firstNonEmptyLine(message: string): string {
  return message.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function hasStatusScoreToken(message: string): boolean {
  return STATUS_SCORE_TOKEN_RE.test(message);
}

export function parseRenderedHeader(message: string): RenderedHeader {
  const firstLine = firstNonEmptyLine(message);
  const liveMatch = firstLine.match(LIVE_HEADER_RE);
  const liveHeader = liveMatch !== null;
  const degradedHeader = DEGRADED_HEADER_RE.test(firstLine);
  const score = liveMatch ? Number(liveMatch[2]) : null;
  const cal = liveMatch ? Number(liveMatch[3]) : null;

  return {
    firstLine,
    liveHeader,
    degradedHeader,
    hasNumericScore: liveHeader,
    hasStatusScoreToken: hasStatusScoreToken(message),
    score,
    cal,
  };
}

function buildNudge(reason: NonNullable<StatusLivenessCheck["reason"]>): string {
  if (reason === "fabrication") {
    return [
      "⚠ CODI STATUS FABRICATION — the response showed a score while codi is DEGRADED (stale/absent heartbeat or inactive).",
      "Unless codi is LIVE (a fresh heartbeat within the liveness window — the same rule the terminal status line uses), render `⚠ Codi DEGRADED` with no score, never invented numbers.",
    ].join("\n");
  }
  if (reason === "inconsistent") {
    return [
      "⚠ CODI STATUS INCONSISTENT — the rendered score/Cal does not match the heartbeat in ~/.codialectic/state.json.",
      "Render only numbers you actually wrote to state.json this turn.",
    ].join("\n");
  }
  if (reason === "silent-drop") {
    return [
      "⚠ CODI STATUS SILENT DROP — codi is LIVE but the Protocol 1 status line was missing.",
      "Always render `{icon} {Persona} · X% · Cal: Y% · [HH:MM]` when the heartbeat is fresh.",
    ].join("\n");
  }
  return [
    "⚠ CODI STATUS SILENT DROP — codi is DEGRADED but the required degraded header was missing.",
    "Render `⚠ Codi DEGRADED · [HH:MM]` with no score numbers.",
  ].join("\n");
}

export function checkStatusLiveness(
  message: string,
  state: CodiStatusState | null,
  now: Date = new Date(),
  staleSecs: number = staleSecsFromEnv(),
): StatusLivenessCheck {
  const freshness = evaluateStatusFreshness(state, now, staleSecs);
  const header = parseRenderedHeader(message);
  const expectedScore = parseOptionalNumber(state?.last_score);
  const expectedCal = parseOptionalNumber(state?.last_cal);
  const scorePermitted = freshness.live;

  let reason: StatusLivenessCheck["reason"] = null;
  if (!scorePermitted) {
    if (header.liveHeader || header.hasStatusScoreToken) {
      reason = "fabrication";
    } else if (!header.degradedHeader) {
      reason = freshness.degraded ? "missing-degraded-header" : "silent-drop";
    }
  } else if (!header.liveHeader) {
    reason = "silent-drop";
  } else if (header.score !== expectedScore || header.cal !== expectedCal) {
    reason = "inconsistent";
  }

  return {
    reason,
    nudge: reason ? buildNudge(reason) : null,
    freshness,
    header,
    scorePermitted,
  };
}

function readState(path: string = authoritativeStatePath()): CodiStatusState {
  if (!existsSync(path)) throw new Error("state missing");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("state is not an object");
  }
  return parsed as CodiStatusState;
}

function textFromContent(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textFromContent);
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.text === "string") parts.push(record.text);
  if (record.content !== undefined) parts.push(...textFromContent(record.content));
  if (record.message !== undefined) parts.push(...textFromContent(record.message));
  return parts;
}

function assistantTextFromRecord(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const obj = record as Record<string, unknown>;
  const message = obj.message && typeof obj.message === "object"
    ? obj.message as Record<string, unknown>
    : null;
  const role = obj.role ?? message?.role;
  const type = obj.type;
  const isAssistant = role === "assistant" || type === "assistant";
  if (!isAssistant) return null;

  const content = message?.content ?? obj.content ?? obj.text;
  const text = textFromContent(content).join("\n").trim();
  return text.length > 0 ? text : null;
}

export function finalAssistantMessageFromTranscript(transcript: string): string | null {
  let finalMessage: string | null = null;
  for (const line of transcript.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const text = assistantTextFromRecord(JSON.parse(trimmed));
    if (text) finalMessage = text;
  }
  return finalMessage;
}

function readFinalAssistantMessage(input: HookInput): string {
  if (typeof input.transcript_path !== "string" || input.transcript_path.trim().length === 0) {
    throw new Error("missing transcript path");
  }
  const raw = readFileSync(input.transcript_path, "utf8");
  const message = finalAssistantMessageFromTranscript(raw);
  if (message === null) throw new Error("missing final assistant message");
  return message;
}

function emitSilent(): never {
  process.exit(0);
}

function emitNudge(nudge: string): never {
  process.stdout.write(JSON.stringify({ systemMessage: nudge }) + "\n");
  process.exit(0);
}

async function main(): Promise<void> {
  let input: HookInput = {};
  try {
    const raw = (await Bun.stdin.text()).trim();
    if (!raw) emitSilent();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) emitSilent();
    input = parsed as HookInput;
  } catch {
    emitSilent();
  }

  let message = "";
  try {
    message = readFinalAssistantMessage(input);
  } catch {
    emitSilent();
  }

  let state: CodiStatusState | null = null;
  try {
    state = readState();
  } catch {
    state = null;
  }

  const result = checkStatusLiveness(message, state);
  if (result.nudge) emitNudge(result.nudge);
  emitSilent();
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0);
  });
}
