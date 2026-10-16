import type { Device } from "./device";
import type { SpanRunner } from "./runner/span";

/**
 * `device` with every call timed as a `device.<name>` span in the attempt's `trace.jsonl` (trace only: no console
 * line, since a settle or an alert is not a step). The driver calls a device call makes are `driver.*` spans of
 * their own, so a slow `device.openLink` shows what it spent its time on. Without a span runner (a bare
 * `FixtureSession`) the device is returned unchanged.
 */
export function traceDevice(device: Device, span: SpanRunner | undefined): Device {
	if (span === undefined) return device;
	return {
		get devtools() {
			return device.devtools;
		},
		alert: (action) => span("device.alert", () => device.alert(action), { detail: (answered) => ({ answered }) }),
		openLink: (url, options) => span("device.openLink", () => device.openLink(url, options)),
		home: () => span("device.home", () => device.home()),
		back: () => span("device.back", () => device.back()),
		orientation: (set) => span("device.orientation", () => device.orientation(set)),
		appearance: (set) => span("device.appearance", () => device.appearance(set)),
		clipboard: () => span("device.clipboard", () => device.clipboard()),
		setClipboard: (text) => span("device.setClipboard", () => device.setClipboard(text)),
		hideKeyboard: () => span("device.hideKeyboard", () => device.hideKeyboard()),
		screenshot: (name) => span("device.screenshot", () => device.screenshot(name)),
		snapshot: (options) => span("device.snapshot", () => device.snapshot(options)),
		settle: (options) =>
			span("device.settle", () => device.settle(options), {
				detail: ({ quiet, waitedMs, via, reason, frontmostPid }) => ({
					quiet,
					waitedMs,
					...(via === undefined ? {} : { via }),
					...(reason === undefined ? {} : { reason }),
					...(frontmostPid === undefined ? {} : { frontmostPid }),
				}),
			}),
	};
}
