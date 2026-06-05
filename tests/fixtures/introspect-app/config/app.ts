import { defineConfig } from "fake-ream";
import { LoggingMiddleware } from "../app/middleware/LoggingMiddleware";

export default defineConfig({
	name: "introspect-fixture",
	port: process.env.PORT,
	logLevel: env("LOG_LEVEL", "info"),
	debug: false,
	tags: ["alpha", "beta"],
	plugins: [LoggingMiddleware],
});
