import { describe, expect, test } from "bun:test";
import { decide, gateCommand, hookOutput } from "./bash-gate";

const allowed = (command: string, bin = "warden"): boolean => gateCommand(command, bin).allow;

describe("gateCommand", () => {
	test("the tool's CLI, alone or by path", () => {
		expect(allowed("warden ui snapshot -i --udid U")).toBe(true);
		expect(allowed("/x/bin/warden ui press @e1")).toBe(true);
		expect(allowed("agent-device press @e2 --settle", "agent-device")).toBe(true);
	});

	test("shell variables and env prefixes (the commands claude's own matcher denied)", () => {
		expect(allowed("U=28E4CA55; warden ui open nz.example --relaunch --udid $U 2>&1 | tail -20")).toBe(true);
		expect(
			allowed('U=28E4; agent-device fill @e14 "ada@example.com" --udid $U && agent-device snapshot -i', "agent-device")
		).toBe(true);
		expect(allowed("WARDEN_JSON=1 warden ls")).toBe(true);
		expect(allowed("export U=x && warden ui wait id=a --udid $U")).toBe(true);
	});

	test("read-only utilities, pipes, redirections, loops and substitutions of the CLI", () => {
		expect(allowed("warden ui snapshot --json | jq '.nodes | length' > /tmp/n 2>/dev/null")).toBe(true);
		expect(allowed("for i in 1 2 3; do warden ui press id=next; sleep 1; done")).toBe(true);
		expect(allowed("if warden ui is id=x visible; then echo yes; else echo no; fi")).toBe(true);
		expect(allowed('S=$(warden ui snapshot -i); echo "$S" | grep -c button')).toBe(true);
		expect(allowed("cd /tmp && ls")).toBe(true);
		expect(allowed("echo 'a; xcrun simctl erase all'")).toBe(true);
	});

	test("anything else that could touch the device is denied, with the segment named", () => {
		const r = gateCommand("warden ui snapshot; xcrun simctl io booted screenshot /tmp/x.png", "warden");
		expect(r).toEqual({ allow: false, reason: expect.stringContaining("`xcrun`") });
		expect(allowed("agent-device open x", "warden")).toBe(false);
		expect(allowed("warden ui snapshot", "agent-device")).toBe(false);
		expect(allowed("U=$(xcrun simctl list); warden ui open x")).toBe(false);
		expect(allowed("echo `adb devices`")).toBe(false);
		expect(allowed("warden ui snapshot | xargs adb shell")).toBe(false);
		expect(allowed("(adb devices)")).toBe(false);
		expect(allowed("python3 -c 'print(1)'")).toBe(false);
	});
});

describe("decide", () => {
	test("allows or denies Bash; says nothing about other tools", () => {
		expect(decide({ tool_name: "Bash", tool_input: { command: "warden ls" } }, "warden")).toEqual({ allow: true });
		expect(decide({ tool_name: "Bash", tool_input: { command: "adb devices" } }, "warden")?.allow).toBe(false);
		expect(decide({ tool_name: "Read", tool_input: { file_path: "/x" } }, "warden")).toBeUndefined();
		expect(decide("junk", "warden")).toBeUndefined();
	});
});

describe("hookOutput", () => {
	test("the PreToolUse decision claude reads from stdout", () => {
		expect(JSON.parse(hookOutput({ allow: true }))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				permissionDecisionReason: "bench: the tool's CLI and read-only shell utilities",
			},
		});
		expect(JSON.parse(hookOutput({ allow: false, reason: "no" })).hookSpecificOutput.permissionDecision).toBe("deny");
	});
});
