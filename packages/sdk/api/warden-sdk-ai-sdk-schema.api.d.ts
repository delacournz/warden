import { z } from "zod";
/** Names of the tools in the `core` set. */
export declare const CORE_TOOL_NAMES: readonly ["open", "close", "snapshot", "press", "fill", "type", "get", "is", "find", "wait", "back", "scroll", "swipe", "alert", "screenshot", "logs", "route"];
/** Names the `all` set adds on top of `core`. */
export declare const EXTRA_TOOL_NAMES: readonly ["claim", "release", "devices", "install", "metro", "eval", "network", "record_start", "record_note", "record_stop", "record_status", "perf_startup", "perf_metrics", "perf_memory", "perf_logs", "perf_crashes"];
export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type ExtraToolName = (typeof EXTRA_TOOL_NAMES)[number];
export type ToolName = CoreToolName | ExtraToolName;
/** Input schema per tool. */
export declare const toolInputSchemas: {
    readonly open: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
        relaunch: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly close: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly snapshot: z.ZodObject<{
        interactiveOnly: z.ZodOptional<z.ZodBoolean>;
        offscreen: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly press: z.ZodObject<{
        point: z.ZodOptional<z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>>;
        count: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
        selector: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly fill: z.ZodObject<{
        text: z.ZodString;
        clear: z.ZodOptional<z.ZodBoolean>;
        ref: z.ZodOptional<z.ZodString>;
        selector: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly type: z.ZodObject<{
        text: z.ZodString;
    }, z.core.$strip>;
    readonly get: z.ZodObject<{
        property: z.ZodEnum<{
            value: "value";
            text: "text";
            label: "label";
            identifier: "identifier";
            frame: "frame";
            role: "role";
        }>;
        ref: z.ZodOptional<z.ZodString>;
        selector: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly is: z.ZodObject<{
        state: z.ZodEnum<{
            visible: "visible";
            enabled: "enabled";
            focused: "focused";
            selected: "selected";
            checked: "checked";
            hittable: "hittable";
        }>;
        ref: z.ZodOptional<z.ZodString>;
        selector: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly find: z.ZodObject<{
        selector: z.ZodString;
        all: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly wait: z.ZodObject<{
        for: z.ZodEnum<{
            text: "text";
            visible: "visible";
            hidden: "hidden";
            present: "present";
            absent: "absent";
            stable: "stable";
        }>;
        text: z.ZodOptional<z.ZodString>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        ref: z.ZodOptional<z.ZodString>;
        selector: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly back: z.ZodObject<{}, z.core.$strip>;
    readonly scroll: z.ZodObject<{
        amount: z.ZodOptional<z.ZodNumber>;
        untilRef: z.ZodOptional<z.ZodString>;
        untilSelector: z.ZodOptional<z.ZodString>;
        ref: z.ZodOptional<z.ZodString>;
        selector: z.ZodOptional<z.ZodString>;
        direction: z.ZodEnum<{
            up: "up";
            down: "down";
            left: "left";
            right: "right";
        }>;
    }, z.core.$strip>;
    readonly swipe: z.ZodObject<{
        from: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>;
        to: z.ZodObject<{
            x: z.ZodNumber;
            y: z.ZodNumber;
        }, z.core.$strip>;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly alert: z.ZodObject<{
        action: z.ZodOptional<z.ZodEnum<{
            accept: "accept";
            dismiss: "dismiss";
            read: "read";
        }>>;
        button: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly screenshot: z.ZodObject<{
        scale: z.ZodOptional<z.ZodNumber>;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly logs: z.ZodObject<{
        since: z.ZodOptional<z.ZodNumber>;
        level: z.ZodOptional<z.ZodEnum<{
            error: "error";
            log: "log";
            info: "info";
            warn: "warn";
            debug: "debug";
        }>>;
        limit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly claim: z.ZodObject<{
        platform: z.ZodEnum<{
            ios: "ios";
            android: "android";
        }>;
        profile: z.ZodOptional<z.ZodString>;
        runtime: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly release: z.ZodObject<{
        leaseIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        shutdown: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly devices: z.ZodObject<{
        platform: z.ZodOptional<z.ZodEnum<{
            ios: "ios";
            android: "android";
        }>>;
        booted: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly install: z.ZodObject<{
        path: z.ZodString;
    }, z.core.$strip>;
    readonly metro: z.ZodObject<{
        action: z.ZodEnum<{
            start: "start";
            stop: "stop";
            status: "status";
        }>;
        project: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly eval: z.ZodObject<{
        expression: z.ZodString;
    }, z.core.$strip>;
    readonly network: z.ZodObject<{
        since: z.ZodOptional<z.ZodNumber>;
        urlContains: z.ZodOptional<z.ZodString>;
        limit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly route: z.ZodObject<{}, z.core.$strip>;
    readonly record_start: z.ZodObject<{
        name: z.ZodString;
        to: z.ZodOptional<z.ZodString>;
        helper: z.ZodOptional<z.ZodString>;
        suite: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        overwrite: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly record_note: z.ZodObject<{
        text: z.ZodString;
    }, z.core.$strip>;
    readonly record_stop: z.ZodObject<{
        verify: z.ZodOptional<z.ZodBoolean>;
        overwrite: z.ZodOptional<z.ZodBoolean>;
        suite: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly record_status: z.ZodObject<{}, z.core.$strip>;
    readonly perf_startup: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
        warm: z.ZodOptional<z.ZodBoolean>;
        runs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly perf_metrics: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
        duration: z.ZodOptional<z.ZodString>;
        interval: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly perf_memory: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly perf_logs: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<{
            error: "error";
            info: "info";
            warn: "warn";
            debug: "debug";
            verbose: "verbose";
            fatal: "fatal";
        }>>;
        grep: z.ZodOptional<z.ZodString>;
        since: z.ZodOptional<z.ZodString>;
        lines: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly perf_crashes: z.ZodObject<{
        app: z.ZodOptional<z.ZodString>;
        since: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
};
/** What the model reads to pick a tool. */
export declare const toolDescriptions: {
    readonly open: "Launch the app under test (or a deep link).";
    readonly close: "Terminate the app under test.";
    readonly snapshot: "Read the screen as compact text. Each element has a ref like @e3; use refs in press/fill/get/is/wait. Refs expire on the next snapshot.";
    readonly press: "Tap an element by ref or selector, or a screen point.";
    readonly fill: "Focus a text field, replace its content and confirm the value.";
    readonly type: "Type text into the currently focused field.";
    readonly get: "Read one property of an element.";
    readonly is: "Test one state of an element (visible, enabled, ...).";
    readonly find: "List elements matching a selector in a fresh snapshot.";
    readonly wait: "Wait until an element reaches a condition, or fail after the timeout.";
    readonly back: "Navigate back (Android back key, iOS back).";
    readonly scroll: "Scroll the screen or a container in a direction, optionally until an element is visible.";
    readonly swipe: "One-finger swipe between two screen points.";
    readonly alert: "Read the system alert, or accept/dismiss it.";
    readonly screenshot: "Capture the screen to a PNG file; returns its path and shows you the image (omitted when over the size cap: pass a smaller scale).";
    readonly logs: "Console messages of the app (needs a dev build with Metro).";
    readonly claim: "Claim a device lease for a platform (a session is opened on it).";
    readonly release: "Release device leases held by this client.";
    readonly devices: "List devices on this machine.";
    readonly install: "Install a prebuilt app on the session's device.";
    readonly metro: "Start, stop or inspect the dev server.";
    readonly eval: "Evaluate JavaScript in the app's Hermes runtime.";
    readonly network: "Network requests the app made.";
    readonly route: "The route (screen) the app is on, e.g. (tabs)/todos (needs a dev build with Metro).";
    readonly record_start: "Start recording this session as an e2e spec: later press/fill/scroll/... calls are journalled as steps (needs a dev build or accessible ids to make durable selectors).";
    readonly record_note: "Mark a user-visible step in the recording; it becomes a comment above the next action in the spec.";
    readonly record_stop: "Write the recorded spec and, by default, run it once on the device. Returns the file, lint findings, whether it passed and the warden.config.ts snippet.";
    readonly record_status: "The recording in progress: target, step count, the last steps and lint findings.";
    readonly perf_startup: "Cold (or warm) app start time: median and p90 over several launches, with findings. Kills and relaunches the app.";
    readonly perf_metrics: "CPU % and memory of the app over a few seconds: min/avg/p95/max, memory growth and findings.";
    readonly perf_memory: "Where the app's memory sits right now (Android meminfo categories, iOS footprint and regions).";
    readonly perf_logs: "The app's recent device logs (secrets redacted), filtered by level, regex or age.";
    readonly perf_crashes: "Crashes and ANRs of the app: process, summary, top frames and findings.";
};
export type ToolInputs = {
    [K in ToolName]: z.infer<(typeof toolInputSchemas)[K]>;
};
