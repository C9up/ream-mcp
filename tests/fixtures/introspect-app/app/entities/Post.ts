import { Entity, Column, BelongsTo, AfterCreate } from "fake-atlas";
import { User } from "./User";

@Entity({ table: "posts" })
export class Post {
	@Column()
	id: string;

	@Column()
	title: string;

	@BelongsTo("user", User)
	user: User;

	@AfterCreate
	notifyAuthor() {}
}
