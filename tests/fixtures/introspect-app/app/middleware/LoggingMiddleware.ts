export class LoggingMiddleware {
	handle(ctx: any, next: () => Promise<void>) {
		return next();
	}
}
