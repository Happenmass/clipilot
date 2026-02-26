import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createEmbeddingProvider,
	createGeminiEmbeddingProvider,
	createRemoteEmbeddingProvider,
	embedBatchWithRetry,
	enforceEmbeddingMaxInputTokens,
	fetchRemoteEmbeddingVectors,
	isAuthError,
	resolveRemoteEmbeddingClient,
} from "../../src/memory/embedder.js";
import type { EmbeddingProvider, MemoryChunk } from "../../src/memory/types.js";

describe("resolveRemoteEmbeddingClient", () => {
	it("should use apiKey from config", () => {
		const client = resolveRemoteEmbeddingClient({
			provider: "openai",
			model: "text-embedding-3-small",
			config: { apiKey: "sk-test-key" },
		});
		expect(client).toBeDefined();
		expect(client!.headers.Authorization).toBe("Bearer sk-test-key");
		expect(client!.model).toBe("text-embedding-3-small");
		expect(client!.baseUrl).toBe("https://api.openai.com/v1");
	});

	it("should fallback to env variable", () => {
		process.env.OPENAI_API_KEY = "sk-env-key";
		const client = resolveRemoteEmbeddingClient({
			provider: "openai",
			model: "text-embedding-3-small",
		});
		expect(client).toBeDefined();
		expect(client!.headers.Authorization).toBe("Bearer sk-env-key");
		delete process.env.OPENAI_API_KEY;
	});

	it("should return null when no key available", () => {
		delete process.env.OPENAI_API_KEY;
		const client = resolveRemoteEmbeddingClient({
			provider: "openai",
			model: "text-embedding-3-small",
		});
		expect(client).toBeNull();
	});

	it("should use custom baseUrl from config", () => {
		const client = resolveRemoteEmbeddingClient({
			provider: "openai",
			model: "test-model",
			config: { apiKey: "sk-test", baseUrl: "https://custom.api.com/v1" },
		});
		expect(client!.baseUrl).toBe("https://custom.api.com/v1");
	});

	it("should merge custom headers", () => {
		const client = resolveRemoteEmbeddingClient({
			provider: "openai",
			model: "test-model",
			config: { apiKey: "sk-test", headers: { "X-Custom": "value" } },
		});
		expect(client!.headers["X-Custom"]).toBe("value");
		expect(client!.headers.Authorization).toBe("Bearer sk-test");
	});
});

describe("createRemoteEmbeddingProvider", () => {
	it("should create provider with correct id and model", () => {
		const provider = createRemoteEmbeddingProvider({
			id: "openai",
			client: {
				model: "text-embedding-3-small",
				baseUrl: "https://api.openai.com/v1",
				headers: { Authorization: "Bearer test" },
			},
		});
		expect(provider.id).toBe("openai");
		expect(provider.model).toBe("text-embedding-3-small");
		expect(typeof provider.embedQuery).toBe("function");
		expect(typeof provider.embedBatch).toBe("function");
	});
});

describe("createGeminiEmbeddingProvider", () => {
	it("should create provider with gemini id", () => {
		const provider = createGeminiEmbeddingProvider({
			apiKeys: ["key1"],
			model: "gemini-embedding-001",
		});
		expect(provider.id).toBe("gemini");
		expect(provider.model).toBe("gemini-embedding-001");
	});

	it("should use all API keys in rotation on failure", async () => {
		const attempts: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const urlStr = String(url);
			const keyMatch = urlStr.match(/key=(\w+)/);
			if (keyMatch) attempts.push(keyMatch[1]);

			// First two keys fail, third succeeds
			if (attempts.length < 3) {
				return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
			}
			return new Response(
				JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }),
				{ status: 200 },
			);
		}) as any;

		const provider = createGeminiEmbeddingProvider({
			apiKeys: ["keyA", "keyB", "keyC"],
			model: "gemini-embedding-001",
		});

		const result = await provider.embedQuery("test");
		expect(result).toEqual([0.1, 0.2, 0.3]);
		expect(attempts).toEqual(["keyA", "keyB", "keyC"]);

		globalThis.fetch = originalFetch;
	});
});

describe("createEmbeddingProvider factory", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save and clear all embedding env vars
		for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "VOYAGE_API_KEY", "MISTRAL_API_KEY"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		// Restore env vars
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("auto mode should return null when no providers available", async () => {
		const result = await createEmbeddingProvider({
			provider: "auto",
			fallback: "none",
		});
		expect(result.provider).toBeNull();
		expect(result.unavailableReason).toBeDefined();
	});

	it("auto mode should detect openai when OPENAI_API_KEY is set", async () => {
		process.env.OPENAI_API_KEY = "sk-test-auto";
		const result = await createEmbeddingProvider({
			provider: "auto",
			fallback: "none",
		});
		expect(result.provider).toBeDefined();
		expect(result.provider!.id).toBe("openai");
	});

	it("auto mode should detect gemini when GEMINI_API_KEY is set", async () => {
		process.env.GEMINI_API_KEY = "gem-test";
		const result = await createEmbeddingProvider({
			provider: "auto",
			fallback: "none",
		});
		expect(result.provider).toBeDefined();
		expect(result.provider!.id).toBe("gemini");
	});

	it("explicit mode should return specified provider", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const result = await createEmbeddingProvider({
			provider: "openai",
			fallback: "none",
		});
		expect(result.provider).toBeDefined();
		expect(result.provider!.id).toBe("openai");
	});

	it("explicit mode should fallback when primary unavailable", async () => {
		process.env.MISTRAL_API_KEY = "mistral-key";
		const result = await createEmbeddingProvider({
			provider: "openai",
			fallback: "mistral",
		});
		expect(result.provider).toBeDefined();
		expect(result.provider!.id).toBe("mistral");
		expect(result.fallbackFrom).toBe("openai");
		expect(result.fallbackReason).toBeDefined();
	});

	it("explicit mode should return null when both unavailable", async () => {
		const result = await createEmbeddingProvider({
			provider: "openai",
			fallback: "mistral",
		});
		expect(result.provider).toBeNull();
		expect(result.unavailableReason).toBeDefined();
	});

	it("explicit mode with fallback=none should return null when provider unavailable", async () => {
		const result = await createEmbeddingProvider({
			provider: "voyage",
			fallback: "none",
		});
		expect(result.provider).toBeNull();
	});
});

describe("isAuthError", () => {
	it("should detect 401 status", () => {
		expect(isAuthError({ status: 401 })).toBe(true);
	});

	it("should detect 403 status", () => {
		expect(isAuthError({ status: 403 })).toBe(true);
	});

	it("should detect unauthorized message", () => {
		expect(isAuthError({ message: "Unauthorized access" })).toBe(true);
	});

	it("should detect invalid api key message", () => {
		expect(isAuthError({ message: "Invalid API key provided" })).toBe(true);
	});

	it("should not flag 500 errors as auth errors", () => {
		expect(isAuthError({ status: 500, message: "Internal server error" })).toBe(false);
	});

	it("should handle null/undefined", () => {
		expect(isAuthError(null)).toBe(false);
		expect(isAuthError(undefined)).toBe(false);
	});
});

describe("embedBatchWithRetry", () => {
	it("should return on first success", async () => {
		const provider: EmbeddingProvider = {
			id: "test",
			model: "test-model",
			embedQuery: async () => [0.1],
			embedBatch: async (texts) => texts.map(() => [0.1, 0.2]),
		};

		const result = await embedBatchWithRetry(provider, ["hello", "world"]);
		expect(result).toEqual([[0.1, 0.2], [0.1, 0.2]]);
	});

	it("should retry on transient errors", async () => {
		let attempts = 0;
		const provider: EmbeddingProvider = {
			id: "test",
			model: "test-model",
			embedQuery: async () => [0.1],
			embedBatch: async (texts) => {
				attempts++;
				if (attempts < 3) {
					const err = new Error("Server error");
					(err as any).status = 500;
					throw err;
				}
				return texts.map(() => [0.5]);
			},
		};

		const result = await embedBatchWithRetry(provider, ["test"]);
		expect(result).toEqual([[0.5]]);
		expect(attempts).toBe(3);
	});

	it("should NOT retry auth errors", async () => {
		let attempts = 0;
		const provider: EmbeddingProvider = {
			id: "test",
			model: "test-model",
			embedQuery: async () => [0.1],
			embedBatch: async () => {
				attempts++;
				const err = new Error("Unauthorized");
				(err as any).status = 401;
				throw err;
			},
		};

		await expect(embedBatchWithRetry(provider, ["test"])).rejects.toThrow("Unauthorized");
		expect(attempts).toBe(1);
	});

	it("should throw after max retries", async () => {
		const provider: EmbeddingProvider = {
			id: "test",
			model: "test-model",
			embedQuery: async () => [0.1],
			embedBatch: async () => {
				const err = new Error("Server overloaded");
				(err as any).status = 503;
				throw err;
			},
		};

		await expect(embedBatchWithRetry(provider, ["test"])).rejects.toThrow("Server overloaded");
	});
});

describe("enforceEmbeddingMaxInputTokens", () => {
	const provider: EmbeddingProvider = {
		id: "test",
		model: "test-model",
		maxInputTokens: 100, // → maxChars = 400
		embedQuery: async () => [0.1],
		embedBatch: async () => [[0.1]],
	};

	it("should pass through chunks within limit", () => {
		const chunks: MemoryChunk[] = [
			{ startLine: 1, endLine: 5, text: "short text", hash: "h1" },
		];
		const result = enforceEmbeddingMaxInputTokens(provider, chunks);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("short text");
	});

	it("should split oversized chunks", () => {
		const longText = "x".repeat(900); // > 400 chars limit
		const chunks: MemoryChunk[] = [
			{ startLine: 1, endLine: 10, text: longText, hash: "h1" },
		];
		const result = enforceEmbeddingMaxInputTokens(provider, chunks);
		expect(result.length).toBeGreaterThan(1);
		expect(result[0].text.length).toBeLessThanOrEqual(400);
		// All pieces should have the same line numbers
		for (const piece of result) {
			expect(piece.startLine).toBe(1);
			expect(piece.endLine).toBe(10);
		}
	});

	it("should produce unique hashes for split chunks", () => {
		const longText = "a".repeat(400) + "b".repeat(400) + "c".repeat(100);
		const chunks: MemoryChunk[] = [
			{ startLine: 1, endLine: 1, text: longText, hash: "h1" },
		];
		const result = enforceEmbeddingMaxInputTokens(provider, chunks);
		const hashes = new Set(result.map((c) => c.hash));
		expect(hashes.size).toBe(result.length);
	});

	it("should not split chunks exactly at limit", () => {
		const exactText = "x".repeat(400);
		const chunks: MemoryChunk[] = [
			{ startLine: 1, endLine: 1, text: exactText, hash: "h1" },
		];
		const result = enforceEmbeddingMaxInputTokens(provider, chunks);
		expect(result).toHaveLength(1);
	});

	it("should use KNOWN_LIMITS when maxInputTokens not set", () => {
		const providerNoLimit: EmbeddingProvider = {
			id: "openai",
			model: "text-embedding-3-small",
			// maxInputTokens not set → looks up KNOWN_LIMITS["openai:text-embedding-3-small"] = 8192 → maxChars = 32768
			embedQuery: async () => [0.1],
			embedBatch: async () => [[0.1]],
		};
		const text = "x".repeat(30000); // Within 32768
		const chunks: MemoryChunk[] = [
			{ startLine: 1, endLine: 1, text, hash: "h1" },
		];
		const result = enforceEmbeddingMaxInputTokens(providerNoLimit, chunks);
		expect(result).toHaveLength(1);
	});
});
