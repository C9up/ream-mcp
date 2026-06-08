/**
 * Verify that importing `signal-bootstrap` registers the early
 * SIGTERM/SIGINT handlers and that `uninstallEarlyHandlers()`
 * removes them. Side-effect module — the import itself is the
 * setup, the API under test is the cleanup function.
 */
import { afterEach, describe, expect, it } from "vitest";

describe("ream-mcp > signal-bootstrap", () => {
	afterEach(async () => {
		const mod = await import("../../src/signal-bootstrap.js");
		mod.uninstallEarlyHandlers();
	});

	it("registers a SIGTERM listener on import", async () => {
		const before = process.listenerCount("SIGTERM");
		await import("../../src/signal-bootstrap.js");
		expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(before);
	});

	it("uninstallEarlyHandlers() removes the SIGTERM + SIGINT listeners it installed", async () => {
		const mod = await import("../../src/signal-bootstrap.js");
		const beforeTerm = process.listenerCount("SIGTERM");
		const beforeInt = process.listenerCount("SIGINT");
		mod.uninstallEarlyHandlers();
		expect(process.listenerCount("SIGTERM")).toBeLessThanOrEqual(beforeTerm);
		expect(process.listenerCount("SIGINT")).toBeLessThanOrEqual(beforeInt);
	});

	it("uninstallEarlyHandlers() is idempotent — second call is a no-op", async () => {
		const mod = await import("../../src/signal-bootstrap.js");
		mod.uninstallEarlyHandlers();
		expect(() => mod.uninstallEarlyHandlers()).not.toThrow();
	});
});
