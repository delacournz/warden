package nz.co.delacour.warden.passkeys;

import android.content.Context;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Software ES256 authenticator + the provider's own JSON store (`{mode, uv, credentials}`, credential records in the
 * shape of `passkey-store.ts`: binary fields base64url, `privateKey` a PKCS#8 P-256 key).
 */
final class Authenticator {
	static final byte[] AAGUID = new byte[] {
		(byte) 0x77, 0x61, 0x72, 0x64, 0x65, 0x6e, 0x2d, 0x70, 0x61, 0x73, 0x73, 0x6b, 0x65, 0x79, 0x00, 0x01
	}; // "warden-passkey\0\1"
	private static final Object LOCK = new Object();

	private Authenticator() {}

	static String b64(byte[] b) {
		return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
	}

	static byte[] unb64(String s) {
		return Base64.decode(s, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
	}

	static byte[] sha256(byte[] in) {
		try {
			return MessageDigest.getInstance("SHA-256").digest(in);
		} catch (Exception e) {
			throw new IllegalStateException(e);
		}
	}

	// ---- store -------------------------------------------------------------------------------------------------

	private static File file(Context c) {
		return new File(c.getFilesDir(), "store.json");
	}

	static JSONObject load(Context c) {
		synchronized (LOCK) {
			try {
				File f = file(c);
				if (!f.exists()) return fresh();
				byte[] data = java.nio.file.Files.readAllBytes(f.toPath());
				return new JSONObject(new String(data, StandardCharsets.UTF_8));
			} catch (Exception e) {
				return fresh();
			}
		}
	}

	private static JSONObject fresh() {
		try {
			return new JSONObject().put("mode", "auto").put("uv", "match").put("credentials", new JSONArray());
		} catch (JSONException e) {
			throw new IllegalStateException(e);
		}
	}

	static void save(Context c, JSONObject store) {
		synchronized (LOCK) {
			try {
				File tmp = new File(c.getFilesDir(), "store.json.tmp");
				try (FileOutputStream out = new FileOutputStream(tmp)) {
					out.write(store.toString().getBytes(StandardCharsets.UTF_8));
				}
				if (!tmp.renameTo(file(c))) throw new IllegalStateException("rename failed");
			} catch (Exception e) {
				throw new IllegalStateException(e);
			}
		}
	}

	// ---- CBOR (maps, byte/text strings, ints only) -----------------------------------------------------------------

	static final class Cbor {
		final ByteArrayOutputStream out = new ByteArrayOutputStream();

		private void head(int major, long v) {
			int m = major << 5;
			if (v < 24) out.write(m | (int) v);
			else if (v < 256) { out.write(m | 24); out.write((int) v); }
			else if (v < 65536) { out.write(m | 25); out.write((int) (v >> 8)); out.write((int) v); }
			else { out.write(m | 26); for (int s = 24; s >= 0; s -= 8) out.write((int) (v >> s)); }
		}

		Cbor map(int n) { head(5, n); return this; }
		Cbor num(long v) { if (v >= 0) head(0, v); else head(1, -1 - v); return this; }
		Cbor text(String s) { byte[] b = s.getBytes(StandardCharsets.UTF_8); head(3, b.length); out.write(b, 0, b.length); return this; }
		Cbor bytes(byte[] b) { head(2, b.length); out.write(b, 0, b.length); return this; }
		byte[] done() { return out.toByteArray(); }
	}

	private static byte[] fixed32(BigInteger n) {
		byte[] raw = n.toByteArray();
		byte[] out = new byte[32];
		int len = Math.min(raw.length, 32);
		System.arraycopy(raw, raw.length - len, out, 32 - len, len);
		return out;
	}

	private static int flags(String uv, boolean attested) {
		int f = 0x01 | 0x08 | 0x10; // UP | BE | BS
		if (!"skip".equals(uv)) f |= 0x04; // UV
		if (attested) f |= 0x40; // AT
		return f;
	}

	// ---- operations ------------------------------------------------------------------------------------------

	static String clientData(String type, String challenge, String origin, String pkg) throws JSONException {
		return new JSONObject().put("type", type).put("challenge", challenge).put("origin", origin)
			.put("crossOrigin", false).put("androidPackageName", pkg).toString();
	}

	/** Registers a credential in the store and returns the WebAuthn JSON RegistrationResponse. */
	static String register(Context c, JSONObject store, JSONObject req, String origin, String pkg, byte[] givenHash) throws Exception {
		String rpId = req.getJSONObject("rp").getString("id");
		JSONObject user = req.getJSONObject("user");
		String uv = store.optString("uv", "match");
		byte[] credId = new byte[16];
		new SecureRandom().nextBytes(credId);
		KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
		g.initialize(new ECGenParameterSpec("secp256r1"));
		KeyPair kp = g.generateKeyPair();
		ECPublicKey pub = (ECPublicKey) kp.getPublic();
		byte[] x = fixed32(pub.getW().getAffineX());
		byte[] y = fixed32(pub.getW().getAffineY());
		byte[] cose = new Cbor().map(5).num(1).num(2).num(3).num(-7).num(-1).num(1).num(-2).bytes(x).num(-3).bytes(y).done();
		ByteArrayOutputStream ad = new ByteArrayOutputStream();
		ad.write(sha256(rpId.getBytes(StandardCharsets.UTF_8)));
		ad.write(flags(uv, true));
		ad.write(new byte[4]);
		ad.write(AAGUID);
		ad.write(new byte[] {(byte) (credId.length >> 8), (byte) credId.length});
		ad.write(credId);
		ad.write(cose);
		byte[] authData = ad.toByteArray();
		byte[] attObj = new Cbor().map(3).text("fmt").text("none").text("attStmt").map(0).text("authData").bytes(authData).done();
		// a privileged caller (browser) builds clientDataJSON itself and hands over its hash: nothing to put in the response
		String cd = givenHash == null ? clientData("webauthn.create", req.getString("challenge"), origin, pkg) : "";

		JSONObject rec = new JSONObject()
			.put("credentialId", b64(credId)).put("rpId", rpId).put("userHandle", user.getString("id"))
			.put("userName", user.optString("name")).put("displayName", user.optString("displayName"))
			.put("privateKey", b64(kp.getPrivate().getEncoded()))
			.put("signCount", 0).put("createdAt", System.currentTimeMillis())
			.put("backupEligible", true).put("backupState", true);
		store.getJSONArray("credentials").put(rec);
		save(c, store);

		JSONObject resp = new JSONObject()
			.put("clientDataJSON", b64(cd.getBytes(StandardCharsets.UTF_8)))
			.put("attestationObject", b64(attObj))
			.put("transports", new JSONArray().put("internal"))
			.put("authenticatorData", b64(authData))
			.put("publicKeyAlgorithm", -7)
			.put("publicKey", b64(pub.getEncoded()));
		return new JSONObject().put("id", b64(credId)).put("rawId", b64(credId)).put("type", "public-key")
			.put("authenticatorAttachment", "platform").put("response", resp)
			.put("clientExtensionResults", new JSONObject()).toString();
	}

	/** ES256 (-7) must be among the offered algorithms; an absent list means "any" (WebAuthn default). */
	static boolean supportsEs256(JSONObject req) {
		JSONArray params = req.optJSONArray("pubKeyCredParams");
		if (params == null || params.length() == 0) return true;
		for (int i = 0; i < params.length(); i++) if (params.optJSONObject(i) != null && params.optJSONObject(i).optInt("alg") == -7) return true;
		return false;
	}

	static boolean excluded(JSONObject store, JSONObject req, String rpId) throws JSONException {
		JSONArray ex = req.optJSONArray("excludeCredentials");
		if (ex == null) return false;
		JSONArray creds = store.getJSONArray("credentials");
		for (int i = 0; i < ex.length(); i++) {
			String id = ex.getJSONObject(i).getString("id");
			for (int j = 0; j < creds.length(); j++) {
				JSONObject cr = creds.getJSONObject(j);
				if (cr.getString("rpId").equals(rpId) && cr.getString("credentialId").equals(id)) return true;
			}
		}
		return false;
	}

	/** Credentials usable for a get request (rpId match, allowCredentials filter), newest first. */
	static java.util.List<JSONObject> matching(JSONObject store, JSONObject req) throws JSONException {
		String rpId = req.optString("rpId", null);
		JSONArray allow = req.optJSONArray("allowCredentials");
		java.util.ArrayList<JSONObject> out = new java.util.ArrayList<>();
		JSONArray creds = store.getJSONArray("credentials");
		for (int i = 0; i < creds.length(); i++) {
			JSONObject cr = creds.getJSONObject(i);
			if (rpId != null && !cr.getString("rpId").equals(rpId)) continue;
			if (allow != null && allow.length() > 0) {
				boolean ok = false;
				for (int j = 0; j < allow.length(); j++) if (allow.getJSONObject(j).getString("id").equals(cr.getString("credentialId"))) ok = true;
				if (!ok) continue;
			}
			out.add(cr);
		}
		java.util.Collections.sort(out, (a, b) -> Long.compare(b.optLong("createdAt"), a.optLong("createdAt")));
		return out;
	}

	/** Signs an assertion with `cred` and returns the WebAuthn JSON AuthenticationResponse. */
	static String assertion(JSONObject store, JSONObject cred, JSONObject req, String origin, String pkg, byte[] givenHash) throws Exception {
		String uv = store.optString("uv", "match");
		byte[] credId = unb64(cred.getString("credentialId"));
		ByteArrayOutputStream ad = new ByteArrayOutputStream();
		ad.write(sha256(cred.getString("rpId").getBytes(StandardCharsets.UTF_8)));
		ad.write(flags(uv, false));
		ad.write(new byte[4]);
		byte[] authData = ad.toByteArray();
		byte[] cdBytes = givenHash == null
			? clientData("webauthn.get", req.getString("challenge"), origin, pkg).getBytes(StandardCharsets.UTF_8)
			: new byte[0];
		ByteArrayOutputStream msg = new ByteArrayOutputStream();
		msg.write(authData);
		msg.write(givenHash != null ? givenHash : sha256(cdBytes));
		PrivateKey pk = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(unb64(cred.getString("privateKey"))));
		Signature s = Signature.getInstance("SHA256withECDSA");
		s.initSign(pk);
		s.update(msg.toByteArray());
		byte[] sig = s.sign();
		JSONObject resp = new JSONObject()
			.put("clientDataJSON", b64(cdBytes)).put("authenticatorData", b64(authData))
			.put("signature", b64(sig)).put("userHandle", cred.getString("userHandle"));
		return new JSONObject().put("id", b64(credId)).put("rawId", b64(credId)).put("type", "public-key")
			.put("authenticatorAttachment", "platform").put("response", resp)
			.put("clientExtensionResults", new JSONObject()).toString();
	}
}
