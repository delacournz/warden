import { loadavg } from "node:os";
import { readXcode } from "@delacour/warden-core/xcode";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Host } from "../results/schema";
import type { Exec } from "./exec";

async function out(exec: Exec, cmd: string, args: readonly string[], stream: "stdout" | "stderr" = "stdout") {
	const r = await exec.run(cmd, args, { timeoutMs: 15_000 });
	if (r.spawnError !== undefined || r.code !== 0) return undefined;
	const first = r[stream].trim().split("\n")[0]?.trim();
	return first === undefined || first === "" ? undefined : first;
}

/** Optional fields are left out of the object (not set to undefined) so the zod schema stays happy. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

/** The selected Xcode's version (`27.1`), honouring `DEVELOPER_DIR`; undefined when none is readable. */
async function xcodeVersion(exec: Exec): Promise<string | undefined> {
	const xcode = await readXcode(async (cmd, opts) => {
		const [bin = "", ...args] = cmd;
		const r = await exec.run(bin, args, { timeoutMs: 15_000, env: opts?.env });
		return { exitCode: r.spawnError === undefined ? r.code : 127, stdout: r.stdout, stderr: r.stderr };
	}, process.env);
	return xcode.success ? xcode.data.version : undefined;
}

/** `openjdk version "17.0.9" 2023-10-17` to `17.0.9`; the raw line when the shape differs. */
function javaVersion(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	return /version "([^"]+)"/.exec(line)?.[1] ?? line;
}

/** `warden 0.1.0 (dev, /path)` to `0.1.0`. */
function wardenVersion(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	return /^warden\s+(\S+)/.exec(line)?.[1] ?? line;
}

/**
 * The machine the numbers came from. Required fields failing to read is an error (a results file with a
 * blank host is worthless); xcode/java/node are best effort.
 */
export async function hostInfo(exec: Exec, opts: { cliPath?: string; wardenVersion?: string } = {}): AsyncResult<Host> {
	const [model, cpu, cores, mem, macos, xcode, java, node, warden] = await Promise.all([
		out(exec, "sysctl", ["-n", "hw.model"]),
		out(exec, "sysctl", ["-n", "machdep.cpu.brand_string"]),
		out(exec, "sysctl", ["-n", "hw.ncpu"]),
		out(exec, "sysctl", ["-n", "hw.memsize"]),
		out(exec, "sw_vers", ["-productVersion"]),
		xcodeVersion(exec),
		out(exec, "java", ["-version"], "stderr"),
		out(exec, "node", ["-v"]),
		opts.wardenVersion === undefined && opts.cliPath !== undefined
			? out(exec, process.execPath, [opts.cliPath, "version"])
			: Promise.resolve(undefined),
	]);
	const missing = Object.entries({ model, cpu, cores, memBytes: mem, macos })
		.filter(([, v]) => v === undefined)
		.map(([k]) => k);
	if (missing.length > 0) return err(`host info unavailable: ${missing.join(", ")}`);
	const coreCount = Number(cores);
	const memBytes = Number(mem);
	if (!Number.isInteger(coreCount) || !Number.isFinite(memBytes)) return err("host info: non-numeric cores/memsize");
	return ok({
		model: model as string,
		cpu: cpu as string,
		cores: coreCount,
		memBytes,
		macos: macos as string,
		...optional("xcode", xcode),
		...optional("java", javaVersion(java)),
		...optional("node", node?.replace(/^v/, "")),
		bun: Bun.version,
		warden: opts.wardenVersion ?? wardenVersion(warden) ?? "unknown",
		loadAvgAtStart: loadavg()[0] ?? 0,
	});
}
