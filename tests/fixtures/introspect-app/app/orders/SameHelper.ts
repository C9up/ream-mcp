// FIXTURE — intentional duplicate of app/billing/Helper.ts.
// Different identifier names, same body — drives the
// `quality.duplicates` test asserting identifier anonymization.

export function discountOrder(
	total: number,
	pct: number,
	minimum: number,
): number {
	if (pct < 0) {
		throw new Error("rate must be non-negative");
	}
	if (total <= minimum) {
		return minimum;
	}
	const reduced = total * (1 - pct);
	return reduced < minimum ? minimum : reduced;
}
