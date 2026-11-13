package nz.co.delacour.warden.uiad;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import dalvik.system.DexClassLoader;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * The `audit` op's loader: `warden-atf.jar` (the Accessibility Test Framework, shrunk, pushed by the host on the first
 * audit only) is opened with a DexClassLoader and its entry class called by reflection, so this dex never links the
 * framework and stays small. The framework wants a Context for display metrics and string resources; a shell-uid
 * process has none, so the system context is taken from `ActivityThread.systemMain()` once.
 */
final class Atf {
	private static final String ENTRY = "nz.co.delacour.warden.atf.AtfAudit";

	private static String loadedPath;
	private static Method run;
	private static Context context;

	private Atf() {}

	private static synchronized Context systemContext() throws Exception {
		if (context != null) return context;
		// ActivityThread builds a Handler for the calling thread
		if (Looper.myLooper() == null) Looper.prepare();
		Class<?> thread = Class.forName("android.app.ActivityThread");
		Object at = thread.getMethod("systemMain").invoke(null);
		context = (Context) thread.getMethod("getSystemContext").invoke(at);
		return context;
	}

	private static synchronized Method entry(String path) throws Exception {
		if (run != null && path.equals(loadedPath)) return run;
		DexClassLoader loader = new DexClassLoader(path, null, null, Atf.class.getClassLoader());
		run = loader.loadClass(ENTRY).getMethod("run", AccessibilityNodeInfo.class, Bitmap.class, Context.class);
		loadedPath = path;
		return run;
	}

	/** `Outer: message <- Inner: message`, so a failure inside the framework names its root cause. */
	private static String chain(Throwable t) {
		StringBuilder sb = new StringBuilder();
		for (int depth = 0; t != null && depth < 5; depth++, t = t.getCause()) {
			if (depth > 0) sb.append(" <- ");
			sb.append(t);
		}
		return sb.toString();
	}

	/** The JSON text `AtfAudit.run` returns for the tree under `root`. */
	static String run(String path, AccessibilityNodeInfo root, Bitmap screenshot) throws Uia.OpError {
		try {
			Method m = entry(path);
			return (String) m.invoke(null, root, screenshot, systemContext());
		} catch (InvocationTargetException e) {
			throw new Uia.OpError("E_INTERNAL", "ATF audit failed: " + chain(e.getCause() == null ? e : e.getCause()), false);
		} catch (ClassNotFoundException e) {
			throw new Uia.OpError("E_UNSUPPORTED", "ATF entry class not found in " + path, false);
		} catch (Throwable t) {
			throw new Uia.OpError("E_INTERNAL", "ATF audit could not start: " + t, false);
		}
	}
}
