/**
 * xos-259-hook-output-schema.test.ts
 *
 * The bug: precompact-handoff.ts emitted
 *   { hookSpecificOutput: { hookEventName: "PreCompact", additionalContext } }
 * PreCompact does not support `hookSpecificOutput`. Claude Code rejected the
 * whole object, so the reminder was never delivered to any session and every
 * compaction printed a hook failure to the user.
 *
 * Two things are under test, and the second is the one with a future:
 *   1. This hook now emits a valid shape, and the reminder is delivered from
 *      SessionStart(compact) where plain stdout reaches the model.
 *   2. NO hook in this plugin emits hookSpecificOutput for an event that does
 *      not support it. That is the class the bug belonged to; a test pinned to
 *      the single instance would let the next one through.
 *
 * Each guard is checked against a known-bad input as well as a known-good one.
 * A validator that never rejects anything passes the happy path just fine.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readdirSync } from "fs";
import { spawnSync } from "child_process";

import { buildPreCompactOutput } from "./precompact-handoff.ts";
import {
  decideDelivery,
  renderReminder,
  MAX_MARKER_AGE_MS,
  type HandoffMarker,
} from "./postcompact-handoff-reminder.ts";
import { markerPathFor, artifactDirFor } from "./handoff-paths.ts";

const HOOKS_DIR = import.meta.dir;
const PRECOMPACT = join(HOOKS_DIR, "precompact-handoff.ts");
const POSTCOMPACT = join(HOOKS_DIR, "postcompact-handoff-reminder.ts");

/**
 * Events whose output may carry `hookSpecificOutput`.
 *
 * Source of truth: the schema Claude Code echoes on a validation failure
 * (PreToolUse, UserPromptSubmit, PostToolUse, PostToolBatch, Stop,
 * SubagentStop), plus PermissionRequest and UserPromptExpansion from
 * https://code.claude.com/docs/en/hooks.
 *
 * Deliberately permissive: a false positive here would block correct code,
 * while the events that actually matter (PreCompact, SessionStart, SessionEnd,
 * Notification, TaskCompleted) are nowhere near this list.
 */
const HOOK_SPECIFIC_OUTPUT_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PermissionRequest",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "SubagentStop",
]);

const TOP_LEVEL_FIELDS = new Set([
  "continue",
  "suppressOutput",
  "stopReason",
  "decision",
  "reason",
  "systemMessage",
  "terminalSequence",
  "permissionDecision",
  "hookSpecificOutput",
]);

function validateHookOutput(obj: unknown): string[] {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return ["output is not a JSON object"];
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`unknown top-level field: ${key}`);
  }
  const hso = rec.hookSpecificOutput;
  if (hso !== undefined) {
    if (typeof hso !== "object" || hso === null) {
      errors.push("hookSpecificOutput is not an object");
    } else {
      const evt = (hso as Record<string, unknown>).hookEventName;
      if (typeof evt !== "string") {
        errors.push("hookSpecificOutput.hookEventName missing");
      } else if (!HOOK_SPECIFIC_OUTPUT_EVENTS.has(evt)) {
        errors.push(`hookSpecificOutput not supported for event: ${evt}`);
      }
    }
  }
  return errors;
}

/** The class guard: scan real source for hookSpecificOutput event literals. */
export function scanForInvalidHookEvents(dir: string): Array<{ file: string; event: string }> {
  const bad: Array<{ file: string; event: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, name), "utf8");
    // Matches both `hookEventName: "X"` (object literal) and `"hookEventName": "X"` (JSON).
    for (const m of src.matchAll(/["']?hookEventName["']?\s*[:=]\s*["']([A-Za-z]+)["']/g)) {
      const event = m[1]!;
      if (!HOOK_SPECIFIC_OUTPUT_EVENTS.has(event)) bad.push({ file: name, event });
    }
  }
  return bad;
}

function runHook(hookPath: string, payload: unknown) {
  return spawnSync("bun", ["run", hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
}

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "codi-xos259-"));
  mkdirSync(join(root, "brain"), { recursive: true });
  return root;
}

// ───────────────────────────────────────────────────────────────────────────
describe("the validator itself rejects the shape that shipped", () => {
  test("the exact old payload fails validation", () => {
    const oldPayload = {
      hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: "…" },
      systemMessage: "Co-Dialectic: PreCompact firing",
    };
    const errors = validateHookOutput(oldPayload);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("PreCompact");
  });

  test("a valid PreToolUse payload passes", () => {
    expect(
      validateHookOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "…",
        },
      })
    ).toEqual([]);
  });

  test("SessionStart is rejected too — it has no hookSpecificOutput either", () => {
    const errors = validateHookOutput({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "…" },
    });
    expect(errors.join(" ")).toContain("SessionStart");
  });

  test("an unknown top-level field is caught", () => {
    expect(validateHookOutput({ additionalContext: "top-level is not a field" })).toEqual([
      "unknown top-level field: additionalContext",
    ]);
  });
});

describe("precompact-handoff emits a valid shape", () => {
  test("built output validates and carries no hookSpecificOutput", () => {
    const out = buildPreCompactOutput({ trigger: "manual", packetWritten: true, uncommitted: 3 });
    expect(validateHookOutput(out)).toEqual([]);
    expect(out).not.toHaveProperty("hookSpecificOutput");
    expect(out.systemMessage).toContain("manual");
  });

  test("running the real hook produces parseable, valid stdout", () => {
    const ws = tempWorkspace();
    const r = runHook(PRECOMPACT, {
      hook_event_name: "PreCompact",
      trigger: "auto",
      session_id: "sess-abc",
      cwd: ws,
      workspace: ws,
      transcript_path: "/tmp/fake-transcript.jsonl",
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(validateHookOutput(parsed)).toEqual([]);
  });

  test("both artifacts land, and the marker says a handoff is owed", () => {
    const ws = tempWorkspace();
    const input = { session_id: "sess-marker", cwd: ws, workspace: ws };
    runHook(PRECOMPACT, { ...input, hook_event_name: "PreCompact", trigger: "manual" });

    const marker = JSON.parse(readFileSync(markerPathFor(input), "utf8"));
    expect(marker.handoff_pending).toBe(true);
    expect(marker.consumed_at).toBeNull();
    expect(marker.packet_file).toBeTruthy();
    expect(existsSync(marker.packet_file)).toBe(true);
  });

  test("a write failure still exits 0 — compaction is never blocked", () => {
    // Point the workspace at a path that cannot be created.
    const r = runHook(PRECOMPACT, {
      hook_event_name: "PreCompact",
      trigger: "manual",
      session_id: "sess-nowrite",
      cwd: "/dev/null/nope",
      workspace: "/dev/null/nope",
    });
    expect(r.status).toBe(0);
    expect(validateHookOutput(JSON.parse(r.stdout))).toEqual([]);
  });
});

describe("no hook in this plugin repeats the mistake", () => {
  test("the source sweep finds nothing", () => {
    expect(scanForInvalidHookEvents(HOOKS_DIR)).toEqual([]);
  });

  test("the sweep would catch it — it flags a planted violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "codi-xos259-scan-"));
    writeFileSync(
      join(dir, "bad-hook.ts"),
      `const out = { hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: "x" } };\n`
    );
    writeFileSync(
      join(dir, "good-hook.ts"),
      `const out = { hookSpecificOutput: { hookEventName: "PreToolUse" } };\n`
    );
    const found = scanForInvalidHookEvents(dir);
    expect(found).toEqual([{ file: "bad-hook.ts", event: "PreCompact" }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the reminder fires after compaction, exactly once", () => {
  const pendingMarker = (over: Partial<HandoffMarker> = {}): HandoffMarker => ({
    ts: new Date().toISOString(),
    trigger: "manual",
    packet_file: "/tmp/packet.json",
    transcript_path: "/tmp/t.jsonl",
    git_branch: "main",
    git_head_sha: "abc123",
    git_uncommitted_count: 2,
    handoff_pending: true,
    consumed_at: null,
    ...over,
  });

  test("delivers on a compaction with a fresh pending marker", () => {
    const d = decideDelivery("compact", JSON.stringify(pendingMarker()), new Date());
    expect(d.deliver).toBe(true);
  });

  test("stays silent on normal startup — the matcher is not the only guard", () => {
    const d = decideDelivery("startup", JSON.stringify(pendingMarker()), new Date());
    expect(d).toEqual({ deliver: false, reason: "not-a-compaction" });
  });

  test("stays silent once consumed", () => {
    const d = decideDelivery(
      "compact",
      JSON.stringify(pendingMarker({ handoff_pending: false })),
      new Date()
    );
    expect(d).toEqual({ deliver: false, reason: "already-consumed" });
  });

  test("a pre-XOS-259 marker (no handoff_pending) is treated as consumed", () => {
    const legacy = { ts: new Date().toISOString(), trigger: "manual", schema_version: "1.1.0" };
    const d = decideDelivery("compact", JSON.stringify(legacy), new Date());
    expect(d).toEqual({ deliver: false, reason: "already-consumed" });
  });

  test("a stale marker does not resurrect an old handoff", () => {
    const old = pendingMarker({
      ts: new Date(Date.now() - MAX_MARKER_AGE_MS - 60_000).toISOString(),
    });
    const d = decideDelivery("compact", JSON.stringify(old), new Date());
    expect(d).toEqual({ deliver: false, reason: "stale-marker" });
  });

  test("just inside the freshness window still delivers", () => {
    const recent = pendingMarker({
      ts: new Date(Date.now() - MAX_MARKER_AGE_MS + 60_000).toISOString(),
    });
    expect(decideDelivery("compact", JSON.stringify(recent), new Date()).deliver).toBe(true);
  });

  test("missing and corrupt markers are distinguished, and neither delivers", () => {
    expect(decideDelivery("compact", null, new Date())).toEqual({
      deliver: false,
      reason: "no-marker",
    });
    expect(decideDelivery("compact", "{not json", new Date())).toEqual({
      deliver: false,
      reason: "unparseable-marker",
    });
  });

  test("the reminder names the skill and points at the packet", () => {
    const text = renderReminder(pendingMarker());
    expect(text).toContain("codi-handoff");
    expect(text).toContain("/tmp/packet.json");
    expect(text).toContain("/tmp/t.jsonl");
    expect(text).toContain("branch=main");
  });

  test("an unfinished prior handoff is called out", () => {
    expect(renderReminder(pendingMarker({ has_uncommitted_handoff_doc: true }))).toContain(
      "left unfinished"
    );
    expect(renderReminder(pendingMarker({ has_uncommitted_handoff_doc: false }))).not.toContain(
      "left unfinished"
    );
  });
});

describe("end to end: compact, then start", () => {
  test("the reminder is delivered as plain text, then not again", () => {
    const ws = tempWorkspace();
    const input = { session_id: "sess-e2e", cwd: ws, workspace: ws };

    runHook(PRECOMPACT, { ...input, hook_event_name: "PreCompact", trigger: "manual" });

    const first = runHook(POSTCOMPACT, {
      ...input,
      hook_event_name: "SessionStart",
      source: "compact",
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("POST-COMPACT HANDOFF REMINDER");
    expect(first.stdout).toContain("codi-handoff");

    // SessionStart delivers PLAIN stdout to the model. If this were JSON, the
    // model would be handed punctuation instead of instructions.
    expect(() => JSON.parse(first.stdout)).toThrow();

    const second = runHook(POSTCOMPACT, {
      ...input,
      hook_event_name: "SessionStart",
      source: "compact",
    });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe("");

    const marker = JSON.parse(readFileSync(markerPathFor(input), "utf8"));
    expect(marker.handoff_pending).toBe(false);
    expect(marker.consumed_at).toBeTruthy();
  });

  test("a resume after compaction says nothing", () => {
    const ws = tempWorkspace();
    const input = { session_id: "sess-resume", cwd: ws, workspace: ws };
    runHook(PRECOMPACT, { ...input, hook_event_name: "PreCompact", trigger: "auto" });

    const r = runHook(POSTCOMPACT, {
      ...input,
      hook_event_name: "SessionStart",
      source: "resume",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    // and the handoff is still owed for the real compaction start
    expect(JSON.parse(readFileSync(markerPathFor(input), "utf8")).handoff_pending).toBe(true);
  });

  test("no marker at all is silent, not an error", () => {
    const ws = tempWorkspace();
    const r = runHook(POSTCOMPACT, {
      hook_event_name: "SessionStart",
      source: "compact",
      session_id: "sess-none",
      cwd: ws,
      workspace: ws,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("writer and reader agree on the path by construction", () => {
    // The whole point of handoff-paths.ts. If these ever diverge the handoff
    // fails silently: the write succeeds, the read finds nothing, no error.
    const ws = tempWorkspace();
    const input = { session_id: "weird/id with spaces", cwd: ws, workspace: ws };
    runHook(PRECOMPACT, { ...input, hook_event_name: "PreCompact", trigger: "manual" });

    expect(existsSync(markerPathFor(input))).toBe(true);
    expect(markerPathFor(input).startsWith(artifactDirFor(input))).toBe(true);
    // the session id is sanitized, not passed through into a path
    expect(artifactDirFor(input)).not.toContain("weird/id");
  });
});
