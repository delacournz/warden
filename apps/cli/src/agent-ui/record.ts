import { journalRecorders } from "@delacour/warden-sdk/ops/authoring/recorder";
import type { RecordSink } from "@delacour/warden-sdk/ops/record";
import type { RefStore } from "@delacour/warden-sdk/ops/ref-store";
import type { StateStore } from "@delacour/warden-sdk/ops/state-store";
import { storeLocator } from "@delacour/warden-store/store";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import type { UiRunEnv } from "./run";

export class UiRecord {
	/**
	 * The recorder an op session appends finished actions to: the test sink when `deps.record` is set, else the active
	 * recording's journal (the SDK's `journalRecorder`). Nothing is loaded or written when no recording is active, so an
	 * ordinary action never imports the journal code.
	 */
	recorderFor(ctx: CommandContext, deps: UiDeps, stores: { state: StateStore; refs: RefStore }): RecordSink {
		const journal = journalRecorders.journalRecorder({
			home: storeLocator.wardenHome(ctx.env),
			env: ctx.env,
			now: ctx.now,
			state: stores.state,
			refs: stores.refs,
			warn: (message) => ctx.err(ctx.ui.color.yellow(`warden ui: ${message}`)),
		});
		return {
			append: async (udid, step) => {
				if (deps.record) return deps.record.append(udid, step);
				await journal.append(udid, step);
			},
		};
	}

	/**
	 * The route the app moved to after an action, when a recording is active and the action can navigate (the SDK's
	 * `routeAfterFor` over a devtools-capable op session). Best effort: any failure is no route, never an error.
	 */
	routeAfterFor(
		ctx: CommandContext,
		deps: UiDeps,
		env: UiRunEnv,
		device: UiDevice,
		state: StateStore
	): (action: string) => Promise<string | undefined> {
		return journalRecorders.routeAfterFor(state, async () => {
			const [{ uiSession }, { uiDevtoolsCli }] = await Promise.all([import("./session"), import("./devtools-cli")]);
			return uiSession.opSessionFor(ctx, deps, device, env, uiDevtoolsCli.extrasFor(ctx, deps, device));
		});
	}
}

export const uiRecord = new UiRecord();
