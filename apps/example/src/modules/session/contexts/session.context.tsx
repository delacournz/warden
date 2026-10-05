import { createContext, type ReactNode, use, useMemo, useState } from "react";

type Session = { email: string } | null;

type SessionContextValue = {
	session: Session;
	signIn: (email: string) => void;
	signOut: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/** In-memory session: every launch starts signed out, so each e2e test begins from the welcome screen. */
export function SessionProvider({ children }: { children: ReactNode }) {
	const [session, setSession] = useState<Session>(null);
	const value = useMemo<SessionContextValue>(
		() => ({
			session,
			signIn: (email) => setSession({ email: email.trim().toLowerCase() }),
			signOut: () => setSession(null),
		}),
		[session]
	);
	return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionContextValue {
	const value = use(SessionContext);
	if (!value) throw new Error("useSession must be used inside <SessionProvider>");
	return value;
}
