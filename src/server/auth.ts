import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const AUTH_COOKIE_NAME = "clipilot_auth";

export function createServerAuthToken(): string {
	return randomBytes(24).toString("base64url");
}

export function buildAuthCookie(token: string): string {
	return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
	if (!cookieHeader) return {};

	const pairs = cookieHeader.split(";");
	const cookies: Record<string, string> = {};
	for (const pair of pairs) {
		const trimmed = pair.trim();
		if (!trimmed) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		cookies[key] = decodeURIComponent(value);
	}
	return cookies;
}

export function isAuthorized(headers: IncomingHttpHeaders, expectedToken: string): boolean {
	const cookies = parseCookies(headers.cookie);
	return cookies[AUTH_COOKIE_NAME] === expectedToken;
}
