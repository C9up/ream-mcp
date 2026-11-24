import { defineConfig } from "@c9up/blackhole";

export default defineConfig({
	secret: process.env.APP_KEY,
	csrf: { exceptRoutes: ["/webhooks/*"] },
});
