import { conditionsOf, registerConditions } from "./conditions/device-conditions";
import type { Device } from "./device";
import type { SpanRunner } from "./runner/span";

/**
 * `device` with every call timed as a `device.<name>` span in the attempt's `trace.jsonl` (trace only: no console
 * line, since a settle or an alert is not a step). The condition calls are `device.network.<call>`,
 * `device.location.<call>`, `device.clock.<call>` and `device.timeline`. The driver calls a device call makes are `driver.*` spans of
 * their own, so a slow `device.openLink` shows what it spent its time on. Without a span runner (a bare
 * `FixtureSession`) the device is returned unchanged.
 */
export function traceDevice(device: Device, span: SpanRunner | undefined): Device {
	if (span === undefined) return device;
	const { network, location, clock, permissions } = device;
	const traced: Device = {
		get devtools() {
			return device.devtools;
		},
		get perf() {
			return device.perf;
		},
		network: {
			set: (condition, options) => span("device.network.set", () => network.set(condition, options)),
			during: (condition, fn, options) => span("device.network.during", () => network.during(condition, fn, options)),
			flap: (options) => span("device.network.flap", () => network.flap(options)),
			fault: (rules) => span("device.network.fault", () => network.fault(rules)),
			status: () => span("device.network.status", () => network.status()),
			reset: () => span("device.network.reset", () => network.reset()),
		},
		location: {
			set: (point) => span("device.location.set", () => location.set(point)),
			route: (points, options) => span("device.location.route", () => location.route(points, options)),
			scenario: (name) => span("device.location.scenario", () => location.scenario(name)),
			clear: () => span("device.location.clear", () => location.clear()),
		},
		clock: {
			set: (at, options) => span("device.clock.set", () => clock.set(at, options)),
			advance: (by) => span("device.clock.advance", () => clock.advance(by)),
			during: (at, fn, options) => span("device.clock.during", () => clock.during(at, fn, options)),
			reset: () => span("device.clock.reset", () => clock.reset()),
			status: () => clock.status(),
		},
		permissions: {
			set: (grants, options) => span("device.permissions.set", () => permissions.set(grants, options)),
			reset: (options) => span("device.permissions.reset", () => permissions.reset(options)),
		},
		timezone: (tz) => span("device.timezone", () => device.timezone(tz)),
		locale: (tag, options) => span("device.locale", () => device.locale(tag, options)),
		a11y: (op) => span("device.a11y", () => device.a11y(op)),
		battery: (op) => span("device.battery", () => device.battery(op)),
		memoryWarning: (options) => span("device.memoryWarning", () => device.memoryWarning(options)),
		push: (payload, options) => span("device.push", () => device.push(payload, options)),
		timeline: (steps) => span("device.timeline", () => device.timeline(steps)),
		alert: (action) => span("device.alert", () => device.alert(action), { detail: (answered) => ({ answered }) }),
		openLink: (url, options) => span("device.openLink", () => device.openLink(url, options)),
		home: () => span("device.home", () => device.home()),
		back: () => span("device.back", () => device.back()),
		orientation: (set) => span("device.orientation", () => device.orientation(set)),
		appearance: (set) => span("device.appearance", () => device.appearance(set)),
		biometrics: {
			status: () => span("device.biometrics.status", () => device.biometrics.status()),
			enroll: () => span("device.biometrics.enroll", () => device.biometrics.enroll()),
			unenroll: () => span("device.biometrics.unenroll", () => device.biometrics.unenroll()),
			match: () => span("device.biometrics.match", () => device.biometrics.match()),
			fail: () => span("device.biometrics.fail", () => device.biometrics.fail()),
		},
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
	const internals = conditionsOf(device);
	if (internals !== undefined) registerConditions(traced, internals);
	return traced;
}
