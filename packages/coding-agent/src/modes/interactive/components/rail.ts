/**
 * RailContainer — pi's signature visual frame.
 *
 * Wraps any set of children and prepends a colored 1-column "rail" glyph
 * (`▎` by default) plus a single space to every rendered line, including
 * blank ones. Children render at `width - 2` so the rail is a true gutter
 * and never overlaps content.
 *
 * Color-coded usage:
 *   user      → accent (violet)
 *   assistant → dim
 *   tool ok   → success
 *   tool err  → error
 *   bash      → bashMode (mint)
 *   custom    → customMessageLabel
 *
 * Centralizing this here means swapping the rail glyph or width is a
 * one-line change site-wide.
 */

import { type Component, Container } from "@mariozechner/pi-tui";
import { GLYPHS } from "../theme/glyphs.js";

export type RailColorFn = (str: string) => string;

export interface RailContainerOptions {
	/** Function that wraps the rail glyph in the appropriate color. */
	colorFn: RailColorFn;
	/** Override the rail glyph if a child wants a sub-rail. Default: `▎`. */
	glyph?: string;
}

export class RailContainer extends Container {
	private colorFn: RailColorFn;
	private glyph: string;

	constructor(options: RailContainerOptions) {
		super();
		this.colorFn = options.colorFn;
		this.glyph = options.glyph ?? GLYPHS.railBar;
	}

	setColorFn(colorFn: RailColorFn): void {
		this.colorFn = colorFn;
	}

	render(width: number): string[] {
		// Reserve 2 columns: rail glyph + 1 space.
		const innerWidth = Math.max(1, width - 2);
		const innerLines = super.render(innerWidth);
		const prefix = `${this.colorFn(this.glyph)} `;
		// Always emit at least one rail line so a freshly-mounted, empty
		// container still shows the gutter.
		if (innerLines.length === 0) {
			return [prefix];
		}
		return innerLines.map((line) => `${prefix}${line}`);
	}
}

/**
 * Convenience wrapper: build a RailContainer pre-populated with a single child.
 * Most call sites have one child component (e.g., a Markdown or Container) and
 * this saves three lines of boilerplate.
 */
export function railWrap(child: Component, colorFn: RailColorFn, glyph?: string): RailContainer {
	const rail = new RailContainer({ colorFn, glyph });
	rail.addChild(child);
	return rail;
}
