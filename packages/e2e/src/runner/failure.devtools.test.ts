import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevtoolsFacet } from "@delacour/warden-devtools/devtools.types";
import { devtoolsFacetOpener } from "@delacour/warden-devtools/facet";
import { fakeMetros, fakePages } from "@delacour/warden-devtools/testing/devtools";
import { facetStubs } from "@delacour/warden-devtools/testing/facet";
import { failureArtifacts } from "./failure";

const cleanup: (() => void)[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wdn-failure-dt-"));
	dirs.push(dir);
	return dir;
};

async function openFake(): Promise<{
	facet: DevtoolsFacet;
	emit: (method: string, params: unknown) => void;
	queue: ReturnType<typeof fakePages.create>["state"];
}> {
	const p = fakePages.create();
	const fake = fakeMetros.start({ respond: (request, connection) => p.respond(request, connection) });
	cleanup.push(() => void fake.stop());
	const opened = await devtoolsFacetOpener.open({
		env: { metroUrl: fake.url },
		device: {},
		fetch,
		WebSocket,
		sleep: (ms) => (ms === 500 ? new Promise<void>(() => undefined) : Bun.sleep(2)),
	});
	if (!opened.success) throw new Error(opened.error.message);
	cleanup.push(() => opened.data.close());
	return { facet: opened.data, emit: fake.emit, queue: p.state };
}

describe("captureDevtoolsArtifacts", () => {
	test("writes console.jsonl and network.jsonl of the attached app", async () => {
		const { facet, emit, queue } = await openFake();
		emit("Runtime.consoleAPICalled", {
			type: "error",
			args: [{ type: "string", value: "kaboom" }],
			timestamp: 20,
		});
		await Bun.sleep(30);
		queue.queue.push(fakePages.entry("https://api.test/me", { status: 500 }));
		const dir = tmp();
		const capture = await failureArtifacts.captureDevtoolsArtifacts(facet, dir);
		expect(capture).toEqual({ files: ["console.jsonl", "network.jsonl"], problems: [] });
		expect(readFileSync(join(dir, "console.jsonl"), "utf8")).toContain("kaboom");
		expect(readFileSync(join(dir, "network.jsonl"), "utf8")).toContain("https://api.test/me");
	});

	test("an unwritable directory is a problem, not a throw", async () => {
		const stub = facetStubs.create();
		stub.facet.attachArtifacts = async () => ({
			success: false,
			error: { code: "io_failed", message: "no space" },
		});
		const capture = await failureArtifacts.captureDevtoolsArtifacts(stub.facet, tmp());
		expect(capture.files).toEqual([]);
		expect(capture.problems).toEqual(["devtools artifacts: io_failed: no space"]);
	});

	test("a wedged facet is given up on after the timeout", async () => {
		const stub = facetStubs.create();
		stub.facet.attachArtifacts = () => new Promise(() => undefined);
		const capture = await failureArtifacts.captureDevtoolsArtifacts(stub.facet, tmp(), 30);
		expect(capture.files).toEqual([]);
		expect(capture.problems[0]).toContain("timed out");
	});

	test("a throwing facet is a problem too", async () => {
		const stub = facetStubs.create();
		stub.facet.attachArtifacts = async () => {
			throw new Error("socket gone");
		};
		const dir = tmp();
		writeFileSync(join(dir, "keep"), "x");
		const capture = await failureArtifacts.captureDevtoolsArtifacts(stub.facet, dir);
		expect(capture.problems).toEqual(["devtools artifacts: socket gone"]);
	});
});
