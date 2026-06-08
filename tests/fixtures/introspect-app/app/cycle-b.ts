// FIXTURE — intentional cycle with cycle-a.ts.
import { useA } from "./cycle-a.js";

export function useB(): string {
	return `b:${useA()}`;
}
