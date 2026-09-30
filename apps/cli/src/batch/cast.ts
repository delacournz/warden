/** asciicast v2 (https://docs.asciinema.org/manual/asciicast/v2/) recorder for warden's own TUI output. */
export type Cast = {
	/** output `data` written at epoch ms `at`; bare `\n` becomes `\r\n` (raw terminal) */
	write: (at: number, data: string) => void;
	/** grow the recorded terminal height to fit a frame of `lines` */
	resizeTo: (lines: number) => void;
	/** the `.cast` file: header line + one `[seconds, "o", data]` line per write */
	text: () => string;
};

export function createCast(opts: { width: number; height: number; startedAt: number }): Cast {
	let height = opts.height;
	const events: string[] = [];
	return {
		write: (at, data) => {
			const t = Math.max(0, Math.round(at - opts.startedAt)) / 1000;
			events.push(JSON.stringify([t, "o", data.replace(/\r?\n/g, "\r\n")]));
		},
		resizeTo: (lines) => {
			height = Math.max(height, lines);
		},
		text: () => {
			const header = {
				version: 2,
				width: opts.width,
				height,
				timestamp: Math.floor(opts.startedAt / 1000),
				env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
			};
			return `${[JSON.stringify(header), ...events].join("\n")}\n`;
		},
	};
}
