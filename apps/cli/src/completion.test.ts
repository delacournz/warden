import { describe, expect, test } from "bun:test";
import { Command as Commander, Option } from "@commander-js/extra-typings";
import { type Completion, completionHelpers } from "./completion";

/** A small tree shaped like warden's: groups of subcommands, value options, choices, hidden bits, aliases. */
function tree(): Commander {
	const root = new Commander("warden").helpCommand(true);
	root.command("claim").description("lease devices").argument("[platform]").option("--json", "machine-readable");
	const sims = root.command("sims").description("simulator audit");
	sims.command("audit").description("disk audit").option("--json", "machine-readable");
	sims.command("prune").description("delete idle sims").option("-y, --yes", "skip the prompt");
	sims.command("delete").alias("rm").description("pick sims to delete").argument("[udids...]");
	const app = root.command("app").description("install a build");
	app
		.option("--udid <udid>", "target device")
		.addOption(new Option("--install-mode <mode>", "how to install").choices(["clean", "reinstall"]))
		.addOption(new Option("--clean", "deprecated").hideHelp())
		.argument("<platform>");
	root.command("__internal", { hidden: true }).description("worker");
	root.command("version").description("print the version").option("--json", "machine-readable");
	return root;
}

const values = (c: Completion) => c.candidates.map((x) => x.value);

describe("complete", () => {
	test("bare `warden ` lists visible top-level commands with summaries, no help/hidden", () => {
		const result = completionHelpers.complete(tree(), [""]);
		expect(values(result)).toEqual(["claim", "sims", "app", "version"]);
		expect(result.candidates[1]).toEqual({ kind: "command", value: "sims", description: "simulator audit" });
		expect(result.files).toBe(false);
	});

	test("a prefix narrows the commands", () => {
		expect(values(completionHelpers.complete(tree(), ["s"]))).toEqual(["sims"]);
	});

	test("`warden sims ` lists its subcommands", () => {
		expect(values(completionHelpers.complete(tree(), ["sims", ""]))).toEqual(["audit", "prune", "delete"]);
	});

	test("aliases descend too", () => {
		const result = completionHelpers.complete(tree(), ["sims", "rm", ""]);
		expect(result.candidates).toEqual([]);
		expect(result.files).toBe(true);
	});

	test("`-` lists the current command's visible options, long form preferred", () => {
		expect(values(completionHelpers.complete(tree(), ["sims", "prune", "-"]))).toEqual(["--yes", "--help"]);
		expect(values(completionHelpers.complete(tree(), ["app", "--"]))).toEqual(["--udid", "--install-mode", "--help"]);
	});

	test("options already on the line are not offered again", () => {
		expect(values(completionHelpers.complete(tree(), ["sims", "prune", "--yes", "-"]))).toEqual(["--help"]);
	});

	test("a leaf without arguments offers its options on an empty word", () => {
		expect(values(completionHelpers.complete(tree(), ["version", ""]))).toEqual(["--json", "--help"]);
	});

	test("a leaf with free arguments falls back to files", () => {
		const result = completionHelpers.complete(tree(), ["claim", ""]);
		expect(result.candidates).toEqual([]);
		expect(result.files).toBe(true);
	});

	test("an option's choices complete its value (separate word or --opt=)", () => {
		expect(values(completionHelpers.complete(tree(), ["app", "--install-mode", ""]))).toEqual(["clean", "reinstall"]);
		expect(values(completionHelpers.complete(tree(), ["app", "--install-mode", "re"]))).toEqual(["reinstall"]);
		expect(values(completionHelpers.complete(tree(), ["app", "--install-mode=c"]))).toEqual(["--install-mode=clean"]);
	});

	test("a value option without choices skips its value and asks for files", () => {
		expect(completionHelpers.complete(tree(), ["app", "--udid", ""])).toEqual({ candidates: [], files: true });
		expect(values(completionHelpers.complete(tree(), ["app", "--udid", "ABC", "--j"]))).toEqual([]);
	});

	test("an `a | b` help hint stands in for .choices() on arguments and options", () => {
		const root = new Commander("warden");
		root
			.command("claim")
			.argument("[platform]", "ios | android (asked for when omitted)")
			.option("--platform <p>", "ios | android")
			.option("--udid <udid>", "the device | the lease");
		expect(values(completionHelpers.complete(root, ["claim", ""]))).toEqual(["ios", "android"]);
		expect(values(completionHelpers.complete(root, ["claim", "--platform", "a"]))).toEqual(["android"]);
		expect(completionHelpers.complete(root, ["claim", "--udid", ""]).files).toBe(true);
	});

	test("an unknown word does not derail the walk", () => {
		expect(values(completionHelpers.complete(tree(), ["nope", ""]))).toEqual([]);
	});
});

describe("formatCompletion", () => {
	test("kind<TAB>value<TAB>description lines, then a files marker", () => {
		expect(
			completionHelpers.formatCompletion({
				candidates: [
					{ kind: "command", value: "audit", description: "disk\naudit" },
					{ kind: "option", value: "--json", description: "" },
				],
				files: true,
			})
		).toEqual(["command\taudit\tdisk audit", "option\t--json\t", "files"]);
	});
});
