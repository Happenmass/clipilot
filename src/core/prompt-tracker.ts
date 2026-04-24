/** Max prompts retained per agent session to prevent unbounded memory growth */
const MAX_PROMPTS_PER_SESSION = 200;

export class PromptTracker {
	private map = new Map<string, string[]>();

	record(sessionId: string, prompt: string): void {
		const arr = this.map.get(sessionId) ?? [];
		arr.push(prompt);
		// Evict oldest prompts when cap is exceeded
		if (arr.length > MAX_PROMPTS_PER_SESSION) {
			arr.splice(0, arr.length - MAX_PROMPTS_PER_SESSION);
		}
		this.map.set(sessionId, arr);
	}

	getFor(sessionId: string): string[] {
		return this.map.get(sessionId)?.slice() ?? [];
	}

	release(sessionId: string): void {
		this.map.delete(sessionId);
	}

	/** Release all tracked sessions */
	releaseAll(): void {
		this.map.clear();
	}
}
