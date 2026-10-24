import { describe, expect, test } from "bun:test";
import { importOptional, isPackageMissing, loadServerSpan, OTEL_START, otlpConfigured } from "./otel";

const missing = async (specifier: string): Promise<unknown> => import(specifier);

describe("isPackageMissing", () => {
	test("is true for Bun's resolve error naming the package", async () => {
		const error = await missing("@delacournz/warden-docs-missing").catch((e: unknown) => e);
		expect(isPackageMissing(error, "@delacournz/warden-docs-missing")).toBe(true);
	});

	test("is false when a different package is missing (a broken install, not an absent one)", async () => {
		const error = await missing("@delacournz/warden-docs-missing").catch((e: unknown) => e);
		expect(isPackageMissing(error, "@delacournz/warden-docs")).toBe(false);
	});

	test("is false for any other error", () => {
		expect(isPackageMissing(new Error("boom"), OTEL_START)).toBe(false);
		expect(isPackageMissing("Cannot find package '@delacournz/otel-start'", OTEL_START)).toBe(false);
	});
});

describe("importOptional", () => {
	test("returns the module when it loads", async () => {
		const mod = { a: 1 };
		expect(await importOptional("pkg", async () => mod)).toBe(mod);
	});

	test("returns undefined when the package is not installed", async () => {
		const result = await importOptional("@delacournz/warden-docs-missing/preload", () =>
			missing("@delacournz/warden-docs-missing/preload")
		);
		expect(result).toBeUndefined();
	});

	test("rethrows anything else", async () => {
		const result = importOptional("pkg", async () => {
			throw new Error("boom");
		});
		await expect(result).rejects.toThrow("boom");
	});
});

describe("loadServerSpan", () => {
	test("returns the package's withServerSpan", async () => {
		const withServerSpan =
			<Args extends unknown[]>(_name: string, fn: (request: Request, ...args: Args) => Promise<Response> | Response) =>
			async (request: Request, ...args: Args) =>
				fn(request, ...args);
		const wrap = await loadServerSpan(async () => ({ withServerSpan }));
		expect(wrap).toBe(withServerSpan);
	});

	test("accepts a module namespace (null prototype)", async () => {
		const withServerSpan = () => async () => new Response();
		const namespace: Record<string, unknown> = Object.create(null);
		namespace.withServerSpan = withServerSpan;
		expect(await loadServerSpan(async () => namespace)).toBe(withServerSpan);
	});

	test("is undefined when @delacournz/otel-start is not installed", async () => {
		expect(await loadServerSpan(async () => undefined)).toBeUndefined();
	});

	test("throws when the package loads without withServerSpan", async () => {
		await expect(loadServerSpan(async () => ({}))).rejects.toThrow("withServerSpan");
	});
});

describe("otlpConfigured", () => {
	test("is true for Railway's or Dash0's OTLP exporter env", () => {
		expect(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(true);
		expect(otlpConfigured({ DASH0_OTLP_ENDPOINT: "https://ingress.dash0.com" })).toBe(true);
	});

	test("is false otherwise, empty values included", () => {
		expect(otlpConfigured({})).toBe(false);
		expect(otlpConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_SERVICE_NAME: "warden-docs" })).toBe(false);
	});
});
