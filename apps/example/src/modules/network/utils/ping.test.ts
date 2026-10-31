import { describe, expect, test } from "bun:test";
import { ping } from "./ping";

const clock = () => {
	let t = 0;
	return () => (t += 25);
};

describe("ping", () => {
	test("one request, no retry: a landed 200", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return new Response("x");
		}) as unknown as typeof fetch;
		const result = await ping("https://x.test", { fetchImpl, timeoutMs: 50, now: clock() });
		expect(result).toEqual({ ok: true, status: 200, ms: 25 });
		expect(calls).toBe(1);
	});

	test("a failure is reported once, as a failure", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			throw new TypeError("Network request failed");
		}) as unknown as typeof fetch;
		const result = await ping("https://x.test", { fetchImpl, timeoutMs: 50, now: clock() });
		expect(result).toEqual({ ok: false, status: null, error: "Network request failed", ms: 25 });
		expect(calls).toBe(1);
	});

	test("an HTTP error status is a failure", async () => {
		const fetchImpl = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
		const result = await ping("https://x.test", { fetchImpl, timeoutMs: 50, now: clock() });
		expect(result).toMatchObject({ ok: false, status: 503, error: "HTTP 503" });
	});

	test("aborts at the timeout", async () => {
		const fetchImpl = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			})) as unknown as typeof fetch;
		const result = await ping("https://x.test", { fetchImpl, timeoutMs: 20, now: clock() });
		expect(result).toMatchObject({ ok: false, error: "Timed out" });
	});
});
