// Types for the NAPI loader (`index.js`).
//
// The surface is derived from `src/native/generated.d.ts`, which
// `pnpm build:napi-types` writes from napi-derive's own `type-def`
// output — so it cannot drift from the Rust the way the restatement
// that used to live here silently could.
//
// All core functions return either primitives or **JSON-encoded
// strings**; the TS layer is responsible for parsing. Keeping the FFI
// surface in primitives sidesteps NAPI codegen complexity for nested
// structs.

export type ReamMcpCore = typeof import("./src/native/generated.js");

export const core: ReamMcpCore;
