import { formatSize } from "@delacour/warden-core/builds/prune";
import { type DiskFacts, type DiskReason, judgeDisk, readDiskFacts } from "@delacour/warden-core/disk";
import { readHostFacts } from "@delacour/warden-core/host";
import type { CommandContext } from "../context";
import { diskConfigFromEnv } from "../disk-deps";
import { describeReason, fixFor } from "./disk";
import type { DoctorCheck } from "./doctor";

/** ok when none of `kinds` is among the reasons; otherwise a warning that names each reason and its fix. */
function row(
	name: string,
	reasons: readonly DiskReason[],
	kinds: ReadonlySet<DiskReason["kind"]>,
	okDetail: string
): DoctorCheck {
	const hits = reasons.filter((r) => kinds.has(r.kind));
	if (hits.length === 0) return { name, level: "optional", status: "ok", detail: okDetail };
	const detail = hits.map((r) => `${describeReason(r)} — ${fixFor(r)}`).join("; ");
	return { name, level: "optional", status: "warn", detail };
}

/** `disk-free`, `swap`, `snapshots` from the same verdict as `warden disk`; a probe that can't be read reads as ok. */
export function diskCheckRows(facts: DiskFacts, env: Record<string, string | undefined>): DoctorCheck[] {
	const { reasons } = judgeDisk(facts, diskConfigFromEnv(env).config);
	const free =
		facts.freeBytes === undefined || facts.totalBytes === undefined
			? "unknown"
			: `${formatSize(facts.freeBytes)} free of ${formatSize(facts.totalBytes)}`;
	const swap = facts.swapUsedBytes === undefined ? "unknown" : `${formatSize(facts.swapUsedBytes)} used`;
	const snaps = facts.snapshots ? "none" : "unknown";
	return [
		row("disk-free", reasons, new Set(["low-free"]), free),
		row("swap", reasons, new Set(["swap"]), swap),
		row("snapshots", reasons, new Set(["os-update-snapshots", "tm-snapshots"]), snaps),
	];
}

export async function diskChecks(ctx: CommandContext): Promise<DoctorCheck[]> {
	const host = await (ctx.hostFacts?.() ?? readHostFacts(ctx.exec));
	const facts = await readDiskFacts(ctx.exec, { os: host.os, home: ctx.env.HOME ?? "", now: ctx.now() });
	return diskCheckRows(facts, ctx.env);
}
