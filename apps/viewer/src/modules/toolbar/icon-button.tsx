import { Button } from "@delacournz/apogee/button";
import { Toggle } from "@delacournz/apogee/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@delacournz/apogee/tooltip";
import type { ReactNode } from "react";

const QUIET = "text-muted-foreground hover:text-foreground focus-visible:text-foreground";

type IconButtonProps = {
	label: string;
	onClick: () => void;
	children: ReactNode;
	destructive?: boolean;
};

/** A small ghost icon button with an accessible name and a tooltip. */
export function IconButton({ label, onClick, children, destructive = false }: IconButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={label}
						onClick={onClick}
						className={destructive ? `${QUIET} hover:bg-destructive/15 hover:text-destructive` : QUIET}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

type IconToggleProps = {
	label: string;
	pressed: boolean;
	onPressedChange: (pressed: boolean) => void;
	children: ReactNode;
};

/** An icon toggle with an accessible name and a tooltip. The pressed state is the accent. */
export function IconToggle({ label, pressed, onPressedChange, children }: IconToggleProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Toggle
						size="sm"
						aria-label={label}
						pressed={pressed}
						onPressedChange={onPressedChange}
						className={`size-6 min-h-0 min-w-0 p-0 ${QUIET} data-pressed:text-primary`}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}
