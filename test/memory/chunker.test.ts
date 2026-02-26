import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/memory/chunker.js";

describe("chunkMarkdown", () => {
	it("should return empty array for empty content", () => {
		const chunks = chunkMarkdown("");
		expect(chunks).toHaveLength(1); // One chunk with empty string
		expect(chunks[0].text).toBe("");
		expect(chunks[0].startLine).toBe(1);
		expect(chunks[0].endLine).toBe(1);
	});

	it("should handle single line content", () => {
		const chunks = chunkMarkdown("Hello world");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe("Hello world");
		expect(chunks[0].startLine).toBe(1);
		expect(chunks[0].endLine).toBe(1);
		expect(chunks[0].hash).toBeTruthy();
	});

	it("should produce correct line numbers (1-indexed)", () => {
		const content = "line1\nline2\nline3\nline4\nline5";
		const chunks = chunkMarkdown(content, { tokens: 1000, overlap: 0 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].startLine).toBe(1);
		expect(chunks[0].endLine).toBe(5);
	});

	it("should split content into chunks respecting maxChars", () => {
		// Each line is ~20 chars, maxChars = 50 (tokens=12), so ~2 lines per chunk
		const lines = Array.from({ length: 10 }, (_, i) => `Line number ${i + 1} here`);
		const content = lines.join("\n");
		const chunks = chunkMarkdown(content, { tokens: 12, overlap: 0 });

		expect(chunks.length).toBeGreaterThan(1);
		// First chunk should start at line 1
		expect(chunks[0].startLine).toBe(1);
		// Last chunk should end at the last line
		expect(chunks[chunks.length - 1].endLine).toBe(10);
	});

	it("should carry overlap between chunks", () => {
		// Create content where each line is ~100 chars
		const makeLine = (n: number) => `Line ${n}: ${"x".repeat(90)}`;
		const lines = Array.from({ length: 10 }, (_, i) => makeLine(i + 1));
		const content = lines.join("\n");

		// tokens=50 → maxChars=200, overlap=25 → overlapChars=100
		const chunks = chunkMarkdown(content, { tokens: 50, overlap: 25 });

		expect(chunks.length).toBeGreaterThan(1);

		// Check that chunks overlap: chunk[1].startLine <= chunk[0].endLine
		if (chunks.length >= 2) {
			expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
		}
	});

	it("should handle oversized single line gracefully", () => {
		// A single line that exceeds maxChars
		const longLine = "x".repeat(5000);
		const chunks = chunkMarkdown(longLine, { tokens: 100, overlap: 20 });

		// Should still produce at least one chunk containing the long line
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		expect(chunks[0].text).toBe(longLine);
	});

	it("should produce unique hashes for different content", () => {
		// Each line has unique content so chunks will differ
		const lines = Array.from({ length: 40 }, (_, i) => `unique line ${i}: ${String.fromCharCode(65 + (i % 26))}`);
		const content = lines.join("\n");
		const chunks = chunkMarkdown(content, { tokens: 20, overlap: 0 });

		if (chunks.length >= 2) {
			const hashes = new Set(chunks.map((c) => c.hash));
			expect(hashes.size).toBe(chunks.length);
		}
	});

	it("should use default config when none provided", () => {
		const content = "test content line\n".repeat(500);
		const chunks = chunkMarkdown(content);

		// Default tokens=400, maxChars=1600
		// Each line is ~18 chars, so ~88 lines per chunk → should produce multiple chunks
		expect(chunks.length).toBeGreaterThan(1);
	});
});
