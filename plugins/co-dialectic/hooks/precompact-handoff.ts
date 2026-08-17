#!/usr/bin/env bun
/**
 * precompact-handoff.ts — capture pre-compaction state (Co-Dialectic).
 *
 * Fires on PreCompact (Claude Code's signal that the context window is about to
 * be summarized). At this moment the session still has its FULL conversation
 * context. Once compaction completes, the summary will have dropped:
 *   - the actual unfinished tasks the user just discussed
 *   - the decisions made in the current arc
 *   - the lessons that should be codified
 *   - the open follow-ups and their crisp triggers
 *
 * ── What this hook does (XOS-259 rewrite) ────────────────────────────────────
 * It CAPTURES: a structured packet plus a latest-only marker under
 * <workspace>/brain/sessions/<session_id>/, holding what can be known
 * deterministically from the OS — timestamp, trigger, cwd, git state, and the
 * transcript path.
 *
 * It does NOT try to talk to the model. Two reasons, and the second is the one
 * that matters:
 *
 *   1. It can't. PreCompact does not support `hookSpecificOutput` — only the
 *      universal fields (`continue`, `systemMessage`, `terminalSequence`, …).
 *      The previous version emitted `hookSpecificOutput.additionalContext`, so
 *      the whole payload failed schema validation and was discarded, taking the
 *      valid `systemMessage` down with it. Every compaction printed a hook
 *      failure and injected nothing.
 *      → https://code.claude.com/docs/en/hooks
 *
 *   2. It shouldn't. Context injected at PreCompact lands in the conversation
 *      that is about to be summarized away. Even had the field been accepted,
 *      the reminder was aimed at the wrong moment in the lifecycle.
 *
 * The reminder now fires from postcompact-handoff-reminder.ts on
 * SessionStart(compact) — after the summary exists, where plain stdout IS added
 * to the model's context and the model can still act. This hook's job is to
 * leave that hook something true to say: `handoff_pending: true` in the marker.
 *
 * Fail-safe: ALWAYS exit 0. Never blocks compaction. If a write fails, log to
 * stderr and proceed — compaction must not be blocked by hook errors.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import {
  artifactDirFor,
  markerPathFor,
  packetPathFor,
  type HandoffPathInput,
} from "./handoff-paths.ts";

interface PreCompactInput extends HandoffPathInput {
  hook_event_name?: string;
  transcript_path?: string;
  trigger?: "manual" | "auto" | string;
}

interface GitState {
  in_repo: boolean;
  branch?: string;
  head_sha?: string;
  head_subject?: string;
  uncommitted_files_count?: number;
  uncommitted_files?: string[];
  recent_commits?: Array<{ sha: string; subject: string }>;
  has_uncommitted_handoff_doc?: boolean;
  error?: string;
}

function captureGitState(cwd: string): GitState {
  try {
    // Check if cwd is inside a git repo
    const inRepo = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
    if ((inRepo.status ?? 1) !== 0) {
      return { in_repo: false };
    }

    const branchRes = spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" });
    const branch = (branchRes.stdout ?? "").trim() || "(detached)";

    const headRes = spawnSync("git", ["-C", cwd, "log", "-1", "--format=%H|%s"], { encoding: "utf8" });
    const [head_sha = "", head_subject = ""] = (headRes.stdout ?? "").trim().split("|", 2);

    const statusRes = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" });
    const allUncommitted = (statusRes.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const uncommittedFiles = allUncommitted.slice(0, 50).map((l) => l.slice(3));
    const hasHandoffDoc = allUncommitted.some((l) =>
      l.includes("NEXT_SESSION_HANDOFF.md") || l.includes("HANDOFF.md")
    );

    const logRes = spawnSync(
      "git",
      ["-C", cwd, "log", "--oneline", "-10", "--format=%h|%s"],
      { encoding: "utf8" }
    );
    const recent_commits = (logRes.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const [sha = "", ...rest] = l.split("|");
        return { sha, subject: rest.join("|") };
      });

    return {
      in_repo: true,
      branch,
      head_sha: head_sha.slice(0, 12),
      head_subject,
      uncommitted_files_count: allUncommitted.length,
      uncommitted_files: uncommittedFiles,
      recent_commits,
      has_uncommitted_handoff_doc: hasHandoffDoc,
    };
  } catch (e) {
    return { in_repo: false, error: String(e) };
  }
}

async function main(): Promise<void> {
  let input: PreCompactInput = {};
  try {
    const raw = await Bun.stdin.text();
    if (raw && raw.trim()) input = JSON.parse(raw);
  } catch {
    // Malformed stdin — proceed with empty input; never block compaction
  }

  const now = new Date().toISOString();
  const trigger = input.trigger ?? "unknown";
  const transcript = input.transcript_path ?? null;
  const cwd = input.cwd ?? process.cwd();
  const sessionId = input.session_id ?? null;
  const artifactDir = artifactDirFor(input);
  const markerFile = markerPathFor(input);

  // ── Layer 2: CAPTURE — structured packet to disk ──────────────────────────
  const gitState = captureGitState(cwd);
  const packet = {
    schema_version: "1.0.0",
    ts: now,
    trigger,
    cwd,
    session_id: sessionId,
    transcript_path: transcript,
    git: gitState,
    notes: [
      "This is the minimal deterministic packet captured by the precompact-handoff hook.",
      "It does NOT contain conversation semantics (unfinished work, decisions, lessons).",
      "Those live in the full codi-handoff skill output. If Claude invoked the skill,",
      "look for a richer handoff in NEXT_SESSION_HANDOFF.md or the workspace substrate.",
      "If Claude did NOT invoke the skill, this packet is the only structured record",
      "of pre-compaction state — combine with transcript_path to reconstruct.",
    ],
    next_step_for_post_compact_claude: [
      "1. Read this packet + check transcript_path to see what was in flight.",
      "2. If NEXT_SESSION_HANDOFF.md was uncommitted, the skill may have been invoked",
      "   but didn't complete the commit — check the diff and finish the work.",
      "3. If uncommitted_files is non-empty, those represent in-flight work — commit",
      "   or stash before starting new tasks.",
    ],
  };

  let packetFile: string | null = null;
  try {
    if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });
    packetFile = packetPathFor(input, now);
    writeFileSync(packetFile, JSON.stringify(packet, null, 2));
  } catch (e) {
    process.stderr.write(`precompact-handoff: packet write failed: ${e}\n`);
  }

  // Marker file (latest-only) for easy discovery by post-compact Claude
  try {
    if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      markerFile,
      JSON.stringify(
        {
          ts: now,
          trigger,
          transcript_path: transcript,
          cwd,
          session_id: sessionId,
          packet_file: packetFile,
          git_uncommitted_count: gitState.uncommitted_files_count ?? 0,
          git_branch: gitState.branch ?? null,
          git_head_sha: gitState.head_sha ?? null,
          has_uncommitted_handoff_doc: gitState.has_uncommitted_handoff_doc ?? false,
          // XOS-259: the post-compact hook reads this. `true` means "a handoff
          // reminder is owed to the model and has not been delivered yet".
          // postcompact-handoff-reminder.ts flips it to false once it prints,
          // so a resume or a second compaction does not re-nag.
          handoff_pending: true,
          consumed_at: null,
          schema_version: "1.2.0",
        },
        null,
        2
      )
    );
  } catch (e) {
    process.stderr.write(`precompact-handoff: marker write failed: ${e}\n`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  // `systemMessage` is the ONLY channel PreCompact has, and it goes to the user,
  // not the model. Adding `hookSpecificOutput` here is what broke this hook: the
  // schema rejects it for this event and discards the entire object, so the
  // failure is total rather than partial. Keep this payload to universal fields.
  const output = buildPreCompactOutput({
    trigger,
    packetWritten: packetFile !== null,
    uncommitted: gitState.uncommitted_files_count ?? null,
  });

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/**
 * Exported so the schema test can assert the shape without spawning a process,
 * and — more importantly — so the assertion is against the same object the hook
 * actually prints, not a copy of it.
 */
export function buildPreCompactOutput(facts: {
  trigger: string;
  packetWritten: boolean;
  uncommitted: number | null;
}): { systemMessage: string } {
  return {
    systemMessage:
      `Co-Dialectic: pre-compaction state captured (trigger=${facts.trigger}, ` +
      `packet=${facts.packetWritten ? "✓" : "✗"}, ` +
      `uncommitted=${facts.uncommitted ?? "n/a"}). ` +
      `Handoff reminder will fire after compaction completes.`,
  };
}

// Only run when executed as a hook. Without this guard, importing anything from
// this module (the schema test does) would run main(), read stdin, write files
// and call process.exit(0) — which aborts the whole `bun test` runner and takes
// every other suite down with it, silently.
if (import.meta.main) {
  main().catch((err) => {
    // Fail-safe: never block compaction on error
    process.stderr.write(`precompact-handoff error: ${err}\n`);
    process.exit(0);
  });
}
