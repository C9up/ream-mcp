export class AppProvider {
	constructor(private app: any) {}

	register() {
		this.app.bind("logger", () => ({ log: console.log }));
	}
}
