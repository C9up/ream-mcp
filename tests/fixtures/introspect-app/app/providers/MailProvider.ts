export class MailProvider {
	constructor(private app: any) {}

	register() {
		this.app.singleton("mailer", () => ({ send: () => {} }));
	}

	async boot() {
		// validate SMTP creds, etc.
	}

	async shutdown() {
		// flush queue
	}
}
