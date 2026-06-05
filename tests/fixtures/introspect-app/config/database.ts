import { defineConfig } from "fake-ream";

export default defineConfig({
	default: "pg",
	connections: {
		pg: {
			host: "localhost",
			port: 5432,
			user: env("DB_USER", "postgres"),
		},
	},
});
