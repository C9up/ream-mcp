declare function createBlackhole(opts: object): void;
declare function unsafeHtml(
	strings: TemplateStringsArray,
	...vals: unknown[]
): string;
declare const userInput: string;

export function bootstrap(): string {
	// csrf_disabled
	createBlackhole({ csrf: false });
	// xss_html_raw_output — interpolated tagged template using
	// the explicitly-unsafe escape hatch.
	return unsafeHtml`<div>${userInput}</div>`;
}
