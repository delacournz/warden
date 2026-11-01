/** Result of a finished command. Structurally the same as core's `ExecResult`. */
export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type ExecOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	/** aborting kills the command (SIGTERM), like a timeout */
	signal?: AbortSignal;
};

/** Injectable process runner. Structurally the same as core's `Exec`; core may re-export this later. */
export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Whether a pid is alive. Structurally the same as core's `PidAlive`. */
export type PidAlive = (pid: number) => boolean;

/** Typed progress a host can render (spinners, logs) or ignore. */
export type WardenLogEvent =
	| { kind: "progress"; phase: string; message: string; deviceId?: string; leaseId?: string }
	| { kind: "warn"; message: string; scope?: string }
	| {
			kind: "fingerprint";
			platform: string;
			key: string;
			/** native-only hash, set when `key` also covers the JS inputs */
			native?: string;
			/** the JS inputs' hash (`fingerprint.include` native+js) */
			js?: string;
			project: string;
			variant?: string;
			projectKey: string;
	  }
	| { kind: "debug"; message: string }
	| { kind: "lease"; action: "claimed" | "released"; leaseId: string; deviceId?: string; label?: string };

/** Every side effect warden's logic needs, injected: the one deps type each package takes. */
export type WardenHost = {
	env: Record<string, string | undefined>;
	cwd: string;
	/** the warden home directory (`WARDEN_HOME` or `~/.warden`) */
	home: string;
	now: () => number;
	exec: Exec;
	sleep: (ms: number) => Promise<void>;
	pidAlive: PidAlive;
	log?: (event: WardenLogEvent) => void;
};
