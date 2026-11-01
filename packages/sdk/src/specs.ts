import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Affected, affectedService, type Suite, type SuiteError } from "@delacour/warden-core/affected/affected";
import { specScanner } from "@delacour/warden-core/affected/specs";
import { storeLocator } from "@delacour/warden-store/store";
import { e2eReportSchema } from "./contracts/e2e-report.schema";
import type { Core } from "./core";
import { coreRuntime } from "./core";
import { WardenError } from "./errors";
import type { CallOptions, WardenErrorCode } from "./sdk.types";
import type {
	CliOutput,
	SpecsAffectedParams,
	SpecsAffectedResult,
	SpecsDeps,
	SpecsListParams,
	SpecsNamespace,
	SpecsRunParams,
	SuiteInfo,
} from "./specs.types";

const SUITE_CODES: Record<SuiteError["code"], WardenErrorCode> = {
	several_suites: "usage",
	no_suites: "not_found",
	unknown_suite: "not_found",
	no_config: "not_found",
	config: "config_invalid",
};

const STDERR_TAIL = 2000;

/** Pure helpers of the e2e CLI bridge: the argv, the report parse and the default spawn seam. */
export class SpecsCli {
	/**
	 * The `warden` CLI argv prefix: the option, else `warden` on PATH, else the checkout's `apps/cli/src/main.ts`
	 * under bun (a source install), else plain `warden` (failing at spawn with `tool_missing`).
	 */
	resolveCliCommand(
		option: readonly string[] | undefined,
		which: (cmd: string) => string | null = Bun.which,
		exists: (path: string) => boolean = existsSync,
		execPath: string = process.execPath,
		sourceMain: string = resolve(import.meta.dir, "../../../apps/cli/src/main.ts")
	): string[] {
		if (option && option.length > 0) return [...option];
		const onPath = which("warden");
		if (onPath) return [onPath];
		if (exists(sourceMain)) return [execPath, sourceMain];
		return ["warden"];
	}

	/** `warden e2e <suite> --json …` argv (without the CLI prefix). */
	e2eArgs(params: SpecsRunParams): string[] {
		return [
			"e2e",
			...(params.suite !== undefined ? [params.suite] : []),
			"--json",
			...(params.all ? ["--all"] : []),
			...(params.specs && params.specs.length > 0 ? ["--specs", params.specs.join(",")] : []),
			...(params.base !== undefined ? ["--base", params.base] : []),
			...(params.platform ? ["--platform", params.platform] : []),
			...(params.project !== undefined ? ["--project", params.project] : []),
			...(params.retry !== undefined ? ["--retry", String(params.retry)] : []),
		];
	}

	parseE2eReport(out: CliOutput): ReturnType<typeof e2eReportSchema.safeParse> {
		try {
			return e2eReportSchema.safeParse(JSON.parse(out.stdout));
		} catch {
			return e2eReportSchema.safeParse(undefined);
		}
	}

	/** Default seam: `Bun.spawn`; an abort kills the child. */
	readonly bunDeps: SpecsDeps = {
		spawn: async (argv, o) => {
			const [bin, ...rest] = argv;
			if (!bin) throw new WardenError({ code: "tool_missing", message: "empty warden command" });
			let proc: ReturnType<typeof Bun.spawn>;
			try {
				proc = Bun.spawn([bin, ...rest], {
					cwd: o.cwd,
					env: Object.fromEntries(Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined)),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
			} catch (cause) {
				throw new WardenError({
					code: "tool_missing",
					message: `cannot run ${bin}: ${cause instanceof Error ? cause.message : String(cause)}`,
					hint: "install warden or pass createWardenClient({ cliCommand })",
				});
			}
			const kill = () => proc.kill("SIGTERM");
			o.signal?.addEventListener("abort", kill, { once: true });
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
					this.pumpLines(proc.stderr as ReadableStream<Uint8Array>, o.onStderrLine),
					proc.exited,
				]);
				return { exitCode, stdout, stderr } satisfies CliOutput;
			} finally {
				o.signal?.removeEventListener("abort", kill);
			}
		},
	};

	private async pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
		const decoder = new TextDecoder();
		let all = "";
		let pending = "";
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			all += text;
			pending += text;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		}
		if (pending.length > 0) onLine(pending);
		return all;
	}
}

export const specsCli = new SpecsCli();

/** The `specs` namespace of one client: suites, affected selection and e2e runs. */
export class SpecsService {
	constructor(private readonly core: Core) {}

	namespace(): SpecsNamespace {
		const { core } = this;
		return {
			list: (params, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.listSuites(params)),
			affected: (params, opts) => coreRuntime.guarded(core.signalFor(opts), () => this.affectedSpecs(params)),
			run: (params, opts) => this.runSpecs(params, opts),
		};
	}

	private suiteFailure(error: SuiteError): WardenError {
		return new WardenError({
			code: SUITE_CODES[error.code],
			message: error.message,
			...(error.suites ? { details: { suites: error.suites } } : {}),
		});
	}

	private async loadSuite(name: string | undefined): Promise<Suite> {
		const { core } = this;
		const found = await affectedService.findSuite(core.host.exec, core.host.cwd, name, core.git, core.host.env);
		if (!found.success) throw this.suiteFailure(found.error);
		return found.data;
	}

	private checkProject(suite: Suite, project: string | undefined): void {
		if (project === undefined || suite.config.project === project) return;
		throw new WardenError({
			code: "usage",
			message: `suite "${suite.name}" belongs to project ${suite.config.project ?? "(none)"}, not "${project}"`,
		});
	}

	private suiteInfo(suite: Suite): SuiteInfo {
		const { config, configDir } = suite;
		const specsDir = join(configDir, config.specsDir);
		const scan = specScanner.scan(specsDir);
		const specs = scan.specs
			.filter((spec) => spec.kind === "e2e")
			.map((spec) => {
				const settings = specScanner.settings(spec.id, config.specs);
				return {
					id: spec.id,
					file: spec.file,
					required: settings.required ?? true,
					platforms: specScanner.platforms(spec, settings),
				};
			});
		return {
			name: suite.name,
			...(config.platform ? { platform: config.platform } : {}),
			...(config.project !== undefined ? { project: config.project } : {}),
			base: config.base,
			specsDir,
			implicit: suite.implicit === true,
			specs,
			warnings: scan.warnings,
		};
	}

	/** The suite names to list: the one asked for, else every configured one (a lone suite needs no name). */
	private async suiteNames(name: string | undefined): Promise<Array<string | undefined>> {
		const { core } = this;
		if (name !== undefined) return [name];
		const found = await affectedService.findSuite(core.host.exec, core.host.cwd, undefined, core.git, core.host.env);
		if (found.success) return [undefined];
		if (found.error.code === "several_suites" && found.error.suites) return found.error.suites;
		throw this.suiteFailure(found.error);
	}

	private async listSuites(params: SpecsListParams | undefined): Promise<SuiteInfo[]> {
		const names = await this.suiteNames(params?.suite);
		const suites: SuiteInfo[] = [];
		for (const name of names) {
			const suite = await this.loadSuite(name);
			if (params?.project !== undefined && suite.config.project !== params.project) continue;
			suites.push(this.suiteInfo(suite));
		}
		return suites;
	}

	private affectedResult(affected: Affected): SpecsAffectedResult {
		return {
			suite: affected.suite.name,
			...(affected.base !== undefined ? { base: affected.base } : {}),
			changes: affected.changes.map((c) => ({ ...c })),
			platforms: affected.selections.map((s) => ({ ...s })),
			warnings: affected.warnings,
		};
	}

	private async affectedSpecs(params: SpecsAffectedParams | undefined): Promise<SpecsAffectedResult> {
		const { core } = this;
		const suite = await this.loadSuite(params?.suite);
		this.checkProject(suite, params?.project);
		const result = await affectedService.compute({
			exec: core.host.exec,
			cwd: core.host.cwd,
			git: core.git,
			env: core.host.env,
			cacheDir: join(storeLocator.wardenHome(core.host.env), "affected"),
			suite: suite.name,
			...(params?.base !== undefined ? { base: params.base } : {}),
			...(params?.platform ? { platform: params.platform } : {}),
			...(params?.files ? { files: params.files } : {}),
		});
		if (!result.success) throw new WardenError({ code: "failed", message: result.error });
		return this.affectedResult(result.data);
	}

	private async runSpecs(params: SpecsRunParams, opts: CallOptions | undefined) {
		const { core } = this;
		const signal = core.signalFor(opts);
		return coreRuntime.guarded(signal, async () => {
			if (params.all && params.specs && params.specs.length > 0) {
				throw new WardenError({ code: "usage", message: "all and specs are exclusive" });
			}
			const argv = [...specsCli.resolveCliCommand(core.options.cliCommand), ...specsCli.e2eArgs(params)];
			const deps = core.seams.specs ?? specsCli.bunDeps;
			const out = await deps.spawn(argv, {
				cwd: core.host.cwd,
				env: core.host.env,
				...(signal ? { signal } : {}),
				onStderrLine: (line) => params.onEvent?.({ kind: "log", line }),
			});
			coreRuntime.guard(signal);
			const parsed = specsCli.parseE2eReport(out);
			if (parsed.success) return parsed.data;
			throw new WardenError({
				code: out.exitCode === 130 ? "interrupted" : "failed",
				message: `warden e2e exited ${out.exitCode} without a report`,
				details: { exitCode: out.exitCode, stderr: out.stderr.slice(-STDERR_TAIL) },
			});
		});
	}
}
