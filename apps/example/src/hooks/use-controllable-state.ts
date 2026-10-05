import { useCallback, useRef, useState } from "react";

type UseControllableStateOptions<T> = {
	/** Controlled value. When not `undefined` the hook defers to the caller. */
	value?: T;
	/** Initial value used while uncontrolled. */
	defaultValue: T;
	onChange?: (value: T) => void;
};

/**
 * Supports both controlled and uncontrolled usage from one hook.
 *
 * While `value` is undefined the state is held internally; once a value is
 * passed the caller owns it and the setter only reports upward. Which mode is
 * in play is locked in on first render — switching later is a caller bug and
 * warns in development rather than silently changing behaviour.
 */
export function useControllableState<T>({
	value,
	defaultValue,
	onChange,
}: UseControllableStateOptions<T>): [T, (next: T) => void] {
	const isControlled = value !== undefined;
	const wasControlled = useRef(isControlled);
	const [uncontrolled, setUncontrolled] = useState<T>(defaultValue);

	if (process.env.NODE_ENV !== "production" && wasControlled.current !== isControlled) {
		console.warn(
			`useControllableState: switched from ${wasControlled.current ? "controlled" : "uncontrolled"} to ` +
				`${isControlled ? "controlled" : "uncontrolled"}. Pick one for the lifetime of the component.`
		);
		wasControlled.current = isControlled;
	}

	const setValue = useCallback(
		(next: T) => {
			if (!isControlled) setUncontrolled(next);
			onChange?.(next);
		},
		[isControlled, onChange]
	);

	return [isControlled ? value : uncontrolled, setValue];
}
