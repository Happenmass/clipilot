import type { TmuxBridge } from "../tmux/bridge.js";

export interface LaunchOptions {
	workingDir: string;
	sessionName: string;
	windowName?: string;
	env?: Record<string, string>;
}

export interface AgentCharacteristics {
	/** Patterns indicating the agent is waiting for user input */
	waitingPatterns: RegExp[];
	/** Patterns indicating the agent has completed its task */
	completionPatterns: RegExp[];
	/** Patterns indicating an error occurred */
	errorPatterns: RegExp[];
	/** Patterns indicating the agent is actively working (spinners, progress) */
	activePatterns: RegExp[];
	/** Key sequence to send for confirmation */
	confirmKey: string;
	/** Key sequence to abort current operation */
	abortKey: string;
}

export interface AgentAdapter {
	/** Agent identifier */
	readonly name: string;

	/** Human-readable display name */
	readonly displayName: string;

	/**
	 * Launch the agent in a tmux pane.
	 * Returns the tmux pane target string (e.g., "clipilot:0.0").
	 */
	launch(bridge: TmuxBridge, opts: LaunchOptions): Promise<string>;

	/**
	 * Send a task prompt to the agent.
	 * Handles long text via paste-buffer if needed.
	 */
	sendPrompt(bridge: TmuxBridge, paneTarget: string, prompt: string): Promise<void>;

	/**
	 * Send a response to an agent that's waiting for input.
	 * Used for confirmation prompts, follow-up questions, etc.
	 */
	sendResponse(bridge: TmuxBridge, paneTarget: string, response: string): Promise<void>;

	/** Abort the current operation */
	abort(bridge: TmuxBridge, paneTarget: string): Promise<void>;

	/** Gracefully shut down the agent. Optional — called after all tasks complete. */
	shutdown?(bridge: TmuxBridge, paneTarget: string): Promise<void>;

	/** Get agent-specific characteristics for state detection */
	getCharacteristics(): AgentCharacteristics;

	/** Return the absolute path to this adapter's bundled skills directory */
	getSkillsDir?(): string;

	/** Return a text description of the adapter's base capabilities (non-skill) */
	getBaseCapabilities?(): string;
}
