import type { HttpContext } from "@c9up/ream";
import { createError } from "@c9up/ream";
import { SafeString } from "@c9up/inker";
import db from "@c9up/atlas/services/db";

const E_POST_NOT_FOUND = createError("Post not found", "E_POST_NOT_FOUND", 404);

export default class PostsController {
	async store({ request, response }: HttpContext) {
		const title = request.input("title");
		const found = await db.rawQuery("select * from posts where title = ?", [title]);
		response.cookie("last_post", title, {
			maxAge: "2h",
			secure: true,
			sameSite: "lax",
		});
		if (!found) throw new E_POST_NOT_FOUND();
		return new SafeString("<p>saved</p>");
	}

	async update() {}

	async destroy() {}
}
