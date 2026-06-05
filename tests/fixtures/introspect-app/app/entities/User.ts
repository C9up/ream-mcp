import { Entity, Column, HasMany, BeforeSave } from "fake-atlas";
import { Post } from "./Post";

@Entity("users")
export class User {
	@Column()
	id: string;

	@Column()
	email: string;

	@HasMany("posts", Post)
	posts: Post[];

	@BeforeSave
	hashPasswordOnSave() {}
}
