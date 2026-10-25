const REDACTED = "[redacted]";

/** `Authorization: Basic abc…` / `Authorization: Bearer abc…` (the whole value, scheme included). */
const AUTHORIZATION = /(authorization["']?\s*[:=]\s*["']?)[^\r\n"']+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const API_KEY = /(\bapi[_-]?key["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi;
const PASSWORD = /(\bpass(?:word|wd)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Mask secrets in one log line: Authorization/Bearer tokens, `api_key=`, JWTs, `password=`, emails → `[redacted]`. */
export function redact(line: string): string {
	return line
		.replace(AUTHORIZATION, `$1${REDACTED}`)
		.replace(BEARER, `Bearer ${REDACTED}`)
		.replace(JWT, REDACTED)
		.replace(API_KEY, `$1${REDACTED}`)
		.replace(PASSWORD, `$1${REDACTED}`)
		.replace(EMAIL, REDACTED);
}
