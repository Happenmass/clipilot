import { EventEmitter } from "node:events";
import type { AgentAdapter } from "../agents/adapter.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { PaneAnalysis, StateDetector } from "../tmux/state-detector.js";
import { logger } from "../utils/logger.js";
import type { Memory } from "./memory.js";
import type { Planner } from "./planner.js";
import type { Task, TaskGraph, TaskResult } from "./task.js";

export interface SchedulerOptions {
	maxParallel: number;
	autonomyLevel: "low" | "medium" | "high" | "full";
	defaultAgent: string;
	goal: string;
}

export interface SchedulerEvents {
	task_start: [task: Task];
	task_complete: [task: Task, result: TaskResult];
	task_failed: [task: Task, error: string];
	state_update: [paneState: PaneAnalysis, task: Task];
	need_human: [task: Task, reason: string];
	all_complete: [progress: ReturnType<TaskGraph["getProgress"]>];
	log: [message: string];
	plan_ready: [taskGraph: TaskGraph];
}

export class Scheduler extends EventEmitter<SchedulerEvents> {
	private taskGraph: TaskGraph;
	private bridge: TmuxBridge;
	private stateDetector: StateDetector;
	private planner: Planner;
	private agents: Map<string, AgentAdapter>;
	private options: SchedulerOptions;
	private memory?: Memory;

	private running = false;
	private paused = false;
	private aborted = false;
	private agentPaneTarget: string | null = null;

	constructor(
		taskGraph: TaskGraph,
		bridge: TmuxBridge,
		stateDetector: StateDetector,
		planner: Planner,
		agents: Map<string, AgentAdapter>,
		options: SchedulerOptions,
		memory?: Memory,
	) {
		super();
		this.taskGraph = taskGraph;
		this.bridge = bridge;
		this.stateDetector = stateDetector;
		this.planner = planner;
		this.agents = agents;
		this.options = options;
		this.memory = memory;
	}

	getTaskGraph(): TaskGraph {
		return this.taskGraph;
	}

	isRunning(): boolean {
		return this.running;
	}

	isPaused(): boolean {
		return this.paused;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.paused = false;
		this.aborted = false;

		logger.info("scheduler", "Starting task execution");
		this.emit("log", "Scheduler started");

		const agentName = this.options.defaultAgent;
		const adapter = this.agents.get(agentName);

		if (!adapter) {
			logger.error("scheduler", `No adapter found for agent: ${agentName}`);
			this.emit("log", `Fatal error: No adapter for agent: ${agentName}`);
			this.running = false;
			return;
		}

		try {
			// Launch agent once — all tasks reuse this pane
			const sessionName = generateSessionName(this.options.goal);
			this.agentPaneTarget = await adapter.launch(this.bridge, {
				workingDir: process.cwd(),
				sessionName,
			});
			logger.info("scheduler", `Agent launched in ${this.agentPaneTarget}`);
			this.stateDetector.setCharacteristics(adapter.getCharacteristics());

			await this.runLoop();
		} catch (err: any) {
			logger.error("scheduler", `Fatal error: ${err.message}`);
			this.emit("log", `Fatal error: ${err.message}`);
		} finally {
			// Gracefully shut down agent
			if (this.agentPaneTarget && adapter.shutdown) {
				try {
					await adapter.shutdown(this.bridge, this.agentPaneTarget);
					logger.info("scheduler", "Agent shut down gracefully");
				} catch (err: any) {
					logger.warn("scheduler", `Agent shutdown failed: ${err.message}`);
				}
			}
			this.agentPaneTarget = null;
			this.running = false;
		}
	}

	pause(): void {
		this.paused = true;
		logger.info("scheduler", "Paused");
		this.emit("log", "Scheduler paused");
	}

	resume(): void {
		this.paused = false;
		logger.info("scheduler", "Resumed");
		this.emit("log", "Scheduler resumed");
	}

	abort(): void {
		this.aborted = true;
		this.running = false;
		logger.info("scheduler", "Aborted");
		this.emit("log", "Scheduler aborted");
	}

	async steer(instruction: string): Promise<void> {
		logger.info("scheduler", `Steer instruction: ${instruction}`);
		this.emit("log", `User instruction: ${instruction}`);
		// TODO: Forward instruction to current running agent
	}

	private async runLoop(): Promise<void> {
		while (!this.aborted && !this.taskGraph.isComplete()) {
			// Wait if paused
			while (this.paused && !this.aborted) {
				await sleep(500);
			}
			if (this.aborted) break;

			// Check for deadlock
			if (this.taskGraph.isDeadlocked()) {
				logger.error("scheduler", "Task graph is deadlocked — no tasks can proceed");
				this.emit("log", "DEADLOCK: No tasks can proceed. Stopping.");
				break;
			}

			// Get ready tasks
			const readyTasks = this.taskGraph.getReadyTasks();
			if (readyTasks.length === 0) {
				// No ready tasks but some are running — wait
				if (this.taskGraph.getRunningTasks().length > 0) {
					await sleep(1000);
					continue;
				}
				break;
			}

			// Execute next ready task
			const task = readyTasks[0];
			await this.executeTask(task);
		}

		if (!this.aborted) {
			const progress = this.taskGraph.getProgress();
			this.emit("all_complete", progress);
			logger.info("scheduler", `All tasks complete: ${progress.completed}/${progress.total} succeeded`);
		}
	}

	private async executeTask(task: Task): Promise<void> {
		const agentName = task.agentType || this.options.defaultAgent;
		const adapter = this.agents.get(agentName);

		if (!adapter || !this.agentPaneTarget) {
			const reason = !adapter ? `No adapter for agent: ${agentName}` : "Agent pane not available";
			logger.error("scheduler", reason);
			this.taskGraph.updateStatus(task.id, "failed", {
				success: false,
				summary: reason,
			});
			this.emit("task_failed", task, reason);
			return;
		}

		const paneTarget = this.agentPaneTarget;

		// Mark task as running
		this.taskGraph.updateStatus(task.id, "running");
		this.emit("task_start", task);
		this.emit("log", `Starting task: ${task.title} [${adapter.displayName}]`);

		try {
			// Generate prompt for this task
			const completedTasks = this.taskGraph.getAllTasks().filter((t) => t.status === "completed");
			const prompt = task.prompt || (await this.planner.generatePrompt(task, completedTasks));

			// Send the prompt to the reused pane
			await adapter.sendPrompt(this.bridge, paneTarget, prompt);

			// Set cooldown to avoid misdetecting the previous prompt as completion
			this.stateDetector.setCooldown(3000);

			// Monitor execution with state detector
			const result = await this.monitorTask(task, paneTarget, adapter);

			// Update task status (pane stays alive regardless of result)
			this.taskGraph.updateStatus(task.id, result.success ? "completed" : "failed", result);

			if (result.success) {
				this.emit("task_complete", task, result);
				this.emit("log", `Task completed: ${task.title}`);
			} else {
				this.emit("task_failed", task, result.summary);
				this.emit("log", `Task failed: ${task.title} — ${result.summary}`);

				// Handle failure based on autonomy level
				await this.handleFailure(task, result);
			}
		} catch (err: any) {
			const result: TaskResult = {
				success: false,
				summary: `Execution error: ${err.message}`,
				errors: [err.message],
			};
			this.taskGraph.updateStatus(task.id, "failed", result);
			this.emit("task_failed", task, err.message);
			this.emit("log", `Task error: ${task.title} — ${err.message}`);
		}
	}

	private async monitorTask(task: Task, paneTarget: string, adapter: AgentAdapter): Promise<TaskResult> {
		return new Promise((resolve) => {
			const taskContext = `${task.title}: ${task.description}`;
			let resolved = false;
			let waitingInputRetries = 0;
			const maxWaitingInputRetries = 3;

			const unsubscribe = this.stateDetector.onStateChange(async (analysis, paneContent) => {
				if (resolved) return;

				this.emit("state_update", analysis, task);

				switch (analysis.status) {
					case "completed": {
						resolved = true;
						unsubscribe();
						this.stateDetector.stopMonitoring();
						resolve({
							success: true,
							summary: analysis.detail,
						});
						break;
					}

					case "error": {
						if (analysis.suggestedAction?.type === "escalate" || analysis.confidence > 0.8) {
							resolved = true;
							unsubscribe();
							this.stateDetector.stopMonitoring();
							resolve({
								success: false,
								summary: analysis.detail,
								errors: [analysis.detail],
							});
						}
						break;
					}

					case "waiting_input": {
						if (this.options.autonomyLevel === "high" || this.options.autonomyLevel === "full") {
							// Check retry limit
							waitingInputRetries++;
							if (waitingInputRetries > maxWaitingInputRetries) {
								logger.warn("scheduler", `waiting_input retry limit reached (${maxWaitingInputRetries})`);
								this.emit("need_human", task, `Auto-response failed after ${maxWaitingInputRetries} attempts`);
								break;
							}

							let actionValue = analysis.suggestedAction?.value;

							// If no value from Layer 1.5, trigger Layer 2 LLM analysis
							if (!actionValue) {
								logger.info(
									"scheduler",
									"No suggestedAction value, triggering Layer 2 for interaction analysis",
								);
								try {
									const llmResult = await this.stateDetector.analyzeState(paneContent, taskContext);
									if (llmResult.suggestedAction?.type === "escalate") {
										this.emit("need_human", task, llmResult.detail);
										break;
									}
									actionValue = llmResult.suggestedAction?.value;
								} catch (err: any) {
									logger.error("scheduler", `Layer 2 analysis failed: ${err.message}`);
									this.emit("need_human", task, `Interaction analysis failed: ${err.message}`);
									break;
								}
							}

							if (actionValue) {
								await adapter.sendResponse(this.bridge, paneTarget, actionValue);
								this.stateDetector.setCooldown(3000);
							} else {
								// LLM returned no actionable value
								this.emit("need_human", task, analysis.detail);
							}
						} else {
							// Request human intervention
							this.emit("need_human", task, analysis.detail);
						}
						break;
					}

					case "idle": {
						// Agent idle after some work — might be completed
						// Trigger Layer 2 analysis
						const deepResult = await this.stateDetector.analyzeState(paneContent, taskContext);
						if (deepResult.status === "completed") {
							resolved = true;
							unsubscribe();
							this.stateDetector.stopMonitoring();
							resolve({
								success: true,
								summary: deepResult.detail,
							});
						}
						break;
					}

					// "active" or "unknown" — just wait
				}
			});

			this.stateDetector.startMonitoring(paneTarget, taskContext);

			// Timeout after 10 minutes per task
			setTimeout(
				() => {
					if (!resolved) {
						resolved = true;
						unsubscribe();
						this.stateDetector.stopMonitoring();
						resolve({
							success: false,
							summary: "Task timed out after 10 minutes",
							errors: ["timeout"],
						});
					}
				},
				10 * 60 * 1000,
			);
		});
	}

	private async handleFailure(task: Task, result: TaskResult): Promise<void> {
		if (task.attempts < task.maxAttempts && this.options.autonomyLevel !== "low") {
			// Retry
			logger.info("scheduler", `Retrying task ${task.id} (attempt ${task.attempts + 1}/${task.maxAttempts})`);
			this.taskGraph.updateStatus(task.id, "pending");
		} else if (this.options.autonomyLevel === "full") {
			// Try replanning
			try {
				const newGraph = await this.planner.replan(
					"", // Original goal not stored here, would need to pass it in
					this.taskGraph,
					task,
					result.summary,
				);
				this.taskGraph = newGraph;
				this.emit("plan_ready", newGraph);

				if (this.memory) {
					await this.memory.recordLesson(
						`Task "${task.title}" failed with: ${result.summary}. Replanned successfully.`,
					);
				}
			} catch {
				this.emit("need_human", task, `Failed after ${task.attempts} attempts and replanning failed`);
			}
		} else {
			this.emit("need_human", task, `Failed after ${task.attempts} attempts: ${result.summary}`);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateSessionName(goal: string): string {
	const slug = goal
		.replace(/[^\w\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30)
		.replace(/-$/, "");
	return `clipilot-${slug || "session"}`;
}
