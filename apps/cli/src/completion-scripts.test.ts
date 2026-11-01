import { describe, expect, test } from "bun:test";
import { COMPLETION_SHELLS, completionScripts } from "./completion-scripts";

describe("completionScript", () => {
	test.each(COMPLETION_SHELLS.map((s) => [s]))("%s asks `warden __complete` for every word", (shell) => {
		const script = completionScripts.completionScript(shell);
		expect(script).toContain("__complete --");
		expect(script).toContain("files");
	});

	test("zsh: registers with compdef, menu-selects (tab lists, tab picks, tab cycles) unless styled already", () => {
		const script = completionScripts.completionScript("zsh");
		expect(script).toContain("compdef _warden warden");
		expect(script).toContain("zstyle ':completion:*:*:warden:*' menu select");
		expect(script).toContain("_describe");
	});

	test("bash: complete -F; fish: complete -c", () => {
		expect(completionScripts.completionScript("bash")).toContain("complete -F _warden warden");
		expect(completionScripts.completionScript("fish")).toContain("complete -c warden");
	});

	test("zsh: parses cleanly", async () => {
		const proc = Bun.spawn(["zsh", "-n", "-c", completionScripts.completionScript("zsh")], { stderr: "pipe" });
		expect(await proc.exited).toBe(0);
	});

	test("bash: parses cleanly", async () => {
		const proc = Bun.spawn(["bash", "-n", "-c", completionScripts.completionScript("bash")], { stderr: "pipe" });
		expect(await proc.exited).toBe(0);
	});
});

describe("shellFromEnv", () => {
	test("basename of $SHELL when supported", () => {
		expect(completionScripts.shellFromEnv({ SHELL: "/bin/zsh" })).toBe("zsh");
		expect(completionScripts.shellFromEnv({ SHELL: "/opt/homebrew/bin/fish" })).toBe("fish");
		expect(completionScripts.shellFromEnv({ SHELL: "/bin/tcsh" })).toBeUndefined();
		expect(completionScripts.shellFromEnv({})).toBeUndefined();
	});
});
