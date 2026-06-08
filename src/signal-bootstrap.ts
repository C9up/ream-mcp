/**
 * Side-effect-only module that installs minimal SIGTERM/SIGINT
 * handlers BEFORE any heavy imports run.
 *
 * Why: ESM hoists static imports to the top of every module, so by
 * the time `bootstrap()` (and its `installSignalHandlers` call) has
 * a chance to run, several hundred milliseconds of `import` work
 * may already have elapsed (`@modelcontextprotocol/sdk`,
 * `ts-morph`, etc.). A SIGTERM that arrives in that window would
 * trigger Node's default action — terminate with exit code 143 —
 * because no handler is registered yet.
 *
 * `index.ts` imports this module FIRST so the basic handler is
 * installed before `server.ts` is loaded. The proper close-driven
 * handler in `server.ts::installSignalHandlers` calls
 * `uninstallEarlyHandlers()` and replaces it.
 */

let earlyHandler: ((signal: NodeJS.Signals) => void) | null = (
	_signal: NodeJS.Signals,
) => {
	process.exit(0);
};

process.on("SIGTERM", earlyHandler);
process.on("SIGINT", earlyHandler);

export function uninstallEarlyHandlers(): void {
	if (!earlyHandler) return;
	process.off("SIGTERM", earlyHandler);
	process.off("SIGINT", earlyHandler);
	earlyHandler = null;
}
