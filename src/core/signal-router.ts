import { EventEmitter } from "node:events";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { PaneAnalysis, StateDetector } from "../tmux/state-detector.js";
import { logger } from "../utils/logger.js";
import type { ContextManager } from "./context-manager.js";

export type SignalType = "DECISION_NEEDED" | "NOTIFY" | "USER_STEER";

export interface Signal {
	type: SignalType;
	paneContent: string;
	analysis?: PaneAnalysis;
	goalContext?: string;
	message?: string;
}

export type SignalHandler = (signal: Signal) => Promise<void>;

export interface SignalRouterEvents {
	goal_complete: [result: { success: boolean; summary: string }];
	goal_failed: [error: string];
	need_human: [reason: string];
	log: [message: string];
}

const OPSX_PATTERN = /\/opsx[:\s]/i;
const SPEC_KEYWORDS = /openspec|proposal\.md|design\.md|tasks\.md|artifact|spec\.md/i;

export class SignalRouter extends EventEmitter<SignalRouterEvents> {
	private stateDetector: StateDetector;

	private defaultLines = 50;
	private expandedLines = 300;
	private expandUntilNextPrompt = false;

	private signalHandler: SignalHandler | null = null;
	private unsubscribe: (() => void) | null = null;

	// Execution control
	private _paused = false;
	private _aborted = false;

	constructor(stateDetector: StateDetector, _bridge: TmuxBridge, _contextManager: ContextManager) {
		super();
		this.stateDetector = stateDetector;
	}

	// ─── Execution control ───────────────────────────────

	pause(): void {
		this._paused = true;
		logger.info("signal-router", "Paused");
		this.emit("log", "Execution paused");
	}

	resume(): void {
		this._paused = false;
		logger.info("signal-router", "Resumed");
		this.emit("log", "Execution resumed");
	}

	abort(): void {
		this._aborted = true;
		logger.info("signal-router", "Aborted");
		this.emit("log", "Execution aborted");
	}

	isPaused(): boolean {
		return this._paused;
	}

	isAborted(): boolean {
		return this._aborted;
	}

	// ─── Signal handling ─────────────────────────────────

	onSignal(handler: SignalHandler): void {
		this.signalHandler = handler;
	}

	notifyPromptSent(prompt: string): void {
		if (OPSX_PATTERN.test(prompt)) {
			this.expandUntilNextPrompt = true;
			logger.info("signal-router", "Detected /opsx command in prompt, expanding capture lines");
		}
	}

	resetCaptureExpansion(): void {
		if (this.expandUntilNextPrompt) {
			this.expandUntilNextPrompt = false;
			logger.info("signal-router", "Resetting capture lines to default");
		}
	}

	getCaptureLines(paneContent?: string): number {
		if (this.expandUntilNextPrompt) {
			return this.expandedLines;
		}
		if (paneContent && SPEC_KEYWORDS.test(paneContent)) {
			return this.expandedLines;
		}
		return this.defaultLines;
	}

	startMonitoring(paneTarget: string, goalContext: string): void {
		this.unsubscribe = this.stateDetector.onStateChange(async (analysis, paneContent) => {
			await this.routeSignal(analysis, paneContent, goalContext);
		});
		this.stateDetector.startMonitoring(paneTarget, goalContext);
	}

	stopMonitoring(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		this.stateDetector.stopMonitoring();
	}

	private async routeSignal(analysis: PaneAnalysis, paneContent: string, goalContext: string): Promise<void> {
		// Determine capture lines based on content
		const captureLines = this.getCaptureLines(paneContent);
		const effectiveContent = paneContent;

		// If we need more lines and the current content seems limited, re-capture
		if (captureLines > this.defaultLines && paneContent.split("\n").length <= this.defaultLines) {
			// Content may have been captured with default lines; signal handler can use fetch_more
		}

		if (this.isActiveAndConfident(analysis)) {
			// Agent is actively working with high confidence — just log, don't bother MainAgent
			logger.info("signal-router", `Fast-path: agent active (conf=${analysis.confidence}), skipping`);
		} else {
			// All other states (completed, waiting_input, error, low-confidence) → let MainAgent decide
			await this.handleMainAgentPath(analysis, effectiveContent, goalContext);
		}
	}

	private isActiveAndConfident(analysis: PaneAnalysis): boolean {
		return analysis.status === "active" && analysis.confidence > 0.7;
	}

	private async handleMainAgentPath(analysis: PaneAnalysis, paneContent: string, goalContext: string): Promise<void> {
		logger.info("signal-router", `MainAgent path: ${analysis.status} (conf=${analysis.confidence})`);

		if (this.signalHandler) {
			await this.signalHandler({
				type: "DECISION_NEEDED",
				paneContent,
				analysis,
				goalContext,
			});
		}
	}
}
