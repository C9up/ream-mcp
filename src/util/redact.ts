/**
 * Scrubbing for text that leaves the server in a tool result. What a client
 * receives lands in the model's context and the chat history, so it carries a
 * message, never the machine's layout or a credential. Full detail goes to
 * stderr.
 */

const WINDOWS_PATH = /[A-Za-z]:\\[^\s'"`]+/g;
const POSIX_PATH = /\/(?:[^\s/'"`]+\/)+[^\s/'"`]+/g;

/** Replace absolute filesystem paths with `<path>`. */
export function redactPaths(detail: string): string {
	return detail.replace(WINDOWS_PATH, "<path>").replace(POSIX_PATH, "<path>");
}

/**
 * Remove a connection URL, and its password on its own, from `detail` — a
 * driver error may quote either.
 */
export function redactUrl(detail: string, url: string): string {
	let out = detail;
	if (url.length > 0) out = out.split(url).join("<database-url>");
	const passwords: string[] = [];
	try {
		const encoded = new URL(url).password;
		passwords.push(encoded, decodeURIComponent(encoded));
	} catch {
		// Not parseable as a URL: there is no password component to find.
	}
	for (const password of passwords) {
		if (password.length > 0) out = out.split(password).join("<redacted>");
	}
	return out;
}
