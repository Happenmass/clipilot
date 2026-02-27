import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateDetector } from "../../src/tmux/state-detector.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { PromptLoader } from "../../src/llm/prompt-loader.js";
import type { AgentCharacteristics } from "../../src/agents/adapter.js";

function hash(content: string): string {
	return createHash("md5").update(content).digest("hex");
}

function createMockBridge(initialContent = "> "): { bridge: TmuxBridge; setContent: (c: string) => void } {
	let content = initialContent;
	const bridge = {
		capturePane: vi.fn(async () => ({
			content,
			lines: content.split("\n"),
			timestamp: Date.now(),
		})),
	} as any;
	return {
		bridge,
		setContent: (c: string) => {
			content = c;
		},
	};
}

function createMockLLM(): LLMClient {
	return {
		completeJson: vi.fn().mockResolvedValue({
			status: "completed",
			confidence: 0.9,
			detail: "Task completed",
		}),
	} as any;
}

function createMockPromptLoader(): PromptLoader {
	return {
		resolve: vi.fn().mockReturnValue("system prompt"),
	} as any;
}

const characteristics: AgentCharacteristics = {
	waitingPatterns: [/^>\s*$/m, /❯\s*\d+\.\s/],
	completionPatterns: [/^>\s*$/m],
	errorPatterns: [/Error:/i],
	activePatterns: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
	confirmKey: "y",
	abortKey: "Escape",
};

describe("StateDetector.waitForSettled", () => {
	let llm: LLMClient;
	let promptLoader: PromptLoader;

	beforeEach(() => {
		llm = createMockLLM();
		promptLoader = createMockPromptLoader();
	});

	// Task 4.1: Phase 1 → Phase 2 normal flow
	it("should complete Phase 1 → Phase 2 normal flow", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 200,
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("initial content");

		// After 100ms, agent starts producing output
		setTimeout(() => setContent("working on task..."), 100);
		// After 200ms, agent finishes — content shows prompt
		setTimeout(() => setContent("> "), 200);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
		});

		expect(result.timedOut).toBe(false);
		expect(result.content).toBe("> ");
		// Should detect waiting_input pattern from "> "
		expect(result.analysis.status).toBe("waiting_input");
	});

	// Task 4.2: Phase 1 timeout (hash never changes)
	it("should timeout if hash never changes (Phase 1 stuck)", async () => {
		const { bridge } = createMockBridge("static content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 200,
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("static content");

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 300,
		});

		expect(result.timedOut).toBe(true);
		expect(result.analysis.detail).toContain("Timeout");
	});

	// Task 4.3: Phase 2 error fast escape
	it("should return immediately on error pattern during Phase 2", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 2000, // Long threshold — error should escape before this
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("initial content");

		// Agent starts working
		setTimeout(() => setContent("compiling..."), 80);
		// Agent hits error
		setTimeout(() => setContent("Error: compilation failed"), 160);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
		});
		const elapsed = Date.now() - startTime;

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("error");
		// Should return much faster than stableThresholdMs (2000ms)
		expect(elapsed).toBeLessThan(1000);
	});

	// Task 4.4: Phase 2 — active with high confidence resets waiting
	it("should continue waiting when active pattern detected after stability", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 150,
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("initial content");

		// Phase 1→2: content changes
		setTimeout(() => setContent("⠋ Processing step 1..."), 80);
		// Content becomes "stable" with active spinner — should reset and continue
		// After more waiting, content changes to final state (bare prompt)
		setTimeout(() => setContent("> "), 400);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
		});

		expect(result.timedOut).toBe(false);
		expect(result.content).toBe("> ");
		expect(result.analysis.status).toBe("waiting_input");
	});

	// Task 4.5: Abort mid-wait
	it("should return immediately when aborted", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 2000,
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("initial content");
		let aborted = false;

		// Content changes so we enter Phase 2
		setTimeout(() => setContent("working..."), 80);
		// Abort after 200ms
		setTimeout(() => {
			aborted = true;
		}, 200);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			isAborted: () => aborted,
		});
		const elapsed = Date.now() - startTime;

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("unknown");
		expect(result.analysis.detail).toBe("Aborted by user");
		expect(elapsed).toBeLessThan(1000);
	});

	// Task 4.1 supplement: captureHash helper
	it("captureHash should return md5 hash of pane content", async () => {
		const { bridge } = createMockBridge("test content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 100,
			stableThresholdMs: 2000,
			captureLines: 50,
		}, promptLoader);

		const result = await detector.captureHash("test:0.0");
		expect(result).toBe(hash("test content"));
	});

	// waiting_input fast escape during content changes
	it("should return immediately on waiting_input pattern during Phase 2 content changes", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 2000, // Long threshold — waiting_input should escape before this
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("initial content");

		// Agent starts working
		setTimeout(() => setContent("compiling..."), 80);
		// Agent shows permission prompt (content changes again, hash differs)
		setTimeout(() => setContent("Do you want to proceed?\n❯ 1. Yes\n  2. No"), 160);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
		});
		const elapsed = Date.now() - startTime;

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("waiting_input");
		// Should return much faster than stableThresholdMs (2000ms)
		expect(elapsed).toBeLessThan(1000);
	});

	// Animation and numbered option menu coexist
	it("should detect waiting_input even when animation causes continuous hash changes", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 2000,
			captureLines: 50,
		}, promptLoader);
		detector.setCharacteristics(characteristics);

		const preHash = hash("initial content");
		let animFrame = 0;

		// Simulate animation: content keeps changing (different spinner frame each poll)
		// but the permission prompt is always present at the bottom
		const animInterval = setInterval(() => {
			animFrame++;
			const spinner = ["⏺", "⏻", "⏼"][animFrame % 3];
			setContent(
				`${spinner} Searching for 1 pattern…\n` +
				`\n` +
				`Bash command\n` +
				`  find /Users/test -name "*.kt"\n` +
				`Do you want to proceed?\n` +
				`❯ 1. Yes\n` +
				`  2. Yes, allow reading\n` +
				`  3. No`,
			);
		}, 60);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
		});
		const elapsed = Date.now() - startTime;
		clearInterval(animInterval);

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("waiting_input");
		// Should detect quickly despite continuous animation
		expect(elapsed).toBeLessThan(1000);
	});

	// Task 4.1 supplement: Layer 2 LLM analysis fallback
	it("should fall back to Layer 2 LLM analysis when no pattern matches", async () => {
		const { bridge, setContent } = createMockBridge("initial");
		const detector = new StateDetector(bridge, llm, {
			pollIntervalMs: 50,
			stableThresholdMs: 150,
			captureLines: 50,
		}, promptLoader);
		// No characteristics set — quickPatternCheck will return null
		// This forces Layer 2 analysis

		const preHash = hash("initial");

		// Content changes then stabilizes with no recognizable pattern
		setTimeout(() => setContent("some ambiguous output"), 80);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
		});

		expect(result.timedOut).toBe(false);
		// LLM mock returns "completed"
		expect(result.analysis.status).toBe("completed");
		expect((llm.completeJson as any).mock.calls.length).toBeGreaterThan(0);
	});
});
