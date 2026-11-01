import type { CallOptions, NativeLogEntry, NativeLogsParams, SessionDevtoolsNamespace } from "./sdk.types";

/** The two ways the session reads the native log; `nativeLogsMethod` picks one by `follow`. */
export type NativeLogsReaders = {
	read(params: NativeLogsParams | undefined, opts: CallOptions | undefined): Promise<NativeLogEntry[]>;
	follow(params: NativeLogsParams, opts: CallOptions | undefined): AsyncIterable<NativeLogEntry>;
};

/** `devtools.nativeLogs`: a list, or with `follow: true` a stream. */
export function nativeLogsMethod(readers: NativeLogsReaders): SessionDevtoolsNamespace["nativeLogs"] {
	function nativeLogs(params: NativeLogsParams & { follow: true }, opts?: CallOptions): AsyncIterable<NativeLogEntry>;
	function nativeLogs(params?: NativeLogsParams & { follow?: false }, opts?: CallOptions): Promise<NativeLogEntry[]>;
	function nativeLogs(
		params?: NativeLogsParams & { follow?: boolean },
		opts?: CallOptions
	): AsyncIterable<NativeLogEntry> | Promise<NativeLogEntry[]> {
		const { follow, ...rest } = params ?? {};
		return follow === true ? readers.follow(rest, opts) : readers.read(rest, opts);
	}
	return nativeLogs;
}
