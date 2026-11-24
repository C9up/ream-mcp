import type { HttpContext } from "@c9up/ream";
import { SafeString } from "@c9up/inker";
import db from "@c9up/atlas/services/db";

export default class PostsController {
	async index({ response }: HttpContext) {
		response.json([]);
	}

	async store({ request, response }: HttpContext) {
		const title = request.input("title");
		// sql_interpolation
		const found = await db.rawQuery(`select * from posts where title = '${title}'`);
		// cookie_missing_flags: drops the Secure default.
		response.cookie("last_post", title, { maxAge: "2h", secure: false });
		if (!found) {
			// raw_error_not_reamerror
			throw new Error("not found");
		}
		// xss_html_raw_output: user input printed raw.
		return new SafeString(request.input("body"));
	}
}
