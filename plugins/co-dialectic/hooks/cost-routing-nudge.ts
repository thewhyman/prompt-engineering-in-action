#!/usr/bin/env bun
/**
 * cost-routing-nudge.ts — Co-Dialectic v4.34.0 Stop hook harness.
 *
 * Detects fish-work done directly by whale models in the current turn, records
 * a per-session nudge for the next UserPromptSubmit, and optionally surfaces a
 * human-visible Stop systemMessage. It never blocks.
 */

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, extname, join } from "path";

export interface HookInput {
  transcript_path?: string;
  session_id?: string;
  sessionId?: string;
  stop_hook_active?: boolean;
}

export interface CostNudgeRecord {
  schema_version: "1.0.0";
  session_id: string;
  fire_count: number;
  pending: boolean;
  nudge: string | null;
  last_fire_at: string | null;
  last_trigger: "code-volume" | "browser-driving" | null;
  last_authored_code_lines: number;
  last_browser_calls: number;
  last_dom_dump_calls: number;
  consumed_at?: string | null;
}

export interface TranscriptAnalysis {
  authoredCodeLines: number;
  largestWriteLines: number;
  browserCalls: number;
  domDumpCalls: number;
  hasDelegationEvidence: boolean;
  models: string[];
  hasWhaleModel: boolean;
  trigger: "code-volume" | "browser-driving" | null;
}

const MAX_TAIL_BYTES = 512 * 1024;
const MAX_FIRES_PER_SESSION = 3;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_WHALE_MODELS = "opus|fable";

const CODE_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".clj",
  ".cljs",
  ".cpp",
  ".cs",
  ".css",
  ".cxx",
  ".dart",
  ".erl",
  ".ex",
  ".exs",
  ".fs",
  ".fsx",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".hrl",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".mjs",
  ".mm",
  ".php",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".zsh",
]);

const DOM_DUMP_NAMES = [
  "take_snapshot",
  "read_page",
  "get_page_text",
  "browser_snapshot",
  "take_heapsnapshot",
];

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeSessionId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "");
  if (sanitized.length > 0 && sanitized.length <= 96) return sanitized;
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `session-${digest}`;
}

export function sessionIdFromInput(input: HookInput): string | null {
  return safeSessionId(input.session_id ?? input.sessionId);
}

function codiStateDir(): string {
  return (
    process.env.CODI_STATE_DIR?.trim() ||
    process.env.CLAUDE_PLUGIN_DATA?.trim() ||
    join(process.env.HOME || homedir(), ".codialectic")
  );
}

export function costNudgeDir(): string {
  return join(codiStateDir(), "cost-nudge");
}

export function costNudgePath(sessionId: string): string {
  return join(costNudgeDir(), `${sessionId}.json`);
}

export function gcCostNudgeState(nowMs = Date.now()): void {
  const dir = costNudgeDir();
  try {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (nowMs - stat.mtimeMs > STATE_TTL_MS) unlinkSync(path);
    }
  } catch {
    // Fail-open: stale state cleanup is opportunistic only.
  }
}

function emptyRecord(sessionId: string): CostNudgeRecord {
  return {
    schema_version: "1.0.0",
    session_id: sessionId,
    fire_count: 0,
    pending: false,
    nudge: null,
    last_fire_at: null,
    last_trigger: null,
    last_authored_code_lines: 0,
    last_browser_calls: 0,
    last_dom_dump_calls: 0,
    consumed_at: null,
  };
}

function readCostNudgeRecord(sessionId: string): CostNudgeRecord {
  const path = costNudgePath(sessionId);
  if (!existsSync(path)) return emptyRecord(sessionId);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid cost nudge record");
  }
  const record = parsed as Partial<CostNudgeRecord>;
  return {
    ...emptyRecord(sessionId),
    ...record,
    schema_version: "1.0.0",
    session_id: sessionId,
    fire_count: Number.isFinite(record.fire_count) ? Number(record.fire_count) : 0,
    pending: record.pending === true,
    nudge: typeof record.nudge === "string" ? record.nudge : null,
    last_fire_at: typeof record.last_fire_at === "string" ? record.last_fire_at : null,
    last_trigger: record.last_trigger === "code-volume" || record.last_trigger === "browser-driving"
      ? record.last_trigger
      : null,
    last_authored_code_lines: Number.isFinite(record.last_authored_code_lines)
      ? Number(record.last_authored_code_lines)
      : 0,
    last_browser_calls: Number.isFinite(record.last_browser_calls) ? Number(record.last_browser_calls) : 0,
    last_dom_dump_calls: Number.isFinite(record.last_dom_dump_calls) ? Number(record.last_dom_dump_calls) : 0,
  };
}

function writeCostNudgeRecord(record: CostNudgeRecord): void {
  const path = costNudgePath(record.session_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}

export function consumeCostNudgeForSession(sessionId: string): string | null {
  try {
    gcCostNudgeState();
    const record = readCostNudgeRecord(sessionId);
    if (record.pending !== true || typeof record.nudge !== "string" || record.nudge.length === 0) {
      return null;
    }

    const lastFireMs = record.last_fire_at ? Date.parse(record.last_fire_at) : NaN;
    if (!Number.isFinite(lastFireMs) || Date.now() - lastFireMs > STATE_TTL_MS) return null;

    const nudge = record.nudge;
    writeCostNudgeRecord({
      ...record,
      pending: false,
      nudge: null,
      consumed_at: nowIso(),
    });
    return nudge;
  } catch {
    return null;
  }
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
  return !contentHasToolResult(recordContent(obj));
}

function isAssistantRecord(record: unknown): record is Record<string, unknown> {
  if (!record || typeof record !== "object") return false;
  const obj = record as Record<string, unknown>;
  const message = obj.message && typeof obj.message === "object"
    ? obj.message as Record<string, unknown>
    : null;
  const role = obj.role ?? message?.role;
  const type = obj.type;
  return role === "assistant" || type === "assistant";
}

function assistantModelFromRecord(record: unknown): string | null {
  if (!isAssistantRecord(record)) return null;
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : null;
  const raw = message?.model ?? record.model;
  if (typeof raw !== "string") return null;
  const model = raw.trim();
  if (model.length === 0 || model === "<synthetic>") return null;
  return model;
}

function isToolUseRecord(record: Record<string, unknown>): boolean {
  return record.type === "tool_use" || record.role === "tool_use";
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

function toolNameFromRecord(record: Record<string, unknown>): string | null {
  const raw = record.name ?? record.tool_name ?? record.toolName ?? record.tool;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function objectFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function toolInput(record: Record<string, unknown>): Record<string, unknown> {
  return objectFromUnknown(record.input) ??
    objectFromUnknown(record.tool_input) ??
    objectFromUnknown(record.arguments) ??
    objectFromUnknown(record.args) ??
    objectFromUnknown(record.parameters) ??
    record;
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
        // Plain string command.
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
      if (typeof command === "string" && command.trim().length > 0) commands.push(command.trim());
    }
  };

  for (const candidate of candidates) visit(candidate);
  return commands;
}

function invocationStringsFromInput(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(invocationStringsFromInput);
  if (!value || typeof value !== "object") return [];

  const strings: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["content", "old_string", "new_string"].includes(key)) continue;
    strings.push(...invocationStringsFromInput(child));
  }
  return strings;
}

function simpleToolName(name: string): string {
  const parts = name.split(/[.:/]/);
  const last = parts[parts.length - 1] ?? name;
  return last.toLowerCase();
}

function isWriteTool(name: string): boolean {
  return simpleToolName(name) === "write";
}

function isEditTool(name: string): boolean {
  return simpleToolName(name) === "edit";
}

function isMultiEditTool(name: string): boolean {
  const simple = simpleToolName(name);
  return simple === "multiedit" || simple === "multi_edit";
}

function isBashFamilyTool(name: string): boolean {
  return /\b(?:bash|shell|terminal|exec_command|run_command)\b/i.test(name);
}

function isBrowserTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("mcp__playwright") ||
    lower.includes("mcp__chrome-devtools") ||
    lower.includes("mcp__chrome_devtools") ||
    lower.includes("mcp__claude-in-chrome") ||
    lower.includes("mcp__claude_in_chrome") ||
    lower.startsWith("playwright_") ||
    lower.startsWith("chrome-devtools_") ||
    lower.startsWith("chrome_devtools_") ||
    lower.startsWith("claude-in-chrome_") ||
    lower.startsWith("claude_in_chrome_");
}

function isDomDumpTool(name: string): boolean {
  const lower = name.toLowerCase();
  return DOM_DUMP_NAMES.some((domName) => lower.includes(domName));
}

function pathString(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "filePath", "path", "filename"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isExcludedPath(path: string): boolean {
  const normalized = normalizedPath(path);
  const lower = normalized.toLowerCase();
  if (lower === "plans" || lower.startsWith("plans/") || lower.includes("/plans/")) return true;
  if (lower.startsWith("scratchpad/") || lower.includes("/scratchpad/")) return true;
  if (lower.startsWith(".scratch/") || lower.includes("/.scratch/")) return true;

  const tmpRoots = [process.env.TMPDIR, tmpdir(), "/tmp", "/private/tmp"]
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => normalizedPath(root).replace(/\/+$/, "").toLowerCase());
  return tmpRoots.some((root) => lower === root || lower.startsWith(`${root}/`));
}

function isCodeFilePath(path: string): boolean {
  if (isExcludedPath(path)) return false;
  if (normalizedPath(path).toLowerCase().endsWith(".md")) return false;
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function authoredCodeFromToolUse(toolUse: Record<string, unknown>): {
  totalLines: number;
  writeLines: number;
} {
  const name = toolNameFromRecord(toolUse);
  if (!name) return { totalLines: 0, writeLines: 0 };

  const input = toolInput(toolUse);
  const path = pathString(input);
  if (!path || !isCodeFilePath(path)) return { totalLines: 0, writeLines: 0 };

  if (isWriteTool(name)) {
    const content = input.content;
    const lines = typeof content === "string" ? lineCount(content) : 0;
    return { totalLines: lines, writeLines: lines };
  }

  if (isEditTool(name)) {
    const lines = typeof input.new_string === "string" ? lineCount(input.new_string) : 0;
    return { totalLines: lines, writeLines: 0 };
  }

  if (isMultiEditTool(name)) {
    let totalLines = 0;
    if (Array.isArray(input.edits)) {
      for (const edit of input.edits) {
        const editObj = objectFromUnknown(edit);
        if (typeof editObj?.new_string === "string") totalLines += lineCount(editObj.new_string);
      }
    }
    if (typeof input.new_string === "string") totalLines += lineCount(input.new_string);
    return { totalLines, writeLines: 0 };
  }

  return { totalLines: 0, writeLines: 0 };
}

function hasDelegationEvidence(toolUse: Record<string, unknown>): boolean {
  const name = toolNameFromRecord(toolUse) ?? "";
  if (/^(?:agent|task)$/i.test(name)) return true;

  const invocationStrings = [
    name,
    ...commandStringsFromToolUse(toolUse),
    ...invocationStringsFromInput(toolInput(toolUse)),
  ];
  if (invocationStrings.some((text) => /\/ship-feature\b/i.test(text))) return true;

  if (!isBashFamilyTool(name)) return false;
  return commandStringsFromToolUse(toolUse).some((command) =>
    /\bcodex\s+exec\b/i.test(command) ||
    /\bgemini\s+-m\b/i.test(command) ||
    /\bgemini-2\.5-flash\b/i.test(command) ||
    /\/ship-feature\b/i.test(command)
  );
}

function whaleRegex(): RegExp {
  try {
    return new RegExp(process.env.CODI_WHALE_MODELS || DEFAULT_WHALE_MODELS, "i");
  } catch {
    return new RegExp(DEFAULT_WHALE_MODELS, "i");
  }
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
    }
  }
  return records;
}

export function analyzeTranscript(transcript: string, failOnParseError = false): TranscriptAnalysis {
  const records = parseTranscriptRecords(transcript, failOnParseError);
  let lastHumanUserIndex = -1;
  records.forEach((record, index) => {
    if (isHumanUserRecord(record)) lastHumanUserIndex = index;
  });

  const thisTurnRecords = lastHumanUserIndex >= 0 ? records.slice(lastHumanUserIndex + 1) : records;
  const tools = thisTurnRecords.flatMap(toolUseBlocksFromValue);
  let authoredCodeLines = 0;
  let largestWriteLines = 0;
  let browserCalls = 0;
  let domDumpCalls = 0;

  for (const toolUse of tools) {
    const name = toolNameFromRecord(toolUse) ?? "";
    const authored = authoredCodeFromToolUse(toolUse);
    authoredCodeLines += authored.totalLines;
    largestWriteLines = Math.max(largestWriteLines, authored.writeLines);
    if (isBrowserTool(name)) browserCalls += 1;
    if (isDomDumpTool(name)) domDumpCalls += 1;
  }

  const models = thisTurnRecords
    .map(assistantModelFromRecord)
    .filter((model): model is string => model !== null);
  const whale = whaleRegex();
  const hasWhaleModel = models.some((model) => whale.test(model));
  const codeTrigger = authoredCodeLines >= 50 || largestWriteLines >= 30;
  const browserTrigger = browserCalls >= 3 || domDumpCalls >= 2;

  return {
    authoredCodeLines,
    largestWriteLines,
    browserCalls,
    domDumpCalls,
    hasDelegationEvidence: tools.some(hasDelegationEvidence),
    models,
    hasWhaleModel,
    trigger: codeTrigger ? "code-volume" : browserTrigger ? "browser-driving" : null,
  };
}

function readTranscriptTail(input: HookInput): string {
  if (typeof input.transcript_path !== "string" || input.transcript_path.trim().length === 0) {
    throw new Error("missing transcript path");
  }
  const path = input.transcript_path;
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

function commandAvailable(command: string): boolean {
  try {
    return spawnSync("which", [command], { stdio: "ignore", timeout: 750 }).status === 0;
  } catch {
    return false;
  }
}

function codeAgentTarget(): string {
  return commandAvailable("codex") ? "your unlimited code agent (`codex exec`)" : "your unlimited code agent";
}

function browserAgentTarget(): string {
  return commandAvailable("gemini")
    ? "Flash (`gemini -m gemini-2.5-flash`)"
    : "your browser agent";
}

function ordinal(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

export function buildCostNudge(analysis: TranscriptAnalysis, fireCount: number): string {
  if (fireCount <= 1) {
    if (analysis.trigger === "browser-driving") {
      return `🐟 This turn drove browser/bulk work directly (${analysis.browserCalls} browser calls, ${analysis.domDumpCalls} DOM dumps). That's ${browserAgentTarget()}'s job — the whale's metered quota is the constraint; keep it on judgment, spec, synthesis, gating. Delegate the browser work.`;
    }
    return `🐟 This turn hand-authored ~${analysis.authoredCodeLines} lines of code directly. That's ${codeAgentTarget()}'s job — the whale's metered quota is the constraint; keep it on judgment, spec, synthesis, gating. Delegate the generation.`;
  }

  return `🐟 ${ordinal(fireCount)} time this session the whale did fish-work directly instead of delegating. Each one spends metered Claude quota while the unlimited code/browser agents sit idle. Route generation → ${codeAgentTarget()}, browser/bulk → ${browserAgentTarget()}, feature work → /ship-feature.`;
}

function emitSilent(): never {
  process.exit(0);
}

function emitNudge(systemMessage: string): never {
  process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
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

  const sessionId = sessionIdFromInput(input);
  if (!sessionId) emitSilent();

  let analysis: TranscriptAnalysis;
  try {
    gcCostNudgeState();
    analysis = analyzeTranscript(readTranscriptTail(input), true);
  } catch {
    emitSilent();
  }

  if (!analysis.trigger || !analysis.hasWhaleModel || analysis.models.length === 0) emitSilent();
  if (analysis.hasDelegationEvidence) emitSilent();

  try {
    const prior = readCostNudgeRecord(sessionId);
    if (prior.fire_count >= MAX_FIRES_PER_SESSION) emitSilent();

    const fireCount = prior.fire_count + 1;
    const nudge = buildCostNudge(analysis, fireCount);
    writeCostNudgeRecord({
      ...prior,
      fire_count: fireCount,
      pending: true,
      nudge,
      last_fire_at: nowIso(),
      last_trigger: analysis.trigger,
      last_authored_code_lines: analysis.authoredCodeLines,
      last_browser_calls: analysis.browserCalls,
      last_dom_dump_calls: analysis.domDumpCalls,
      consumed_at: null,
    });
    emitNudge(nudge);
  } catch {
    emitSilent();
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0);
  });
}
