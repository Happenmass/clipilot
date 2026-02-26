import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextManager } from "../../src/core/context-manager.js";

function createMockPromptLoader(template: string) {
	return {
		getRaw: vi.fn().mockReturnValue(template),
		resolve: vi.fn().mockReturnValue("You are a history compressor."),
		load: vi.fn(),
		setGlobalContext: vi.fn(),
	} as any;
}

function createMockLLMClient(compressedResult = "## Completed Tasks\n- #1 Setup: done") {
	return {
		complete: vi.fn().mockResolvedValue({ content: compressedResult }),
		completeJson: vi.fn(),
		stream: vi.fn(),
	} as any;
}

describe("ContextManager", () => {
	let contextManager: ContextManager;
	let mockLLM: ReturnType<typeof createMockLLMClient>;
	let mockPromptLoader: ReturnType<typeof createMockPromptLoader>;

	const template = "Goal: {{goal}}\nTasks: {{task_graph_summary}}\nHistory: {{compressed_history}}\nMemory: {{memory}}";

	beforeEach(() => {
		mockLLM = createMockLLMClient();
		mockPromptLoader = createMockPromptLoader(template);
		contextManager = new ContextManager({
			llmClient: mockLLM,
			promptLoader: mockPromptLoader,
		});
	});

	describe("module replacement", () => {
		it("should replace template variables with module values", () => {
			contextManager.updateModule("goal", "Build an API");
			contextManager.updateModule("task_graph_summary", "[✓]#1 [ ]#2");

			const prompt = contextManager.getSystemPrompt();
			expect(prompt).toContain("Goal: Build an API");
			expect(prompt).toContain("Tasks: [✓]#1 [ ]#2");
		});

		it("should clear unreplaced variables", () => {
			contextManager.updateModule("goal", "Test");

			const prompt = contextManager.getSystemPrompt();
			expect(prompt).not.toContain("{{");
			expect(prompt).toContain("Goal: Test");
			expect(prompt).toContain("History: ");
		});

		it("should update modules dynamically", () => {
			contextManager.updateModule("goal", "v1");
			expect(contextManager.getSystemPrompt()).toContain("Goal: v1");

			contextManager.updateModule("goal", "v2");
			expect(contextManager.getSystemPrompt()).toContain("Goal: v2");
		});
	});

	describe("conversation management", () => {
		it("should start with empty conversation", () => {
			expect(contextManager.getMessages()).toHaveLength(0);
		});

		it("should add messages to conversation", () => {
			contextManager.addMessage({ role: "user", content: "hello" });
			contextManager.addMessage({ role: "assistant", content: "hi" });

			const msgs = contextManager.getMessages();
			expect(msgs).toHaveLength(2);
			expect(msgs[0].role).toBe("user");
			expect(msgs[1].role).toBe("assistant");
		});

		it("should track conversation length", () => {
			expect(contextManager.getConversationLength()).toBe(0);
			contextManager.addMessage({ role: "user", content: "test" });
			expect(contextManager.getConversationLength()).toBe(1);
		});
	});

	describe("shouldCompress", () => {
		it("should return false when under threshold", () => {
			contextManager.addMessage({ role: "user", content: "short message" });
			expect(contextManager.shouldCompress()).toBe(false);
		});

		it("should return true when over threshold", () => {
			// With default 128000 limit and 0.7 threshold = 89600 tokens
			// Each char ~0.25 tokens, so need ~358400 chars
			const longContent = "x".repeat(360000);
			contextManager.addMessage({ role: "user", content: longContent });
			expect(contextManager.shouldCompress()).toBe(true);
		});

		it("should respect custom thresholds", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000,
				compressionThreshold: 0.5,
				flushThreshold: 0.3, // Must be < compressionThreshold
			});
			// Threshold: 1000 * 0.5 = 500 tokens = ~2000 chars
			smallCtx.addMessage({ role: "user", content: "x".repeat(2100) });
			expect(smallCtx.shouldCompress()).toBe(true);
		});
	});

	describe("compress", () => {
		it("should call LLM with conversation and existing history", async () => {
			contextManager.updateModule("goal", "Build API");
			contextManager.updateModule("task_graph_summary", "[✓]#1");
			contextManager.updateModule("compressed_history", "Previous context");
			contextManager.addMessage({ role: "user", content: "[TASK_READY] Task #2" });
			contextManager.addMessage({ role: "assistant", content: "Starting task" });

			await contextManager.compress();

			expect(mockLLM.complete).toHaveBeenCalledOnce();
			const callArgs = mockLLM.complete.mock.calls[0];
			const input = JSON.parse(callArgs[0][0].content);
			expect(input.existing_history).toBe("Previous context");
			expect(input.new_conversation).toHaveLength(2);
			expect(input.current_goal).toBe("Build API");
		});

		it("should update compressed_history module and clear conversation", async () => {
			contextManager.addMessage({ role: "user", content: "test" });
			contextManager.addMessage({ role: "user", content: "test2" });

			await contextManager.compress();

			// After compress, conversation has 1 post-compaction context message
			expect(contextManager.getMessages()).toHaveLength(1);
			expect(contextManager.getMessages()[0].content).toContain("CONTEXT_RECOVERY");
			expect(contextManager.getSystemPrompt()).toContain("## Completed Tasks");
		});

		it("should handle empty existing history", async () => {
			contextManager.addMessage({ role: "user", content: "first message" });

			await contextManager.compress();

			const callArgs = mockLLM.complete.mock.calls[0];
			const input = JSON.parse(callArgs[0][0].content);
			expect(input.existing_history).toBe("");
		});
	});

	// ─── Task 7.9: New upgrade tests ─────────────────────

	describe("prepareForLLM", () => {
		it("should return system prompt and deep-cloned messages", () => {
			contextManager.updateModule("goal", "Build API");
			contextManager.addMessage({ role: "user", content: "hello" });
			contextManager.addMessage({ role: "assistant", content: "hi" });

			const prepared = contextManager.prepareForLLM();

			expect(prepared.system).toContain("Goal: Build API");
			expect(prepared.messages).toHaveLength(2);
			expect(prepared.messages[0].content).toBe("hello");
		});

		it("should preserve original conversation (deep clone)", () => {
			contextManager.addMessage({ role: "user", content: "original" });

			const prepared = contextManager.prepareForLLM();

			// Mutate the prepared messages
			(prepared.messages[0] as any).content = "mutated";

			// Original should be unchanged
			expect(contextManager.getMessages()[0].content).toBe("original");
		});

		it("should not modify the original conversation after transformContext", () => {
			// Add a large tool result that would be truncated
			contextManager.addMessage({ role: "user", content: "call tool" });
			contextManager.addMessage({
				role: "tool",
				content: "x".repeat(300000), // Very large tool result
				tool_use_id: "t1",
			});

			const original = contextManager.getMessages();
			const originalToolContent = (original[1] as any).content;

			contextManager.prepareForLLM();

			// Original should be unchanged
			expect(contextManager.getMessages()[1].content).toBe(originalToolContent);
		});
	});

	describe("transformContext", () => {
		it("should truncate single tool result exceeding 50% of context window", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000, // 50% cap = 500 tokens = 2000 chars
				flushThreshold: 0.3,
			});

			smallCtx.addMessage({ role: "user", content: "test" });
			smallCtx.addMessage({
				role: "tool",
				content: "x".repeat(3000), // exceeds 2000 char cap
				tool_use_id: "t1",
			});

			const prepared = smallCtx.prepareForLLM();
			const toolMsg = prepared.messages.find((m) => m.role === "tool");

			expect((toolMsg as any).content.length).toBeLessThan(3000);
			expect((toolMsg as any).content).toContain("[truncated]");
		});

		it("should compact oldest tool results when budget overflow (75% cap)", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200, // 75% = 150 tokens = 600 chars
				flushThreshold: 0.3,
			});

			// Add multiple tool results that collectively exceed budget
			smallCtx.addMessage({ role: "user", content: "call tool 1" });
			smallCtx.addMessage({ role: "tool", content: "A".repeat(400), tool_use_id: "t1" });
			smallCtx.addMessage({ role: "user", content: "call tool 2" });
			smallCtx.addMessage({ role: "tool", content: "B".repeat(400), tool_use_id: "t2" });

			const prepared = smallCtx.prepareForLLM();

			// The oldest tool result should be compacted
			const firstToolMsg = prepared.messages.find((m) => m.role === "tool");
			expect((firstToolMsg as any).content).toContain("compacted");
		});
	});

	describe("hybrid token counting", () => {
		it("should accumulate pending chars from addMessage", () => {
			contextManager.addMessage({ role: "user", content: "hello" }); // 5 chars
			contextManager.addMessage({ role: "assistant", content: "world" }); // 5 chars

			// getCurrentTokenEstimate: lastKnownTokenCount(0) + ceil(10/4) = 3
			const estimate = contextManager.getCurrentTokenEstimate();
			expect(estimate).toBe(3); // ceil(10/4)
		});

		it("should reset pending chars on reportUsage", () => {
			contextManager.addMessage({ role: "user", content: "hello" });

			contextManager.reportUsage({ inputTokens: 50, outputTokens: 20 });

			// After report: lastKnown = 70, pending = 0
			expect(contextManager.getCurrentTokenEstimate()).toBe(70);
		});

		it("should combine lastKnown + pending estimate", () => {
			contextManager.reportUsage({ inputTokens: 100, outputTokens: 50 });
			// lastKnown = 150, pending = 0

			contextManager.addMessage({ role: "user", content: "x".repeat(40) });
			// pending = 40, pendingTokens = ceil(40/4) = 10

			expect(contextManager.getCurrentTokenEstimate()).toBe(160); // 150 + 10
		});

		it("should use hybrid counting in shouldCompress when usage reported", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200, // threshold at 0.7 = 140 tokens
				flushThreshold: 0.3,
			});

			// Report 150 tokens — exceeds 140 threshold
			smallCtx.reportUsage({ inputTokens: 100, outputTokens: 50 });

			expect(smallCtx.shouldCompress()).toBe(true);
		});

		it("should fall back to char estimation when no usage reported", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000,
				compressionThreshold: 0.5,
				flushThreshold: 0.3,
			});

			// No reportUsage called — falls back to estimateTokens
			smallCtx.addMessage({ role: "user", content: "x".repeat(2100) });
			expect(smallCtx.shouldCompress()).toBe(true);
		});
	});

	describe("memory flush trigger logic", () => {
		it("should not trigger flush when no memoryStore", () => {
			// Default contextManager has no memoryStore
			expect(contextManager.shouldRunMemoryFlush()).toBe(false);
		});

		it("should not trigger flush when under threshold", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000,
				flushThreshold: 0.3,
				memoryStore: { write: vi.fn(), close: vi.fn() } as any,
			});

			// Token estimate is 0 — well under 300 (1000 * 0.3)
			expect(ctx.shouldRunMemoryFlush()).toBe(false);
		});

		it("should trigger flush when above threshold with memoryStore", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3, // 200 * 0.3 = 60 tokens
				memoryStore: { write: vi.fn(), close: vi.fn() } as any,
			});

			// Report 70 tokens — exceeds 60 threshold
			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 });

			expect(ctx.shouldRunMemoryFlush()).toBe(true);
		});

		it("should not trigger flush twice in same compaction cycle", async () => {
			const mockStore = { write: vi.fn(), close: vi.fn() } as any;
			const mockLLMWithToolCalls = {
				...mockLLM,
				complete: vi.fn().mockResolvedValue({
					content: "flushed",
					contentBlocks: [{ type: "text", text: "flushed" }],
				}),
			};

			const ctx = new ContextManager({
				llmClient: mockLLMWithToolCalls,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3,
				memoryStore: mockStore,
			});

			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 }); // > 60

			expect(ctx.shouldRunMemoryFlush()).toBe(true);

			// Simulate running flush (updates lastFlushCompactionCount)
			await ctx.runMemoryFlush();

			// Should not trigger again in same cycle
			expect(ctx.shouldRunMemoryFlush()).toBe(false);
		});

		it("should re-enable flush after compaction", async () => {
			const mockStore = { write: vi.fn(), close: vi.fn() } as any;
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3,
				memoryStore: mockStore,
			});

			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 });
			expect(ctx.shouldRunMemoryFlush()).toBe(true);

			// Simulate flush
			await ctx.runMemoryFlush();
			expect(ctx.shouldRunMemoryFlush()).toBe(false);

			// Now compress (increments compactionCount)
			ctx.addMessage({ role: "user", content: "test" });
			await ctx.compress();

			// After compaction, token counts reset, so need to report usage again
			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 });

			// Flush should be re-enabled (new compaction cycle)
			expect(ctx.shouldRunMemoryFlush()).toBe(true);
		});
	});

	describe("threshold invariant", () => {
		it("should throw if flushThreshold >= compressionThreshold", () => {
			expect(() => {
				new ContextManager({
					llmClient: mockLLM,
					promptLoader: mockPromptLoader,
					flushThreshold: 0.8,
					compressionThreshold: 0.7,
				});
			}).toThrow("flushThreshold (0.8) must be less than compressionThreshold (0.7)");
		});

		it("should throw if flushThreshold equals compressionThreshold", () => {
			expect(() => {
				new ContextManager({
					llmClient: mockLLM,
					promptLoader: mockPromptLoader,
					flushThreshold: 0.7,
					compressionThreshold: 0.7,
				});
			}).toThrow("flushThreshold (0.7) must be less than compressionThreshold (0.7)");
		});

		it("should accept valid flush < compress thresholds", () => {
			expect(() => {
				new ContextManager({
					llmClient: mockLLM,
					promptLoader: mockPromptLoader,
					flushThreshold: 0.5,
					compressionThreshold: 0.7,
				});
			}).not.toThrow();
		});
	});
});
