import type { AgentAdapter } from "../agents/adapter.js";
import type { PaneAnalysis, StateDetector } from "../tmux/state-detector.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { TaskGraph, TaskResult } from "./task.js";
import type { ContextManager } from "./context-manager.js";
import { logger } from "../utils/logger.js";

export type SignalType = "TASK_READY" | "DECISION_NEEDED" | "NOTIFY" | "USER_STEER";

export interface Signal {
	type: SignalType;
	paneContent: string;
	analysis?: PaneAnalysis;
	taskContext?: string;
	message?: string;
}

export type SignalHandler = (signal: Signal) => Promise<void>;

const OPSX_PATTERN = /\/opsx[:\s]/i;
const SPEC_KEYWORDS = /openspec|proposal\.md|design\.md|tasks\.md|artifact|spec\.md/i;

export class SignalRouter {
	private stateDetector: StateDetector;
	private bridge: TmuxBridge;
	private contextManager: ContextManager;
	private taskGraph: TaskGraph;

	private defaultLines = 50;
	private expandedLines = 300;
	private expandUntilNextTask = false;
	private lastSentPrompt = "";

	private signalHandler: SignalHandler | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		stateDetector: StateDetector,
		bridge: TmuxBridge,
		contextManager: ContextManager,
		taskGraph: TaskGraph,
	) {
		this.stateDetector = stateDetector;
		this.bridge = bridge;
		this.contextManager = contextManager;
		this.taskGraph = taskGraph;
	}

	setTaskGraph(taskGraph: TaskGraph): void {
		this.taskGraph = taskGraph;
	}

	onSignal(handler: SignalHandler): void {
		this.signalHandler = handler;
	}

	notifyPromptSent(prompt: string): void {
		this.lastSentPrompt = prompt;
		if (OPSX_PATTERN.test(prompt)) {
			this.expandUntilNextTask = true;
			logger.info("signal-router", "Detected /opsx command in prompt, expanding capture lines");
		}
	}

	notifyNewTask(): void {
		if (this.expandUntilNextTask) {
			this.expandUntilNextTask = false;
			logger.info("signal-router", "New task started, resetting capture lines to default");
		}
	}

	getCaptureLines(paneContent?: string): number {
		if (this.expandUntilNextTask) {
			return this.expandedLines;
		}
		if (paneContent && SPEC_KEYWORDS.test(paneContent)) {
			return this.expandedLines;
		}
		return this.defaultLines;
	}

	startMonitoring(paneTarget: string, taskContext: string): void {
		this.unsubscribe = this.stateDetector.onStateChange(async (analysis, paneContent) => {
			await this.routeSignal(analysis, paneContent, taskContext);
		});
		this.stateDetector.startMonitoring(paneTarget, taskContext);
	}

	stopMonitoring(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		this.stateDetector.stopMonitoring();
	}

	private async routeSignal(analysis: PaneAnalysis, paneContent: string, taskContext: string): Promise<void> {
		// Determine capture lines based on content
		const captureLines = this.getCaptureLines(paneContent);
		let effectiveContent = paneContent;

		// If we need more lines and the current content seems limited, re-capture
		if (captureLines > this.defaultLines && paneContent.split("\n").length <= this.defaultLines) {
			// Content may have been captured with default lines; signal handler can use fetch_more
		}

		if (this.isFastPath(analysis)) {
			await this.handleFastPath(analysis, effectiveContent, taskContext);
		} else {
			await this.handleMainAgentPath(analysis, effectiveContent, taskContext);
		}
	}

	private isFastPath(analysis: PaneAnalysis): boolean {
		if (analysis.status === "active" && analysis.confidence > 0.7) {
			return true;
		}
		if (analysis.status === "completed" && analysis.confidence >= 0.9) {
			return true;
		}
		return false;
	}

	private async handleFastPath(analysis: PaneAnalysis, paneContent: string, taskContext: string): Promise<void> {
		if (analysis.status === "completed" && analysis.confidence >= 0.9) {
			logger.info("signal-router", `Fast-path: auto-completing task (conf=${analysis.confidence})`);

			// Notify MainAgent conversation history
			this.contextManager.addMessage({
				role: "user",
				content: `[NOTIFY] Task auto-completed via fast-path (conf=${analysis.confidence}). Detail: ${analysis.detail}`,
			});

			// Emit a completion signal to the handler to resolve the task
			if (this.signalHandler) {
				await this.signalHandler({
					type: "NOTIFY",
					paneContent,
					analysis,
					taskContext,
					message: `Auto-completed (conf=${analysis.confidence})`,
				});
			}
		} else {
			// active with high confidence — just log, don't bother MainAgent
			logger.info("signal-router", `Fast-path: agent active (conf=${analysis.confidence}), skipping`);
		}
	}

	private async handleMainAgentPath(
		analysis: PaneAnalysis,
		paneContent: string,
		taskContext: string,
	): Promise<void> {
		logger.info("signal-router", `MainAgent path: ${analysis.status} (conf=${analysis.confidence})`);

		if (this.signalHandler) {
			await this.signalHandler({
				type: "DECISION_NEEDED",
				paneContent,
				analysis,
				taskContext,
			});
		}
	}
}
