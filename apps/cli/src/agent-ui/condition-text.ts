import type {
	ConditionRecord,
	LocationCondition,
	NetworkCondition,
} from "@delacour/warden-core/conditions/conditions.types";
import { formatDuration } from "@delacour/warden-core/duration";

/** One condition as a short human phrase: `3g`, `custom 800 ms / 780 kbps down`, `flap 10s up / 3s down`. */
export function describeNetwork(condition: NetworkCondition): string {
	switch (condition.kind) {
		case "online":
		case "offline":
			return condition.kind;
		case "preset":
			return condition.preset;
		case "custom": {
			const parts = [
				condition.latencyMs !== undefined && `${condition.latencyMs} ms`,
				condition.jitterMs !== undefined && `±${condition.jitterMs} ms`,
				condition.downKbps !== undefined && `${condition.downKbps} kbps down`,
				condition.upKbps !== undefined && `${condition.upKbps} kbps up`,
				condition.lossPct !== undefined && `${condition.lossPct}% loss`,
			].filter((part): part is string => part !== false);
			return `custom ${parts.join(", ")}`.trim();
		}
		case "flap": {
			const jitter = condition.jitterPct === undefined ? "" : ` ±${condition.jitterPct}%`;
			const base = condition.base === undefined ? "" : ` over ${describeNetwork(condition.base)}`;
			return `flap ${formatDuration(condition.upMs)} up / ${formatDuration(condition.downMs)} down${jitter}${base}`;
		}
	}
}

export function describeLocation(condition: LocationCondition): string {
	switch (condition.kind) {
		case "point":
			return `${condition.lat},${condition.lon}`;
		case "route":
			return `route of ${condition.points.length} points${condition.loop ? " (loop)" : ""}`;
		case "gpx":
			return `gpx ${condition.path}`;
		case "scenario":
			return `scenario ${condition.name}`;
		case "clear":
			return "cleared";
	}
}

/** `network 3g · location 37.3,-122` for `warden ui status`; undefined when the lease has none set. */
export function conditionsLine(records: readonly ConditionRecord[]): string | undefined {
	const parts = records.map((record) => {
		switch (record.area) {
			case "network":
				return `network ${describeNetwork(record.value)}`;
			case "location":
				return `location ${describeLocation(record.value)}`;
			case "clock":
				return `clock ${record.value.kind}`;
			case "permission":
				return `permission ${record.value.grants.map((g) => `${g.permission}=${g.state}`).join(",")}`;
			case "locale":
				return `locale ${[record.value.timezone, record.value.locale].filter((v) => v !== undefined).join(" ")}`;
			case "a11y":
				return `a11y ${[record.value.textSize === undefined ? undefined : `text ${record.value.textSize}`, record.value.boldText ? "bold" : undefined].filter((v) => v !== undefined).join(" ")}`.trim();
			case "battery":
				return `battery ${record.value.level === undefined ? "" : `${record.value.level}%`}${record.value.cosmetic ? " (status bar)" : ""}`.trim();
		}
		return "";
	});
	return parts.length === 0 ? undefined : parts.join(" · ");
}
