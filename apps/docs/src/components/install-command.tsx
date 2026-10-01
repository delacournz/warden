import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { CopyCommand } from "@/components/copy-command";
import { cn } from "@/lib/cn";

const PACKAGE = "@delacour/warden";

export type PackageManager = "npm" | "bun" | "pnpm" | "yarn";

/** Global install per package manager, npm first as the default. */
export const INSTALL_COMMANDS: Record<PackageManager, string> = {
	npm: `npm i -g ${PACKAGE}`,
	bun: `bun add -g ${PACKAGE}`,
	pnpm: `pnpm add -g ${PACKAGE}`,
	yarn: `yarn global add ${PACKAGE}`,
};

const MANAGERS = Object.keys(INSTALL_COMMANDS) as PackageManager[];
const STORAGE_KEY = "warden:package-manager";

function isManager(value: string | null): value is PackageManager {
	return value !== null && value in INSTALL_COMMANDS;
}

/** The visitor's last pick, remembered per browser; storage failures fall back to npm. */
function useManager(): [PackageManager, (pm: PackageManager) => void] {
	const [manager, setManager] = useState<PackageManager>("npm");
	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(STORAGE_KEY);
			if (isManager(stored)) setManager(stored);
		} catch {
			return;
		}
	}, []);
	const choose = (pm: PackageManager) => {
		setManager(pm);
		try {
			window.localStorage.setItem(STORAGE_KEY, pm);
		} catch {
			return;
		}
	};
	return [manager, choose];
}

/**
 * The global install command with a tab per package manager; `setup` chains
 * `warden install` so one line installs and wires the agent hooks. Tabs follow the
 * ARIA tabs pattern: arrow keys move between managers, the panel is the copy
 * command for the selected one.
 */
export function InstallCommand({ className, setup = false }: { className?: string; setup?: boolean }): ReactElement {
	const [manager, choose] = useManager();
	const id = useId();
	const tabs = useRef<Array<HTMLButtonElement | null>>([]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const next = MANAGERS[(MANAGERS.indexOf(manager) + step + MANAGERS.length) % MANAGERS.length];
		if (!next) return;
		choose(next);
		tabs.current[MANAGERS.indexOf(next)]?.focus();
	};

	return (
		<div className={cn("flex min-w-0 flex-col gap-2", className)}>
			<div aria-label="Package manager" className="flex gap-1" onKeyDown={onKeyDown} role="tablist">
				{MANAGERS.map((pm, i) => (
					<button
						aria-controls={`${id}-panel`}
						aria-selected={pm === manager}
						className={cn(
							"rounded-full px-3 py-1 font-mono text-xs transition-colors",
							pm === manager ? "bg-fill text-ink" : "text-ink-2 hover:text-ink"
						)}
						id={`${id}-${pm}`}
						key={pm}
						onClick={() => choose(pm)}
						ref={(el) => {
							tabs.current[i] = el;
						}}
						role="tab"
						tabIndex={pm === manager ? 0 : -1}
						type="button"
					>
						{pm}
					</button>
				))}
			</div>
			<div aria-labelledby={`${id}-${manager}`} id={`${id}-panel`} role="tabpanel">
				<CopyCommand command={setup ? `${INSTALL_COMMANDS[manager]} && warden install` : INSTALL_COMMANDS[manager]} />
			</div>
		</div>
	);
}
