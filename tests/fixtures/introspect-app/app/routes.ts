import { router } from "fake-router";
import { UsersController } from "./controllers/UsersController";
import { PostsController } from "./controllers/PostsController";

router.get("/health", () => "ok");

router
	.group(() => {
		router.get("/users", [UsersController, "index"]);
		router.post("/users", [UsersController, "create"]);
		router.get("/posts/:id", [PostsController, "show"]);

		// Nested group — exercises the H1 patch (multi-level
		// flatten). Outer prefix is `/api`, outer middleware `auth`;
		// inner prefix `/v2`, inner middleware `throttle` — child
		// route should compose to `/api/v2/admin` with both
		// middlewares prepended in outer→inner order.
		router
			.group(() => {
				router.get("/admin", [UsersController, "admin"]);
			})
			.prefix("/v2")
			.middleware("throttle");
	})
	.prefix("/api")
	.middleware("auth");
