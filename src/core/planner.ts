import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import { logger } from "../utils/logger.js";
import { type Task, TaskGraph } from "./task.js";

interface PlannerContext {
	projectInfo?: string;
	fileTree?: string;
	recentGitLog?: string;
}

interface PlannedTask {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
	estimatedComplexity: "low" | "medium" | "high";
}

export class Planner {
	private llmClient: LLMClient;
	private promptLoader: PromptLoader;

	constructor(llmClient: LLMClient, promptLoader: PromptLoader) {
		this.llmClient = llmClient;
		this.promptLoader = promptLoader;
	}

	async plan(goal: string, context?: PlannerContext): Promise<TaskGraph> {
		logger.info("planner", `Planning for goal: ${goal}`);

		const contextParts = [`Development goal: ${goal}`];

		if (context?.projectInfo) {
			contextParts.push(`\nProject info:\n${context.projectInfo}`);
		}
		if (context?.fileTree) {
			contextParts.push(`\nFile structure:\n${context.fileTree}`);
		}
		if (context?.recentGitLog) {
			contextParts.push(`\nRecent git history:\n${context.recentGitLog}`);
		}

		const plannedTasks = await this.llmClient.completeJson<PlannedTask[]>(
			[{ role: "user", content: contextParts.join("\n") }],
			{
				systemPrompt: this.promptLoader.resolve("planner"),
				temperature: 0.2,
			},
		);

		const graph = new TaskGraph();

		for (const pt of plannedTasks) {
			const task: Task = {
				id: pt.id,
				title: pt.title,
				description: pt.description,
				status: "pending",
				dependencies: pt.dependencies,
				attempts: 0,
				maxAttempts: 3,
				estimatedComplexity: pt.estimatedComplexity,
				createdAt: Date.now(),
			};
			graph.addTask(task);
		}

		const progress = graph.getProgress();
		logger.info("planner", `Plan created: ${progress.total} tasks`);

		return graph;
	}

	async replan(
		originalGoal: string,
		currentGraph: TaskGraph,
		failedTask: Task,
		errorInfo: string,
	): Promise<TaskGraph> {
		logger.info("planner", `Replanning after failure of task: ${failedTask.title}`);

		const completedTasks = currentGraph.getAllTasks().filter((t) => t.status === "completed");
		const pendingTasks = currentGraph.getAllTasks().filter((t) => t.status === "pending");

		const contextParts = [
			`Original goal: ${originalGoal}`,
			`\nCompleted tasks:\n${completedTasks.map((t) => `- [DONE] ${t.title}: ${t.result?.summary || "completed"}`).join("\n")}`,
			`\nFailed task: ${failedTask.title}\nDescription: ${failedTask.description}\nError: ${errorInfo}`,
			`\nRemaining tasks:\n${pendingTasks.map((t) => `- ${t.title}`).join("\n")}`,
			`\nPlease create a revised plan that accounts for the failure and finds an alternative approach. Keep completed tasks as-is and replan the remaining work.`,
		];

		const plannedTasks = await this.llmClient.completeJson<PlannedTask[]>(
			[{ role: "user", content: contextParts.join("\n") }],
			{
				systemPrompt: this.promptLoader.resolve("planner"),
				temperature: 0.3,
			},
		);

		const graph = new TaskGraph();

		// Re-add completed tasks
		for (const task of completedTasks) {
			graph.addTask(task);
		}

		// Add new planned tasks
		for (const pt of plannedTasks) {
			const task: Task = {
				id: pt.id,
				title: pt.title,
				description: pt.description,
				status: "pending",
				dependencies: pt.dependencies,
				attempts: 0,
				maxAttempts: 3,
				estimatedComplexity: pt.estimatedComplexity,
				createdAt: Date.now(),
			};
			graph.addTask(task);
		}

		logger.info("planner", `Replan created: ${graph.getProgress().total} total tasks`);
		return graph;
	}

	async generatePrompt(task: Task, completedTasks: Task[]): Promise<string> {
		const contextParts = [`Task to accomplish: ${task.title}\n${task.description}`];

		if (completedTasks.length > 0) {
			contextParts.push(
				`\nPreviously completed tasks:\n${completedTasks.map((t) => `- ${t.title}: ${t.result?.summary || "completed"}`).join("\n")}`,
			);
		}

		const response = await this.llmClient.complete([{ role: "user", content: contextParts.join("\n") }], {
			systemPrompt: this.promptLoader.resolve("prompt-generator"),
			temperature: 0.3,
		});

		return response.content;
	}
}
