export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export class HookJson {
	isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	isJsonObject(value: unknown): value is JsonObject {
		return this.isRecord(value);
	}

	/** `obj[key]` when it is a non-empty string. */
	stringField(obj: Record<string, unknown>, key: string): string | undefined {
		const value = obj[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}

	errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

export const hookJson = new HookJson();
