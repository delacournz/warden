package nz.co.delacour.warden.atf;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityCheckPreset;
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityCheckResult.AccessibilityCheckResultType;
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityHierarchyCheck;
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityHierarchyCheckResult;
import com.google.android.apps.common.testing.accessibility.framework.Parameters;
import com.google.android.apps.common.testing.accessibility.framework.replacements.Rect;
import com.google.android.apps.common.testing.accessibility.framework.uielement.AccessibilityHierarchyAndroid;
import com.google.android.apps.common.testing.accessibility.framework.uielement.ViewHierarchyElement;
import com.google.android.apps.common.testing.accessibility.framework.utils.contrast.BitmapImage;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The part of `warden-atf` that touches the Accessibility Test Framework: loaded by `warden-uiad` through a
 * DexClassLoader on the first `audit` op, called by reflection (`run`). Everything it returns is one JSON string, so
 * the two dexes share no types besides the framework's own.
 */
public final class AtfAudit {
	private AtfAudit() {}

	/**
	 * Run the preset's hierarchy checks on the tree under `root`. `screenshot` (nullable) lets the contrast checks
	 * read pixels. Results of type ERROR / WARNING / INFO are returned; RESOLVED / NOT_RUN / SUPPRESSED are counted only.
	 */
	public static String run(AccessibilityNodeInfo root, Bitmap screenshot, Context context) throws Exception {
		long t0 = SystemClock.uptimeMillis();
		AccessibilityHierarchyAndroid hierarchy = AccessibilityHierarchyAndroid.newBuilder(root, context).build();
		long built = SystemClock.uptimeMillis();
		Parameters parameters = new Parameters();
		if (screenshot != null) parameters.putScreenCapture(new BitmapImage(screenshot));
		JSONArray results = new JSONArray();
		int checks = 0;
		int ignored = 0;
		JSONArray failed = new JSONArray();
		for (AccessibilityHierarchyCheck check : AccessibilityCheckPreset.getAccessibilityHierarchyChecksForPreset(AccessibilityCheckPreset.LATEST)) {
			checks++;
			List<AccessibilityHierarchyCheckResult> found;
			try {
				found = check.runCheckOnHierarchy(hierarchy, null, parameters);
			} catch (Throwable t) {
				// one check that cannot run on this screen must not lose the others
				failed.put(check.getClass().getSimpleName() + ": " + t);
				continue;
			}
			for (AccessibilityHierarchyCheckResult result : found) {
				AccessibilityCheckResultType type = result.getType();
				if (type != AccessibilityCheckResultType.ERROR && type != AccessibilityCheckResultType.WARNING && type != AccessibilityCheckResultType.INFO) {
					ignored++;
					continue;
				}
				results.put(one(check, result, type));
			}
		}
		long done = SystemClock.uptimeMillis();
		JSONObject out = new JSONObject();
		out.put("checks", checks);
		out.put("ignored", ignored);
		out.put("contrast", screenshot != null);
		out.put("hierarchyMs", built - t0);
		out.put("checksMs", done - built);
		out.put("failedChecks", failed);
		out.put("results", results);
		return out.toString();
	}

	private static JSONObject one(AccessibilityHierarchyCheck check, AccessibilityHierarchyCheckResult result, AccessibilityCheckResultType type) throws Exception {
		JSONObject o = new JSONObject();
		o.put("check", check.getClass().getSimpleName());
		o.put("type", type.name());
		o.put("resultId", result.getResultId());
		ViewHierarchyElement element = result.getElement();
		if (element != null) {
			put(o, "resourceName", element.getResourceName());
			put(o, "className", element.getClassName());
			put(o, "text", element.getText());
			put(o, "contentDescription", element.getContentDescription());
			Rect b = element.getBoundsInScreen();
			if (b != null) o.put("bounds", new JSONArray().put(b.getLeft()).put(b.getTop()).put(b.getRight()).put(b.getBottom()));
		}
		try {
			// needs the framework's string resources (strings.xml in the jar); warden words its own text when absent
			put(o, "message", result.getMessage(Locale.ENGLISH));
		} catch (Throwable t) {
			o.put("messageError", t.getClass().getSimpleName());
		}
		return o;
	}

	private static void put(JSONObject o, String key, Object value) throws Exception {
		if (value == null) return;
		String s = value.toString();
		if (s.isEmpty()) return;
		o.put(key, s);
	}
}
