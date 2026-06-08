export class AuthMiddleware {
	handle(ctx: any, next: () => Promise<void>) {
		return next();
	}
}
