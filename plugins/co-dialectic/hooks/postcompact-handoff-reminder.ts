#!/usr/bin/env bun
/**
 * postcompact-handoff-reminder.ts — deliver the handoff reminder AFTER
 * compaction, which is the only point where it can still be acted on.
 *
 * XOS-259. Its predecessor tried to inject this text from the PreCompact hook.
 * That failed twice over: PreCompact has no `additionalContext` field (the
 * payload was rejected wholesale), and context injected there lands in the
 * conversation being summarized away.
 *
 * SessionStart is the documented channel:
 *
 *   "The exceptions are UserPromptSubmit, UserPromptExpansion, and
 *    SessionStart, where Claude Code adds plain-text stdout as context that
 *    Claude can see and act on."
 *   — https://code.claude.com/docs/en/hooks
 *
 * So this hook writes PLAIN TEXT to stdout. Not JSON. Emitting a JSON object
 * here would be delivered to the model verbatim as literal JSON — technically
 * "working", but the model would read punctuation instead of instructions.
 *
 * Wiring: SessionStart with matcher "compact". The `source === "compact"` check
 * below is deliberate redundancy — if a future edit drops the matcher, this hook
 * still refuses to nag on every startup and resume.
 *
 * Fail-safe: ALWAYS exit 0, ALWAYS silent on error. A session must never fail
 * to start because a reminder could not be rendered.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { markerPathFor, type HandoffPathInput } from "./handoff-paths.ts";

/** A marker older than this is a leftover, not a live handoff. */
export const MAX_MARKER_AGE_MS = 6 * 60 * 60 * 1000;

interface SessionStartInput extends HandoffPathInput {
  hook_event_name?: string;
  source?: string;
}

export interface HandoffMarker {
  ts?: string;
  trigger?: string;
  transcript_path?: string | null;
  packet_file?: string | null;
  git_branch?: string | null;
  git_head_sha?: string | null;
  git_uncommitted_count?: number;
  has_uncommitted_handoff_doc?: boolean;
  handoff_pending?: boolean;
  consumed_at?: string | null;
}

export type SkipReason =
  | "not-a-compaction"
  | "no-marker"
  | "unparseable-marker"
  | "already-consumed"
  | "stale-marker";

export type ReminderDecision =
  | { deliver: true; marker: HandoffMarker }
  | { deliver: false; reason: SkipReason };

/**
 * Pure decision, so the conditions are testable without a filesystem or a
 * clock. `now` is injected for the same reason.
 */
export function decideDelivery(
  source: string | undefined,
  rawMarker: string | null,
  now: Date
): ReminderDecision {
  if (source !== "compact") return { deliver: false, reason: "not-a-compaction" };
  if (rawMarker === null) return { deliver: false, reason: "no-marker" };

  let marker: HandoffMarker;
  try {
    marker = JSON.parse(rawMarker);
  } catch {
    return { deliver: false, reason: "unparseable-marker" };
  }

  // Absent `handoff_pending` means a marker written by a pre-XOS-259 hook.
  // Treat it as consumed: those sessions are long over, and re-nagging about a
  // compaction that happened weeks ago is worse than staying quiet.
  if (marker.handoff_pending !== true) return { deliver: false, reason: "already-consumed" };

  const written = marker.ts ? Date.parse(marker.ts) : NaN;
  if (Number.isNaN(written)) return { deliver: false, reason: "unparseable-marker" };
  if (now.getTime() - written > MAX_MARKER_AGE_MS) {
    return { deliver: false, reason: "stale-marker" };
  }

  return { deliver: true, marker };
}

/**
 * The reminder text. Rendered here, at consumption time, rather than stored by
 * the writer — so the framing is post-compaction ("the summary above is lossy")
 * instead of the pre-compaction framing the old hook used.
 */
export function renderReminder(marker: HandoffMarker): string {
  const lines: string[] = [
    "━━━ POST-COMPACT HANDOFF REMINDER (Co-Dialectic) ━━━",
    `This session was just compacted (trigger=${marker.trigger ?? "unknown"}, at=${marker.ts ?? "unknown"}).`,
    "The summary you are working from is lossy by construction. Before the next",
    "user turn, capture the handoff while the summary is still fresh.",
    "",
    "REQUIRED ACTION:",
    "  1. Invoke the codi-handoff skill (Protocol 9 — auto closure detection).",
    "  2. Let it run its phases: scan unfinished items, decisions, lessons,",
    "     codify open follow-ups with crisp triggers, emit structured packet.",
    "  3. The workspace adapter persists to NEXT_SESSION_HANDOFF.md or the",
    "     configured substrate. Codi knows nothing about the substrate — it",
    "     captures and emits.",
    "",
    "DO NOT write the handoff manually via Edit/Write — the skill owns the",
    "structured-packet schema and the workspace dispatch. Manual writes lose the",
    "structure and diverge from the Protocol 9 spec.",
  ];

  if (marker.packet_file) {
    lines.push(
      "",
      "A deterministic packet was captured before compaction — read it for the",
      "git state and in-flight work the summary may have dropped:",
      `  ${marker.packet_file}`
    );
  }
  if (marker.transcript_path) {
    lines.push(`Full pre-compaction transcript: ${marker.transcript_path}`);
  }

  lines.push(
    "",
    `Git state at capture: branch=${marker.git_branch ?? "n/a"}, ` +
      `uncommitted=${marker.git_uncommitted_count ?? 0}, ` +
      `HEAD=${marker.git_head_sha ?? "n/a"}.`
  );
  if (marker.has_uncommitted_handoff_doc) {
    lines.push(
      "⚠ A handoff doc was uncommitted at capture time — an earlier handoff may",
      "  have been started and left unfinished. Check the diff before rewriting."
    );
  }
  lines.push("━━━ END POST-COMPACT REMINDER ━━━");

  return lines.join("\n");
}

async function main(): Promise<void> {
  let input: SessionStartInput = {};
  try {
    const raw = await Bun.stdin.text();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    return; // Malformed stdin — stay silent, never block session start
  }

  const markerFile = markerPathFor(input);
  let rawMarker: string | null = null;
  try {
    if (existsSync(markerFile)) rawMarker = readFileSync(markerFile, "utf8");
  } catch {
    return;
  }

  const decision = decideDelivery(input.source, rawMarker, new Date());
  if (!decision.deliver) return;

  process.stdout.write(renderReminder(decision.marker) + "\n");

  // Consume it. Deliver-once matters: SessionStart(compact) fires again on the
  // next compaction, and an un-consumed marker would replay a stale reminder
  // pointing at the wrong packet.
  try {
    writeFileSync(
      markerFile,
      JSON.stringify(
        { ...decision.marker, handoff_pending: false, consumed_at: new Date().toISOString() },
        null,
        2
      )
    );
  } catch (e) {
    process.stderr.write(`postcompact-handoff-reminder: consume failed: ${e}\n`);
  }
}

if (import.meta.main) {
  main()
    .catch((err) => {
      process.stderr.write(`postcompact-handoff-reminder error: ${err}\n`);
    })
    .finally(() => process.exit(0));
}
