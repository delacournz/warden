package nz.co.delacour.warden.uiad;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * One connected `UiAutomation` and the ops built on it. The connection is made exactly the way the platform's own
 * `uiautomator` command makes it (`UiAutomationShellWrapper`): `new UiAutomation(Looper, new UiAutomationConnection())`
 * then `connect()`, through reflection so a hidden-API signature change is a runtime error naming the member, never
 * a link error. Every op returns the JSON text of its `data`.
 */
final class Uia {
	/** An op failed in a way the host should see as a protocol error (`code` is a driver error code). */
	static final class OpError extends Exception {
		final String code;
		final boolean retryable;

		OpError(String code, String message, boolean retryable) {
			super(message);
			this.code = code;
			this.retryable = retryable;
		}
	}

	private UiAutomation ua;
	private HandlerThread thread;
	private Display display;
	private String displayError;
	private final Object eventLock = new Object();
	private long lastEventMs;
	private long eventCount;
	private long lastInputMs;
	private String connectVia = "";
	private boolean includeInvisible;
	long connectMs;
	final long startedMs = SystemClock.uptimeMillis();

	// ---------- connection ----------

	/** Connect; throws with the platform's own message when another UiAutomation client already holds the slot. */
	void connect() throws Exception {
		long t0 = SystemClock.uptimeMillis();
		thread = new HandlerThread("warden-uiad");
		thread.setDaemon(true);
		thread.start();
		Looper looper = thread.getLooper();
		Object connection;
		Class<?> iface;
		try {
			Class<?> impl = Class.forName("android.app.UiAutomationConnection");
			iface = Class.forName("android.app.IUiAutomationConnection");
			connection = impl.getDeclaredConstructor().newInstance();
		} catch (Throwable t) {
			throw new OpError("E_UNSUPPORTED", "UiAutomationConnection is not reachable on API " + Build.VERSION.SDK_INT + ": " + t, false);
		}
		Constructor<UiAutomation> ctor;
		try {
			ctor = UiAutomation.class.getDeclaredConstructor(Looper.class, iface);
			ctor.setAccessible(true);
		} catch (Throwable t) {
			throw new OpError("E_UNSUPPORTED", "UiAutomation(Looper, IUiAutomationConnection) missing on API " + Build.VERSION.SDK_INT + ": " + t, false);
		}
		ua = ctor.newInstance(looper, connection);
		try {
			Method withFlags = UiAutomation.class.getDeclaredMethod("connect", int.class);
			withFlags.setAccessible(true);
			invoke(withFlags, 0);
			connectVia = "connect(int)";
		} catch (NoSuchMethodException e) {
			Method plain = UiAutomation.class.getDeclaredMethod("connect");
			plain.setAccessible(true);
			invoke(plain);
			connectVia = "connect()";
		}
		AccessibilityServiceInfo info = ua.getServiceInfo();
		if (info != null) {
			Main.log("debug", "stock service info flags=0x" + Integer.toHexString(info.flags) + " events=0x" + Integer.toHexString(info.eventTypes));
			info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
			ua.setServiceInfo(info);
		}
		ua.setOnAccessibilityEventListener(new UiAutomation.OnAccessibilityEventListener() {
			@Override
			public void onAccessibilityEvent(AccessibilityEvent event) {
				if (!significant(event.getEventType())) return;
				synchronized (eventLock) {
					lastEventMs = SystemClock.uptimeMillis();
					eventCount++;
					eventLock.notifyAll();
				}
			}
		});
		initDisplay();
		connectMs = SystemClock.uptimeMillis() - t0;
	}

	private void invoke(Method m, Object... args) throws Exception {
		try {
			m.invoke(ua, args);
		} catch (InvocationTargetException e) {
			Throwable cause = e.getCause();
			if (cause instanceof Exception) throw (Exception) cause;
			throw e;
		}
	}

	/** Release the UiAutomation slot (`disconnect()`, `destroy()` on older images; both are hidden API). */
	void close() {
		if (ua != null) {
			for (String name : new String[] {"disconnect", "destroy"}) {
				try {
					Method m = UiAutomation.class.getDeclaredMethod(name);
					m.setAccessible(true);
					m.invoke(ua);
					break;
				} catch (Throwable ignored) {
					// try the next name; the process exit drops the connection anyway
				}
			}
		}
		if (thread != null) thread.quitSafely();
	}

	/** Events that mean "the screen is changing"; hover, touch-exploration and a11y-focus noise does not. */
	private static boolean significant(int type) {
		switch (type) {
			case AccessibilityEvent.TYPE_VIEW_HOVER_ENTER:
			case AccessibilityEvent.TYPE_VIEW_HOVER_EXIT:
			case AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_START:
			case AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_END:
			case AccessibilityEvent.TYPE_GESTURE_DETECTION_START:
			case AccessibilityEvent.TYPE_GESTURE_DETECTION_END:
			case AccessibilityEvent.TYPE_TOUCH_INTERACTION_START:
			case AccessibilityEvent.TYPE_TOUCH_INTERACTION_END:
			case AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED:
			case AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED:
			case AccessibilityEvent.TYPE_ANNOUNCEMENT:
				return false;
			default:
				return true;
		}
	}

	private void initDisplay() {
		try {
			Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
			Object instance = global.getMethod("getInstance").invoke(null);
			display = (Display) global.getMethod("getRealDisplay", int.class).invoke(instance, 0);
		} catch (Throwable t) {
			displayError = String.valueOf(t);
		}
	}

	// ---------- health ----------

	String health() {
		StringBuilder sb = new StringBuilder(256);
		sb.append("{\"version\":").append(q(Main.VERSION));
		sb.append(",\"protocol\":").append(Main.PROTOCOL);
		sb.append(",\"sdk\":").append(Build.VERSION.SDK_INT);
		sb.append(",\"release\":").append(q(Build.VERSION.RELEASE));
		sb.append(",\"model\":").append(q(Build.MODEL));
		sb.append(",\"uid\":").append(android.os.Process.myUid());
		sb.append(",\"pid\":").append(android.os.Process.myPid());
		sb.append(",\"uiAutomation\":{\"state\":\"connected\",\"connect\":").append(q(connectVia));
		sb.append(",\"connectMs\":").append(connectMs).append('}');
		synchronized (eventLock) {
			long now = SystemClock.uptimeMillis();
			sb.append(",\"events\":{\"count\":").append(eventCount);
			sb.append(",\"lastAgoMs\":").append(eventCount == 0 ? -1 : now - lastEventMs).append('}');
		}
		sb.append(",\"uptimeMs\":").append(SystemClock.uptimeMillis() - startedMs);
		sb.append(",\"screen\":");
		screenJson(sb);
		if (displayError != null) sb.append(",\"displayError\":").append(q(displayError));
		sb.append('}');
		return sb.toString();
	}

	private static String q(String s) {
		StringBuilder sb = new StringBuilder();
		Json.str(sb, s == null ? "" : s);
		return sb.toString();
	}

	/** `{"width":W,"height":H,"scale":S,"rotation":R}`; zeros when the display cannot be read. */
	private void screenJson(StringBuilder sb) {
		int w = 0;
		int h = 0;
		float scale = 0;
		int rotation = 0;
		if (display != null) {
			DisplayMetrics m = new DisplayMetrics();
			display.getRealMetrics(m);
			w = m.widthPixels;
			h = m.heightPixels;
			scale = m.density;
			rotation = display.getRotation();
		}
		sb.append("{\"width\":").append(w).append(",\"height\":").append(h);
		sb.append(",\"scale\":").append(scale).append(",\"rotation\":").append(rotation).append('}');
	}

	// ---------- snapshot ----------

	private static final class Walk {
		final StringBuilder sb;
		final int maxNodes;
		final int width;
		final int height;
		final boolean keepInvisible;
		int nodes;
		boolean truncated;

		Walk(StringBuilder sb, int maxNodes, int width, int height, boolean keepInvisible) {
			this.sb = sb;
			this.maxNodes = maxNodes;
			this.width = width;
			this.height = height;
			this.keepInvisible = keepInvisible;
		}
	}

	/** Parameters of the `snapshot` op. */
	static final class SnapshotOptions {
		/** "active": the active window's tree, what `uiautomator dump` returns; "all": every interactive window, top layer first. */
		String scope = "active";
		int maxNodes = 20000;
		/** wait for this long without accessibility events first (the `waitForIdle` a dump always pays); 0 = read now */
		long idleMs = 0;
		/** how long a null root is retried (a window that is still opening) */
		long rootWaitMs = 600;
		/** `uiautomator dump` skips children that are not visible to the user; false keeps them, flagged `invisible` */
		boolean skipInvisible = true;
		/** drop the client-side node cache first, so the read reflects the app now and not the last event */
		boolean fresh = true;
		/** add the `windows` list (needs interactive-window retrieval, which changes `visibleToUser`: see {@link #windowsJson}) */
		boolean windows = false;
	}

	String snapshot(SnapshotOptions o) throws OpError {
		long t0 = SystemClock.uptimeMillis();
		if (o.idleMs > 0) settle(o.idleMs, Math.max(o.idleMs * 4, 2000));
		boolean all = "all".equals(o.scope);
		boolean needWindows = all || o.windows;
		if (o.fresh) clearCache();
		List<AccessibilityWindowInfo> windows = new ArrayList<AccessibilityWindowInfo>();
		List<AccessibilityNodeInfo> roots = new ArrayList<AccessibilityNodeInfo>();
		StringBuilder windowsJson = new StringBuilder();
		if (needWindows) setInteractiveWindows(true);
		try {
			if (needWindows) {
				List<AccessibilityWindowInfo> found = ua.getWindows();
				if (found != null) windows = found;
				windowsJson = windowsJson(windows);
			}
			if (all) {
				for (AccessibilityWindowInfo w : windows) {
					AccessibilityNodeInfo root = w.getRoot();
					if (root != null) roots.add(root);
				}
			} else {
				AccessibilityNodeInfo root = activeRoot(o.rootWaitMs);
				if (root == null) throw new OpError("E_AX_UNAVAILABLE", "no root node for the active window (UiAutomation returned null)", true);
				roots.add(root);
			}
		} finally {
			if (needWindows) setInteractiveWindows(false);
		}
		if (roots.isEmpty()) throw new OpError("E_AX_UNAVAILABLE", "no window with a root node", true);
		int width = 0;
		int height = 0;
		if (display != null) {
			DisplayMetrics m = new DisplayMetrics();
			display.getRealMetrics(m);
			width = m.widthPixels;
			height = m.heightPixels;
		}
		StringBuilder sb = new StringBuilder(32 * 1024);
		sb.append("{\"backend\":\"uiad\",\"screen\":");
		screenJson(sb);
		if (needWindows) sb.append(",\"windows\":").append(windowsJson);
		sb.append(",\"elements\":[");
		long readStart = SystemClock.uptimeMillis();
		int total = 0;
		boolean truncated = false;
		for (int i = 0; i < roots.size(); i++) {
			if (i > 0) sb.append(',');
			Walk walk = new Walk(sb, o.maxNodes - total, width, height, !o.skipInvisible);
			dump(walk, roots.get(i));
			total += walk.nodes;
			truncated |= walk.truncated;
		}
		long now = SystemClock.uptimeMillis();
		sb.append("],\"truncated\":").append(truncated);
		sb.append(",\"nodes\":").append(total);
		sb.append(",\"readMs\":").append(now - readStart);
		sb.append(",\"ms\":").append(now - t0).append('}');
		return sb.toString();
	}

	/**
	 * Interactive-window retrieval (`FLAG_RETRIEVE_INTERACTIVE_WINDOWS`) is off in the stock `uiautomator` service
	 * info and turning it on changes which nodes report `visibleToUser` (3 zero-height svg paths on the example
	 * app). So it is only switched on for the call that needs `getWindows()`, then off again.
	 */
	private void setInteractiveWindows(boolean on) {
		AccessibilityServiceInfo info = ua.getServiceInfo();
		if (info == null) return;
		if (on) info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
		else info.flags &= ~AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
		ua.setServiceInfo(info);
	}

	private static StringBuilder windowsJson(List<AccessibilityWindowInfo> windows) {
		StringBuilder sb = new StringBuilder(256);
		sb.append('[');
		for (int i = 0; i < windows.size(); i++) {
			AccessibilityWindowInfo w = windows.get(i);
			Rect r = new Rect();
			w.getBoundsInScreen(r);
			if (i > 0) sb.append(',');
			sb.append("{\"id\":").append(w.getId()).append(",\"type\":").append(w.getType());
			sb.append(",\"layer\":").append(w.getLayer());
			if (w.isActive()) sb.append(",\"active\":true");
			if (w.isFocused()) sb.append(",\"focused\":true");
			CharSequence title = w.getTitle();
			if (title != null) {
				sb.append(",\"title\":");
				Json.str(sb, title);
			}
			sb.append(",\"bounds\":[").append(r.left).append(',').append(r.top).append(',').append(r.right).append(',').append(r.bottom).append("]}");
		}
		return sb.append(']');
	}

	/** One node as JSON, with the attribute set `uiautomator dump` writes (names kept close to the XML). */
	private void dump(Walk walk, AccessibilityNodeInfo node) {
		StringBuilder sb = walk.sb;
		walk.nodes++;
		sb.append('{');
		boolean first = true;
		first = Json.field(sb, first, "class", node.getClassName());
		first = Json.field(sb, first, "pkg", node.getPackageName());
		first = Json.field(sb, first, "id", node.getViewIdResourceName());
		first = Json.field(sb, first, "text", node.getText());
		first = Json.field(sb, first, "desc", node.getContentDescription());
		if (Build.VERSION.SDK_INT >= 26) first = Json.field(sb, first, "hint", node.getHintText());
		Rect r = visibleBounds(walk, node);
		if (!first) sb.append(',');
		sb.append("\"bounds\":[").append(r.left).append(',').append(r.top).append(',').append(r.right).append(',').append(r.bottom).append(']');
		first = false;
		first = Json.flag(sb, first, "clickable", node.isClickable());
		first = Json.flag(sb, first, "longClickable", node.isLongClickable());
		first = Json.flag(sb, first, "checkable", node.isCheckable());
		first = Json.flag(sb, first, "checked", node.isChecked());
		first = Json.flag(sb, first, "scrollable", node.isScrollable());
		first = Json.flag(sb, first, "selected", node.isSelected());
		first = Json.flag(sb, first, "focused", node.isFocused());
		first = Json.flag(sb, first, "focusable", node.isFocusable());
		first = Json.flag(sb, first, "password", node.isPassword());
		first = Json.flag(sb, first, "editable", node.isEditable());
		first = Json.flag(sb, first, "disabled", !node.isEnabled());
		first = Json.flag(sb, first, "invisible", !node.isVisibleToUser());
		if (Build.VERSION.SDK_INT >= 24) sb.append(",\"order\":").append(node.getDrawingOrder());
		int count = node.getChildCount();
		boolean any = false;
		for (int i = 0; i < count; i++) {
			if (walk.nodes >= walk.maxNodes) {
				walk.truncated = true;
				break;
			}
			AccessibilityNodeInfo child = node.getChild(i);
			if (child == null || (!walk.keepInvisible && !child.isVisibleToUser())) continue;
			sb.append(any ? "," : ",\"children\":[");
			any = true;
			dump(walk, child);
		}
		if (any) sb.append(']');
		sb.append('}');
	}

	/** `AccessibilityNodeInfoHelper.getVisibleBoundsInScreen` as of API 34+: the node's screen bounds clipped to the display. */
	private Rect visibleBounds(Walk walk, AccessibilityNodeInfo node) {
		Rect r = new Rect();
		node.getBoundsInScreen(r);
		if (walk.width > 0 && walk.height > 0) r.intersect(new Rect(0, 0, walk.width, walk.height));
		return r;
	}

	// ---------- reads helpers ----------

	/** Drop the client-side node cache (`UiAutomation.clearCache`, API 31+) so a read reflects the app now, not the last event. */
	private void clearCache() {
		try {
			ua.clearCache();
		} catch (Throwable ignored) {
			// older images have no cache API; their reads were uncached
		}
	}

	private AccessibilityNodeInfo activeRoot(long waitMs) {
		long deadline = SystemClock.uptimeMillis() + waitMs;
		for (;;) {
			AccessibilityNodeInfo root = ua.getRootInActiveWindow();
			if (root != null || SystemClock.uptimeMillis() >= deadline) return root;
			SystemClock.sleep(25);
		}
	}

	// ---------- settle ----------

	/**
	 * Wait until no significant accessibility event arrived for `quietMs`, counted from the later of the call and the
	 * last injected input. Returns the outcome and the number of events seen while waiting.
	 */
	String settle(long quietMs, long timeoutMs) {
		long start = SystemClock.uptimeMillis();
		long eventsBefore;
		long firstEventMs = -1;
		boolean quiet = false;
		synchronized (eventLock) {
			eventsBefore = eventCount;
			for (;;) {
				long now = SystemClock.uptimeMillis();
				long baseline = Math.max(start, Math.max(lastEventMs, lastInputMs));
				if (firstEventMs < 0 && eventCount > eventsBefore) firstEventMs = lastEventMs - start;
				if (now - baseline >= quietMs) {
					quiet = true;
					break;
				}
				if (now - start >= timeoutMs) break;
				long wait = Math.min(baseline + quietMs - now, start + timeoutMs - now);
				try {
					eventLock.wait(Math.max(1, wait));
				} catch (InterruptedException e) {
					break;
				}
			}
		}
		long waited = SystemClock.uptimeMillis() - start;
		StringBuilder sb = new StringBuilder(96);
		sb.append("{\"quiet\":").append(quiet).append(",\"waitedMs\":").append(waited);
		sb.append(",\"via\":\"events\",\"events\":").append(eventCountSince(eventsBefore));
		if (firstEventMs >= 0) sb.append(",\"firstEventMs\":").append(firstEventMs);
		if (!quiet) sb.append(",\"reason\":\"timeout\"");
		sb.append('}');
		return sb.toString();
	}

	private long eventCountSince(long before) {
		synchronized (eventLock) {
			return eventCount - before;
		}
	}

	// ---------- input ----------

	/** `injectInputEvent(event, sync, waitForAnimations)`: hidden 3-arg overload, absent on older images. */
	private Method injectNoAnimationWait;
	private boolean injectLookedUp;

	/**
	 * The public 2-arg overload also syncs input transactions with window animations (~16-30 ms per event, for
	 * nothing when animations are off, as warden's driver sets them). The hidden 3-arg overload can skip that.
	 */
	private boolean injectOne(android.view.InputEvent event, boolean sync) throws Exception {
		if (!injectLookedUp) {
			injectLookedUp = true;
			try {
				injectNoAnimationWait = UiAutomation.class.getMethod("injectInputEvent", android.view.InputEvent.class, boolean.class, boolean.class);
			} catch (NoSuchMethodException e) {
				injectNoAnimationWait = null;
			}
		}
		if (injectNoAnimationWait != null) {
			try {
				return (Boolean) injectNoAnimationWait.invoke(ua, event, sync, false);
			} catch (InvocationTargetException e) {
				Throwable cause = e.getCause();
				if (cause instanceof Exception) throw (Exception) cause;
				throw e;
			}
		}
		return ua.injectInputEvent(event, sync);
	}

	private void inject(android.view.InputEvent event, boolean sync) throws OpError {
		boolean ok;
		try {
			ok = injectOne(event, sync);
		} catch (Throwable t) {
			throw new OpError("E_HID", "injectInputEvent failed: " + t, false);
		}
		if (!ok) throw new OpError("E_HID", "injectInputEvent refused the event", false);
		lastInputMs = SystemClock.uptimeMillis();
	}

	private MotionEvent motion(long downTime, int action, float x, float y) {
		MotionEvent e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0);
		e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
		return e;
	}

	String tap(float x, float y, int count, long holdMs, long gapMs, boolean sync) throws OpError {
		long downMs = 0;
		long upMs = 0;
		for (int i = 0; i < count; i++) {
			long down = SystemClock.uptimeMillis();
			MotionEvent d = motion(down, MotionEvent.ACTION_DOWN, x, y);
			inject(d, false);
			downMs = SystemClock.uptimeMillis() - down;
			d.recycle();
			if (holdMs > 0) SystemClock.sleep(holdMs);
			long upStart = SystemClock.uptimeMillis();
			MotionEvent u = motion(down, MotionEvent.ACTION_UP, x, y);
			inject(u, sync);
			upMs = SystemClock.uptimeMillis() - upStart;
			u.recycle();
			if (i + 1 < count && gapMs > 0) SystemClock.sleep(gapMs);
		}
		return "{\"downMs\":" + downMs + ",\"upMs\":" + upMs + ",\"via\":" + q(injectNoAnimationWait != null ? "inject3" : "inject2") + "}";
	}

	/** DOWN at the start, hold `pressMs`, `steps` MOVEs over `durationMs`, hold `releaseMs`, UP at the end. */
	String swipe(float x1, float y1, float x2, float y2, long durationMs, int steps, long pressMs, long releaseMs) throws OpError {
		long down = SystemClock.uptimeMillis();
		MotionEvent d = motion(down, MotionEvent.ACTION_DOWN, x1, y1);
		inject(d, false);
		d.recycle();
		if (pressMs > 0) SystemClock.sleep(pressMs);
		int n = Math.max(1, steps);
		for (int i = 1; i <= n; i++) {
			if (durationMs > 0) SystemClock.sleep(Math.max(1, durationMs / n));
			float f = (float) i / n;
			MotionEvent m = motion(down, MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f);
			inject(m, false);
			m.recycle();
		}
		if (releaseMs > 0) SystemClock.sleep(releaseMs);
		MotionEvent u = motion(down, MotionEvent.ACTION_UP, x2, y2);
		inject(u, true);
		u.recycle();
		return "{}";
	}

	String key(int keyCode, int metaState, int times, long gapMs, boolean sync) throws OpError {
		for (int i = 0; i < times; i++) {
			long now = SystemClock.uptimeMillis();
			KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0, metaState);
			down.setSource(InputDevice.SOURCE_KEYBOARD);
			inject(down, false);
			KeyEvent up = new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0, metaState);
			up.setSource(InputDevice.SOURCE_KEYBOARD);
			inject(up, sync);
			if (i + 1 < times && gapMs > 0) SystemClock.sleep(gapMs);
		}
		return "{}";
	}

	/** Replace the text of the focused input (or the node with `resourceId`) with `ACTION_SET_TEXT`; unicode safe. Replies with the text it now holds (empty while the field shows its hint). */
	String setText(String text, String resourceId) throws OpError {
		AccessibilityNodeInfo root = activeRoot(500);
		if (root == null) throw new OpError("E_AX_UNAVAILABLE", "no root node for the active window", true);
		AccessibilityNodeInfo target = null;
		if (resourceId != null && !resourceId.isEmpty()) {
			List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(resourceId);
			if (found != null && !found.isEmpty()) target = found.get(0);
		} else {
			target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
		}
		if (target == null) throw new OpError("E_NO_ELEMENT", "no focused input to set text on", false);
		Bundle args = new Bundle();
		args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
		boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
		lastInputMs = SystemClock.uptimeMillis();
		if (!ok) throw new OpError("E_HID", "ACTION_SET_TEXT was refused by the node", false);
		target.refresh();
		StringBuilder sb = new StringBuilder(64);
		sb.append("{\"text\":");
		Json.str(sb, target.getText() == null || target.isShowingHintText() ? "" : target.getText());
		sb.append('}');
		return sb.toString();
	}

	/** The input-focused node of the active window, fresh (not from the client cache). */
	private AccessibilityNodeInfo focusedInput() throws OpError {
		clearCache();
		AccessibilityNodeInfo root = activeRoot(500);
		if (root == null) throw new OpError("E_AX_UNAVAILABLE", "no root node for the active window", true);
		AccessibilityNodeInfo target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
		if (target == null) throw new OpError("E_NO_ELEMENT", "no focused input", false);
		target.refresh();
		return target;
	}

	/** What the field really holds: a field showing its hint holds nothing; a password field's text is not readable. */
	private static CharSequence heldText(AccessibilityNodeInfo node) throws OpError {
		CharSequence text = node.getText();
		if (text == null || node.isShowingHintText()) return "";
		if (node.isPassword() && text.length() > 0) {
			throw new OpError("E_UNSUPPORTED", "the text of a password field is not readable, so it cannot be edited in place", false);
		}
		return text;
	}

	private boolean setSelection(AccessibilityNodeInfo node, int start, int end) {
		Bundle args = new Bundle();
		args.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start);
		args.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end);
		return node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, args);
	}

	/**
	 * Type `text` at the caret of the focused input, replacing the selection, like a keyboard would: the new text is
	 * `before + text + after` through `ACTION_SET_TEXT` and the caret is put after it. Unicode safe.
	 */
	String typeText(String text) throws OpError {
		AccessibilityNodeInfo target = focusedInput();
		CharSequence held = heldText(target);
		int length = held.length();
		int start = target.getTextSelectionStart();
		int end = target.getTextSelectionEnd();
		if (start < 0 || end < 0) {
			start = length;
			end = length;
		}
		int from = Math.min(Math.min(start, end), length);
		int to = Math.min(Math.max(start, end), length);
		String next = held.subSequence(0, from).toString() + text + held.subSequence(to, length).toString();
		Bundle args = new Bundle();
		args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next);
		boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
		lastInputMs = SystemClock.uptimeMillis();
		if (!ok) throw new OpError("E_HID", "ACTION_SET_TEXT was refused by the node", false);
		int caret = from + text.length();
		boolean placed = setSelection(target, caret, caret);
		lastInputMs = SystemClock.uptimeMillis();
		target.refresh();
		StringBuilder sb = new StringBuilder(next.length() + 64);
		sb.append("{\"text\":");
		Json.str(sb, target.getText() == null || target.isShowingHintText() ? "" : target.getText());
		sb.append(",\"caret\":").append(caret).append(",\"caretPlaced\":").append(placed).append('}');
		return sb.toString();
	}

	/** Select the whole text of the focused input (`ACTION_SET_SELECTION`), so the next key or text replaces it. */
	String selectAll() throws OpError {
		AccessibilityNodeInfo target = focusedInput();
		int length = heldText(target).length();
		boolean ok = setSelection(target, 0, length);
		lastInputMs = SystemClock.uptimeMillis();
		if (!ok) throw new OpError("E_HID", "ACTION_SET_SELECTION was refused by the node", false);
		return "{\"length\":" + length + "}";
	}

	/** PNG as base64 (`UiAutomation.takeScreenshot`); a host `screencap` is the fallback. */
	String screenshot() throws OpError {
		long t0 = SystemClock.uptimeMillis();
		Bitmap bitmap = ua.takeScreenshot();
		if (bitmap == null) throw new OpError("E_IO", "takeScreenshot returned null", true);
		long grabbed = SystemClock.uptimeMillis();
		ByteArrayOutputStream out = new ByteArrayOutputStream(512 * 1024);
		bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
		long encoded = SystemClock.uptimeMillis();
		StringBuilder sb = new StringBuilder(out.size() * 4 / 3 + 128);
		sb.append("{\"width\":").append(bitmap.getWidth()).append(",\"height\":").append(bitmap.getHeight());
		sb.append(",\"grabMs\":").append(grabbed - t0).append(",\"encodeMs\":").append(encoded - grabbed);
		sb.append(",\"png\":\"").append(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)).append("\"}");
		return sb.toString();
	}
}
