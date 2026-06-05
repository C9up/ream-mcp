export class ThrottleMiddleware {
	handle(ctx: any, next: () => Promise<void>) {
		return next();
	}
}
