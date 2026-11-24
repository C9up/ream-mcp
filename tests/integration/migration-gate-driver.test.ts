/**
 * The migration write gate classifies the address the driver dials, so its
 * model of the URL must be the driver's. This dials through @c9up/atlas
 * (sqlx 0.9.1) with two listeners that only record the connection and hang
 * up, one on 127.0.0.1 and one on ::1, and checks that the driver connects
 * where `serverDialTarget` says, for each way a URL or a `PG*` variable
 * selects the host. No database is involved.
 */

import { createServer, type Server } from "node:net";

import { createNapiConnection } from "@c9up/atlas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serverDialTarget } from "../../src/util/env-guard.js";

const PG_VARS = ["PGHOST", "PGHOSTADDR", "PGPORT"] as const;

function listen(host: string, port: number, hits: string[]): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => {
			hits.push(host);
			socket.destroy();
		});
		server.once("error", reject);
		server.listen(port, host, () => resolve(server));
	});
}

async function dial(url: string): Promise<void> {
	// One attempt, a short window: the listeners hang up at once.
	await Promise.race([
		createNapiConnection(url, 1, 1, undefined, {
			retries: 0,
			timeoutMs: 1500,
		}).then(
			(c) => c.close(),
			() => undefined,
		),
		new Promise((r) => setTimeout(r, 4000)),
	]);
}

const hits: string[] = [];
const servers: Server[] = [];
let port = 0;

beforeAll(async () => {
	const v4 = await listen("127.0.0.1", 0, hits);
	servers.push(v4);
	const address = v4.address();
	port = typeof address === "object" && address !== null ? address.port : 0;
	servers.push(await listen("::1", port, hits));
});

afterAll(() => {
	for (const server of servers) server.close();
	for (const name of PG_VARS) delete process.env[name];
});

describe("serverDialTarget agrees with where the driver connects", () => {
	const cases = (): Array<[string, string, Record<string, string>]> => [
		["control", `postgres://u:p@127.0.0.1:${port}/db`, {}],
		["?hostaddr=", `postgres://u:p@127.0.0.1:${port}/db?hostaddr=::1`, {}],
		[
			"PGHOSTADDR",
			`postgres://u:p@127.0.0.1:${port}/db`,
			{ PGHOSTADDR: "::1" },
		],
		[
			"PGHOST, no authority host",
			"postgres:///db",
			{ PGHOST: "::1", PGPORT: String(port) },
		],
		[
			"?host= twice",
			`postgres://u:p@127.0.0.1:${port}/db?host=127.0.0.1&host=::1`,
			{},
		],
		[
			"?socket= on PostgreSQL",
			`postgres://u:p@[::1]:${port}/db?socket=/tmp/x`,
			{},
		],
		["?host= on MySQL", `mysql://u:p@[::1]:${port}/db?host=127.0.0.1`, {}],
	];

	it("for each host-selecting form", async () => {
		for (const [label, url, env] of cases()) {
			hits.length = 0;
			Object.assign(process.env, env);
			const target = serverDialTarget(url);
			await dial(url);
			for (const name of PG_VARS) delete process.env[name];
			const expected =
				target?.kind === "tcp" ? target.host.replace(/^\[|\]$/g, "") : null;
			expect([...new Set(hits)], label).toEqual([expected]);
		}
	}, 60_000);
});
