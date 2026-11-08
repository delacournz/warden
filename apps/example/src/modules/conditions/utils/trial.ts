export const TRIAL_DAYS = 14;

const DAY_MS = 86_400_000;

/** When this launch started: the install date stand-in (state is in memory, every launch is a first open). */
export const INSTALLED_AT = Date.now();

/** True once `now` is more than `TRIAL_DAYS` days after `installedAt`. */
export function isTrialExpired(now: number, installedAt: number = INSTALLED_AT): boolean {
	return now - installedAt > TRIAL_DAYS * DAY_MS;
}
