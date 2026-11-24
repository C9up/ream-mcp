import router from "@c9up/ream/services/router";

const PostsController = () => import("#controllers/posts_controller");

router.get("/posts", [PostsController, "index"]);
// missing_guard_on_mutation_route: nothing authenticates this write.
router.post("/posts", [PostsController, "store"]);
