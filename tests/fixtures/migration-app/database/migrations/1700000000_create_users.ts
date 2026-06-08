// FIXTURE — drives the migration.* integration tests. Runs
// against an in-memory sqlite via REAM_DATABASE_URL. Don't add
// FK constraints; the second migration handles that pair.

import { Migration } from "@c9up/atlas";

export default class CreateUsers extends Migration {
	up(): void {
		this.schema.createTable("users", (table) => {
			table.id();
			table.string("email", 255).notNullable().unique();
			table.timestamps();
		});
	}

	down(): void {
		this.schema.dropTable("users");
	}
}
