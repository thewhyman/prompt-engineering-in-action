/**
 * handoff-paths.ts — one resolver for the pre/post-compaction handoff artifacts.
 *
 * XOS-259. The PreCompact hook WRITES the marker; the SessionStart(compact)
 * hook READS it. Those are two processes, minutes apart, that must agree on a
 * path derived from the same hook payload. When each computed it privately, a
 * divergence would be silent: the writer succeeds, the reader finds nothing,
 * and the handoff simply never fires — with no error anywhere.
 *
 * That is the failure mode XOS-213 removed from the liveness predicate. Same
 * remedy here: the agreement is structural (one exported function, imported by
 * both) rather than a comment asking a future editor to keep two copies in sync.
 */

import { join } from "path";
import { spawnSync } from "child_process";
import { safeSessionId } from "./session-state.ts";

/** The subset of the hook payload that determines where artifacts land. */
export interface HandoffPathInput {
  cwd?: string;
  session_id?: string;
  workspace?:
    | string
    | {
        current_dir?: string;
        project_dir?: string;
      };
}

/**
 * Where the workspace root is, in descending order of trust:
 * explicit `workspace` from the payload, then the git toplevel, then cwd.
 */
export function workspaceRoot(input: HandoffPathInput, cwd: string): string {
  if (typeof input.workspace === "string" && input.workspace.trim()) {
    return input.workspace.trim();
  }
  if (input.workspace && typeof input.workspace === "object") {
    const projectDir = input.workspace.project_dir?.trim();
    if (projectDir) return projectDir;
    const currentDir = input.workspace.current_dir?.trim();
    if (currentDir) return currentDir;
  }

  const repoRoot = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if ((repoRoot.status ?? 1) === 0 && repoRoot.stdout?.trim()) {
    return repoRoot.stdout.trim();
  }
  return cwd;
}

export function sessionKeyFor(input: HandoffPathInput): string {
  return safeSessionId(input.session_id) ?? "unknown-session";
}

/** `<workspace>/brain/sessions/<session-key>/` — the per-session artifact dir. */
export function artifactDirFor(input: HandoffPathInput): string {
  const cwd = input.cwd ?? process.cwd();
  return join(workspaceRoot(input, cwd), "brain", "sessions", sessionKeyFor(input));
}

/** The latest-only marker the post-compact hook consumes. */
export function markerPathFor(input: HandoffPathInput): string {
  return join(artifactDirFor(input), "last-precompact.json");
}

export function packetPathFor(input: HandoffPathInput, isoTimestamp: string): string {
  const stamp = isoTimestamp.replace(/[:.]/g, "-");
  return join(artifactDirFor(input), `precompact-packet-${sessionKeyFor(input)}-${stamp}.json`);
}
