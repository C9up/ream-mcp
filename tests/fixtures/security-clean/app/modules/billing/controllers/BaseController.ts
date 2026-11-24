import { Guard } from "@c9up/warden";

export class BaseController {
	@Guard("web")
	async destroy() {}
}
