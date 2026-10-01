import type { Command } from "../command";
import { affectedCommand } from "./affected";
import { appCommand } from "./app";
import { arrangeCommand } from "./arrange";
import { batchCommand } from "./batch";
import { buildsCommand } from "./builds";
import { checkCommand } from "./check";
import { claimCommand } from "./claim";
import { cloneCommand } from "./clone";
import { devicesCommand } from "./devices";
import { doctorCommand } from "./doctor";
import { e2eCommand } from "./e2e";
import { gcCommand } from "./gc";
import { goldenCommand } from "./golden";
import { heartbeatCommand } from "./heartbeat";
import { hookCommand } from "./hook";
import { installCommand } from "./install";
import { lsCommand } from "./ls";
import { portCommand } from "./port";
import { releaseCommand } from "./release";
import { runCommand } from "./run";
import { simsCommand } from "./sims";
import { skillCommand } from "./skill";
import { updateCommand } from "./update";
import { versionCommand } from "./version";

export const COMMANDS: readonly Command[] = [
	claimCommand,
	releaseCommand,
	runCommand,
	batchCommand,
	affectedCommand,
	e2eCommand,
	lsCommand,
	devicesCommand,
	simsCommand,
	arrangeCommand,
	cloneCommand,
	goldenCommand,
	checkCommand,
	heartbeatCommand,
	gcCommand,
	portCommand,
	appCommand,
	buildsCommand,
	hookCommand,
	installCommand,
	skillCommand,
	doctorCommand,
	updateCommand,
	versionCommand,
];
