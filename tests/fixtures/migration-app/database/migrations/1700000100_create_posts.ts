// FIXTURE — second migration so multi-batch rollback / status
// transitions can be exercised by integration tests.

import { Migration } from "@c9up/atlas";

export default class CreatePosts extends Migration {
	up(): void {
		this.schema.createTable("posts", (table) => {
			table.id();
			table.integer("user_id").notNullable();
			table.string("title", 255).notNullable();
			table.timestamps();
		});
	}

	down(): void {
		this.schema.dropTable("posts");
	}
}
