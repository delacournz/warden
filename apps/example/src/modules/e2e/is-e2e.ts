/** Set for e2e builds (`EXPO_PUBLIC_E2E=1`): freezes decorative motion so the runner's settle waits stay short. */
export const IS_E2E = process.env.EXPO_PUBLIC_E2E === "1";
