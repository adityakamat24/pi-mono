/**
 * Single source of truth for the glyph set used across the interactive UI.
 *
 * Keeping these in one place makes it easy to swap an icon site-wide and to
 * verify everything renders in monospace terminals (every glyph below is
 * width-1 and Unicode BMP).
 */

export const GLYPHS = {
	/** Vertical bar drawn to the left of every chat block (signature look). */
	railBar: "▎",
	/** Lighter vertical bar used to indent nested output under a rail. */
	railSubBar: "▏",
	/** Footer section divider (lightly dotted vertical). */
	sectionDivider: "┊",

	/** Role / kind glyphs prepended to a block's heading line. */
	user: "▶",
	assistant: "◆",
	bash: "❯",
	skill: "✦",

	/** Tool execution status glyphs. */
	toolPending: "◌",
	toolRunning: "◉",
	toolSuccess: "●",
	toolError: "✕",

	/** Mode banner prefix (footer). */
	modeBanner: "⏵⏵",

	/** Footer stat icons. */
	arrowUp: "↑",
	arrowDown: "↓",
	cacheRead: "⤓",
	cacheWrite: "⤒",
	contextDial: "◐",
	branch: "⎇",
	dot: "·",
} as const;

export type GlyphName = keyof typeof GLYPHS;
