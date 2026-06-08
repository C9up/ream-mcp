// FIXTURE — intentional cycle with cycle-b.ts; drives
// `quality.dep_graph` cycle detection. Do NOT remove the import.
import { useB } from "./cycle-b.js";

export function useA(): string {
	return `a:${useB()}`;
}
