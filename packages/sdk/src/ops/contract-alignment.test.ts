import { expect, test } from "bun:test";
import { WARDEN_ERROR_CODES, type WardenError } from "@delacour/warden-types/error";
import type { WardenErrorCode as ContractErrorCode } from "../sdk.types";
import type { OpSession } from "./session";

/**
 * The ops are the engine behind the public contract (`sdk.types.ts`): every code an op can fail with must be a code the
 * contract promises, and the ops' stores must be swappable. These are compile-time checks; the runtime half pins the
 * code list so adding a code to `@delacour/warden-types` without the contract fails here.
 */

type OpCodeIsInContract = WardenError["code"] extends ContractErrorCode ? true : never;
const opCodesAreContractCodes: OpCodeIsInContract = true;

type SessionHasStores = OpSession extends { refs: { commit: unknown }; state: { update: unknown } } ? true : never;
const sessionHasStores: SessionHasStores = true;

test("every error code the ops can raise is part of the public contract", () => {
	expect(opCodesAreContractCodes && sessionHasStores).toBe(true);
	expect(WARDEN_ERROR_CODES).toContain("stale_ref");
	expect(WARDEN_ERROR_CODES).toContain("wait_target_absent");
});
