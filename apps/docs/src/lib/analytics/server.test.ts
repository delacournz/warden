import { describe, expect, test } from "bun:test";
import { isbot } from "isbot";
import { agentFetch, captureUrl, reportAgentFetch, SERVER_USER_AGENT, serverEventBody } from "./server";

const posthog = { kind: "on", token: "phc_test", host: "https://i.delacour.co.nz" } as const;

describe("agentFetch", () => {
	test("names the llms files", () => {
		expect(agentFetch("/llms.txt")).toBe("llms");
		expect(agentFetch("/llms-full.txt")).toBe("llms");
	});

	test("names a docs page's markdown twin", () => {
		expect(agentFetch("/docs/quickstart.md")).toBe("markdown");
		expect(agentFetch("/docs/index.md")).toBe("markdown");
	});

	test("ignores everything a browser renders", () => {
		expect(agentFetch("/")).toBeNull();
		expect(agentFetch("/docs/quickstart")).toBeNull();
		expect(agentFetch("/api/search")).toBeNull();
		expect(agentFetch("/favicon.svg")).toBeNull();
		expect(agentFetch("/robots.txt")).toBeNull();
	});
});

describe("captureUrl", () => {
	test("is PostHog's single-event endpoint on the configured host", () => {
		expect(captureUrl(posthog)).toBe("https://i.delacour.co.nz/i/v0/e/");
	});
});

describe("serverEventBody", () => {
	test("is the shape PostHog's capture endpoint takes, carrying the caller's agent as a property", () => {
		const request = new Request("https://warden.co.nz/llms.txt?x=1", {
			headers: { "user-agent": "ClaudeBot/1.0", "accept-language": "en-NZ,en;q=0.9" },
		});

		expect(serverEventBody(posthog, request, "llms")).toEqual({
			api_key: "phc_test",
			event: "agent-fetch",
			distinct_id: "agent:ClaudeBot/1.0",
			properties: {
				path: "/llms.txt",
				kind: "llms",
				agent: "ClaudeBot/1.0",
				$current_url: "https://warden.co.nz/llms.txt",
				$host: "warden.co.nz",
				$pathname: "/llms.txt",
				$browser_language: "en-NZ",
				$lib: "warden-docs",
				site: "warden",
				surface: "server",
				$process_person_profile: false,
				$geoip_disable: true,
			},
		});
	});

	test("truncates a long user agent and tolerates a missing one", () => {
		const long = new Request("https://warden.co.nz/llms.txt", { headers: { "user-agent": "x".repeat(500) } });
		const none = new Request("https://warden.co.nz/llms.txt");

		expect(serverEventBody(posthog, long, "llms").properties.agent.length).toBe(190);
		expect(serverEventBody(posthog, long, "llms").distinct_id.length).toBeLessThanOrEqual(200);
		expect(serverEventBody(posthog, none, "llms").properties.agent).toBe("unknown");
		expect(serverEventBody(posthog, none, "llms").properties.$browser_language).toBe("");
	});

	/** The server's own address is the only one PostHog sees; nothing from the reader's request carries theirs. */
	test("carries no IP address", () => {
		const request = new Request("https://warden.co.nz/llms.txt", {
			headers: { "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" },
		});

		expect(JSON.stringify(serverEventBody(posthog, request, "llms"))).not.toContain("203.0.113.7");
	});
});

describe("the user agent the server sends as", () => {
	/**
	 * PostHog's web analytics hides events whose user agent looks like a bot,
	 * which is every agent this event exists to count. The caller's agent rides
	 * in `agent` instead, and the header is one a bot filter lets through.
	 */
	test("is not one a bot filter drops", () => {
		expect(isbot(SERVER_USER_AGENT)).toBe(false);
	});
});

describe("reportAgentFetch", () => {
	function capture(run: () => void): { url: string; init: RequestInit | undefined }[] {
		const sent: { url: string; init: RequestInit | undefined }[] = [];
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

	/**
	 * The browser SDK refuses to start on a host that is not the site's, so a
	 * production build on `localhost` never counts itself; this is the same rule
	 * for the server's events, so a `curl localhost:3210/llms.txt` while testing
	 * never reaches the real project.
	 */
	test("sends nothing for a request that did not arrive on a counted host", () => {
		const sent = capture(() => {
			reportAgentFetch(new Request("http://localhost:3210/llms.txt"), posthog);
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), posthog);
			reportAgentFetch(new Request("https://staging.warden.co.nz/llms.txt"), posthog);
		});

		expect(sent.map((request) => request.url)).toEqual([
			"https://i.delacour.co.nz/i/v0/e/",
			"https://i.delacour.co.nz/i/v0/e/",
		]);
	});

	test("sends nothing for a page, or when PostHog is off", () => {
		const sent = capture(() => {
			reportAgentFetch(new Request("https://warden.co.nz/docs/quickstart"), posthog);
			reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), { kind: "off" });
		});

		expect(sent).toEqual([]);
	});

	test("posts JSON as the server's own agent", () => {
		const [request] = capture(() => reportAgentFetch(new Request("https://warden.co.nz/llms.txt"), posthog));

		expect(request?.init?.method).toBe("POST");
		expect(request?.init?.headers).toEqual({ "content-type": "application/json", "user-agent": SERVER_USER_AGENT });
		expect(JSON.parse(String(request?.init?.body)).event).toBe("agent-fetch");
	});
});
