import { createHash } from "node:crypto";
import type { AgentCharacteristics } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import { logger } from "../utils/logger.js";
import type { TmuxBridge } from "./bridge.js";

export type PaneStatus = "active" | "waiting_input" | "completed" | "error" | "idle" | "unknown";

export interface PaneAnalysis {
	status: PaneStatus;
	confidence: number;
	detail: string;
	suggestedAction?: {
		type: "send_keys" | "wait" | "retry" | "skip" | "escalate";
		value?: string;
	};
}

export interface DeepAnalysis extends PaneAnalysis {
	shouldReplan: boolean;
	alternativeApproach?: string;
	humanInterventionNeeded: boolean;
	reason: string;
}

export interface StateDetectorConfig {
	pollIntervalMs: number;
	stableThresholdMs: number;
	captureLines: number;
}

type StateChangeCallback = (analysis: PaneAnalysis, paneContent: string) => void;

export class StateDetector {
	private config: StateDetectorConfig;
	private bridge: TmuxBridge;
	private llmClient: LLMClient;
	private promptLoader: PromptLoader;
	private characteristics: AgentCharacteristics | null = null;

	private monitoring = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastHash: string | null = null;
	private lastChangeTime = 0;
	private lastContent = "";
	private callbacks: StateChangeCallback[] = [];
	private cooldownUntil = 0;
	private analyzing = false;

	constructor(bridge: TmuxBridge, llmClient: LLMClient, config: StateDetectorConfig, promptLoader: PromptLoader) {
		this.bridge = bridge;
		this.llmClient = llmClient;
		this.config = config;
		this.promptLoader = promptLoader;
	}

	setCharacteristics(characteristics: AgentCharacteristics): void {
		this.characteristics = characteristics;
	}

	setCooldown(durationMs: number): void {
		this.cooldownUntil = Date.now() + durationMs;
		logger.info("state-detector", `Cooldown set for ${durationMs}ms`);
	}

	private isInCooldown(): boolean {
		return Date.now() < this.cooldownUntil;
	}

	onStateChange(callback: StateChangeCallback): () => void {
		this.callbacks.push(callback);
		return () => {
			const idx = this.callbacks.indexOf(callback);
			if (idx >= 0) this.callbacks.splice(idx, 1);
		};
	}

	startMonitoring(paneTarget: string, taskContext: string): void {
		if (this.monitoring) return;
		this.monitoring = true;
		this.lastHash = null;
		this.lastChangeTime = Date.now();
		this.lastContent = "";

		logger.info("state-detector", `Starting monitoring for ${paneTarget}`);

		this.pollTimer = setInterval(() => {
			this.poll(paneTarget, taskContext).catch((err) => {
				logger.error("state-detector", `Poll error: ${err.message}`);
			});
		}, this.config.pollIntervalMs);
	}

	stopMonitoring(): void {
		this.monitoring = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		logger.info("state-detector", "Monitoring stopped");
	}

	private async poll(paneTarget: string, taskContext: string): Promise<void> {
		if (!this.monitoring) return;

		try {
			const capture = await this.bridge.capturePane(paneTarget, {
				startLine: -this.config.captureLines,
			});

			const content = capture.content;
			const hash = createHash("md5").update(content).digest("hex");

			// Layer 1: Quick change detection
			if (hash !== this.lastHash) {
				// Content changed — agent is active
				this.lastHash = hash;
				this.lastChangeTime = Date.now();
				this.lastContent = content;

				// Quick pattern check (Layer 1.5)
				const quickResult = this.quickPatternCheck(content);
				if (quickResult) {
					this.emit(quickResult, content);
				}
				return;
			}

			// Content hasn't changed — check if stable long enough
			const stableDuration = Date.now() - this.lastChangeTime;

			if (stableDuration >= this.config.stableThresholdMs && !this.isInCooldown() && !this.analyzing) {
				// Stable for too long and not in cooldown — trigger Layer 2
				this.analyzing = true;
				logger.info("state-detector", `Content stable for ${stableDuration}ms, triggering Layer 2 analysis`);
				try {
					const analysis = await this.analyzeState(content, taskContext);
					this.emit(analysis, content);
				} finally {
					this.analyzing = false;
					// Reset timer to avoid re-triggering immediately
					this.lastChangeTime = Date.now();
				}
			}
		} catch (err: any) {
			logger.error("state-detector", `Capture error: ${err.message}`);
		}
	}

	/** Layer 1.5: Quick regex-based pattern matching */
	private quickPatternCheck(content: string): PaneAnalysis | null {
		if (!this.characteristics) return null;

		const lastLines = content.split("\n").slice(-5).join("\n");
		const inCooldown = this.isInCooldown();

		// Check error patterns (always check, even during cooldown)
		for (const pattern of this.characteristics.errorPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "error",
					confidence: 0.7,
					detail: "Error pattern detected in output",
					suggestedAction: { type: "escalate" },
				};
			}
		}

		// During cooldown, skip completion and waiting patterns to avoid
		// misinterpreting the previous round's prompt as current completion
		if (inCooldown) {
			return null;
		}

		// Check waiting patterns
		for (const pattern of this.characteristics.waitingPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "waiting_input",
					confidence: 0.6,
					detail: "Agent appears to be waiting for input",
					suggestedAction: { type: "send_keys" },
				};
			}
		}

		// Check active patterns
		for (const pattern of this.characteristics.activePatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "active",
					confidence: 0.8,
					detail: "Agent is actively working",
					suggestedAction: { type: "wait" },
				};
			}
		}

		return null;
	}

	/** Layer 2: LLM-based semantic analysis */
	async analyzeState(paneContent: string, taskContext: string): Promise<PaneAnalysis> {
		try {
			const result = await this.llmClient.completeJson<PaneAnalysis>(
				[
					{
						role: "user",
						content: `Task context: ${taskContext}\n\nCurrent pane content (last ${this.config.captureLines} lines):\n\`\`\`\n${paneContent}\n\`\`\``,
					},
				],
				{
					systemPrompt: this.promptLoader.resolve("state-analyzer"),
					temperature: 0,
				},
			);

			logger.info("state-detector", `Layer 2 analysis: ${result.status} (confidence: ${result.confidence})`);
			return result;
		} catch (err: any) {
			logger.error("state-detector", `Layer 2 analysis failed: ${err.message}`);
			return {
				status: "unknown",
				confidence: 0,
				detail: `Analysis failed: ${err.message}`,
				suggestedAction: { type: "escalate" },
			};
		}
	}

	/** Layer 3: Deep analysis with stronger model */
	async deepAnalyze(
		paneContent: string,
		taskContext: string,
		opts?: { fileChanges?: string; errorHistory?: string[] },
	): Promise<DeepAnalysis> {
		const contextParts = [`Task context: ${taskContext}`, `\nCurrent pane content:\n\`\`\`\n${paneContent}\n\`\`\``];

		if (opts?.fileChanges) {
			contextParts.push(`\nFile changes (git diff):\n\`\`\`\n${opts.fileChanges}\n\`\`\``);
		}

		if (opts?.errorHistory?.length) {
			contextParts.push(`\nPrevious errors:\n${opts.errorHistory.map((e, i) => `${i + 1}. ${e}`).join("\n")}`);
		}

		try {
			const result = await this.llmClient.completeJson<DeepAnalysis>(
				[{ role: "user", content: contextParts.join("\n") }],
				{
					systemPrompt: this.promptLoader.resolve("error-analyzer"),
					temperature: 0,
				},
			);

			logger.info("state-detector", `Layer 3 deep analysis: ${result.status}, replan=${result.shouldReplan}`);
			return result;
		} catch (err: any) {
			logger.error("state-detector", `Layer 3 analysis failed: ${err.message}`);
			return {
				status: "unknown",
				confidence: 0,
				detail: `Deep analysis failed: ${err.message}`,
				shouldReplan: false,
				humanInterventionNeeded: true,
				reason: `Analysis failed: ${err.message}`,
			};
		}
	}

	private emit(analysis: PaneAnalysis, paneContent: string): void {
		for (const cb of this.callbacks) {
			try {
				cb(analysis, paneContent);
			} catch (err: any) {
				logger.error("state-detector", `Callback error: ${err.message}`);
			}
		}
	}
}
