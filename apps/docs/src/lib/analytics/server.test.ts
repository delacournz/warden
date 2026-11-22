import { describe, expect, test } from "bun:test";
import { isbot } from "isbot";
import {
	AGENT_BUCKETS,
	agentBucket,
	agentFetchTarget,
	captureUrl,
	createEventCap,
	type PageSlugs,
	reportAgentFetch,
	SERVER_USER_AGENT,
	serverEventBody,
} from "./server";

const posthog = { kind: "on", token: "phc_test", host: "https://i.delacour.co.nz" } as const;

/** A two-page site: the docs root and `getting-started/quickstart`. */
const pageSlugs: PageSlugs = (slugs) => {
	const path = slugs.join("/");
	return path === "" || path === "getting-started/quickstart" ? slugs : null;
};

describe("agentFetchTarget", () => {
	test("names the llms files", () => {
		expect(agentFetchTarget("/llms.txt", pageSlugs)).toEqual({ kind: "llms", path: "/llms.txt" });
		expect(agentFetchTarget("/llms-full.txt", pageSlugs)).toEqual({ kind: "llms", path: "/llms-full.txt" });
	});

	test("names a known page's markdown twin by the page's own address", () => {
		expect(agentFetchTarget("/docs/getting-started/quickstart.md", pageSlugs)).toEqual({
			kind: "markdown",
			path: "/docs/getting-started/quickstart.md",
		});
		expect(agentFetchTarget("/docs/index.md", pageSlugs)).toEqual({ kind: "markdown", path: "/docs/index.md" });
	});

	test("spells one page one way, however the request spelled it", () => {
		expect(agentFetchTarget("/docs/getting-started/%71uickstart.md", pageSlugs)).toEqual({
			kind: "markdown",
			path: "/docs/getting-started/quickstart.md",
		});
	});

	test("ignores a markdown address no page answers to", () => {
		expect(agentFetchTarget("/docs/nope.md", pageSlugs)).toBeNull();
		expect(agentFetchTarget("/docs/getting-started/quickstart/extra.md", pageSlugs)).toBeNull();
		expect(agentFetchTarget("/docs/%E0%A4%A.md", pageSlugs)).toBeNull();
	});

	test("ignores everything a browser renders", () => {
		expect(agentFetchTarget("/", pageSlugs)).toBeNull();
		expect(agentFetchTarget("/docs/getting-started/quickstart", pageSlugs)).toBeNull();
		expect(agentFetchTarget("/api/search", pageSlugs)).toBeNull();
		expect(agentFetchTarget("/favicon.svg", pageSlugs)).toBeNull();
		expect(agentFetchTarget("/robots.txt", pageSlugs)).toBeNull();
	});
});

describe("agentBucket", () => {
	test("names a program on the list by its label", () => {
		expect(agentBucket("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)")).toBe(
			"claudebot"
		);
		expect(agentBucket("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toBe("gptbot");
		expect(agentBucket("curl/8.7.1")).toBe("curl");
		expect(agentBucket("python-requests/2.32.3")).toBe("python");
		expect(agentBucket("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")).toBe("browser");
	});

	test("puts the more specific program first", () => {
		expect(agentBucket("Claude-User/1.0")).toBe("claude-user");
		expect(agentBucket("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
	});

	test("calls everything else, and a missing header, other", () => {
		expect(agentBucket("my-private-tool/0.1 (build 9f2c; host-name)")).toBe("other");
		expect(agentBucket("")).toBe("other");
		expect(agentBucket(null)).toBe("other");
	});

	test("only ever answers with a label from the list", () => {
		const labels = new Set<string>([...AGENT_BUCKETS.map((bucket) => bucket.label), "other"]);

		for (const agent of ["x".repeat(500), "ClaudeBot/1.0 (a b; c)", "curl/8.7.1\nsecond-line", "🤖"]) {
			expect(labels.has(agentBucket(agent))).toBe(true);
		}
	});
});

describe("captureUrl", () => {
	test("is PostHog's single-event endpoint on the configured host", () => {
		expect(captureUrl(posthog)).toBe("https://i.delacour.co.nz/i/v0/e/");
	});
});

describe("serverEventBody", () => {
	const target = { kind: "markdown", path: "/docs/getting-started/quickstart.md" } as const;

	test("is the shape PostHog's capture endpoint takes, carrying the page's address and the program's label", () => {
		const request = new Request("https://warden.co.nz/docs/getting-started/%71uickstart.md?x=1", {
			headers: { "user-agent": "ClaudeBot/1.0 (extra detail)", "accept-language": "en-NZ,en;q=0.9" },
		});

		expect(serverEventBody(posthog, request, target)).toEqual({
			api_key: "phc_test",
			event: "agent-fetch",
			distinct_id: "agent:claudebot",
			properties: {
				path: "/docs/getting-started/quickstart.md",
				kind: "markdown",
				agent: "claudebot",
				$current_url: "https://warden.co.nz/docs/getting-started/quickstart.md",
				$host: "warden.co.nz",
				$pathname: "/docs/getting-started/quickstart.md",
				$lib: "warden-docs",
				site: "warden",
				surface: "server",
				$process_person_profile: false,
				$geoip_disable: true,
			},
		});
	});

	test("carries nothing of the request but its host and the program's label", () => {
		const request = new Request("https://warden.co.nz/llms.txt?token=query-value", {
			headers: {
				"user-agent": "private-tool/1.0 (ua-detail)",
				"accept-language": "mi-NZ",
				"x-forwarded-for": "203.0.113.7",
				"x-real-ip": "203.0.113.7",
				referer: "https://referrer.example/",
			},
		});
		const body = JSON.stringify(serverEventBody(posthog, request, { kind: "llms", path: "/llms.txt" }));

		for (const value of ["query-value", "private-tool", "ua-detail", "mi-NZ", "203.0.113.7", "referrer.example"]) {
			expect(body).not.toContain(value);
		}
		expect(body).toContain('"agent":"other"');
	});
});

describe("the user agent the server sends as", () => {
	/**
	 * PostHog's web analytics hides events whose user agent looks like a bot,
	 * which is every agent this event exists to count. The caller's label rides
	 * in `agent` instead, and the header is one a bot filter lets through.
	 */
	test("is not one a bot filter drops", () => {
		expect(isbot(SERVER_USER_AGENT)).toBe(false);
	});
});

describe("createEventCap", () => {
	test("allows the limit in one window, then nothing until the next", () => {
		let now = 1_000;
		const allow = createEventCap({ limit: 3, windowMs: 60_000, now: () => now });

		expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);

		now += 59_999;
		expect(allow()).toBe(false);

		now += 1;
		expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
	});
});

describe("reportAgentFetch", () => {
	type Sent = { url: string; init: RequestInit | undefined };

	function capture(run: () => void): Sent[] {
		const sent: Sent[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			sent.push({ url: String(input), init });
			return new Response("ok");
		}) as typeof fetch;

		try {
			run();
		} finally {
			globalThis.fetch = original;
		}
		return sent;
	}

	const always = () => true;
	const deps = { posthog, pageSlugs, allow: always };
	const ok = new Response("ok");
	const paths = (sent: Sent[]) => sent.map((request) => JSON.parse(String(request.init?.body)).properties.path);

	/**
	 * The browser SDK refuses to start on a host that is not the site's, so a
	 * production build on `localhost` never counts itself; this is the same rule
	 * for the server's events, so a `curl localhost:3210/llms.txt` while testing
	 * never reaches the real project.
	 */
	test("sends nothing for a request that did not arrive on a counted host", () => {
		const sent = capture(() => {
			reportAgentFetch(new Request("http://localhost:3210/llms.txt"), ok, deps);
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), ok, deps);
			reportAgentFetch(new Request("https://staging.warden.co.nz/llms.txt"), ok, deps);
		});

		expect(sent.map((request) => request.url)).toEqual([
			"https://i.delacour.co.nz/i/v0/e/",
			"https://i.delacour.co.nz/i/v0/e/",
		]);
	});

	test("sends nothing for a page, or when PostHog is off", () => {
		const sent = capture(() => {
			reportAgentFetch(new Request("https://warden.co.nz/docs/getting-started/quickstart"), ok, deps);
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), ok, { ...deps, posthog: { kind: "off" } });
		});

		expect(sent).toEqual([]);
	});

	test("counts only a read that was answered with the file", () => {
		const sent = capture(() => {
			for (const status of [301, 304, 404, 500]) {
				reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), new Response(null, { status }), deps);
			}
			reportAgentFetch(new Request("https://warden.co.nz/docs/nope.md"), ok, deps);
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt", { method: "HEAD" }), ok, deps);
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt", { method: "POST" }), ok, deps);
			reportAgentFetch(new Request("https://warden.co.nz/docs/index.md"), ok, deps);
		});

		expect(paths(sent)).toEqual(["/docs/index.md"]);
	});

	test("stops sending once the window's cap is reached", () => {
		const allow = createEventCap({ limit: 2, windowMs: 60_000, now: () => 0 });
		const sent = capture(() => {
			for (let read = 0; read < 5; read++) {
				reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), ok, { ...deps, allow });
			}
		});

		expect(sent.length).toBe(2);
	});

	test("spends none of the cap on a request it does not count", () => {
		const allow = createEventCap({ limit: 1, windowMs: 60_000, now: () => 0 });
		const sent = capture(() => {
			reportAgentFetch(new Request("https://warden.co.nz/docs/nope.md"), ok, { ...deps, allow });
			reportAgentFetch(new Request("https://warden.co.nz/"), ok, { ...deps, allow });
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), ok, { ...deps, allow });
		});

		expect(sent.length).toBe(1);
	});

	test("posts JSON as the server's own agent", () => {
		const [request] = capture(() => reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), ok, deps));

		expect(request?.init?.method).toBe("POST");
		expect(request?.init?.headers).toEqual({ "content-type": "application/json", "user-agent": SERVER_USER_AGENT });
		expect(JSON.parse(String(request?.init?.body)).event).toBe("agent-fetch");
	});
});
