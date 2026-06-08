export class CorsMiddleware {
	handle(ctx: any, next: () => Promise<void>) {
		return next();
	}
}
