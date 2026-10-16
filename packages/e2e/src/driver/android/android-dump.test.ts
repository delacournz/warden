import { describe, expect, test } from "bun:test";
import { collectSpanDetail, type SpanDetail } from "../span-detail";
import { openAdbSession } from "./adb-session";
import { createDumper, type DumpRoute, routeOrder } from "./android-dump";
import { fakeAndroidHost } from "./android-host.testing";

const XML = '<?xml version="1.0"?><hierarchy rotation="0"><node class="x" bounds="[0,0][1,1]" /></hierarchy>';
const TRAILER = "UI hierchary dumped to: /dev/stdout\n";
const TTY = /exec-out uiautomator dump \/dev\/tty$/;

function setup(init: Parameters<typeof fakeAndroidHost>[0]) {
	const host = fakeAndroidHost(init);
	const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
	const lines: string[] = [];
	const dumper = createDumper({ session, exec: host.exec, adb: "adb", serial: "s1", log: (l) => lines.push(l) });
	return { host, session, dumper, lines };
}

describe("route order", () => {
	test("tty first from API 30, where the resident shell's stdout route is the one that comes back empty", () => {
		expect(routeOrder(30)).toEqual(["tty", "stdout", "file"]);
		expect(routeOrder(36)).toEqual(["tty", "stdout", "file"]);
	});

	test("stdout first below API 30 and when the level is unknown", () => {
		expect(routeOrder(29)).toEqual(["stdout", "tty", "file"]);
		expect(routeOrder(undefined)).toEqual(["stdout", "tty", "file"]);
	});

	test("a remembered route goes first and the others keep their order", () => {
		expect(routeOrder(34, "file")).toEqual(["file", "tty", "stdout"]);
		expect(routeOrder(28, "tty")).toEqual(["tty", "stdout", "file"]);
	});
});

describe("dump span detail", () => {
	test("the route that worked and how many were tried are left for the snapshot span", async () => {
		const { session, dumper } = setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: TRAILER }],
			host: [{ match: TTY, reply: XML }],
		});
		const first: SpanDetail = {};
		await collectSpanDetail(first, () => dumper.dump());
		expect(first).toMatchObject({ dumpRoute: "tty", dumpRoutesTried: 2 });
		expect(typeof first.dumpMs).toBe("number");
		const second: SpanDetail = {};
		await collectSpanDetail(second, () => dumper.dump());
		expect(second).toMatchObject({ dumpRoute: "tty", dumpRoutesTried: 1 });
		await session.close();
	});
});

describe("dump routes", () => {
	test("stdout route wins when it works and is remembered", async () => {
		const { host, session, dumper } = setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: XML + TRAILER }],
		});
		const first = await dumper.dump();
		expect(first.success && first.data.route).toBe("stdout");
		expect(dumper.route()).toBe("stdout");
		await dumper.dump();
		expect(host.host).toEqual([]);
		expect(host.shell.length).toBe(2);
		await session.close();
	});

	test("falls back stdout -> tty and remembers tty first", async () => {
		const { host, session, dumper, lines } = setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: TRAILER }],
			host: [{ match: TTY, reply: XML }],
		});
		const first = await dumper.dump();
		expect(first.success && first.data.route).toBe("tty");
		expect(host.shell).toEqual(["uiautomator dump /dev/stdout"]);
		expect(lines.some((l) => l.includes("route: tty"))).toBe(true);
		await dumper.dump();
		expect(host.shell).toEqual(["uiautomator dump /dev/stdout"]);
		expect(host.host.length).toBe(2);
		await session.close();
	});

	test("falls back to the file route last", async () => {
		const { host, session, dumper } = setup({
			shell: [
				{ match: "uiautomator dump /dev/stdout", reply: TRAILER },
				{ match: /^rm -f \/sdcard\/warden-ui\.xml/, reply: XML },
			],
			host: [{ match: TTY, reply: "ERROR: null root node returned by UiTestAutomationBridge.\n" }],
		});
		const res = await dumper.dump();
		expect(res.success && res.data.route).toBe("file");
		expect(host.host.length).toBe(1);
		await session.close();
	});

	test("a remembered route that stops working falls back to the others", async () => {
		let stdoutWorks = true;
		const { session, dumper } = setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: () => (stdoutWorks ? XML : TRAILER) }],
			host: [{ match: TTY, reply: XML }],
		});
		expect((await dumper.dump()).success).toBe(true);
		stdoutWorks = false;
		const res = await dumper.dump();
		expect(res.success && res.data.route).toBe("tty");
		await session.close();
	});

	test("no route works: E_AX_UNAVAILABLE carrying the tool's message", async () => {
		const err = "ERROR: null root node returned by UiTestAutomationBridge.\n";
		const { session, dumper } = setup({
			shell: [{ match: /uiautomator/, reply: err }],
			host: [{ match: TTY, reply: err }],
		});
		const res = await dumper.dump();
		expect(!res.success && res.error.code).toBe("E_AX_UNAVAILABLE");
		expect(!res.success && res.error.message).toContain("null root node");
		expect(!res.success && res.error.retryable).toBe(true);
		await session.close();
	});

	test("an initial route is tried first; a discovery is reported once", async () => {
		const routes: DumpRoute[] = [];
		const host = fakeAndroidHost({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: TRAILER }],
			host: [{ match: TTY, reply: XML }],
		});
		const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
		const dumper = createDumper({
			session,
			exec: host.exec,
			adb: "adb",
			serial: "s1",
			initialRoute: "tty",
			onRoute: (r) => routes.push(r),
		});
		const res = await dumper.dump();
		expect(res.success && res.data.route).toBe("tty");
		expect(host.shell).toEqual([]);
		expect(routes).toEqual([]);

		const fresh = createDumper({ session, exec: host.exec, adb: "adb", serial: "s1", onRoute: (r) => routes.push(r) });
		await fresh.dump();
		await fresh.dump();
		expect(routes).toEqual(["tty"]);
		await session.close();
	});

	test("sdk 30+ with nothing remembered probes tty first and reports it once", async () => {
		const routes: DumpRoute[] = [];
		const host = fakeAndroidHost({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: TRAILER }],
			host: [{ match: TTY, reply: XML }],
		});
		const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
		const dumper = createDumper({
			session,
			exec: host.exec,
			adb: "adb",
			serial: "s1",
			sdk: 34,
			onRoute: (r) => routes.push(r),
		});
		const res = await dumper.dump();
		expect(res.success && res.data.route).toBe("tty");
		expect(host.shell).toEqual([]);
		expect(host.host.length).toBe(1);
		expect(routes).toEqual(["tty"]);
		await session.close();
	});

	test("a remembered route that fails re-probes the rest and reports the one that works", async () => {
		const routes: DumpRoute[] = [];
		const host = fakeAndroidHost({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: XML }],
			host: [{ match: TTY, reply: TRAILER }],
		});
		const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
		const lines: string[] = [];
		const dumper = createDumper({
			session,
			exec: host.exec,
			adb: "adb",
			serial: "s1",
			sdk: 34,
			initialRoute: "tty",
			onRoute: (r) => routes.push(r),
			log: (l) => lines.push(l),
		});
		const res = await dumper.dump();
		expect(res.success && res.data.route).toBe("stdout");
		expect(host.host.length).toBe(1);
		expect(host.shell).toEqual(["uiautomator dump /dev/stdout"]);
		expect(routes).toEqual(["stdout"]);
		expect(dumper.route()).toBe("stdout");
		await session.close();
	});
});
