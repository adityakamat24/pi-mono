import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { modeHint, modeLabel } from "../../../core/mode/types.js";
import { GLYPHS } from "../theme/glyphs.js";
import { type ThemeColor, theme } from "../theme/theme.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Format token counts (compact). */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Color the section divider in dim. */
function divider(): string {
	return ` ${theme.fg("dim", GLYPHS.sectionDivider)} `;
}

/**
 * New footer: single line with rail prefix, accented section glyphs, and
 * dotted dividers between groups (path · tokens · context · model).
 *
 * Falls back to a two-line layout when the terminal is too narrow to fit
 * everything on one row.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {
		// Provider handles git branch caching; nothing to do here.
	}

	dispose(): void {
		// Provider handles git watcher cleanup.
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Cumulative token / cost stats — O(1) read from the session's running totals.
		const totals = this.session.getUsageTotals();
		const totalInput = totals.input;
		const totalOutput = totals.output;
		const totalCacheRead = totals.cacheRead;
		const totalCacheWrite = totals.cacheWrite;
		const totalCost = totals.cost;

		// Context usage
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Path group: pwd · branch · session name
		let pwd = this.session.sessionManager.getCwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}
		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();
		const pathGroupParts: string[] = [theme.fg("dim", pwd)];
		if (branch) {
			pathGroupParts.push(`${theme.fg("success", GLYPHS.branch)} ${theme.fg("dim", branch)}`);
		}
		if (sessionName) {
			pathGroupParts.push(theme.fg("dim", sessionName));
		}
		const pathGroup = pathGroupParts.join(theme.fg("dim", " · "));

		// Tokens group
		const tokenParts: string[] = [];
		if (totalInput)
			tokenParts.push(`${theme.fg("accent", GLYPHS.arrowUp)}${theme.fg("dim", formatTokens(totalInput))}`);
		if (totalOutput)
			tokenParts.push(`${theme.fg("accent", GLYPHS.arrowDown)}${theme.fg("dim", formatTokens(totalOutput))}`);
		if (totalCacheRead)
			tokenParts.push(`${theme.fg("muted", GLYPHS.cacheRead)}${theme.fg("dim", formatTokens(totalCacheRead))}`);
		if (totalCacheWrite)
			tokenParts.push(`${theme.fg("muted", GLYPHS.cacheWrite)}${theme.fg("dim", formatTokens(totalCacheWrite))}`);
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			tokenParts.push(theme.fg("success", costStr));
		}
		const tokenGroup = tokenParts.join(" ");

		// Context group: dial + 10-segment progress bar + percentage + window size.
		// Bar segments are violet by default; turn warning at >70%, error at >90%
		// for an at-a-glance "you're filling up" cue.
		const autoIndicator = this.autoCompactEnabled ? " · auto" : "";
		let contextColor: ThemeColor = "accent";
		if (contextPercentValue > 90) contextColor = "error";
		else if (contextPercentValue > 70) contextColor = "warning";

		const totalSegments = 10;
		const filledSegments =
			contextPercent === "?"
				? 0
				: Math.max(0, Math.min(totalSegments, Math.round((contextPercentValue / 100) * totalSegments)));
		const bar =
			theme.fg(contextColor, "▰".repeat(filledSegments)) +
			theme.fg("borderMuted", "▱".repeat(totalSegments - filledSegments));
		const tail = `${contextPercent === "?" ? "?" : `${contextPercent}%`} · ${formatTokens(contextWindow)}${autoIndicator}`;
		const contextGroup = `${theme.fg(contextColor, GLYPHS.contextDial)} ${bar} ${theme.fg("dim", tail)}`;

		// Model group
		const modelName = state.model?.id || "no-model";
		let modelGroup = theme.fg("dim", modelName);
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			const tail = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
			modelGroup = `${theme.fg("dim", modelName)} ${theme.fg("muted", `· ${tail}`)}`;
		}
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			modelGroup = `${theme.fg("muted", `(${state.model.provider})`)} ${modelGroup}`;
		}

		// Compose: rail prefix + groups joined by dotted dividers
		const railPrefix = `${theme.fg("dim", GLYPHS.railBar)} `;
		const groups = [pathGroup, tokenGroup, contextGroup, modelGroup].filter((g) => visibleWidth(g) > 0);
		const singleLine = railPrefix + groups.join(divider());

		const lines: string[] = [];

		// Mode banner (above everything else when not normal)
		const mode = this.session.getMode();
		if (mode !== "normal") {
			const label = modeLabel(mode).toLowerCase();
			const hintText = modeHint(mode);
			const badgeColor: ThemeColor = mode === "plan" ? "accent" : "warning";
			const tail = hintText ? ` · ${hintText}` : "";
			const badgeText = `${GLYPHS.modeBanner} ${label} on${tail} (alt+m to cycle)`;
			lines.push(theme.fg(badgeColor, truncateToWidth(badgeText, width, "...")));
		}

		if (visibleWidth(singleLine) <= width) {
			lines.push(singleLine);
		} else {
			// Two-line fallback: path on top, stats/context/model on bottom.
			const top = railPrefix + pathGroup;
			const bottomGroups = [tokenGroup, contextGroup, modelGroup].filter((g) => visibleWidth(g) > 0);
			const bottom = railPrefix + bottomGroups.join(divider());
			lines.push(truncateToWidth(top, width, theme.fg("dim", "...")));
			lines.push(truncateToWidth(bottom, width, theme.fg("dim", "...")));
		}

		// Extension statuses
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
