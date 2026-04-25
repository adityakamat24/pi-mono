/**
 * Background job manager — runs long-running shell commands without blocking
 * the agent loop. Used by the `BashSpawn` tool and the `/jobs` slash command.
 *
 * Each job:
 *   - Runs via `child_process.spawn`, NOT `shell: true`. Args are the user's
 *     literal argv. (The `BashSpawn` tool itself accepts a `command` string
 *     and shells it through the same shell pi already trusts for `bash`.)
 *   - Captures stdout+stderr in a bounded ring buffer (default 64 KiB) so
 *     a chatty `npm run dev` doesn't blow up memory.
 *   - Records exit state and duration on completion.
 *   - Is killable individually or together when the session ends.
 *
 * Process-level singleton — tied to the lifetime of the pi process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "exited" | "killed" | "error";

export interface JobInfo {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	finishedAt?: number;
	status: JobStatus;
	exitCode?: number | null;
	pid?: number;
	bytesCaptured: number;
	bytesDropped: number;
}

export interface JobOutputSnapshot {
	tail: string;
	bytesDropped: number;
	bytesCaptured: number;
}

interface InternalJob extends JobInfo {
	child: ChildProcess | undefined;
	ring: RingBuffer;
}

const DEFAULT_RING_BYTES = 64 * 1024;
const DEFAULT_MAX_JOBS = 8;

class RingBuffer {
	private buf: string[] = [];
	private size = 0;
	private dropped = 0;
	constructor(private readonly capacity: number) {}

	push(chunk: string): void {
		this.buf.push(chunk);
		this.size += chunk.length;
		while (this.size > this.capacity && this.buf.length > 0) {
			const removed = this.buf.shift();
			if (removed) {
				this.size -= removed.length;
				this.dropped += removed.length;
			}
		}
	}

	tail(maxBytes: number): string {
		const joined = this.buf.join("");
		if (joined.length <= maxBytes) return joined;
		return joined.slice(-maxBytes);
	}

	get totalCaptured(): number {
		return this.size;
	}

	get totalDropped(): number {
		return this.dropped;
	}
}

export class JobManager {
	private readonly jobs: Map<string, InternalJob> = new Map();
	private readonly maxJobs: number;
	private readonly ringBytes: number;

	constructor(options: { maxJobs?: number; ringBytes?: number } = {}) {
		this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
		this.ringBytes = options.ringBytes ?? DEFAULT_RING_BYTES;
	}

	list(): JobInfo[] {
		return Array.from(this.jobs.values()).map(toInfo);
	}

	get(id: string): JobInfo | undefined {
		const job = this.jobs.get(id);
		return job ? toInfo(job) : undefined;
	}

	tail(id: string, maxBytes = 4096): JobOutputSnapshot | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		return {
			tail: job.ring.tail(maxBytes),
			bytesDropped: job.ring.totalDropped,
			bytesCaptured: job.ring.totalCaptured + job.ring.totalDropped,
		};
	}

	/**
	 * Spawn a command in the background. Returns the new job's ID.
	 *
	 * `args` runs without a shell (`shell: false`). Callers wanting shell
	 * semantics should pass `["bash", "-c", "..."]` or equivalent.
	 */
	spawn(options: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }): JobInfo {
		const running = this.list().filter((j) => j.status === "running").length;
		if (running >= this.maxJobs) {
			throw new Error(
				`Refusing to spawn: ${running} background jobs already running (cap: ${this.maxJobs}). Kill one with /kill or raise settings.task.maxJobs.`,
			);
		}
		const id = randomUUID().slice(0, 8);
		const ring = new RingBuffer(this.ringBytes);
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const job: InternalJob = {
			id,
			command: `${options.command}${options.args.length ? ` ${options.args.join(" ")}` : ""}`,
			cwd: options.cwd,
			startedAt: Date.now(),
			status: "running",
			pid: child.pid,
			bytesCaptured: 0,
			bytesDropped: 0,
			child,
			ring,
		};
		this.jobs.set(id, job);
		child.stdout?.on("data", (chunk: Buffer) => {
			ring.push(chunk.toString("utf-8"));
			job.bytesCaptured = ring.totalCaptured;
			job.bytesDropped = ring.totalDropped;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			ring.push(chunk.toString("utf-8"));
			job.bytesCaptured = ring.totalCaptured;
			job.bytesDropped = ring.totalDropped;
		});
		child.on("error", (err) => {
			job.status = "error";
			job.finishedAt = Date.now();
			ring.push(`\n[error] ${err.message}\n`);
			job.child = undefined;
		});
		child.on("close", (code, signal) => {
			job.finishedAt = Date.now();
			job.exitCode = code;
			job.status = signal ? "killed" : code === 0 ? "exited" : "exited";
			job.child = undefined;
		});
		return toInfo(job);
	}

	/** Send SIGTERM (or SIGKILL after 3s) to the job. */
	async kill(id: string, force = false): Promise<{ ok: boolean; message: string }> {
		const job = this.jobs.get(id);
		if (!job) return { ok: false, message: `No job with id "${id}".` };
		if (job.status !== "running" || !job.child) {
			return { ok: false, message: `Job "${id}" is not running (status: ${job.status}).` };
		}
		try {
			job.child.kill(force ? "SIGKILL" : "SIGTERM");
			if (!force) {
				// Escalate to SIGKILL after 3s if still running.
				setTimeout(() => {
					const still = this.jobs.get(id);
					if (still?.status === "running" && still.child) {
						try {
							still.child.kill("SIGKILL");
						} catch {
							// already gone
						}
					}
				}, 3000).unref?.();
			}
			return { ok: true, message: `Sent ${force ? "SIGKILL" : "SIGTERM"} to job "${id}".` };
		} catch (err) {
			return {
				ok: false,
				message: `Failed to signal job "${id}": ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/** Kill every running job. Called on session shutdown. */
	killAll(): void {
		for (const job of this.jobs.values()) {
			if (job.status === "running" && job.child) {
				try {
					job.child.kill("SIGKILL");
				} catch {
					// best-effort
				}
			}
		}
	}
}

function toInfo(job: InternalJob): JobInfo {
	return {
		id: job.id,
		command: job.command,
		cwd: job.cwd,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		status: job.status,
		exitCode: job.exitCode,
		pid: job.pid,
		bytesCaptured: job.bytesCaptured,
		bytesDropped: job.bytesDropped,
	};
}

let sharedJobManager: JobManager | undefined;

export function getSharedJobManager(): JobManager {
	if (!sharedJobManager) {
		sharedJobManager = new JobManager();
	}
	return sharedJobManager;
}

export function resetSharedJobManagerForTests(): void {
	sharedJobManager?.killAll();
	sharedJobManager = new JobManager();
}
