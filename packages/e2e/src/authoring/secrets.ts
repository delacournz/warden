import { err, ok, type Result } from "@delacour/warden-types/result";
import type { Text } from "./recording.schema";

/** Keep secrets out of the journal: a typed value equal to a `WARDEN_UI_SECRET_<NAME>` is stored as its name. */

export const SECRET_PREFIX = "WARDEN_UI_SECRET_";

export type Env = Readonly<Record<string, string | undefined>>;

/** Every non-empty `WARDEN_UI_SECRET_<NAME>` in `env`. */
export function secretsFromEnv(env: Env): { name: string; value: string }[] {
	const secrets: { name: string; value: string }[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(SECRET_PREFIX) || key.length === SECRET_PREFIX.length) continue;
		if (value !== undefined && value !== "") secrets.push({ name: key.slice(SECRET_PREFIX.length), value });
	}
	return secrets;
}

/** A text that is exactly a secret's value is stored as `{ secret: NAME }` so the value never reaches disk. */
export function redactSecrets(value: string, env: Env): Text {
	const match = secretsFromEnv(env).find((secret) => secret.value === value);
	return match ? { secret: match.name } : value;
}

/** The plain text a stored `Text` stands for; a secret is read from `WARDEN_UI_SECRET_<NAME>` in `env`. */
export function resolveText(value: Text, env: Env): Result<string> {
	if (typeof value === "string") return ok(value);
	const found = env[`${SECRET_PREFIX}${value.secret}`];
	if (found === undefined || found === "") return err(`set ${SECRET_PREFIX}${value.secret} to run this step`);
	return ok(found);
}
