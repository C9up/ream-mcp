export class BodyParserMiddleware {
	handle(ctx: any, next: () => Promise<void>) {
		return next();
	}
}
