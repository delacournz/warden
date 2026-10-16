import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import { createDumper, type DumpRoute } from "./android-dump";
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
});
