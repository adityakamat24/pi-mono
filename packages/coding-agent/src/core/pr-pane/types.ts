/**
 * Types for the PR-pane subsystem — a cumulative session-diff view that shows
 * every change the agent has made since session start, organized like a real
 * code review.
 *
 * The diff is computed by walking the checkpoint manager's per-edit snapshots
 * (under `<agentDir>/sessions/<sessionId>/snapshots/`) and comparing each file's
 * earliest pre-image to its current on-disk state.
 */

/** A single line in a unified diff hunk: context, addition, or deletion. */
export interface HunkLine {
	kind: " " | "+" | "-";
	/** Line number in the *old* file. Undefined for `+` additions. */
	oldLine?: number;
	/** Line number in the *new* file. Undefined for `-` deletions. */
	newLine?: number;
	/** Raw line content (without the leading +/-/  marker). */
	text: string;
}

/** A contiguous span of changes in one file's diff. */
export interface Hunk {
	/**
	 * Stable identifier within a session: `<absPath>#<hunkIndex>`. Used by later
	 * phases to address actions (revert/comment) against a specific hunk.
	 */
	id: string;
	/** Index of this hunk within its FileDiff (0-based). */
	index: number;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: HunkLine[];
}

export type FileStatus =
	/** File existed at session start; modified since. */
	| "modified"
	/** File did not exist at session start; created during the session. */
	| "added"
	/** File existed at session start; deleted during the session. */
	| "deleted"
	/** File was touched but ended up identical to session-start state (rare; usually filtered out). */
	| "unchanged"
	/** File was too large for the snapshot system to capture; cannot show diff. */
	| "skipped";

/** Cumulative diff for one file across the session. */
export interface FileDiff {
	relPath: string;
	absPath: string;
	status: FileStatus;
	hunks: Hunk[];
	/** Number of "+" lines across all hunks. */
	additions: number;
	/** Number of "-" lines across all hunks. */
	deletions: number;
	/**
	 * Optional explanation when `status === "skipped"` (e.g. file too large).
	 * Lets the UI render a placeholder instead of an empty hunk list.
	 */
	skippedReason?: string;
}

export interface SessionDiff {
	files: FileDiff[];
	totalAdditions: number;
	totalDeletions: number;
	/** Files we couldn't read snapshots for (rare; surfaced in UI). */
	skippedCount: number;
}
