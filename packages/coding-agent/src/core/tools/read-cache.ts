/**
 * Per-process LRU cache for the read tool.
 *
 * Same files often get read multiple times in a session (browse → edit →
 * verify → another tool reads it). Each read costs filesystem latency AND
 * LLM context tokens. Caching the *result content* by `(absolutePath, mtimeMs,
 * size)` lets the read tool skip both costs.
 *
 * Invalidation:
 *   - edit/write tools call `invalidatePath(absPath)` on success.
 *   - bash tool calls `invalidateAll()` after a command completes (heuristic
 *     since we can't see what bash touched).
 *   - Stat-mismatch on a hit (mtime/size differ from the cached key) means the
 *     file changed out-of-band; treat as miss and refresh.
 */

import { resolve } from "node:path";

export interface CachedReadEntry {
	/** The exact result content the read tool would return on a fresh read. */
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	/** Optional details produced by the read tool (e.g., truncation info). */
	details?: unknown;
	/** Stat key components — the tuple that authenticates this entry. */
	mtimeMs: number;
	size: number;
	/** Approximate byte cost (text length / data length) used for byte-cap eviction. */
	approxBytes: number;
}

interface ReadCacheOptions {
	maxEntries: number;
	maxBytes: number;
}

const DEFAULT_OPTIONS: ReadCacheOptions = {
	maxEntries: 256,
	maxBytes: 8 * 1024 * 1024,
};

export class ReadCache {
	private readonly options: ReadCacheOptions;
	// Insertion-order Map gives us LRU when we delete-then-set on hit.
	private readonly entries: Map<string, CachedReadEntry> = new Map();
	private currentBytes = 0;

	constructor(options?: Partial<ReadCacheOptions>) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	private static key(path: string): string {
		return resolve(path);
	}

	/**
	 * Look up a cached entry for `path`. Caller passes the current `mtimeMs` and
	 * `size` of the file (cheap stat) so we can verify the cache is still
	 * authoritative. Returns the entry on hit, undefined on miss / stale.
	 */
	get(path: string, mtimeMs: number, size: number): CachedReadEntry | undefined {
		const k = ReadCache.key(path);
		const entry = this.entries.get(k);
		if (!entry) return undefined;
		if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
			// Stale — file changed under us. Drop the entry.
			this.entries.delete(k);
			this.currentBytes -= entry.approxBytes;
			return undefined;
		}
		// Touch for LRU.
		this.entries.delete(k);
		this.entries.set(k, entry);
		return entry;
	}

	/** Insert or replace the entry for `path`, evicting older entries if over caps. */
	set(path: string, entry: CachedReadEntry): void {
		const k = ReadCache.key(path);
		const existing = this.entries.get(k);
		if (existing) {
			this.currentBytes -= existing.approxBytes;
			this.entries.delete(k);
		}
		this.entries.set(k, entry);
		this.currentBytes += entry.approxBytes;
		this.evictIfNeeded();
	}

	invalidatePath(path: string): void {
		const k = ReadCache.key(path);
		const entry = this.entries.get(k);
		if (entry) {
			this.currentBytes -= entry.approxBytes;
			this.entries.delete(k);
		}
	}

	invalidateAll(): void {
		this.entries.clear();
		this.currentBytes = 0;
	}

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.currentBytes;
	}

	private evictIfNeeded(): void {
		while (this.entries.size > this.options.maxEntries || this.currentBytes > this.options.maxBytes) {
			const oldestKey = this.entries.keys().next().value;
			if (!oldestKey) break;
			const oldest = this.entries.get(oldestKey);
			if (!oldest) {
				this.entries.delete(oldestKey);
				continue;
			}
			this.currentBytes -= oldest.approxBytes;
			this.entries.delete(oldestKey);
		}
	}
}

/**
 * Process-singleton cache. Per-session caches would be more correct but
 * over-engineered: the cache is keyed by absolute path and validated by
 * stat info, so it stays correct across sessions in the same process.
 * Tests can construct fresh `ReadCache` instances directly.
 */
let sharedCache: ReadCache | undefined;

export function getSharedReadCache(): ReadCache {
	if (!sharedCache) {
		sharedCache = new ReadCache();
	}
	return sharedCache;
}

/** Test helper: replace the singleton with a fresh instance. */
export function resetSharedReadCacheForTests(): void {
	sharedCache = new ReadCache();
}
