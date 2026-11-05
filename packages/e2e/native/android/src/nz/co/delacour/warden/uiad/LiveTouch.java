package nz.co.delacour.warden.uiad;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;

/**
 * Live touch (plan WDN-STRM, STRM-6): `touch.down|move|up{x,y,pointer?}` and `touch.cancel`, a viewer's finger
 * streamed as it moves. Each op injects one MotionEvent at once: the first finger is ACTION_DOWN, a second
 * ACTION_POINTER_DOWN, a move ACTION_MOVE with every finger (sync=false), a lift ACTION_POINTER_UP or ACTION_UP,
 * cancel ACTION_CANCEL. One down time per gesture (first finger down to last finger up). Pointer ids are the pointer
 * numbers (0, 1). Coordinates are display pixels in the current rotation, like `tap`.
 *
 * A move/up on a pointer that is not down, or a down on one that is, is E_BAD_REQUEST. A finger with no down/move for
 * 10 s is lifted by a watchdog thread, so a lost up never leaves it stuck. Ops run on the protocol thread and the
 * watchdog on its own, so every method is synchronized.
 */
final class LiveTouch {
	interface Injector {
		void inject(MotionEvent event, boolean sync) throws Uia.OpError;
	}

	static final long STALE_MS = 10000;
	private static final long WATCH_MS = 1000;

	private final Injector injector;
	/** per pointer 0/1: held, position, when last put down or moved */
	private final boolean[] held = new boolean[2];
	private final float[][] at = new float[2][2];
	private final long[] lastMs = new long[2];
	private long downTime;
	private Thread watchdog;

	LiveTouch(Injector injector) {
		this.injector = injector;
	}

	private static Uia.OpError bad(String message, String reason) {
		return new Uia.OpError("E_BAD_REQUEST", message + " (" + reason + ")", false);
	}

	static int pointer(int raw) throws Uia.OpError {
		if (raw != 0 && raw != 1) throw bad("\"pointer\" must be 0 or 1", "bad_pointer");
		return raw;
	}

	private int count() {
		return (held[0] ? 1 : 0) + (held[1] ? 1 : 0);
	}

	/** Index of `pointer` among the held pointers (ascending id), as MotionEvent orders them. */
	private int indexOf(int pointer) {
		return pointer == 1 && held[0] ? 1 : 0;
	}

	private MotionEvent event(long eventTime, int action) {
		int n = count();
		MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[n];
		MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[n];
		int i = 0;
		for (int p = 0; p < 2; p++) {
			if (!held[p]) continue;
			props[i] = new MotionEvent.PointerProperties();
			props[i].id = p;
			props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
			coords[i] = new MotionEvent.PointerCoords();
			coords[i].x = at[p][0];
			coords[i].y = at[p][1];
			coords[i].pressure = 1f;
			coords[i].size = 1f;
			i++;
		}
		return MotionEvent.obtain(downTime, eventTime, action, n, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
	}

	private void send(int action, boolean sync) throws Uia.OpError {
		MotionEvent e = event(SystemClock.uptimeMillis(), action);
		try {
			injector.inject(e, sync);
		} finally {
			e.recycle();
		}
	}

	private String reply() {
		return "{\"down\":" + count() + "}";
	}

	synchronized String down(int pointer, float x, float y) throws Uia.OpError {
		if (held[pointer]) throw bad("pointer " + pointer + " is already down (touch.up or touch.cancel first)", "already_down");
		boolean first = count() == 0;
		long now = SystemClock.uptimeMillis();
		if (first) downTime = now;
		held[pointer] = true;
		at[pointer][0] = x;
		at[pointer][1] = y;
		lastMs[pointer] = now;
		try {
			send(first ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_POINTER_DOWN | (indexOf(pointer) << MotionEvent.ACTION_POINTER_INDEX_SHIFT), false);
		} catch (Uia.OpError e) {
			held[pointer] = false;
			throw e;
		}
		armWatchdog();
		return reply();
	}

	synchronized String move(int pointer, float x, float y) throws Uia.OpError {
		if (!held[pointer]) throw bad("pointer " + pointer + " is not down (touch.down first)", "not_down");
		at[pointer][0] = x;
		at[pointer][1] = y;
		lastMs[pointer] = SystemClock.uptimeMillis();
		send(MotionEvent.ACTION_MOVE, false);
		return reply();
	}

	/** `hasPoint` false lifts where the finger last was. */
	synchronized String up(int pointer, boolean hasPoint, float x, float y) throws Uia.OpError {
		if (!held[pointer]) throw bad("pointer " + pointer + " is not down (touch.down first)", "not_down");
		lift(pointer, hasPoint, x, y);
		return reply();
	}

	private void lift(int pointer, boolean hasPoint, float x, float y) throws Uia.OpError {
		if (hasPoint) {
			at[pointer][0] = x;
			at[pointer][1] = y;
		}
		boolean last = count() == 1;
		try {
			send(last ? MotionEvent.ACTION_UP : MotionEvent.ACTION_POINTER_UP | (indexOf(pointer) << MotionEvent.ACTION_POINTER_INDEX_SHIFT), last);
		} finally {
			held[pointer] = false;
		}
	}

	/** ACTION_CANCEL for every held finger, then nothing is held. */
	synchronized String cancel() throws Uia.OpError {
		int released = count();
		try {
			if (released > 0) send(MotionEvent.ACTION_CANCEL, true);
		} finally {
			held[0] = false;
			held[1] = false;
		}
		return "{\"down\":0,\"released\":" + released + "}";
	}

	/** Lifts each finger untouched for STALE_MS; answers how many. */
	synchronized int expire(long now) {
		int stale = 0;
		for (int p = 0; p < 2; p++) {
			if (held[p] && now - lastMs[p] >= STALE_MS) stale++;
		}
		if (stale == 0) return 0;
		try {
			if (stale == count()) {
				cancel();
			} else {
				for (int p = 0; p < 2; p++) {
					if (held[p] && now - lastMs[p] >= STALE_MS) lift(p, false, 0, 0);
				}
			}
			Main.log("warn", "touch: released " + stale + " finger(s) after " + STALE_MS + " ms with no move");
		} catch (Uia.OpError e) {
			Main.log("warn", "touch: releasing a stale finger failed: " + e.getMessage());
		}
		return stale;
	}

	private void armWatchdog() {
		if (watchdog != null) return;
		watchdog = new Thread(new Runnable() {
			@Override
			public void run() {
				while (true) {
					SystemClock.sleep(WATCH_MS);
					synchronized (LiveTouch.this) {
						expire(SystemClock.uptimeMillis());
						if (count() == 0) {
							watchdog = null;
							return;
						}
					}
				}
			}
		}, "warden-uiad-touch");
		watchdog.setDaemon(true);
		watchdog.start();
	}
}
