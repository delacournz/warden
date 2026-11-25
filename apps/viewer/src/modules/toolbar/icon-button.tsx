import { Button } from "@delacournz/apogee/button";
import { Toggle } from "@delacournz/apogee/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@delacournz/apogee/tooltip";
import { cloneElement, type ReactElement, type ReactNode } from "react";

const QUIET =
	"text-muted-foreground hover:text-foreground focus-visible:text-foreground disabled:border-transparent! disabled:bg-transparent! disabled:opacity-40 disabled:shadow-none! disabled:before:hidden";

type HintProps = {
	label: string;
	disabledReason: string | null;
	control: ReactElement;
	children: ReactNode;
};

/**
 * Tooltip around an icon control. A disabled control receives no pointer events, so its tooltip hangs
 * off a focusable wrapper and explains why; an enabled one shows its label.
 */
function Hint({ label, disabledReason, control, children }: HintProps) {
	if (disabledReason) {
		return (
			<Tooltip>
				<TooltipTrigger render={<span className="inline-flex" />}>{cloneElement(control, {}, children)}</TooltipTrigger>
				<TooltipContent side="bottom">{disabledReason}</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<Tooltip>
			<TooltipTrigger render={control}>{children}</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

type IconButtonProps = {
	label: string;
	onClick: () => void;
	children: ReactNode;
	destructive?: boolean;
	disabledReason?: string | null;
};

/** A small ghost icon button with an accessible name and a tooltip; `disabledReason` disables it. */
export function IconButton({ label, onClick, children, destructive = false, disabledReason = null }: IconButtonProps) {
	const style = destructive ? `${QUIET} hover:bg-destructive/15 hover:text-destructive` : QUIET;
	const control = (
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label={label}
			onClick={onClick}
			disabled={disabledReason !== null}
			className={style}
		/>
	);
	return (
		<Hint label={label} disabledReason={disabledReason} control={control}>
			{children}
		</Hint>
	);
}

type IconToggleProps = {
	label: string;
	pressed: boolean;
	onPressedChange: (pressed: boolean) => void;
	children: ReactNode;
	disabledReason?: string | null;
};

/** An icon toggle with an accessible name and a tooltip; the pressed state is the accent. */
export function IconToggle({ label, pressed, onPressedChange, children, disabledReason = null }: IconToggleProps) {
	const control = (
		<Toggle
			size="sm"
			aria-label={label}
			pressed={pressed}
			onPressedChange={onPressedChange}
			disabled={disabledReason !== null}
			className={`size-6 min-h-0 min-w-0 p-0 ${QUIET} data-pressed:text-primary`}
		/>
	);
	return (
		<Hint label={label} disabledReason={disabledReason} control={control}>
			{children}
		</Hint>
	);
}
