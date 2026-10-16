import { describe, expect, test } from "bun:test";
import { NETWORK_SCRIPT, type NetworkScriptConfig, networkInstallExpression } from "./network.script";

type Page = {
	fetch: (input: unknown, init?: Record<string, unknown>) => Promise<Response>;
	__warden_net_patched?: boolean;
	__warden_net_drain?: () => string;
};

type Recorded = {
	method: string;
	url: string;
	status: number;
	durationMs: number;
	ts: number;
	requestHeaders: Record<string, string>;
	responseHeaders: Record<string, string>;
	requestBody?: string;
	responseBody?: string;
	responseBodyTruncated?: boolean;
	error?: string;
};

const config = (extra: Partial<NetworkScriptConfig> = {}): NetworkScriptConfig => ({
	ring: 2000,
	includeBodies: false,
	skipPrefixes: ["http://127.0.0.1:8081", "http://localhost:8081"],
	...extra,
});

/** The script source compiled as Hermes would receive it: untranspiled text, run against a fake global. */
function compile<G>(): (cfg: NetworkScriptConfig, g: G) => string {
	return new Function(`return (${NETWORK_SCRIPT});`)();
}

function install(
	fake: Page["fetch"],
	extra: Partial<NetworkScriptConfig> = {}
): { page: Page; result: string; drain: () => Recorded[] } {
	const page: Page = { fetch: fake };
	const result = compile<Page>()(config(extra), page);
	const drain = (): Recorded[] => JSON.parse(page.__warden_net_drain?.() ?? "[]");
	return { page, result, drain };
}

const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Req": "1" }, ...init });

describe("network script", () => {
	test("stays plain ES2015: nothing Hermes would reject when evaluated untranspiled", () => {
		expect(NETWORK_SCRIPT).not.toMatch(/\basync\b|\bawait\b|=>|\?\.|\?\?|\bclass\b/);
	});

	test("patches once; a second install is a no-op", () => {
		const original = async () => json({});
		const first = install(original);
		expect(first.result).toBe("patched");
		const wrapped = first.page.fetch;
		expect(wrapped).not.toBe(original);
		expect(compile<Page>()(config(), first.page)).toBe("already");
		expect(first.page.fetch).toBe(wrapped);
	});

	test("an app without fetch is reported, not crashed", () => {
		expect(compile<Record<string, unknown>>()(config(), {})).toBe("no fetch");
	});

	test("records method, url, status, duration and lower-cased headers; the app still gets its response", async () => {
		const { page, drain } = install(async () => json({ ok: true }, { status: 201 }));
		const res = await page.fetch("https://api.example.com/items", {
			method: "post",
			headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true });
		const [entry] = drain();
		expect(entry).toMatchObject({
			method: "POST",
			url: "https://api.example.com/items",
			status: 201,
			requestHeaders: { authorization: "Bearer x", "content-type": "application/json" },
			responseHeaders: { "content-type": "application/json", "x-req": "1" },
		});
		expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
		expect(entry?.ts).toBeGreaterThan(0);
		expect(entry).not.toHaveProperty("requestBody");
		expect(entry).not.toHaveProperty("responseBody");
	});

	test("accepts Headers, header pair lists and Request inputs", async () => {
		const { page, drain } = install(async () => json({}));
		await page.fetch("https://a.test/1", { headers: new Headers({ "X-A": "1" }) });
		await page.fetch("https://a.test/2", { headers: [["X-B", "2"]] });
		await page.fetch(new Request("https://a.test/3", { method: "PUT", headers: { "X-C": "3" } }));
		const entries = drain();
		expect(entries.map((e) => [e.method, e.url, e.requestHeaders])).toEqual([
			["GET", "https://a.test/1", { "x-a": "1" }],
			["GET", "https://a.test/2", { "x-b": "2" }],
			["PUT", "https://a.test/3", { "x-c": "3" }],
		]);
	});

	test("Metro traffic is passed through unrecorded", async () => {
		let calls = 0;
		const { page, drain } = install(async () => {
			calls++;
			return json({});
		});
		await page.fetch("http://127.0.0.1:8081/symbolicate");
		await page.fetch("http://localhost:8081/logs");
		await page.fetch("http://127.0.0.1:80810/not-metro");
		expect(calls).toBe(3);
		expect(drain().map((e) => e.url)).toEqual(["http://127.0.0.1:80810/not-metro"]);
	});

	test("bodies are opt-in: request text and a cloned response body", async () => {
		const { page, drain } = install(async () => json({ answer: 42 }), { includeBodies: true });
		const res = await page.fetch("https://a.test/q", { method: "POST", body: JSON.stringify({ q: 1 }) });
		expect(await res.json()).toEqual({ answer: 42 });
		await Bun.sleep(5);
		expect(drain()[0]).toMatchObject({ requestBody: '{"q":1}', responseBody: '{"answer":42}' });
	});

	test("URLSearchParams request bodies are recorded; streams and blobs are not", async () => {
		const { page, drain } = install(async () => json({}), { includeBodies: true });
		await page.fetch("https://a.test/form", { method: "POST", body: new URLSearchParams({ a: "1" }) });
		await page.fetch("https://a.test/blob", { method: "POST", body: new Blob(["x"]) });
		await Bun.sleep(5);
		const [form, blob] = drain();
		expect(form?.requestBody).toBe("a=1");
		expect(blob).not.toHaveProperty("requestBody");
	});

	test("response bodies over 64 KB are cut and flagged; binary content types are skipped", async () => {
		const big = "x".repeat(70 * 1024);
		const { page, drain } = install(
			async (input) =>
				String(input).endsWith("/img")
					? new Response("PNG", { headers: { "Content-Type": "image/png" } })
					: new Response(big, { headers: { "Content-Type": "text/plain" } }),
			{ includeBodies: true }
		);
		await page.fetch("https://a.test/big");
		await page.fetch("https://a.test/img");
		await Bun.sleep(10);
		const entries = drain();
		const bigEntry = entries.find((e) => e.url.endsWith("/big"));
		const imgEntry = entries.find((e) => e.url.endsWith("/img"));
		expect(bigEntry?.responseBody).toHaveLength(64 * 1024);
		expect(bigEntry?.responseBodyTruncated).toBe(true);
		expect(imgEntry).toBeDefined();
		expect(imgEntry).not.toHaveProperty("responseBody");
	});

	test("a failed request is recorded with status 0 and the error, and still rejects for the app", async () => {
		const { page, drain } = install(async () => {
			throw new TypeError("Network request failed");
		});
		await expect(page.fetch("https://a.test/down")).rejects.toThrow("Network request failed");
		expect(drain()[0]).toMatchObject({ status: 0, error: "Network request failed", url: "https://a.test/down" });
	});

	test("the ring keeps the newest 2000 entries; drain empties it", async () => {
		const { page, drain } = install(async () => json({}));
		for (let i = 0; i < 2100; i++) await page.fetch(`https://a.test/${i}`);
		const entries = drain();
		expect(entries).toHaveLength(2000);
		expect(entries[0]?.url).toBe("https://a.test/100");
		expect(entries.at(-1)?.url).toBe("https://a.test/2099");
		expect(drain()).toEqual([]);
	});

	test("install expression embeds the config and picks the global object", () => {
		const expression = networkInstallExpression(config({ includeBodies: true }));
		expect(expression).toContain('"includeBodies":true');
		expect(expression).toContain("globalThis");
		const page: Page = { fetch: async () => json({}) };
		const wrapper = new Function("globalThis", `return ${expression};`);
		expect(wrapper(page)).toBe("patched");
		expect(page.__warden_net_patched).toBe(true);
	});
});
