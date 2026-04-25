/**
 * Auto-checkpoint manager — saves pre-images of files about to be mutated by
 * `edit`/`write` so `/undo` can roll back without ever touching git.
 *
 * Storage layout (under the agent config dir, never inside the user's repo):
 *   <agentDir>/sessions/<sessionId>/snapshots/
 *     <seq>/
 *       manifest.json   [{ relPath, absPath, sha, existedBefore, size }]
 *       files/
 *         <sha>.bin     // content-addressed pre-image; dedupes across entries
 *
 * Coverage: edit + write only. Bash mutations are NOT snapshotted — we don't
 * know what shell commands will touch ahead of time, and silently failing
 * is worse than being upfront.
 *
 * Safety guarantees:
 *   - Never reads, writes, or shells out to git.
 *   - Never creates files inside the user's project tree.
 *   - Snapshot creation is best-effort: on any I/O error the tool call still
 *     proceeds (`/undo` becomes a no-op for that step but nothing breaks).
 *   - Old session dirs are pruned on construction (older than 7 days).
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "../../config.js";

const SNAPSHOT_RETENTION_DAYS = 7;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB per file — refuse to snapshot anything larger.

export interface CheckpointEntry {
	id: string;
	createdAt: number;
	/** What triggered the checkpoint, e.g. "edit src/foo.ts". */
	reason: string;
	/** Absolute paths of files snapshotted (display only). */
	files: string[];
}

interface ManifestFile {
	relPath: string;
	absPath: string;
	sha: string | null; // null when the file did not exist pre-mutation
	size: number;
	existedBefore: boolean;
}

interface Manifest {
	id: string;
	createdAt: number;
	reason: string;
	files: ManifestFile[];
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

export class CheckpointManager {
	private readonly cwd: string;
	private readonly sessionId: string;
	private readonly rootDir: string;
	private readonly entries: CheckpointEntry[] = [];
	private nextSeq = 1;
	private prunedOnce = false;

	constructor(cwd: string, sessionId: string) {
		this.cwd = cwd;
		this.sessionId = sessionId;
		this.rootDir = join(getAgentDir(), "sessions", sessionId, "snapshots");
	}

	/** Returns the in-memory list of checkpoints, oldest first. */
	list(): ReadonlyArray<CheckpointEntry> {
		return this.entries;
	}

	/**
	 * Snapshot the listed files' current contents. Any path that doesn't exist
	 * is recorded with `existedBefore: false` so undo can delete it again.
	 * Returns the entry on success; undefined when there are no paths to track
	 * or the snapshot failed.
	 */
	async create(reason: string, absPaths: string[]): Promise<CheckpointEntry | undefined> {
		this.pruneOldSessionsOnce();

		const unique = Array.from(new Set(absPaths.filter((p) => typeof p === "string" && p.length > 0)));
		if (unique.length === 0) return undefined;

		const seq = this.nextSeq++;
		const id = String(seq);
		const entryDir = join(this.rootDir, id);
		const filesDir = join(entryDir, "files");

		try {
			mkdirSync(filesDir, { recursive: true });
		} catch {
			return undefined;
		}

		const manifestFiles: ManifestFile[] = [];
		for (const absPath of unique) {
			const resolvedAbs = isAbsolute(absPath) ? absPath : resolve(this.cwd, absPath);
			const relPath = relative(this.cwd, resolvedAbs);

			if (!existsSync(resolvedAbs)) {
				manifestFiles.push({
					relPath,
					absPath: resolvedAbs,
					sha: null,
					size: 0,
					existedBefore: false,
				});
				continue;
			}

			try {
				const stats = statSync(resolvedAbs);
				if (!stats.isFile()) continue; // skip directories — edit/write target files only
				if (stats.size > MAX_FILE_BYTES) {
					// Too large to safely snapshot. Record metadata so undo can warn.
					manifestFiles.push({
						relPath,
						absPath: resolvedAbs,
						sha: null,
						size: stats.size,
						existedBefore: true,
					});
					continue;
				}
				const buf = readFileSync(resolvedAbs);
				const sha = sha256(buf);
				const blobPath = join(filesDir, `${sha}.bin`);
				if (!existsSync(blobPath)) {
					writeFileSync(blobPath, buf);
				}
				manifestFiles.push({
					relPath,
					absPath: resolvedAbs,
					sha,
					size: stats.size,
					existedBefore: true,
				});
			} catch {
				// Couldn't read this file — skip it but keep going.
			}
		}

		if (manifestFiles.length === 0) {
			// Clean up empty entry dir.
			try {
				rmSync(entryDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
			return undefined;
		}

		const manifest: Manifest = {
			id,
			createdAt: Date.now(),
			reason,
			files: manifestFiles,
		};
		try {
			writeFileSync(join(entryDir, "manifest.json"), JSON.stringify(manifest, null, 2));
		} catch {
			return undefined;
		}

		const entry: CheckpointEntry = {
			id,
			createdAt: manifest.createdAt,
			reason,
			files: manifestFiles.map((f) => f.absPath),
		};
		this.entries.push(entry);
		return entry;
	}

	/**
	 * Restore the most recent checkpoint (or one referenced by id). Files are
	 * written back to their pre-mutation contents; files that didn't exist
	 * pre-mutation are deleted.
	 */
	async undo(targetId?: string): Promise<{ ok: boolean; message: string }> {
		const entry = targetId ? this.entries.find((e) => e.id === targetId) : this.entries[this.entries.length - 1];
		if (!entry) {
			return { ok: false, message: "No checkpoints to undo." };
		}
		const entryDir = join(this.rootDir, entry.id);
		const manifestPath = join(entryDir, "manifest.json");
		if (!existsSync(manifestPath)) {
			this.removeEntry(entry.id);
			return {
				ok: false,
				message: `Checkpoint ${entry.id} is missing on disk. Removed from list.`,
			};
		}

		let manifest: Manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
		} catch (err) {
			return { ok: false, message: `Failed to read checkpoint manifest: ${(err as Error).message}` };
		}

		const restored: string[] = [];
		const failures: string[] = [];
		for (const f of manifest.files) {
			try {
				if (!f.existedBefore) {
					// File was created by the mutation — delete to revert.
					if (existsSync(f.absPath)) unlinkSync(f.absPath);
					restored.push(f.relPath);
					continue;
				}
				if (f.sha === null) {
					// Existed but wasn't snapshotted (too large). Skip; warn.
					failures.push(`${f.relPath} (file too large to snapshot — left as-is)`);
					continue;
				}
				const blobPath = join(entryDir, "files", `${f.sha}.bin`);
				if (!existsSync(blobPath)) {
					failures.push(`${f.relPath} (snapshot blob missing)`);
					continue;
				}
				mkdirSync(dirname(f.absPath), { recursive: true });
				copyFileSync(blobPath, f.absPath);
				restored.push(f.relPath);
			} catch (err) {
				failures.push(`${f.relPath} (${(err as Error).message})`);
			}
		}

		// Drop the snapshot dir after a successful (even partial) restore.
		try {
			rmSync(entryDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		this.removeEntry(entry.id);

		const ageStr = formatRelativeTime(entry.createdAt);
		const filesStr =
			restored.length === 0
				? "no files restored"
				: `${restored.length} file${restored.length === 1 ? "" : "s"} restored`;
		const failureStr = failures.length > 0 ? ` (${failures.length} skipped: ${failures.join("; ")})` : "";
		return {
			ok: failures.length === 0 || restored.length > 0,
			message: `Restored "${entry.reason}" (${ageStr}): ${filesStr}${failureStr}.`,
		};
	}

	private removeEntry(id: string): void {
		const idx = this.entries.findIndex((e) => e.id === id);
		if (idx >= 0) this.entries.splice(idx, 1);
	}

	/** Drop session snapshot dirs older than SNAPSHOT_RETENTION_DAYS. Runs once per process per manager. */
	private pruneOldSessionsOnce(): void {
		if (this.prunedOnce) return;
		this.prunedOnce = true;

		const sessionsRoot = join(getAgentDir(), "sessions");
		if (!existsSync(sessionsRoot)) return;
		const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
		try {
			for (const sid of readdirSync(sessionsRoot)) {
				if (sid === this.sessionId) continue;
				const snapDir = join(sessionsRoot, sid, "snapshots");
				if (!existsSync(snapDir)) continue;
				try {
					const stat = statSync(snapDir);
					if (stat.mtimeMs < cutoff) {
						rmSync(snapDir, { recursive: true, force: true });
					}
				} catch {
					// skip unreadable dirs
				}
			}
		} catch {
			// sessions root unreadable — skip
		}
	}
}

function formatRelativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}
