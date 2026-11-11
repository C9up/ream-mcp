/**
 * The one place the embeddings model is fetched: `ream-mcp-reindex
 * --download-model`, run by the user, on purpose. The server never downloads
 * anything; it loads these files from disk after checking them again.
 *
 * What is fetched comes from the native core's pinned manifest
 * (`core.embeddingModel()`): a repository revision, and the size and SHA-256
 * of every file. Each file streams to `<name>.partial`, is checked, and only
 * then renamed into place; a file that does not match is deleted and the
 * command fails.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isRecord } from "./guards.js";

export interface ModelFileSpec {
	path: string;
	url: string;
	sha256: string;
	bytes: number;
}

export interface ModelManifest {
	name: string;
	repo: string;
	revision: string;
	dir: string;
	files: ModelFileSpec[];
}

export type Fetcher = (url: string) => Promise<Response>;

function isModelFileSpec(value: unknown): value is ModelFileSpec {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.url === "string" &&
		value.url.startsWith("https://") &&
		typeof value.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(value.sha256) &&
		typeof value.bytes === "number" &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes > 0
	);
}

/** The manifest JSON the native core returns, checked field by field. */
export function parseModelManifest(json: string): ModelManifest {
	const parsed: unknown = JSON.parse(json);
	if (
		!isRecord(parsed) ||
		typeof parsed.name !== "string" ||
		typeof parsed.repo !== "string" ||
		typeof parsed.revision !== "string" ||
		typeof parsed.dir !== "string" ||
		!isAbsolute(parsed.dir) ||
		!Array.isArray(parsed.files) ||
		parsed.files.length === 0 ||
		!parsed.files.every(isModelFileSpec)
	) {
		throw new Error(
			"unexpected embeddings model manifest from the native core",
		);
	}
	return {
		name: parsed.name,
		repo: parsed.repo,
		revision: parsed.revision,
		dir: parsed.dir,
		files: parsed.files,
	};
}

/** `dir/rel`, refusing a `rel` that would leave `dir`. */
function destination(dir: string, rel: string): string {
	const dest = resolve(dir, rel);
	const back = relative(dir, dest);
	if (back === "" || back.startsWith("..") || isAbsolute(back)) {
		throw new Error(`model file path escapes the model directory: ${rel}`);
	}
	return dest;
}

async function matches(path: string, file: ModelFileSpec): Promise<boolean> {
	try {
		if ((await stat(path)).size !== file.bytes) return false;
	} catch {
		return false;
	}
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex") === file.sha256;
}

function megabytes(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** What `downloadModel` will fetch, for the user to read first. */
export function describeDownload(manifest: ModelManifest): string {
	const total = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
	const hosts = [...new Set(manifest.files.map((f) => new URL(f.url).host))];
	return (
		`Fetching the embeddings model ${manifest.name}: ${manifest.repo} at revision ${manifest.revision}, ` +
		`${manifest.files.length} files, ${megabytes(total)}, from ${hosts.join(", ")} into ${manifest.dir}. ` +
		"Every file is checked against its pinned SHA-256."
	);
}

async function fetchOne(
	file: ModelFileSpec,
	dest: string,
	fetcher: Fetcher,
): Promise<void> {
	const response = await fetcher(file.url);
	if (!response.ok || response.body === null) {
		throw new Error(`${file.path}: HTTP ${response.status} from ${file.url}`);
	}
	const partial = `${dest}.partial`;
	await mkdir(dirname(dest), { recursive: true });
	const handle = await open(partial, "w");
	const hash = createHash("sha256");
	let received = 0;
	try {
		for await (const chunk of response.body) {
			received += chunk.byteLength;
			if (received > file.bytes) {
				throw new Error(
					`${file.path}: more than the pinned ${file.bytes} bytes`,
				);
			}
			hash.update(chunk);
			await handle.write(chunk);
		}
		await handle.close();
		if (received !== file.bytes) {
			throw new Error(
				`${file.path}: ${received} bytes, expected ${file.bytes}`,
			);
		}
		if (hash.digest("hex") !== file.sha256) {
			throw new Error(`${file.path}: does not match its pinned SHA-256`);
		}
		await rename(partial, dest);
	} catch (err) {
		await handle.close().catch(() => {});
		await rm(partial, { force: true });
		throw err;
	}
}

/**
 * Fetch every file of `manifest` that is not already present and intact.
 * Returns the paths fetched and the paths already in place.
 */
export async function downloadModel(
	manifest: ModelManifest,
	fetcher: Fetcher,
	log: (line: string) => void,
): Promise<{ fetched: string[]; present: string[] }> {
	const fetched: string[] = [];
	const present: string[] = [];
	for (const file of manifest.files) {
		const dest = destination(manifest.dir, file.path);
		if (await matches(dest, file)) {
			present.push(file.path);
			continue;
		}
		log(`${file.path} (${megabytes(file.bytes)}) <- ${file.url}`);
		await fetchOne(file, dest, fetcher);
		fetched.push(file.path);
	}
	return { fetched, present };
}
