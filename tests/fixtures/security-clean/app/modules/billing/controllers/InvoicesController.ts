import { Permission } from "@c9up/warden";
import { BaseController } from "./BaseController.js";

export default class InvoicesController extends BaseController {
	async index() {}

	@Permission("invoices.create")
	async store() {}

	// Inherits the parent's @Guard, as warden reads it.
	async destroy() {}
}
