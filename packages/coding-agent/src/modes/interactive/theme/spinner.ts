/**
 * Pi's signature loader animation.
 *
 * Six-phase pulse: π flares, decays through dot weights, returns. The cycle
 * is deliberately asymmetric so the eye reads "movement" without "spin".
 *
 * Pass these to any pi-tui Loader via `setIndicator({ frames, intervalMs })`.
 */

export const PI_SPINNER_FRAMES: ReadonlyArray<string> = ["π", "·", "∙", "•", "∙", "·"];

export const PI_SPINNER_INTERVAL_MS = 110;

/** Convenience object matching pi-tui's `LoaderIndicatorOptions`. */
export const PI_SPINNER_INDICATOR = {
	frames: [...PI_SPINNER_FRAMES],
	intervalMs: PI_SPINNER_INTERVAL_MS,
} as const;
