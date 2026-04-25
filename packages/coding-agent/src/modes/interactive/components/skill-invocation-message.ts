import { Container, Markdown, type MarkdownTheme, Text } from "@mariozechner/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.js";
import { GLYPHS } from "../theme/glyphs.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { RailContainer } from "./rail.js";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 *
 * New visual: violet rail with a skill star glyph. The skill block is rendered
 * inline (the user message that triggered it is rendered separately).
 */
export class SkillInvocationMessageComponent extends Container {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;
	private rail: RailContainer;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.rail = new RailContainer({ colorFn: (s: string) => theme.fg("accent", s) });
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

		if (this.expanded) {
			const label = theme.fg("accent", `${GLYPHS.skill} \x1b[1m[skill]\x1b[22m`);
			this.rail.addChild(new Text(label, 0, 0));
			const header = `**${this.skillBlock.name}**\n\n`;
			this.rail.addChild(
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const line =
				theme.fg("accent", `${GLYPHS.skill} \x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageText", this.skillBlock.name) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.rail.addChild(new Text(line, 0, 0));
		}
	}
}
