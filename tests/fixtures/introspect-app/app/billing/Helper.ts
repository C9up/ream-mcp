// FIXTURE — intentional duplicate of app/orders/SameHelper.ts.
// Do NOT dedupe; the dup-detector test relies on this pair.

export function applyDiscount(
	subtotal: number,
	rate: number,
	floor: number,
): number {
	if (rate < 0) {
		throw new Error("rate must be non-negative");
	}
	if (subtotal <= floor) {
		return floor;
	}
	const discounted = subtotal * (1 - rate);
	return discounted < floor ? floor : discounted;
}
