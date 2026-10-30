/**
 * Every claim the landing makes, as data. A sentence here is a promise about the CLI, so each card and answer carries
 * the file that keeps it (`proof.source`) and `landing.test.ts` holds the copy to the code: every `warden` command and
 * flag it names must be in the warden skill (which `skill-coverage.test.ts` holds to the CLI), every number to the
 * constant it quotes, every link to a docs page that exists.
 *
 * Text fields are `RichText`: `` `code` `` and `[text](url)` only.
 */

/** Where a claim is kept: the file whose behaviour it describes. Repo-relative. */
export type Proof = { source: string };

/** A card: the command it names as a chip, a title, one or two sentences and the docs page that says more. */
export type Claim = {
	title: string;
	command: string;
	body: string;
	/** Docs page under `/docs/`, e.g. `devices/leases`. */
	href: string;
	proof: Proof;
};

export type Step = { n: string; title: string; body: string; command: string };

export type Feature = {
	label: string;
	title: string;
	points: readonly string[];
	link: { to: string; text: string };
	/** Terminal or file sample shown beside the points; absent for the run chart. */
	sample?: { label: string; code: string };
};

/** One recorded clip: a real simulator driven by the commands its caption names. */
export type Clip = {
	id: string;
	tab: string;
	title: string;
	caption: string;
	/** Under `public/`, without extension: `.mp4` and `.jpg` sit beside each other. */
	src: string;
	href: string;
	proof: Proof;
};

export type Faq = { q: string; a: string; proof?: Proof };

export const HERO = {
	pill: "open source · MIT · iOS + Android",
	lede: "warden leases iOS simulators, Android emulators and real phones to your coding agents, drives the app on them and keeps what they checked as tests. Devices, ports and builds, leased across every worktree on your Mac. One CLI, free and open source.",
	installNote: "Installs the CLI and the skill for every agent it finds.",
} as const;

export const HOW_IT_WORKS = {
	title: "Claim a device. Drive it. Keep the proof.",
	lede: "Leasing, device control and e2e tests in one tool, on one driver, so what an agent checked by hand passes the same way as a spec.",
	steps: [
		{
			n: "01",
			title: "Install",
			body: "One global CLI, then `warden install` adds the skill to every agent it finds. There is no daemon to start.",
			command: "npm i -g @delacour/warden",
		},
		{
			n: "02",
			title: "Claim",
			body: "Ask for a platform. You get a booted simulator no other agent, worktree or shell on the Mac will be handed.",
			command: "warden claim ios --json",
		},
		{
			n: "03",
			title: "Drive and keep",
			body: "Read the screen, tap and type with `warden ui`, then keep the same checks as a spec that `warden e2e` runs on many devices.",
			command: "warden ui snapshot -i",
		},
	] satisfies readonly Step[],
} as const;

export const BOARD_COPY = {
	title: "One Mac. Every branch at once.",
	lede: "Each agent works in its own worktree. warden hands each one a simulator, a Metro port and the build for its native fingerprint, and never hands the same one to two owners.",
	caption:
		"Illustrative. Three worktrees share a native fingerprint, so one cached build serves all three; the fifth claim waits for a boot slot.",
} as const;

export const WHAT_YOU_GET = {
	title: "Devices that look after themselves,",
	accent: "for agents that don't wait.",
	lede: "Every agent, worktree, CI job and shell on the Mac claims from one sqlite registry. Each claim is a transaction, so two agents asking at the same instant are served in turn, never both.",
	cards: [
		{
			title: "One lease, one device",
			command: "--ttl 30m",
			body: "A leased device belongs to one holder until it releases it or the TTL runs out. Wrapper commands heartbeat every 30 s and release when they exit.",
			href: "devices/leases",
			proof: { source: "packages/core/src/config.defaults.ts" },
		},
		{
			title: "Devices on demand",
			command: "warden capacity",
			body: "Nothing free that fits? warden boots or creates one, up to what the Mac's RAM and CPU can hold, and shuts down idle ones first when it needs room.",
			href: "devices/capacity",
			proof: { source: "packages/core/src/capacity.ts" },
		},
		{
			title: "A fair queue",
			command: "--wait 30m",
			body: "Past capacity, claims wait their turn instead of failing, by `--priority` and age. `--no-wait` fails at once; `warden queue` shows where you are.",
			href: "devices/capacity",
			proof: { source: "packages/core/src/queue.ts" },
		},
		{
			title: "New simulators in seconds",
			command: "warden golden",
			body: "New iOS simulators clone from a settled golden image: 3.7 s clone plus 11.9 s boot, instead of 146–239 s for a fresh one.",
			href: "devices/golden-images",
			proof: { source: "packages/core/src/golden/golden.ts" },
		},
		{
			title: "Idle devices shut down",
			command: "warden gc",
			body: "A warden device nobody has leased for 20 min is shut down to free RAM. `warden sims prune` deletes long-unused ones to free disk.",
			href: "devices/leases",
			proof: { source: "packages/core/src/config.defaults.ts" },
		},
		{
			title: "Bad devices set aside",
			command: "warden release --bad",
			body: "A device that fails its health check at claim time is quarantined, and the claim tries another. Release one as bad yourself and it is set aside for 24 h.",
			href: "devices/leases",
			proof: { source: "packages/core/src/claim.ts" },
		},
		{
			title: "Ports and builds too",
			command: "warden port claim",
			body: "Metro ports are leased like devices. App builds are cached by native fingerprint and shared by every worktree, so a native change builds once.",
			href: "devices/app-builds",
			proof: { source: "apps/cli/src/commands/port.ts" },
		},
		{
			title: "Real phones too",
			command: "--physical",
			body: "Claim a plugged-in Android phone or iPhone and drive it with `warden ui` or a spec. warden never boots or shuts one down, and only uninstalls what it installed.",
			href: "devices/physical-devices",
			proof: { source: "skills/warden/references/physical.md" },
		},
	] satisfies readonly Claim[],
} as const;

const DEV_SAMPLE = `# worktree 1: feature/checkout
$ warden dev ios --json
# worktree 2: fix/login-crash, at the same time
$ warden dev ios --json
# each gets its own simulator and Metro port,
# and the cached build for its native fingerprint`;

const DRIVE_SAMPLE = `# your agent, on its own simulator
$ warden claim ios --json
$ warden ui open com.example.app
$ warden ui snapshot -i
@e1 [textbox] "Add a todo" id=todo-input value="" enabled hittable
@e2 [button] "Add" id=todo-add enabled hittable
$ warden ui fill @e1 "Write e2e specs"
$ warden ui press @e2 --settle
$ warden ui wait text="Write e2e specs"`;

const DEBUG_SAMPLE = `# what broke, from the running app
$ warden dev logs --kind bundle_failed,error
$ warden ui exceptions
$ warden ui network --status 4xx
# why it is slow
$ warden perf record --all --duration 15s --udid $UDID
# or all of it over MCP
$ claude mcp add warden -- warden mcp`;

const KEEP_SAMPLE = `import { expect, test } from "@delacour/warden-e2e";

test("add a todo", async ({ screen }) => {
  await screen.getByTestId("todo-input").fill("Write e2e specs");
  await screen.getByTestId("todo-add").tap();
  await expect(screen.getByText("Write e2e specs")).toBeVisible();
  await expect(screen.getByTestId("remaining")).toHaveText("2 left");
});`;

export const ON_THE_DEVICE = {
	title: "Everything it needs on that device.",
	lede: "Once it holds a simulator, your agent runs the app, drives it, reads what went wrong and keeps what it checked as a test. Every step stays on its own device.",
	features: [
		{
			label: "Run it",
			title: "warden dev in every worktree",
			points: [
				"Claims a device and leases a Metro port per worktree",
				"Installs the cached build: installed, cache, EAS, then local",
				"Never attaches to another checkout's Metro",
				"Expo or bare React Native, with or without a config",
			],
			link: { to: "agents/dev", text: "Dev client per worktree" },
			sample: { label: "terminal", code: DEV_SAMPLE },
		},
		{
			label: "Drive it",
			title: "Device control for agents",
			points: [
				"Reads the screen as @e refs: role, name, testID, state",
				"Presses, fills, scrolls, swipes, waits and checks",
				"Every call checks the lease and heartbeats it",
				"Another agent's device is never a valid target",
			],
			link: { to: "agents/ui", text: "Drive a device" },
			sample: { label: "terminal", code: DRIVE_SAMPLE },
		},
		{
			label: "Debug it",
			title: "Logs, network and profiles",
			points: [
				"Metro's bundle failures, with file, line and code frame",
				"The app's console, exceptions and network, symbolicated",
				"CPU, memory, frames, startup and React profiles with warden perf",
				"The same debug functions as MCP tools with warden mcp",
			],
			link: { to: "agents/debug", text: "Debug the running app" },
			sample: { label: "terminal", code: DEBUG_SAMPLE },
		},
		{
			label: "Keep it",
			title: "What it verified becomes a test",
			points: [
				"warden ui record writes the session as a spec and runs it once",
				"The testIDs warden ui found become the spec's locators",
				"warden ui and specs share one driver, so a check that passed by hand passes in the spec",
				"The warden skill tells the agent when a check belongs in a spec",
			],
			link: { to: "e2e/first-test", text: "Write your first test" },
			sample: { label: "e2e/add-todo.e2e.ts", code: KEEP_SAMPLE },
		},
		{
			label: "Run the suite",
			title: "The suite on every device at once",
			points: [
				"warden e2e leases N simulators and installs the build",
				"One bun test per device, the specs shared between them",
				"warden affected runs only the specs a diff reaches",
				"Failures leave a screenshot, the screen tree and a trace",
			],
			link: { to: "e2e", text: "How e2e works" },
		},
	] satisfies readonly Feature[],
} as const;

export const DEVICE_CONTROL = {
	title: "Change the world",
	accent: "around the app.",
	lede: "Take it offline, break one host, move the GPS, jump the clock or fail Face ID, from a spec or a terminal, on a leased simulator. The app runs unmodified, and warden undoes every condition when the lease ends.",
	clips: [
		{
			id: "biometrics",
			tab: "Face ID",
			title: "Fail Face ID, then match it.",
			caption:
				"`warden ui biometrics fail` and `match` answer the real system prompt. Face ID and Touch ID on simulators, fingerprint on emulators, enrolled with `warden claim --biometrics`.",
			src: "/demos/biometrics/faceid",
			href: "e2e/biometrics",
			proof: { source: "skills/warden/references/ui.md" },
		},
		{
			id: "network",
			tab: "Network",
			title: "Pull the plug.",
			caption:
				"`warden ui network set offline`, `edge`, `online`: the app's own requests are shaped, nothing else on the Mac slows down.",
			src: "/demos/network/offline",
			href: "e2e/conditions",
			proof: { source: "packages/core/src/netproxy/proxy.ts" },
		},
		{
			id: "fault",
			tab: "One host",
			title: "Break one host.",
			caption:
				"`warden ui network fault <host> reset`: requests to that host fail while Wi-Fi still reads connected. `--clear` brings it back.",
			src: "/demos/network/fault",
			href: "e2e/conditions",
			proof: { source: "packages/core/src/netproxy/proxy.ts" },
		},
		{
			id: "location",
			tab: "Location",
			title: "Drive the GPS.",
			caption:
				"`warden ui location route` plays fixes out of a 150 m geofence; the app gets them from plain `expo-location`.",
			src: "/demos/location/route",
			href: "e2e/conditions",
			proof: { source: "skills/warden/references/ui.md" },
		},
		{
			id: "clock",
			tab: "Clock",
			title: "Fast-forward the clock.",
			caption:
				"`warden ui clock advance 10d` expires a 14-day trial; `reset` brings real time back. The app reads `Date.now()`.",
			src: "/demos/clock/trial",
			href: "e2e/conditions",
			proof: { source: "skills/warden/references/ui.md" },
		},
	] satisfies readonly Clip[],
} as const;

export const SAFE_BY_DEFAULT = {
	title: "It only touches",
	accent: "what it leased.",
	lede: "warden is advisory, not a sandbox. What it enforces is its own reach.",
	cards: [
		{
			title: "Your simulator stays yours",
			command: "--adopt",
			body: "A device warden didn't create or lease is read-only: never handed to an agent, shut down, erased or installed on unless you pass `--adopt`.",
			href: "devices/leases",
			proof: { source: "packages/core/src/allocate.ts" },
		},
		{
			title: "Every call checks the lease",
			command: "warden check",
			body: "`warden ui` refuses a device leased to someone else, and heartbeats yours on every call. `warden check` exits 2 when a device is someone else's.",
			href: "agents/ui",
			proof: { source: "apps/cli/src/commands/check.ts" },
		},
		{
			title: "Nothing listening",
			command: "127.0.0.1",
			body: "No server to run and no open port: leases are rows in one sqlite file, and warden's helpers talk over unix sockets. The network proxy binds loopback, only while it shapes traffic.",
			href: "e2e/conditions",
			proof: { source: "packages/core/src/netproxy/proxy.ts" },
		},
		{
			title: "Cleans up after itself",
			command: "SessionEnd",
			body: "Wrappers release when they exit. The Claude Code and Codex hook releases what a session leased and shuts down what it booted; device conditions are undone on release.",
			href: "agent-setup",
			proof: { source: "apps/cli/src/hooks/claude-pretool.ts" },
		},
	] satisfies readonly Claim[],
} as const;

export const FIRST_PROMPT = {
	title: "Productive from the first prompt.",
	lede: "Paste this into Claude Code, Codex, Cursor or any agent in your app's directory. The warden skill tells it the rest.",
	prompt: `Install warden (npm i -g @delacour/warden && warden install) and set this Expo app up with warden init.
Run the app from this worktree with warden dev, then drive it with warden ui and check the home screen renders.
Save what you checked as an e2e spec under e2e/, run it with warden e2e, and release the simulator when you're done.`,
} as const;

export const USE_CASES = {
	title: "What agents build with it.",
	lede: "The jobs agents get asked to do on a mobile app, and the warden command behind each.",
	cards: [
		{
			title: "Parallel worktrees",
			command: "warden dev",
			body: "Five agents, five worktrees, five simulators and five Metro ports, side by side on one Mac.",
			href: "agents/dev",
			proof: { source: "apps/cli/src/commands/dev.ts" },
		},
		{
			title: "Verify a UI change",
			command: "warden ui wait",
			body: "The agent changes a screen, opens it on its own simulator and checks it before it says done.",
			href: "agents/ui",
			proof: { source: "apps/cli/src/commands/ui.ts" },
		},
		{
			title: "Reproduce a bug",
			command: "warden ui record",
			body: "Walk the steps from the issue on a clean device and keep the repro as a spec that fails until the fix lands.",
			href: "e2e/author-specs",
			proof: { source: "apps/cli/src/commands/ui.ts" },
		},
		{
			title: "Test the unhappy paths",
			command: "warden ui network",
			body: "Offline, a failing host, an expired trial, a failed Face ID: the states nobody tests by hand, as specs.",
			href: "e2e/conditions",
			proof: { source: "packages/core/src/netproxy/proxy.ts" },
		},
		{
			title: "Gate every pull request",
			command: "warden affected",
			body: "Only the specs a diff reaches run, in CI or a pre-push hook, across leased simulators.",
			href: "e2e/affected",
			proof: { source: "apps/cli/src/commands/affected.ts" },
		},
		{
			title: "Find what got slow",
			command: "warden perf diff",
			body: "Record CPU, memory, frames and startup before and after a change, and diff the two.",
			href: "devices/perf",
			proof: { source: "apps/cli/src/commands/perf.ts" },
		},
	] satisfies readonly Claim[],
} as const;

export const FAQ = {
	title: "Questions.",
	lede: "Short answers. The docs have the long ones.",
	items: [
		{
			q: "What is warden?",
			a: "One open-source CLI that leases iOS simulators, Android emulators and phones to coding agents, drives the app on them, and runs e2e specs across many of them at once. Devices, Metro ports and app builds are leased per worktree, so agents in parallel never collide.",
		},
		{
			q: "Does warden sandbox my agents?",
			a: "No. It is advisory: the skill tells agents to use only devices a lease hands them, and raw `simctl` or `adb` are not intercepted. What it enforces is its own reach: `warden ui` refuses a device leased to someone else, and warden only shuts down, erases or deletes devices it created.",
			proof: { source: "apps/cli/src/device-lease.ts" },
		},
		{
			q: "What happens when an agent dies holding a device?",
			a: "Every lease has a TTL (30 min, 5 min for a bare agent `warden claim`) and lives only while it is renewed. `warden run`, `dev`, `batch` and `e2e` heartbeat every 30 s and release when they exit, so a killed wrapper frees its device within about 90 s; one that vanishes costs the device until the TTL runs out.",
			proof: { source: "packages/core/src/liveness.ts" },
		},
		{
			q: "What if every device is busy?",
			a: "warden boots or creates another, up to a capacity it derives from the Mac's RAM and CPU. After that the claim waits in a queue ordered by priority and age, up to `--wait` (30 min by default); `--no-wait` fails at once.",
			proof: { source: "packages/core/src/queue.ts" },
		},
		{
			q: "Does it work on Android and real phones?",
			a: "Yes. Android emulators are leased like simulators, and `warden ui` and specs drive them. Plugged-in Android phones and iPhones are opt-in with `--physical`; device conditions and biometrics are simulator and emulator only. iOS needs macOS with Xcode.",
			proof: { source: "skills/warden/references/physical.md" },
		},
		{
			q: "Which agents does it support?",
			a: "Any agent the skills CLI installs into gets the warden skill: Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode, Windsurf, Zed and more. Claude Code and Codex also get the SessionEnd cleanup hook.",
		},
		{
			q: "Is there an MCP server?",
			a: "Yes, for debugging. `warden mcp` serves a `warden dev` session's Metro output, console, exceptions, network, eval, logpoints and profiles over stdio. Claiming devices and running specs stay on the CLI.",
			proof: { source: "apps/cli/src/mcp/tools.ts" },
		},
		{
			q: "What does my app need?",
			a: "Builds, the dev client and Metro target Expo and React Native. `warden ui` and specs drive any installed app by bundle id, finding elements by testID, label, text or role.",
		},
		{
			q: "How much does it cost?",
			a: "Nothing. warden is MIT-licensed and runs on your own Mac or CI runner. No account, no cloud.",
		},
	] satisfies readonly Faq[],
} as const;

export const CLOSING = { title: "Give every agent a device of its own." } as const;

/** Every string the page renders from this file, for the tests. */
export const LANDING = {
	HERO,
	HOW_IT_WORKS,
	BOARD_COPY,
	WHAT_YOU_GET,
	ON_THE_DEVICE,
	DEVICE_CONTROL,
	SAFE_BY_DEFAULT,
	FIRST_PROMPT,
	USE_CASES,
	FAQ,
	CLOSING,
} as const;
