import { el, fakeDriver, snapshotOf } from "../driver.testing";
import { serveDriverStdio } from "./remote-server";

/** A FakeDriver served on this process's stdin/stdout, for `remote-stdio.test.ts` (and the sshd integration tests). */
const driver = fakeDriver({
	screens: [snapshotOf([el("text", { id: "hello", label: "From the fixture" })], { platform: "android" })],
	platform: "android",
	id: "fixture-device",
});
const out = Bun.stdout.writer();
const server = serveDriverStdio({
	driver,
	input: Bun.stdin.stream(),
	write: (bytes) => {
		out.write(bytes);
		out.flush();
	},
});
server.finished.then(async () => {
	await server.stop();
	await out.end();
	process.exit(0);
});
