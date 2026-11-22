/**
 * Newline-delimited JSON-RPC over a pair of streams — stdin and stdout for the
 * real server, in-memory streams in tests.
 *
 * Framing follows the MCP stdio transport: one message per line, UTF-8, no
 * embedded newline. A line longer than {@link MAX_LINE_BYTES} is discarded up
 * to its newline and reported once, so a client that sends a huge or endless
 * line cannot grow this process's memory without bound.
 */

import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** The SDK's stdio buffer limit, kept: 10 MiB for one message. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

export interface LineHandlers {
	line(text: string): void;
	/** A line went over the limit; its bytes were dropped. */
	oversized(): void;
	end(): void;
}

export class StdioLines {
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #handlers: LineHandlers;
	readonly #decoder = new StringDecoder("utf8");
	#pending = "";
	#pendingBytes = 0;
	/** Inside an oversized line: drop everything until its newline. */
	#skipping = false;
	#closed = false;
	readonly #onData = (chunk: Buffer | string): void => {
		this.#accept(
			typeof chunk === "string" ? chunk : this.#decoder.write(chunk),
		);
	};
	readonly #onEnd = (): void => {
		this.#accept(this.#decoder.end());
		this.close();
	};

	constructor(input: Readable, output: Writable, handlers: LineHandlers) {
		this.#input = input;
		this.#output = output;
		this.#handlers = handlers;
		input.on("data", this.#onData);
		input.on("end", this.#onEnd);
	}

	#accept(text: string): void {
		let start = 0;
		while (start < text.length) {
			const newline = text.indexOf("\n", start);
			const piece =
				newline === -1 ? text.slice(start) : text.slice(start, newline);
			if (!this.#skipping) {
				this.#pendingBytes += Buffer.byteLength(piece, "utf8");
				if (this.#pendingBytes > MAX_LINE_BYTES) {
					this.#pending = "";
					this.#pendingBytes = 0;
					this.#skipping = true;
					this.#handlers.oversized();
				} else {
					this.#pending += piece;
				}
			}
			if (newline === -1) return;
			if (this.#skipping) {
				this.#skipping = false;
			} else {
				const line = this.#pending.endsWith("\r")
					? this.#pending.slice(0, -1)
					: this.#pending;
				this.#pending = "";
				this.#pendingBytes = 0;
				if (line.trim().length > 0) this.#handlers.line(line);
			}
			start = newline + 1;
		}
	}

	/** Write one message as a line; resolves once the stream took it. */
	send(message: object): Promise<void> {
		if (this.#closed) return Promise.resolve();
		const line = `${JSON.stringify(message)}\n`;
		return new Promise((resolve) => {
			if (this.#output.write(line)) resolve();
			else this.#output.once("drain", () => resolve());
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#input.off("data", this.#onData);
		this.#input.off("end", this.#onEnd);
		this.#handlers.end();
	}
}
