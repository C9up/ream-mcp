/**
 * `ream-mcp-reindex --download-model`: the only path that fetches the
 * embeddings model. Driven with a fake fetcher — nothing here touches the
 * network.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { core } from "../../index.js";
import {
	describeDownload,
	downloadModel,
	type ModelManifest,
	parseModelManifest,
} from "../../src/util/model-download.js";

const GOOD = Buffer.from("the model bytes");
const SHA = createHash("sha256").update(GOOD).digest("hex");

let dir: string;
let requested: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ream-mcp-model-"));
	requested = [];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function manifest(path = "onnx/model.onnx"): ModelManifest {
	return {
		name: "test model",
		repo: "org/model",
		revision: "abc",
		dir,
		files: [
			{
				path,
				url: "https://example.test/org/model/resolve/abc/x",
				sha256: SHA,
				bytes: GOOD.byteLength,
			},
		],
	};
}

function serving(body: Uint8Array, status = 200) {
	return async (url: string): Promise<Response> => {
		requested.push(url);
		return new Response(Uint8Array.from(body), { status });
	};
}

const quiet = () => {};

describe("ream-mcp > model download", () => {
	it("writes a file whose bytes match the pinned SHA-256", async () => {
		const out = await downloadModel(manifest(), serving(GOOD), quiet);
		expect(out).toEqual({ fetched: ["onnx/model.onnx"], present: [] });
		expect(readFileSync(join(dir, "onnx", "model.onnx"))).toEqual(GOOD);
	});

	it("does not fetch a file already present and intact", async () => {
		mkdirSync(join(dir, "onnx"));
		writeFileSync(join(dir, "onnx", "model.onnx"), GOOD);
		const out = await downloadModel(manifest(), serving(GOOD), quiet);
		expect(out).toEqual({ fetched: [], present: ["onnx/model.onnx"] });
		expect(requested).toEqual([]);
	});

	it("refuses tampered bytes and leaves nothing behind", async () => {
		const tampered = Buffer.from("the model bytez");
		await expect(
			downloadModel(manifest(), serving(tampered), quiet),
		).rejects.toThrow(/pinned SHA-256/);
		expect(readdirSync(join(dir, "onnx"))).toEqual([]);
	});

	it("stops reading a response longer than the pinned size", async () => {
		const longer = Buffer.concat([GOOD, Buffer.alloc(1024 * 1024)]);
		await expect(
			downloadModel(manifest(), serving(longer), quiet),
		).rejects.toThrow(/more than the pinned/);
		expect(readdirSync(join(dir, "onnx"))).toEqual([]);
	});

	it("replaces a corrupted local copy", async () => {
		mkdirSync(join(dir, "onnx"));
		writeFileSync(join(dir, "onnx", "model.onnx"), "the model bytez");
		const out = await downloadModel(manifest(), serving(GOOD), quiet);
		expect(out.fetched).toEqual(["onnx/model.onnx"]);
		expect(readFileSync(join(dir, "onnx", "model.onnx"))).toEqual(GOOD);
	});

	it("fails on an HTTP error", async () => {
		await expect(
			downloadModel(manifest(), serving(GOOD, 404), quiet),
		).rejects.toThrow(/HTTP 404/);
	});

	it("refuses a manifest path that leaves the model directory", async () => {
		await expect(
			downloadModel(manifest("../escape.onnx"), serving(GOOD), quiet),
		).rejects.toThrow(/escapes/);
		expect(requested).toEqual([]);
		expect(existsSync(join(dir, "..", "escape.onnx"))).toBe(false);
	});

	it("says what it fetches, how much, and from where", () => {
		const text = describeDownload(manifest());
		expect(text).toContain("org/model at revision abc");
		expect(text).toContain("from example.test");
		expect(text).toContain(dir);
	});

	it("reads the native core's pinned manifest", () => {
		const real = parseModelManifest(core.embeddingModel());
		expect(real.files.map((f) => f.path).sort()).toEqual([
			"config.json",
			"onnx/model.onnx",
			"special_tokens_map.json",
			"tokenizer.json",
			"tokenizer_config.json",
		]);
		for (const file of real.files) {
			expect(file.url).toBe(
				`https://huggingface.co/${real.repo}/resolve/${real.revision}/${file.path}`,
			);
		}
	});

	it("rejects a manifest whose digest is not a SHA-256", () => {
		const bad = {
			...manifest(),
			files: [{ ...manifest().files[0], sha256: "x" }],
		};
		expect(() => parseModelManifest(JSON.stringify(bad))).toThrow(
			/unexpected embeddings model manifest/,
		);
	});
});
