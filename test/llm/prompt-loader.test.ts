import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptLoader } from "../../src/llm/prompt-loader.js";

describe("PromptLoader", () => {
	let tempDir: string;
	let builtinDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "clipilot-test-"));
		builtinDir = join(tempDir, "builtin-prompts");
		await mkdir(builtinDir, { recursive: true });

		// Create builtin prompt files for testing
		await writeFile(join(builtinDir, "planner.md"), "Default planner prompt\n\n{{memory}}");
		await writeFile(join(builtinDir, "state-analyzer.md"), "Default state analyzer prompt\n\n{{memory}}");
		await writeFile(join(builtinDir, "error-analyzer.md"), "Default error analyzer prompt\n\n{{memory}}");
		await writeFile(join(builtinDir, "prompt-generator.md"), "Default prompt generator prompt\n\n{{memory}}");
		await writeFile(join(builtinDir, "session-summarizer.md"), "Default session summarizer prompt");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("should return built-in defaults when no custom files exist", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		expect(loader.getRaw("planner")).toBe("Default planner prompt\n\n{{memory}}");
		expect(loader.getRaw("state-analyzer")).toBe("Default state analyzer prompt\n\n{{memory}}");
		expect(loader.getRaw("error-analyzer")).toBe("Default error analyzer prompt\n\n{{memory}}");
		expect(loader.getRaw("prompt-generator")).toBe("Default prompt generator prompt\n\n{{memory}}");
		expect(loader.getRaw("session-summarizer")).toBe("Default session summarizer prompt");
	});

	it("should override with project-level .md files", async () => {
		const promptsDir = join(tempDir, ".clipilot", "prompts");
		await mkdir(promptsDir, { recursive: true });
		await writeFile(join(promptsDir, "planner.md"), "Custom planner prompt");

		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		expect(loader.getRaw("planner")).toBe("Custom planner prompt");
		// Other prompts should remain default
		expect(loader.getRaw("state-analyzer")).toBe("Default state analyzer prompt\n\n{{memory}}");
	});

	it("should replace template variables in resolve()", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const result = loader.resolve("planner", { memory: "some memory content" });
		expect(result).toContain("some memory content");
		expect(result).not.toContain("{{memory}}");
	});

	it("should replace unmatched variables with empty string", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const result = loader.resolve("planner");
		expect(result).not.toContain("{{memory}}");
	});

	it("should merge global context via setGlobalContext()", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		loader.setGlobalContext({ memory: "global memory" });
		const result = loader.resolve("planner");
		expect(result).toContain("global memory");
	});

	it("should prioritize call-time context over global context", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		loader.setGlobalContext({ memory: "global memory" });
		const result = loader.resolve("planner", { memory: "call-time memory" });
		expect(result).toContain("call-time memory");
		expect(result).not.toContain("global memory");
	});

	it("should return empty string for unknown prompt names", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const result = loader.getRaw("nonexistent" as any);
		expect(result).toBe("");
	});

	it("should return empty string when builtin dir has no files", async () => {
		const emptyDir = join(tempDir, "empty");
		await mkdir(emptyDir, { recursive: true });

		const loader = new PromptLoader(emptyDir);
		await loader.load(tempDir);

		expect(loader.getRaw("planner")).toBe("");
	});
});
