/**
 * Process-level semaphore for Task tool dispatches.
 *
 * When a `tech-lead` agent fans out 5+ specialists in one turn, each child
 * itself runs tool calls and consumes provider rate limits. A soft cap keeps
 * the overall throughput steady without forcing serialization.
 *
 * The cap is a moving target — `setMaxConcurrency()` updates it live and
 * any waiters above the new cap continue waiting; in-flight work completes.
 */

let inFlight = 0;
let maxConcurrency = 4;
const waitQueue: Array<() => void> = [];

export function setMaxConcurrency(value: number): void {
	maxConcurrency = Math.max(1, Math.floor(value));
	drain();
}

export function getMaxConcurrency(): number {
	return maxConcurrency;
}

export function getInFlight(): number {
	return inFlight;
}

/**
 * Acquire a slot. Resolves immediately if under cap, otherwise queues until
 * a slot frees up. The returned function MUST be called to release.
 */
export async function acquireTaskSlot(signal?: AbortSignal): Promise<() => void> {
	if (signal?.aborted) {
		throw new Error("Task slot acquire aborted before start");
	}

	if (inFlight < maxConcurrency) {
		inFlight++;
		return makeRelease();
	}

	return new Promise<() => void>((resolve, reject) => {
		const onResolve = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
			inFlight++;
			resolve(makeRelease());
		};
		const onAbort = () => {
			const idx = waitQueue.indexOf(onResolve);
			if (idx >= 0) waitQueue.splice(idx, 1);
			reject(new Error("Task slot acquire aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		waitQueue.push(onResolve);
	});
}

function makeRelease(): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		inFlight = Math.max(0, inFlight - 1);
		drain();
	};
}

function drain(): void {
	while (inFlight < maxConcurrency && waitQueue.length > 0) {
		const next = waitQueue.shift();
		// Increment happens inside the resolved `onResolve`, so it's atomic
		// with respect to subsequent drain iterations.
		next?.();
	}
}

/** Test helper: clear in-flight + queue and reset cap to default. */
export function resetTaskConcurrencyForTests(): void {
	inFlight = 0;
	waitQueue.length = 0;
	maxConcurrency = 4;
}
