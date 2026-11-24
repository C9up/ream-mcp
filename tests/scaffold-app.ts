/**
 * A Ream application laid out as `ream new --template web` writes it
 * (`packages/ream-cli/src/scaffold.rs`), for tests that scan a real layout:
 * `bin/`, `start/`, `config/`, `app/middleware/`, `providers/`, `tests/`,
 * the `#` subpath imports and the web template's dependencies.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ScaffoldedApp {
	root: string;
	/** Write (or overwrite) a file, relative to the root. */
	write(rel: string, body: string): void;
}

/** The scaffold's `config/blackhole.ts`; `csrf` replaces its `csrf: { exceptRoutes: [] }`. */
export function scaffoldBlackhole(csrf = "{ exceptRoutes: [] }"): string {
	return `import env from '#start/env.js'
import { defineConfig } from '@c9up/blackhole/config'

export default defineConfig({
  xss: true,
  csrf: ${csrf},
  // Through the validated environment, never \`process.env\` directly.
  secret: env.get('APP_KEY').release(),
})
`;
}

const PACKAGE_JSON = {
	name: "demo",
	version: "0.1.0",
	private: true,
	type: "module",
	imports: {
		"#app/*": "./app/*",
		"#modules/*": "./app/modules/*",
		"#middleware/*": "./app/middleware/*",
		"#exceptions/*": "./app/exceptions/*",
		"#config/*": "./config/*",
		"#providers/*": "./providers/*",
		"#start/*": "./start/*",
	},
	scripts: { dev: "ream dev", test: "ream test" },
	dependencies: {
		"@c9up/ream": "^0.2.32",
		"@c9up/atlas": "^0.3.11",
		"@c9up/warden": "^0.2.0",
		"@c9up/inker": "^0.1.15",
		"@c9up/blackhole": "^0.1.17",
		"@c9up/sigil": "^0.1.13",
	},
	devDependencies: { "@c9up/helix": "^0.2.8", typescript: "^5.7" },
};

const FILES: Record<string, string> = {
	"reamrc.ts": `import { defineConfig } from '@c9up/ream'

export default defineConfig({
  providers: [
    () => import('@c9up/sigil/provider'),
    () => import('@c9up/warden/provider'),
    () => import('@c9up/blackhole/provider'),
    () => import('#providers/AppProvider.js'),
  ],
  preloads: [
    () => import('#start/routes.js'),
    () => import('#start/kernel.js'),
  ],
})
`,
	"bin/server.ts": `import { Ignitor, prettyPrintError } from '@c9up/ream'
import { createHyperServerFactory } from '@c9up/ream/bootstrap'

new Ignitor(new URL('../', import.meta.url), { serverFactory: createHyperServerFactory() })
  .useRcFile((await import('../reamrc.js')).default)
  .httpServer()
  .start()
  .catch((err) => {
    prettyPrintError(err)
    process.exit(1)
  })
`,
	"start/env.ts": `import { Env } from '@c9up/ream'

export default await Env.create(new URL('../', import.meta.url), {
  APP_KEY: Env.schema.secret(),
})
`,
	"start/routes.ts": `import router from '@c9up/ream/services/router'

router.get('/', async ({ response }) => {
  response.status(200).json({ name: 'demo', status: 'running' })
})
`,
	"start/kernel.ts": `import router from '@c9up/ream/services/router'

router.use([
  () => import('@c9up/ream/bodyparser_middleware'),
  () => import('@c9up/ream/session_middleware'),
  () => import('@c9up/blackhole/middleware'),
  () => import('#middleware/auth_middleware.js'),
])
`,
	"config/session.ts": `import env from '#start/env.js'
import { defineConfig } from '@c9up/ream/session/config'

export default defineConfig({
  store: 'cookie',
  secret: env.get('APP_KEY').release(),
})
`,
	"config/auth.ts": `export default {
  defaultStrategy: 'session',
}
`,
	"config/blackhole.ts": scaffoldBlackhole(),
	"app/middleware/auth_middleware.ts": `import type { HttpContext } from '@c9up/ream'

export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: () => Promise<void>) {
    await next()
  }
}
`,
	"providers/AppProvider.ts": `import { Provider } from '@c9up/ream'

export default class AppProvider extends Provider {
  register() {}
}
`,
	"tests/bootstrap.ts": "export const plugins = []\n",
	"tests/functional/root.test.ts": `import { test } from '@c9up/helix'

test('the root route answers', async ({ client }) => {
  await client.get('/').assertOk()
})
`,
};

export function scaffoldWebApp(prefix = "ream-web-"): ScaffoldedApp {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const write = (rel: string, body: string): void => {
		const file = join(root, rel);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	};
	write("package.json", `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`);
	for (const [rel, body] of Object.entries(FILES)) write(rel, body);
	return { root, write };
}
