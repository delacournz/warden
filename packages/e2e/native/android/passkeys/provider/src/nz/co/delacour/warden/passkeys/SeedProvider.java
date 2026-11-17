package nz.co.delacour.warden.passkeys;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * `adb shell content call --uri content://nz.co.delacour.warden.passkeys --method <m> [--arg <a>] [--extra json:s:<j>]`.
 * Methods: setMode (extras mode = auto|cancel|fail|unavailable|off, uv = match|nomatch|skip), add (extra b64 = base64 of the
 * record JSON, or json), remove (arg = credentialId), clear, list. Result: `result` = the whole store JSON, or `error`.
 * Access: manifest `android:permission="android.permission.DUMP"` (shell holds it, third-party apps cannot) plus a uid check.
 */
public final class SeedProvider extends ContentProvider {
	private static final int SHELL_UID = 2000;

	@Override public boolean onCreate() { return true; }

	@Override
	public Bundle call(String method, String arg, Bundle extras) {
		int uid = Binder.getCallingUid();
		Bundle out = new Bundle();
		if (uid != SHELL_UID && uid != 0 && uid != android.os.Process.myUid()) {
			out.putString("error", "E_PERMISSION uid=" + uid);
			return out;
		}
		try {
			JSONObject store = Authenticator.load(getContext());
			JSONArray creds = store.getJSONArray("credentials");
			switch (method) {
				case "setMode":
					String mode = extras == null ? null : extras.getString("mode");
					String uv = extras == null ? null : extras.getString("uv");
					if (mode != null && !java.util.Arrays.asList("auto", "cancel", "fail", "unavailable", "off").contains(mode)) { out.putString("error", "E_MODE " + mode); return out; }
					if (uv != null && !java.util.Arrays.asList("match", "nomatch", "skip").contains(uv)) { out.putString("error", "E_UV " + uv); return out; }
					if (mode != null) store.put("mode", mode);
					if (uv != null) store.put("uv", uv);
					Authenticator.save(getContext(), store);
					break;
				case "add":
					// `json` can be mangled by the device shell's quote handling: prefer `b64` (std base64 of the JSON).
					String raw = extras.getString("b64") != null
						? new String(android.util.Base64.decode(extras.getString("b64"), android.util.Base64.DEFAULT), java.nio.charset.StandardCharsets.UTF_8)
						: extras.getString("json");
					JSONObject added = new JSONObject(raw);
					JSONArray next = new JSONArray();
					for (int i = 0; i < creds.length(); i++) if (!creds.getJSONObject(i).getString("credentialId").equals(added.getString("credentialId"))) next.put(creds.getJSONObject(i));
					next.put(added);
					store.put("credentials", next);
					Authenticator.save(getContext(), store);
					break;
				case "remove": {
					JSONArray keep = new JSONArray();
					for (int i = 0; i < creds.length(); i++) if (!creds.getJSONObject(i).getString("credentialId").equals(arg)) keep.put(creds.getJSONObject(i));
					store.put("credentials", keep);
					Authenticator.save(getContext(), store);
					break;
				}
				case "clear":
					store.put("credentials", new JSONArray());
					Authenticator.save(getContext(), store);
					break;
				case "list":
					break;
				default:
					out.putString("error", "E_METHOD " + method);
					return out;
			}
			out.putString("result", store.toString());
		} catch (Exception e) {
			out.putString("error", String.valueOf(e));
		}
		return out;
	}

	@Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
	@Override public String getType(Uri u) { return null; }
	@Override public Uri insert(Uri u, ContentValues v) { return null; }
	@Override public int delete(Uri u, String s, String[] a) { return 0; }
	@Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
