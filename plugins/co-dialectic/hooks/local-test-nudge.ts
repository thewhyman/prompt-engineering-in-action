#!/usr/bin/env bun
/**
 * local-test-nudge.ts — Co-Dialectic v4.32.0 Stop hook harness.
 *
 * Detects the false-blocker / skipped-verification pattern where the final
 * assistant message says local testing is impossible because auth/access/env is
 * unavailable, but this turn has no local-test evidence. Blocks once with
 * agent-facing feedback, then lets the follow-up Stop pass via stop_hook_active.
 */

import { statSync, openSync, readSync, closeSync } from "fs";

interface HookInput {
  transcript_path?: string;
  stop_hook_active?: boolean;
}

const NUDGE =
  "🫶 Local verification check: you signaled you can't test or verify locally — but the credentials you need are usually already in the project's env/config files; check those before assuming you lack access. Skipping local testing rarely saves time — it ships bugs that surface later and cost rework. A real local test (run it, hit the route, and paste the output) is the fastest path to work that lands right the first time. Check your env/config, run it locally, and show the result.";

const UNAMBIGUOUS_SIGNAL_PHRASES = [
  "can't test locally",
  "cannot test locally",
  "can't verify locally",
  "unable to verify locally",
  "skip the local test",
  "couldn't test",
  "without local testing",
];

const AMBIGUOUS_SIGNAL_PHRASES = [
  "no auth",
  "don't have credentials",
  "do not have credentials",
  "no access to",
  "you'll need to run",
  "you will need to run",
  "i don't have the env",
];

const TESTING_CONTEXT_PATTERN =
  /\b(?:tests?|testing|tested|verify|verifies|verified|verification|run|running|ran|local|locally|checks?|checking|checked|reproduce|reproduced|dev server|endpoint|route)\b/i;

const TOOL_COMMAND_EVIDENCE_PATTERNS = [
  /\bbun\s+test\b/i,
  /\bbun\s+(?:run\s+)?dev\b/i,
  /\bnpm\s+test\b/i,
  /\bnpm\s+run\b/i,
  /\byarn\s+/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bplaywright\b/i,
  /\bcurl\s+/i,
  /\bpytest\b/i,
  /\bnext\s+dev\b/i,
  /\bvite\b/i,
  /\bgh\s+pr\s+checks\b/i,
];

function normalized(message: string): string {
  return message
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

function sentenceBounds(text: string, index: number): [number, number] {
  const before = text.slice(0, index);
  const after = text.slice(index);
  const previousBoundary = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
  );
  const nextCandidates = [after.indexOf("."), after.indexOf("!"), after.indexOf("?"), after.indexOf("\n")]
    .filter((candidate) => candidate >= 0);
  const nextBoundary = nextCandidates.length > 0 ? index + Math.min(...nextCandidates) : text.length;
  return [previousBoundary >= 0 ? previousBoundary + 1 : 0, nextBoundary];
}

function hasTestingContextNearPhrase(lower: string, phrase: string, index: number): boolean {
  const [sentenceStart, sentenceEnd] = sentenceBounds(lower, index);
  const windowStart = Math.max(0, index - 80);
  const windowEnd = Math.min(lower.length, index + phrase.length + 80);
  const context = `${lower.slice(sentenceStart, sentenceEnd)}\n${lower.slice(windowStart, windowEnd)}`;

  if (!TESTING_CONTEXT_PATTERN.test(context)) return false;

  // Do not let the "run" inside "you'll need to run" satisfy its own
  // testing-context requirement; otherwise migration handoff prose false-fires.
  if (phrase.includes("need to run")) {
    const withoutPhrase = context.replaceAll(phrase, "");
    return TESTING_CONTEXT_PATTERN.test(withoutPhrase);
  }

  return true;
}

export function hasSkippedVerificationSignal(message: string): boolean {
  const lower = normalized(message);
  if (UNAMBIGUOUS_SIGNAL_PHRASES.some((phrase) => lower.includes(phrase))) return true;

  if (/\b(?:i\s+)?(?:don't|do not)\s+have\s+auth\b/.test(lower)) {
    const match = lower.match(/\b(?:i\s+)?(?:don't|do not)\s+have\s+auth\b/);
    return match?.index !== undefined && hasTestingContextNearPhrase(lower, match[0], match.index);
  }

  for (const phrase of AMBIGUOUS_SIGNAL_PHRASES) {
    let index = lower.indexOf(phrase);
    while (index >= 0) {
      if (hasTestingContextNearPhrase(lower, phrase, index)) return true;
      index = lower.indexOf(phrase, index + phrase.length);
    }
  }

  return false;
}

export function shouldNudge(message: string, hasToolEvidence = false): boolean {
  // Evidence must be a REAL this-turn tool run (hasToolEvidence). Prose tokens —
  // typing "localhost"/"curl"/"bun test" in the message — are NOT accepted: a
  // claim is not a test, and accepting prose was the exact gaming hole this gate
  // exists to close (an agent could silence the block by typing "localhost").
  return hasSkippedVerificationSignal(message) && !hasToolEvidence;
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

function recordContent(record: Record<string, unknown>): unknown {
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : null;
  return message?.content ?? record.content ?? record.text;
}

function contentHasToolResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(contentHasToolResult);

  const record = value as Record<string, unknown>;
  return record.type === "tool_result" ||
    record.role === "tool_result" ||
    typeof record.tool_use_id === "string" ||
    contentHasToolResult(record.content);
}

function isHumanUserRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const obj = record as Record<string, unknown>;
  const message = obj.message && typeof obj.message === "object"
    ? obj.message as Record<string, unknown>
    : null;
  const role = obj.role ?? message?.role;
  const type = obj.type;
  const isUser = role === "user" || type === "user";
  if (!isUser) return false;

  const content = recordContent(obj);
  return !contentHasToolResult(content);
}

function toolNameFromRecord(record: Record<string, unknown>): string | null {
  const raw = record.name ?? record.tool_name ?? record.toolName ?? record.tool;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function isToolUseRecord(record: Record<string, unknown>): boolean {
  return record.type === "tool_use" ||
    record.role === "tool_use";
}

function isBashFamilyTool(name: string): boolean {
  return /\b(?:bash|shell|terminal|exec_command|run_command)\b/i.test(name);
}

function commandStringsFromToolUse(record: Record<string, unknown>): string[] {
  const candidates = [
    record.command,
    record.cmd,
    record.input,
    record.arguments,
    record.args,
    record.parameters,
    record.tool_input,
  ];

  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          visit(parsed);
          return;
        }
      } catch {
        // A plain string input can be the command for Bash-family tools.
      }
      commands.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const obj = value as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const command = obj[key];
      if (typeof command === "string" && command.trim().length > 0) {
        commands.push(command.trim());
      }
    }
  };

  for (const candidate of candidates) visit(candidate);
  return commands;
}

function toolUseBlocksFromValue(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(toolUseBlocksFromValue);

  const record = value as Record<string, unknown>;
  const found: Record<string, unknown>[] = [];
  if (isToolUseRecord(record)) found.push(record);

  for (const child of [record.content, record.message]) {
    found.push(...toolUseBlocksFromValue(child));
  }
  return found;
}

function hasMatchingToolCommand(record: unknown): boolean {
  for (const toolUse of toolUseBlocksFromValue(record)) {
    const name = toolNameFromRecord(toolUse);
    if (!name || !isBashFamilyTool(name)) continue;

    const commands = commandStringsFromToolUse(toolUse);
    if (commands.some((command) => TOOL_COMMAND_EVIDENCE_PATTERNS.some((pattern) => pattern.test(command)))) {
      return true;
    }
  }
  return false;
}

interface TranscriptAnalysis {
  finalAssistantMessage: string | null;
  hasThisTurnToolEvidence: boolean;
}

function parseTranscriptRecords(transcript: string, failOnParseError = false): unknown[] {
  const records: unknown[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      if (failOnParseError) throw new Error("malformed transcript record");
      continue; // skip malformed / partial-tail lines — never abort
    }
  }
  return records;
}

export function finalAssistantMessageFromTranscript(transcript: string): string | null {
  return analyzeTranscript(transcript).finalAssistantMessage;
}

export function analyzeTranscript(transcript: string, failOnParseError = false): TranscriptAnalysis {
  const records = parseTranscriptRecords(transcript, failOnParseError);
  let finalAssistantMessage: string | null = null;
  let lastHumanUserIndex = -1;

  records.forEach((record, index) => {
    if (isHumanUserRecord(record)) lastHumanUserIndex = index;
    const text = assistantTextFromRecord(record);
    if (text) finalAssistantMessage = text;
  });

  const thisTurnRecords = lastHumanUserIndex >= 0 ? records.slice(lastHumanUserIndex + 1) : records;
  return {
    finalAssistantMessage,
    hasThisTurnToolEvidence: thisTurnRecords.some(hasMatchingToolCommand),
  };
}

function readTranscriptTail(input: HookInput): string {
  if (typeof input.transcript_path !== "string" || input.transcript_path.trim().length === 0) {
    throw new Error("missing transcript path");
  }
  // Read only the tail of the transcript (the final assistant message is at the
  // end) so a huge transcript can never OOM the hook. A partial first line from
  // the cut is tolerated — the per-line parse skips unparseable lines.
  const path = input.transcript_path;
  const MAX_TAIL_BYTES = 512 * 1024;
  const size = statSync(path).size;
  const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
  const length = size - start;
  const fd = openSync(path, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(length);
    if (length > 0) readSync(fd, buf, 0, length, start);
    raw = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  if (start > 0) {
    const firstNewline = raw.indexOf("\n");
    raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
  }
  return raw;
}

function emitSilent(): never {
  process.exit(0);
}

function emitBlock(reason: string): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
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

  if (input.stop_hook_active === true) emitSilent();

  let analysis: TranscriptAnalysis;
  try {
    analysis = analyzeTranscript(readTranscriptTail(input), true);
  } catch {
    emitSilent();
  }

  if (
    analysis.finalAssistantMessage &&
    shouldNudge(analysis.finalAssistantMessage, analysis.hasThisTurnToolEvidence)
  ) {
    emitBlock(NUDGE);
  }
  emitSilent();
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0);
  });
}
