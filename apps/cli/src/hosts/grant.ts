import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deleteGrant, getGrant, putGrant } from "@delacour/warden-core/hosts/registry";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { selfCommand } from "../self-command";
import {
	authorizedLine,
	type PublicKey,
	parseKeyComment,
	parsePublicKey,
	removeAuthorized,
	sshFingerprint,
	upsertAuthorized,
} from "./keys";

/** Host side of `warden host`: who may come in through `__host-serve`. */

export type GrantOptions = {
	key: string;
	machine?: string;
	user?: string;
	/** default `~/.ssh/authorized_keys` */
	authorizedKeys?: string;
	/** the warden the forced command runs (default: this one) */
	warden?: string;
};

export type GrantOutcome = { fingerprint: string; machineId: string; user: string; authorizedKeys: string };

export function authorizedKeysPath(ctx: CommandContext, path: string | undefined): string {
	return path ?? join(ctx.env.HOME ?? "", ".ssh", "authorized_keys");
}

function readText(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeAuthorized(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/** `--key` is a key line or a path to a `.pub` file. */
function readKey(raw: string): Result<PublicKey> {
	const text =
		!raw.startsWith("ssh-") && !raw.startsWith("ecdsa-") && !raw.startsWith("sk-") && existsSync(raw)
			? readFileSync(raw, "utf8")
			: raw;
	return parsePublicKey(text);
}

/** Record the grant and write the forced-command line (replacing an earlier one for the same key). */
export function grantKey(ctx: CommandContext, opts: GrantOptions, now: number): Result<GrantOutcome> {
	const key = readKey(opts.key);
	if (!key.success) return key;
	const fromComment = parseKeyComment(key.data.comment);
	const machineId = opts.machine ?? fromComment?.machineId;
	const user = opts.user ?? fromComment?.user;
	if (machineId === undefined || user === undefined) {
		return err("the key's comment is not `warden:<machineId>:<user>`: pass --machine and --user");
	}
	const fingerprint = sshFingerprint(key.data);
	const self = opts.warden !== undefined ? [opts.warden] : selfCommand();
	const path = authorizedKeysPath(ctx, opts.authorizedKeys);
	writeAuthorized(path, upsertAuthorized(readText(path), key.data, authorizedLine(self, fingerprint, key.data)));
	putGrant(ctx.store(), { fingerprint, machineId, user, publicKey: key.data.blob, addedAt: now });
	return ok({ fingerprint, machineId, user, authorizedKeys: path });
}

/** Drop a grant by fingerprint or key, and its authorized_keys line. */
export function revokeKey(
	ctx: CommandContext,
	opts: { key: string; authorizedKeys?: string }
): Result<{ fingerprint: string; removedLines: number }> {
	const parsed = opts.key.startsWith("SHA256:") ? undefined : readKey(opts.key);
	if (parsed !== undefined && !parsed.success) return parsed;
	const fingerprint = parsed?.success ? sshFingerprint(parsed.data) : opts.key;
	const grant = getGrant(ctx.store(), fingerprint);
	const blob = parsed?.success ? parsed.data.blob : grant?.publicKey;
	if (grant === undefined && blob === undefined) return err(`no grant for ${fingerprint}`);
	deleteGrant(ctx.store(), fingerprint);
	const path = authorizedKeysPath(ctx, opts.authorizedKeys);
	let removedLines = 0;
	if (blob !== undefined && existsSync(path)) {
		const removed = removeAuthorized(readText(path), blob);
		removedLines = removed.removed;
		if (removed.removed > 0) writeAuthorized(path, removed.text);
	}
	return ok({ fingerprint, removedLines });
}
