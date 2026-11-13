import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { execError } from "../exec";
import type { PodsDeps } from "./pods.types";

/** Clone `src` to the not-yet-existing `dst` in one kernel call; false = not possible here (caller falls back). */
export type NativeClone = (src: string, dst: string) => boolean;

type ClonefileFn = (src: Buffer, dst: Buffer, flags: number) => number;
let clonefile: ClonefileFn | null | undefined;

/** `clonefile(2)` through bun:ffi, loaded on first use (darwin only): a whole directory tree in one call, blocks shared. */
export const clonefileClone: NativeClone = (src, dst) => {
	if (process.platform !== "darwin") return false;
	if (clonefile === undefined) {
		try {
			const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
			const lib = dlopen("libSystem.B.dylib", { clonefile: { args: ["cstring", "cstring", "u32"], returns: "i32" } });
			clonefile = lib.symbols.clonefile as ClonefileFn;
		} catch {
			clonefile = null;
		}
	}
	if (clonefile === null) return false;
	try {
		return clonefile(Buffer.from(`${src}\0`), Buffer.from(`${dst}\0`), 0) === 0;
	} catch {
		return false;
	}
};

/**
 * Copy `src` (file or dir) to the not-yet-existing `dst` as a clone: `clonefile(2)` (or `deps.clone`) first, then
 * `cp -c -R`; where neither can clone (another volume, not APFS) a plain copy is made and `log` says so once.
 */
export async function cloneTree(
	deps: Pick<PodsDeps, "exec" | "log" | "clone">,
	src: string,
	dst: string
): AsyncResult<void> {
	mkdirSync(dirname(dst), { recursive: true });
	if ((deps.clone ?? clonefileClone)(src, dst)) return ok(undefined);
	rmSync(dst, { recursive: true, force: true });
	const clone = await deps.exec(["cp", "-c", "-R", src, dst]);
	if (clone.exitCode === 0) return ok(undefined);
	rmSync(dst, { recursive: true, force: true });
	deps.log(`clone failed (${execError(["cp", "-c"], clone)}); copying instead`);
	const copy = await deps.exec(["cp", "-R", src, dst]);
	if (copy.exitCode === 0) return ok(undefined);
	return err(`cannot copy ${src}: ${execError(["cp", "-R", src, dst], copy)}`);
}
