import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@mariozechner/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { RailContainer } from "./rail.js";

/**
 * Component that renders a branch summary with collapsed/expanded state.
 *
 * New visual: pale-lavender left rail with a `[branch]` label, no background.
 */
export class BranchSummaryMessageComponent extends Container {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private rail: RailContainer;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.rail = new RailContainer({ colorFn: (s: string) => theme.fg("customMessageLabel", s) });
		this.addChild(this.rail);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.rail.clear();

		const label = theme.fg("customMessageLabel", `\x1b[1m[branch]\x1b[22m`);
		this.rail.addChild(new Text(label, 0, 0));
		this.rail.addChild(new Spacer(1));

		if (this.expanded) {
			const header = "**Branch Summary**\n\n";
			this.rail.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.rail.addChild(
				new Text(
					theme.fg("customMessageText", "Branch summary (") +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
