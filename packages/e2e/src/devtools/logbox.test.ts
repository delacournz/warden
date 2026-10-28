import { describe, expect, test } from "bun:test";
import { ok, type Result } from "@delacour/warden-types/result";
import type { EvaluateError } from "./devtools.types";
import { type LogBoxSession, muteLogBox } from "./logbox";
import { LOGBOX_EXPRESSION } from "./logbox.script";

type Reply = Result<unknown, EvaluateError>;

/** A session whose evaluate answers from `replies` in turn (the last one repeats); `reconnect()` fires `reconnected`. */
function fakeSession(replies: Reply[]) {
	const expressions: string[] = [];
	const handlers = new Set<() => void>();
	let next = 0;
	const session: LogBoxSession = {
		async evaluate(expression) {
			expressions.push(expression);
			const reply = replies[Math.min(next, replies.length - 1)] as Reply;
			next++;
			return reply;
		},
		on(_event, handler) {
			const h = () => handler();
			handlers.add(h);
			return () => handlers.delete(h);
		},
	};
	return {
		session,
		expressions,
		reconnect: () => {
			for (const h of [...handlers]) h();
		},
	};
}

const tick = () => Bun.sleep(5);
const fast = { sleep: () => Promise.resolve(), intervalMs: 1 };

describe("muteLogBox", () => {
	test("evaluates the LogBox script once when the app answers off", async () => {
		const { session, expressions } = fakeSession([ok("off")]);
		const muted = muteLogBox(session, fast);
		await muted.settled;
		expect(expressions).toEqual([LOGBOX_EXPRESSION]);
		muted.stop();
	});

	test("retries while the bundle is not loaded, then stops at off", async () => {
		const { session, expressions } = fakeSession([
			ok("no-require"),
			{ success: false, error: { message: "context gone", code: "cdp_closed" } },
			ok("not-ready"),
			ok("off"),
		]);
		const muted = muteLogBox(session, fast);
		await muted.settled;
		expect(expressions).toHaveLength(4);
		muted.stop();
	});

	test("gives up after its attempts and logs once", async () => {
		const { session, expressions } = fakeSession([ok("no-require")]);
		const lines: string[] = [];
		const muted = muteLogBox(session, { ...fast, attempts: 3, log: (line) => lines.push(line) });
		await muted.settled;
		expect(expressions).toHaveLength(3);
		expect(lines).toEqual(["devtools: LogBox left on (no-require after 3 attempts)"]);
		muted.stop();
	});

	test("applies again after every reconnect (relaunch, JS reload)", async () => {
		const { session, expressions, reconnect } = fakeSession([ok("off")]);
		const muted = muteLogBox(session, fast);
		await muted.settled;
		reconnect();
		await tick();
		reconnect();
		await tick();
		expect(expressions).toHaveLength(3);
		muted.stop();
		reconnect();
		await tick();
		expect(expressions).toHaveLength(3);
	});

	test("stop ends a retry loop", async () => {
		const { session, expressions } = fakeSession([ok("no-require")]);
		const muted = muteLogBox(session, { sleep: () => Bun.sleep(2), intervalMs: 2 });
		await tick();
		muted.stop();
		const seen = expressions.length;
		await tick();
		await tick();
		expect(expressions.length).toBeLessThanOrEqual(seen + 1);
		await muted.settled;
	});
});
