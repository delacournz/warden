package nz.co.delacour.warden.uiad;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import android.os.Looper;
import org.json.JSONObject;

/**
 * `warden-uiad`: a resident UiAutomation server, one JSON object per line on stdin / stdout (protocol v1,
 * mirroring warden-simd). Run it as the shell user:
 *
 * <pre>CLASSPATH=/data/local/tmp/warden-uiad.dex app_process / nz.co.delacour.warden.uiad.Main</pre>
 *
 * Requests `{id, op, ...params}`; replies `{id, ok:true, data}` / `{id, ok:false, error:{code, message, retryable?}}`;
 * events `{event:"ready"|"log"|"fatal", ...}`. Ops run one at a time, in order. EOF on stdin ends the process, so a
 * dead host (adb tears the shell down) never leaves a UiAutomation client behind.
 */
public final class Main {
	static final int PROTOCOL = 1;
	static final String VERSION = "0.6.0";
	private static final Charset ASCII = Charset.forName("US-ASCII");

	private static FileOutputStream stdout;

	private Main() {}

	private static synchronized void send(String line) {
		try {
			stdout.write((line + "\n").getBytes(ASCII));
			stdout.flush();
		} catch (IOException e) {
			// the host is gone: nothing to tell anyone
			System.exit(1);
		}
	}

	/** A `log` event (`level` is debug, info, warn or error). */
	static void log(String level, String message) {
		send("{\"event\":\"log\",\"level\":" + quote(level) + ",\"message\":" + quote(message) + "}");
	}

	private static String quote(String s) {
		StringBuilder sb = new StringBuilder();
		Json.str(sb, s == null ? "" : s);
		return sb.toString();
	}

	private static String errorJson(String code, String message, boolean retryable) {
		return "{\"code\":" + quote(code) + ",\"message\":" + quote(message) + ",\"retryable\":" + retryable + "}";
	}

	/**
	 * The main thread must own the main looper (`AccessibilityInteractionClient` builds a handler on it) and spin
	 * it; the protocol loop runs on its own thread.
	 */
	public static void main(String[] args) {
		Looper.prepareMainLooper();
		Thread io = new Thread(new Runnable() {
			@Override
			public void run() {
				try {
					serve();
				} catch (Throwable t) {
					send("{\"event\":\"fatal\",\"error\":" + errorJson("E_INTERNAL", t.toString(), false) + "}");
					System.exit(4);
				}
			}
		}, "warden-uiad-io");
		io.start();
		Looper.loop();
	}

	private static void serve() throws Exception {
		stdout = new FileOutputStream(FileDescriptor.out);
		// nothing but protocol lines may reach stdout: stray prints go to stderr
		System.setOut(System.err);

		Uia uia = new Uia();
		try {
			uia.connect();
		} catch (Uia.OpError e) {
			send("{\"event\":\"fatal\",\"error\":" + errorJson(e.code, e.getMessage(), e.retryable) + "}");
			System.exit(3);
			return;
		} catch (Throwable t) {
			String message = String.valueOf(t.getMessage());
			boolean busy = message.contains("already registered") || message.contains("Already connected");
			String code = "E_AX_UNAVAILABLE";
			String detail = busy ? "uiautomation_busy" : "connect_failed";
			send("{\"event\":\"fatal\",\"error\":{\"code\":" + quote(code) + ",\"message\":" + quote(t.getClass().getName() + ": " + message)
					+ ",\"retryable\":false,\"detail\":{\"reason\":" + quote(detail) + "}}}");
			System.exit(3);
			return;
		}
		send("{\"event\":\"ready\",\"protocol\":" + PROTOCOL + ",\"version\":" + quote(VERSION) + ",\"data\":" + uia.health() + "}");

		BufferedReader in = new BufferedReader(new InputStreamReader(new BufferedInputStream(System.in), Charset.forName("UTF-8")));
		String line;
		while ((line = in.readLine()) != null) {
			if (line.trim().isEmpty()) continue;
			if (!handle(uia, line)) break;
		}
		uia.close();
		System.exit(0);
	}

	private static Uia.SnapshotOptions snapshotOptions(JSONObject req) {
		Uia.SnapshotOptions o = new Uia.SnapshotOptions();
		o.scope = req.optString("scope", o.scope);
		o.maxNodes = req.optInt("maxNodes", o.maxNodes);
		o.idleMs = req.optLong("idleMs", o.idleMs);
		o.rootWaitMs = req.optLong("rootWaitMs", o.rootWaitMs);
		o.skipInvisible = req.optBoolean("skipInvisible", o.skipInvisible);
		o.fresh = req.optBoolean("fresh", o.fresh);
		o.windows = req.optBoolean("windows", o.windows);
		return o;
	}

	/** Handle one request line; false after `shutdown`. */
	private static boolean handle(Uia uia, String line) {
		String id = "";
		try {
			JSONObject req = new JSONObject(line);
			id = req.optString("id", "");
			String op = req.optString("op", "");
			String data;
			switch (op) {
				case "health":
					data = uia.health();
					break;
				case "snapshot":
					data = uia.snapshot(snapshotOptions(req));
					break;
				case "settle":
					data = uia.settle(req.optLong("quietMs", 250), req.optLong("timeoutMs", 3000));
					break;
				case "tap":
					data = uia.tap((float) req.getDouble("x"), (float) req.getDouble("y"), req.optInt("count", 1), req.optLong("holdMs", 0), req.optLong("gapMs", 60), req.optBoolean("sync", true));
					break;
				case "swipe":
					data = uia.swipe((float) req.getDouble("x1"), (float) req.getDouble("y1"), (float) req.getDouble("x2"), (float) req.getDouble("y2"), req.optLong("durationMs", 300), req.optInt("steps", 8), req.optLong("pressMs", 0), req.optLong("releaseMs", 0));
					break;
				case "gesture":
					data = uia.gesture(req.getJSONArray("paths"), req.optDouble("frameMs", 16), req.optLong("holdMs", 0), req.optLong("releaseMs", 0));
					break;
				case "key":
					data = uia.key(req.getInt("keyCode"), req.optInt("metaState", 0), req.optInt("times", 1), req.optLong("gapMs", 30), req.optBoolean("sync", true));
					break;
				case "setText":
					data = uia.setText(req.getString("text"), req.optString("resourceId", null));
					break;
				case "typeText":
					data = uia.typeText(req.getString("text"));
					break;
				case "selectAll":
					data = uia.selectAll();
					break;
				case "a11yEvents":
					data = uia.a11yEvents(req.optLong("since", 0));
					break;
				case "srFocus":
					data = uia.srFocus(req.optString("dir", ""), req.has("x") ? (float) req.getDouble("x") : -1, req.has("y") ? (float) req.getDouble("y") : -1);
					break;
				case "srFocused":
					data = uia.srFocused();
					break;
				case "srActivate":
					data = uia.srActivate();
					break;
				case "srEvents":
					data = uia.srEvents(req.optLong("since", 0));
					break;
				case "actionClick":
					data = uia.actionClick((float) req.getDouble("x"), (float) req.getDouble("y"), req.optString("id", null));
					break;
				case "actionScroll":
					data = uia.actionScroll(req.getString("dir"), req.has("x") ? (float) req.getDouble("x") : -1, req.has("y") ? (float) req.getDouble("y") : -1);
					break;
				case "screenshot":
					data = uia.screenshot();
					break;
				case "audit":
					data = uia.audit(req.getString("atf"), req.optBoolean("contrast", true));
					break;
				case "shutdown":
					send("{\"id\":" + quote(id) + ",\"ok\":true,\"data\":{}}");
					return false;
				default:
					send("{\"id\":" + quote(id) + ",\"ok\":false,\"error\":" + errorJson("E_BAD_REQUEST", "unknown op: " + op, false) + "}");
					return true;
			}
			send("{\"id\":" + quote(id) + ",\"ok\":true,\"data\":" + data + "}");
		} catch (Uia.OpError e) {
			send("{\"id\":" + quote(id) + ",\"ok\":false,\"error\":" + errorJson(e.code, e.getMessage(), e.retryable) + "}");
		} catch (org.json.JSONException e) {
			send("{\"id\":" + quote(id) + ",\"ok\":false,\"error\":" + errorJson("E_BAD_REQUEST", e.getMessage(), false) + "}");
		} catch (Throwable t) {
			send("{\"id\":" + quote(id) + ",\"ok\":false,\"error\":" + errorJson("E_INTERNAL", t.toString(), false) + "}");
		}
		return true;
	}
}
