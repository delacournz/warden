import { createHash } from "node:crypto";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { shellQuote } from "./ssh";

/** An OpenSSH public key line: `<type> <base64 blob> [comment]`. */
export type PublicKey = { type: string; blob: string; comment?: string };

const KEY_TYPE =
	/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,3}$/;

/** A bare public key line (no authorized_keys options). */
export function parsePublicKey(raw: string): Result<PublicKey> {
	const [type, blob, ...rest] = raw.trim().split(/\s+/);
	if (type === undefined || blob === undefined || !KEY_TYPE.test(type) || !BASE64.test(blob)) {
		return err("not an OpenSSH public key (`ssh-ed25519 AAAA… comment`)");
	}
	const comment = rest.join(" ");
	return ok({ type, blob, ...(comment !== "" ? { comment } : {}) });
}

/** `SHA256:<base64, no padding>` of the key blob: what `ssh-keygen -l` prints and sshd logs. */
export function sshFingerprint(key: PublicKey): string {
	const digest = createHash("sha256").update(Buffer.from(key.blob, "base64")).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function formatPublicKey(key: PublicKey): string {
	return [key.type, key.blob, key.comment].filter((p): p is string => p !== undefined).join(" ");
}

/** The comment `warden host setup` gives the laptop key it makes: who the key's owner is on a host. */
export function keyComment(machineId: string, user: string): string {
	return `warden:${machineId}:${user}`;
}

const COMMENT = /^warden:([A-Za-z0-9._@+-]{1,128}):([A-Za-z0-9._@+-]{1,128})$/;

export function parseKeyComment(comment: string | undefined): { machineId: string; user: string } | undefined {
	const match = comment === undefined ? null : COMMENT.exec(comment);
	return match?.[1] !== undefined && match[2] !== undefined ? { machineId: match[1], user: match[2] } : undefined;
}

/**
 * The `authorized_keys` line a grant writes: the key may only run `__host-serve --key <fingerprint>` (`restrict`
 * turns off pty, agent and X11 forwarding), with port forwarding back on for `warden dev --host` (`-R` / `-L`).
 */
export function authorizedLine(self: readonly string[], fingerprint: string, key: PublicKey): string {
	const command = [...self.map(shellQuote), "__host-serve", "--key", fingerprint].join(" ").replaceAll('"', '\\"');
	return `command="${command}",restrict,port-forwarding ${formatPublicKey(key)}`;
}

function linesWithout(text: string, blob: string): { kept: string[]; removed: number } {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const kept = lines.filter((l) => !l.split(/\s+/).includes(blob));
	return { kept, removed: lines.length - kept.length };
}

/** `text` with `key`'s line(s) replaced by `line`, everything else untouched. */
export function upsertAuthorized(text: string, key: PublicKey, line: string): string {
	const { kept } = linesWithout(text, key.blob);
	return `${[...kept, line].join("\n")}\n`;
}

export function removeAuthorized(text: string, blob: string): { text: string; removed: number } {
	const { kept, removed } = linesWithout(text, blob);
	return { text: kept.length > 0 ? `${kept.join("\n")}\n` : "", removed };
}
