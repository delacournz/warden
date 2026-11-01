import { type Tool } from "ai";
import type { ClientSeams } from "../core";
import type { Platform, Session, WardenClient, WardenClientOptions } from "../sdk.types";
import { type ToolName } from "./tools.schema";
/** Failure payload of a tool: returned to the model instead of thrown, so it can recover. */
export type ToolFailure = {
    ok: false;
    error: {
        code: string;
        message: string;
        hint?: string;
    };
};
/** Result of a tool: `{ok: true, ...}` or a {@link ToolFailure}. */
export type ToolResult = ({
    ok: true;
} & Record<string, unknown>) | ToolFailure;
export type ToolSetName = "core" | "all";
/** Largest PNG (bytes) the `screenshot` tool hands the model as an image; a bigger one is returned as its path only. */
export declare const DEFAULT_SCREENSHOT_IMAGE_MAX_BYTES = 1000000;
export type CreateWardenToolsOptions = {
    /** an existing client; otherwise one is created from `clientOptions` (label `ai-sdk`) and closed by `close()` */
    client?: WardenClient;
    /** an existing session; otherwise a device is claimed and a session opened on the first tool call */
    session?: Session;
    /** platform to claim when no session is given */
    platform: Platform;
    /** app (bundle id / package) the session drives */
    app?: string;
    /** `core` (17 tools) or `all` (adds device, build, and devtools tools) */
    set: ToolSetName;
    /** tools that need a human yes before running; feed `toolApproval` to the agent / `generateText` */
    approval?: Partial<Record<ToolName, "user-approval">>;
    /** PNG size cap for the image the `screenshot` tool shows the model (default 1 MB); above it only the path is returned */
    screenshotImageMaxBytes?: number;
    /** options of the client this factory creates */
    clientOptions?: WardenClientOptions;
    /** test seams of the client this factory creates */
    clientSeams?: ClientSeams;
};
/** Tools the model can call, keyed by tool name. */
export type WardenToolSet = Partial<Record<ToolName, Tool>>;
export type WardenTools = {
    /** pass as `tools` */
    tools: WardenToolSet;
    /** pass as `toolApproval` (v7 `ai`): the `approval` option, narrowed to the tools in this set */
    toolApproval: Partial<Record<ToolName, "user-approval">>;
    client: WardenClient;
    /** the session once it exists (given, or opened by the first tool call) */
    readonly session: Session | undefined;
    /** open the session now instead of at the first tool call */
    getSession(): Promise<Session>;
    /** close what this factory created (session, client); a given client or session is left alone */
    close(): Promise<void>;
};
/** The shape `toModelOutput` returns (not re-exported by `ai`). */
type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;
/**
 * What the model sees for a `screenshot` result: the path/size line plus the PNG as an image part. The base64 lives in
 * the result's `image` field (so a resumed history still carries it) and is stripped from the text part.
 */
export declare function screenshotModelOutput(output: ToolResult): ToolResultOutput;
/** A caught value as the failure payload; `stale_ref` always tells the model to re-snapshot. */
export declare function toolFailure(error: unknown, signal?: AbortSignal): ToolFailure;
/**
 * Build the Vercel AI SDK tools that drive a warden session. Every tool returns `{ok: true, ...}` or
 * `{ok: false, error: {code, message, hint}}`; none throws. The session is claimed and opened lazily, on the first
 * tool call, when no `session` is given. Approval is v7 `toolApproval`: spread the returned `toolApproval` into the
 * agent or `generateText` call.
 */
export declare function createWardenTools(options: CreateWardenToolsOptions): Promise<WardenTools>;
export {};
