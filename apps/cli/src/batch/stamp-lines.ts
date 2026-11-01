/** A log line's stamp: `[HH:MM:SS.mmm] `, local time. */
export const STAMP = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /;

export class StampLines {
	private pad(n: number, width = 2): string {
		return String(n).padStart(width, "0");
	}

	/** `d` as local `HH:MM:SS.mmm`. */
	clockOf(d: Date): string {
		return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}:${this.pad(d.getSeconds())}.${this.pad(d.getMilliseconds(), 3)}`;
	}

	/**
	 * A stamper for one output stream: prefixes each line with `[HH:MM:SS.mmm] ` (the time its first
	 * byte arrived). A line split across chunks is stamped once, so the state carries between calls.
	 */
	lineStamper(now: () => Date): (chunk: string) => string {
		let lineStart = true;
		return (chunk) => {
			if (chunk === "") return "";
			const prefix = `[${this.clockOf(now())}] `;
			const lines = chunk.split("\n");
			const tail = lines.pop() ?? "";
			const head = lines.map((line, i) => (i === 0 && !lineStart ? line : prefix + line));
			const rest = tail === "" ? "" : lines.length === 0 && !lineStart ? tail : prefix + tail;
			lineStart = tail === "";
			return head.length > 0 ? `${head.join("\n")}\n${rest}` : rest;
		};
	}

	/** `line` without its leading stamp (unchanged when it has none). */
	unstamp(line: string): string {
		return line.replace(STAMP, "");
	}
}

export const stampLines = new StampLines();
