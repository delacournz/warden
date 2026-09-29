import type { Command } from "../context";
import { appCommand } from "./app";
import { buildsCommand } from "./builds";
import { checkCommand } from "./check";
import { claimCommand } from "./claim";
import { devicesCommand } from "./devices";
import { doctorCommand } from "./doctor";
import { gcCommand } from "./gc";
import { heartbeatCommand } from "./heartbeat";
import { hookCommand } from "./hook";
import { installCommand } from "./install";
import { lsCommand } from "./ls";
import { portCommand } from "./port";
import { releaseCommand } from "./release";
import { runCommand } from "./run";

export const COMMANDS: readonly Command[] = [
	claimCommand,
	releaseCommand,
	runCommand,
	lsCommand,
	devicesCommand,
	checkCommand,
	heartbeatCommand,
	gcCommand,
	portCommand,
	appCommand,
	buildsCommand,
	hookCommand,
	installCommand,
	doctorCommand,
];
