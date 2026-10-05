export type Credentials = { email: string; password: string };

export type CredentialsCheck = { ok: true } | { ok: false; field: "email" | "password" | "form"; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one account the demo refuses, so the form-level error path has a deterministic trigger. */
export const LOCKED_EMAIL = "locked@example.com";

export function validateCredentials({ email, password }: Credentials): CredentialsCheck {
	const trimmed = email.trim().toLowerCase();
	if (!EMAIL.test(trimmed)) return { ok: false, field: "email", message: "Enter a valid email address." };
	if (password.length < 8) return { ok: false, field: "password", message: "Password must be at least 8 characters." };
	if (trimmed === LOCKED_EMAIL)
		return { ok: false, field: "form", message: "This account is locked. Try another email." };
	return { ok: true };
}
