declare const Controller: ClassDecorator;
declare const Post: MethodDecorator;
declare const db: { query(sql: string): unknown };
declare const res: {
	cookie(name: string, val: string, opts?: object): void;
};
declare const userId: string;

@Controller
export class UsersController {
	// missing_guard_on_mutation_route — @Post with no @UseGuards anywhere.
	@Post
	create(): unknown {
		// sql_interpolation
		const found = db.query(`SELECT * FROM users WHERE id = ${userId}`);
		// cookie_missing_flags — no secure/httpOnly/sameSite in opts.
		res.cookie("session", "tok", { maxAge: 3600 });
		if (!found) {
			// raw_error_not_reamerror
			throw new Error("not found");
		}
		return found;
	}
}
