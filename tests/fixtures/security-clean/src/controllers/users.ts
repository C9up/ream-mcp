declare const Controller: ClassDecorator;
declare const Post: MethodDecorator;
declare function UseGuards(...g: unknown[]): ClassDecorator;
declare const AuthGuard: unknown;
declare class HttpException {
	constructor(msg: string, code: number);
}
declare const db: { query(sql: string, params?: unknown[]): unknown };
declare const res: {
	cookie(name: string, val: string, opts?: object): void;
};

@Controller
@UseGuards(AuthGuard)
export class UsersController {
	@Post
	create(id: string): unknown {
		const found = db.query("SELECT * FROM users WHERE id = ?", [id]);
		res.cookie("session", "tok", {
			secure: true,
			httpOnly: true,
			sameSite: "lax",
		});
		if (!found) {
			throw new HttpException("not found", 404);
		}
		return found;
	}
}
