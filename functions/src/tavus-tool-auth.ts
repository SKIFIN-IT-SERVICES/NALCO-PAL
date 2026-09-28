/**
 * Shared HMAC verification for HTTPS-delivered Tavus tool calls. Every tool
 * endpoint in this codebase (aluminiumPriceTool, and now the quiz tools)
 * uses the same shared secret (TAVUS_TOOL_HMAC_SECRET) and the same
 * signature scheme, so this is the one place that logic lives.
 */

import * as crypto from "crypto";

export function verifyTavusSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
	const secret = process.env.TAVUS_TOOL_HMAC_SECRET;
	if (!secret) return false;
	if (!signatureHeader) return false;
	const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
	const expectedBuf = Buffer.from(expected, "hex");
	const gotBuf = Buffer.from(signatureHeader, "hex");
	if (expectedBuf.length !== gotBuf.length) return false;
	return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

/** Parses the JSON-encoded `arguments` string Tavus sends with a tool call,
 * returning `{}` on anything malformed rather than throwing — a bad JSON
 * payload should never take down the whole tool call. */
export function parseToolArguments(argsRaw: unknown): Record<string, unknown> {
	if (typeof argsRaw !== "string" || !argsRaw.trim()) return {};
	try {
		const parsed = JSON.parse(argsRaw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
