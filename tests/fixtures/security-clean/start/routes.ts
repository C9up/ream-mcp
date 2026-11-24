import router from "@c9up/ream/services/router";
import PostsController from "#controllers/posts_controller";
import InvoicesController from "#modules/billing/controllers/InvoicesController";

const SessionsController = () => import("#controllers/sessions_controller");

// Guarded on the route.
router.post("/posts", [PostsController, "store"]).guard("web");
router.delete("/posts/:id", [PostsController, "destroy"]).guard("web").role("admin");

// Guarded by the group.
router
	.group(() => {
		router.put("/posts/:id", [PostsController, "update"]);
		router.patch("/posts/:id", [PostsController, "update"]);
	})
	.prefix("/api")
	.guard("jwt");

// Guarded by warden's decorators on the controller actions.
router.resource("invoices", InvoicesController).only(["index", "store", "destroy"]);

// Read-only routes need no guard.
router.get("/sessions/new", [SessionsController, "create"]);
