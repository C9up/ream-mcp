import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDoctor } from "../../src/tools/doctor.js";

interface DoctorResult {
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
	[key: string]: unknown;
}

async function makeWorkspace(): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "doctor-"));
	return root;
}

describe("ream-mcp > tools > doctor.health", () => {
	let root: string;
	beforeEach(async () => {
		root = await makeWorkspace();
	});
	afterEach(async () => {
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("reports node + rust versions and an empty workspace as clean", async () => {
		await fsp.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ name: "test-root", version: "1.0.0" }),
		);
		const result = (await dispatchDoctor(
			root,
			"doctor.health",
		)) as DoctorResult;
		expect(result.nodeVersion).toBe(process.version);
		expect(result.napiBinariesBuilt).toEqual([]);
		expect(result.missingBinaries).toEqual([]);
		expect(result.workspaceClean).toBe(true);
	});

	it("flags packages whose version drifts from the workspace root", async () => {
		await fsp.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "test-root",
				version: "2.0.0",
				workspaces: ["packages/*"],
			}),
		);
		await fsp.mkdir(path.join(root, "src"), { recursive: true });
		await fsp.writeFile(path.join(root, "src", "index.ts"), "");
		const pkgDir = path.join(root, "packages", "drifted");
		await fsp.mkdir(path.join(pkgDir, "src"), { recursive: true });
		await fsp.writeFile(path.join(pkgDir, "src", "index.ts"), "");
		await fsp.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({ name: "@scope/drifted", version: "1.5.0" }),
		);
		const result = (await dispatchDoctor(
			root,
			"doctor.health",
		)) as DoctorResult;
		expect(result.workspaceClean).toBe(false);
		expect(result.knownGaps.some((g) => g.includes("workspace drift"))).toBe(
			true,
		);
	});

	it("ignores packages marked private when checking workspace cleanliness", async () => {
		await fsp.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "test-root",
				version: "2.0.0",
				workspaces: ["packages/*"],
			}),
		);
		const pkgDir = path.join(root, "packages", "private-pkg");
		await fsp.mkdir(pkgDir, { recursive: true });
		await fsp.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@scope/priv",
				version: "0.0.0",
				private: true,
			}),
		);
		const result = (await dispatchDoctor(
			root,
			"doctor.health",
		)) as DoctorResult;
		expect(result.workspaceClean).toBe(true);
	});

	it("reports the workspace root package.json missing as a known gap", async () => {
		// No root package.json written.
		const result = (await dispatchDoctor(
			root,
			"doctor.health",
		)) as DoctorResult;
		expect(result.workspaceClean).toBe(false);
		expect(
			result.knownGaps.some((g) => g.includes("workspace root package.json")),
		).toBe(true);
	});

	it("lists missing NAPI binaries when a package declares `napi` without artefacts", async () => {
		await fsp.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "test-root",
				version: "1.0.0",
				workspaces: ["packages/*"],
			}),
		);
		await fsp.mkdir(path.join(root, "src"), { recursive: true });
		await fsp.writeFile(path.join(root, "src", "index.ts"), "");
		const pkgDir = path.join(root, "packages", "atom");
		await fsp.mkdir(path.join(pkgDir, "src"), { recursive: true });
		await fsp.writeFile(path.join(pkgDir, "src", "index.ts"), "");
		await fsp.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@scope/atom",
				version: "1.0.0",
				napi: { binaryName: "atom" },
				scripts: { "build:napi": "napi build" },
			}),
		);
		const result = (await dispatchDoctor(
			root,
			"doctor.health",
		)) as DoctorResult;
		const missing = result.missingBinaries as Array<{
			package: string;
			expected: string;
			hint: string;
		}>;
		expect(missing.some((m) => m.package === "@scope/atom")).toBe(true);
		expect(missing[0].hint).toContain("pnpm --filter");
	});

	it("lists built NAPI binaries when an artefact exists alongside package.json", async () => {
		await fsp.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "test-root",
				version: "1.0.0",
				workspaces: ["packages/*"],
			}),
		);
		await fsp.mkdir(path.join(root, "src"), { recursive: true });
		await fsp.writeFile(path.join(root, "src", "index.ts"), "");
		const pkgDir = path.join(root, "packages", "atom");
		await fsp.mkdir(path.join(pkgDir, "src"), { recursive: true });
		await fsp.writeFile(path.join(pkgDir, "src", "index.ts"), "");
		await fsp.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: "@scope/atom",
				version: "1.0.0",
				napi: { name: "atom" },
			}),
		);
		// "Bare" .node sentinel — picked up by findNapiArtifact's first probe.
		await fsp.writeFile(path.join(pkgDir, "atom.node"), "binary");
		const result = (await dispatchDoctor(
			root,
			"doctor.health",
		)) as DoctorResult;
		const built = result.napiBinariesBuilt as Array<{
			package: string;
			binary: string;
		}>;
		expect(built.some((b) => b.package === "@scope/atom")).toBe(true);
	});
});

describe("ream-mcp > tools > doctor.env_check", () => {
	let root: string;
	beforeEach(async () => {
		root = await makeWorkspace();
	});
	afterEach(async () => {
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("reports envVars with set=false when not in process.env", async () => {
		const wasSet = "DATABASE_URL" in process.env;
		const orig = process.env.DATABASE_URL;
		delete process.env.DATABASE_URL;

		const result = (await dispatchDoctor(
			root,
			"doctor.env_check",
		)) as DoctorResult;
		const envVars = result.envVars as Array<{
			name: string;
			set: boolean;
			sensitive: boolean;
		}>;
		const dbVar = envVars.find((v) => v.name === "DATABASE_URL");
		expect(dbVar?.set).toBe(false);
		expect(dbVar?.sensitive).toBe(true);

		if (wasSet && orig !== undefined) process.env.DATABASE_URL = orig;
	});

	it("reports envVars with set=true when present and non-empty", async () => {
		process.env.NODE_ENV = "test";
		const result = (await dispatchDoctor(
			root,
			"doctor.env_check",
		)) as DoctorResult;
		const envVars = result.envVars as Array<{ name: string; set: boolean }>;
		const node = envVars.find((v) => v.name === "NODE_ENV");
		expect(node?.set).toBe(true);
	});

	it("reports configFiles[i].exists=false for files not present in root", async () => {
		const result = (await dispatchDoctor(
			root,
			"doctor.env_check",
		)) as DoctorResult;
		const cfgs = result.configFiles as Array<{
			path: string;
			exists: boolean;
		}>;
		const pkg = cfgs.find((c) => c.path === "package.json");
		expect(pkg?.exists).toBe(false);
	});

	it("reports configFiles[i].exists=true once the file is created", async () => {
		await fsp.writeFile(path.join(root, "tsconfig.json"), "{}");
		const result = (await dispatchDoctor(
			root,
			"doctor.env_check",
		)) as DoctorResult;
		const cfgs = result.configFiles as Array<{
			path: string;
			exists: boolean;
		}>;
		const ts = cfgs.find((c) => c.path === "tsconfig.json");
		expect(ts?.exists).toBe(true);
	});
});

describe("ream-mcp > tools > doctor dispatcher", () => {
	it("returns a structured error envelope for unknown tool names", async () => {
		const root = await makeWorkspace();
		try {
			const result = (await dispatchDoctor(
				root,
				"doctor.unknown",
			)) as DoctorResult;
			expect(result.confidence).toBe("low");
			expect(result.error).toContain("Unknown doctor tool");
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});
