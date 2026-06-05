import { LoggingMiddleware } from "./middleware/LoggingMiddleware";
import { CorsMiddleware } from "./middleware/CorsMiddleware";
import { BodyParserMiddleware } from "./middleware/BodyParserMiddleware";
import { AuthMiddleware } from "./middleware/AuthMiddleware";
import { ThrottleMiddleware } from "./middleware/ThrottleMiddleware";

export class HttpKernel {
	globalMiddleware = [
		LoggingMiddleware,
		CorsMiddleware,
		BodyParserMiddleware,
	];

	namedMiddleware = {
		auth: AuthMiddleware,
		throttle: ThrottleMiddleware,
	};
}
