package nz.co.delacour.warden.uiad;

import android.os.Build;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayDeque;

/**
 * Announcements and live-region changes the accessibility event stream carries, kept in a ring buffer so a host can
 * ask "what was announced since cursor N". No screen reader is needed: UiAutomation receives the events either way.
 * Fed from {@link Uia}'s event listener (this class never replaces it, so settle's event stream is untouched).
 */
final class A11yEvents {
	static final int CAPACITY = 200;
	/** `AccessibilityEvent.CONTENT_CHANGE_TYPE_TEXT` (API 19) */
	private static final int CONTENT_CHANGE_TEXT = 0x2;
	/** how far up from the changed node a live region is looked for */
	private static final int LIVE_REGION_DEPTH = 8;

	private static final class Entry {
		final long seq;
		final String kind;
		final String text;
		final long at;

		Entry(long seq, String kind, String text, long at) {
			this.seq = seq;
			this.kind = kind;
			this.text = text;
			this.at = at;
		}
	}

	private final ArrayDeque<Entry> buffer = new ArrayDeque<Entry>();
	private long cursor = 0;

	/** Look at one event; buffers it when it is an announcement or a live-region text change. */
	void onEvent(AccessibilityEvent event) {
		try {
			int type = event.getEventType();
			if (type == AccessibilityEvent.TYPE_ANNOUNCEMENT) {
				String text = join(event.getText());
				if (text.isEmpty() && event.getContentDescription() != null) text = event.getContentDescription().toString();
				add("announcement", text);
			} else if (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED && (event.getContentChangeTypes() & CONTENT_CHANGE_TEXT) != 0) {
				liveRegion(event);
			}
		} catch (Throwable t) {
			Main.log("debug", "a11y event skipped: " + t);
		}
	}

	private void liveRegion(AccessibilityEvent event) {
		AccessibilityNodeInfo source = event.getSource();
		if (source == null) return;
		AccessibilityNodeInfo node = source;
		boolean live = false;
		for (int depth = 0; node != null && depth < LIVE_REGION_DEPTH; depth++) {
			if (node.getLiveRegion() != 0) {
				live = true;
				break;
			}
			node = node.getParent();
		}
		if (!live) return;
		String text = firstNonEmpty(source.getText(), source.getContentDescription());
		if (text.isEmpty()) text = join(event.getText());
		if (text.isEmpty() && node != null) text = firstNonEmpty(node.getText(), node.getContentDescription());
		add("live-region", text);
	}

	private static String firstNonEmpty(CharSequence a, CharSequence b) {
		if (a != null && a.length() > 0) return a.toString();
		if (b != null && b.length() > 0) return b.toString();
		return "";
	}

	private static String join(java.util.List<CharSequence> parts) {
		StringBuilder sb = new StringBuilder();
		if (parts == null) return "";
		for (CharSequence part : parts) {
			if (part == null || part.length() == 0) continue;
			if (sb.length() > 0) sb.append(' ');
			sb.append(part);
		}
		return sb.toString();
	}

	synchronized void add(String kind, String text) {
		if (text == null || text.isEmpty()) return;
		cursor++;
		buffer.addLast(new Entry(cursor, kind, text, System.currentTimeMillis()));
		while (buffer.size() > CAPACITY) buffer.removeFirst();
	}

	/**
	 * `{events:[{kind,text,at}], cursor, lost?}`: events after `since` (0 = from the start); `cursor` is the value to
	 * pass next time; `lost` is true when the ring overwrote events the caller never saw.
	 */
	synchronized String json(long since) {
		StringBuilder sb = new StringBuilder("{\"events\":[");
		boolean firstEvent = true;
		long oldest = buffer.isEmpty() ? cursor + 1 : buffer.peekFirst().seq;
		for (Entry e : buffer) {
			if (e.seq <= since) continue;
			if (!firstEvent) sb.append(',');
			firstEvent = false;
			sb.append("{\"kind\":");
			Json.str(sb, e.kind);
			sb.append(",\"text\":");
			Json.str(sb, e.text);
			sb.append(",\"at\":").append(e.at).append('}');
		}
		sb.append("],\"cursor\":").append(cursor);
		if (since + 1 < oldest && cursor > since) sb.append(",\"lost\":true");
		sb.append('}');
		return sb.toString();
	}
}
