export type TextBatcher = {
	push: (text: string) => void;
	flush: () => void;
	cancel: () => void;
};

/** Debounced text buffer: keys collect until `delayMs` of quiet, or an explicit flush. */
export function createTextBatcher(options: {
	send: (text: string) => void;
	delayMs: number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}): TextBatcher {
	let buffer = "";
	let handle: unknown = null;

	const clear = () => {
		if (handle !== null) options.clearTimer(handle);
		handle = null;
	};
	const flush = () => {
		clear();
		if (buffer === "") return;
		const text = buffer;
		buffer = "";
		options.send(text);
	};
	return {
		push(text) {
			buffer += text;
			clear();
			handle = options.setTimer(flush, options.delayMs);
		},
		flush,
		cancel() {
			clear();
			buffer = "";
		},
	};
}
