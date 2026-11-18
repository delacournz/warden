package nz.co.delacour.warden.passkeys.caller;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.util.Log;
import android.widget.TextView;
import androidx.credentials.CreateCredentialRequest;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Test caller. `am start -n .../.CallerActivity --es op create|get --es rp example.com [--es user alice]
 * [--es excl <credId>] [--es allow <credId>] [--ez auto true]`. Result goes to logcat (tag WPKC) and the TextView.
 */
public final class CallerActivity extends Activity {
	private TextView view;

	@Override
	protected void onCreate(Bundle b) {
		super.onCreate(b);
		view = new TextView(this);
		view.setContentDescription("result");
		view.setText("idle");
		setContentView(view);
		run(getIntent());
	}

	@Override
	protected void onNewIntent(Intent i) {
		super.onNewIntent(i);
		run(i);
	}

	private void show(String s) {
		Log.i("WPKC", s);
		runOnUiThread(() -> view.setText(s));
	}

	private void run(Intent in) {
		String op = in.getStringExtra("op");
		if (op == null) return;
		String rp = in.getStringExtra("rp") == null ? "example.com" : in.getStringExtra("rp");
		if ("seed".equals(op)) {
			try {
				android.os.Bundle r = getContentResolver().call(android.net.Uri.parse("content://nz.co.delacour.warden.passkeys"), "list", null, null);
				show("SEED result " + r);
			} catch (Throwable t) { show("SEED error " + t); }
			return;
		}
		String challenge = "Y2hhbGxlbmdlLWNoYWxsZW5nZS0xMjM0";
		try {
			show("start " + op);
			CredentialManager cm = CredentialManager.Companion.create(this);
			if ("create".equals(op)) {
				JSONObject j = new JSONObject()
					.put("rp", new JSONObject().put("id", rp).put("name", "Example"))
					.put("user", new JSONObject().put("id", "dXNlci1oYW5kbGU").put("name", in.getStringExtra("user") == null ? "alice" : in.getStringExtra("user")).put("displayName", "Alice"))
					.put("challenge", challenge)
					.put("pubKeyCredParams", new JSONArray().put(new JSONObject().put("type", "public-key").put("alg", -7)))
					.put("authenticatorSelection", new JSONObject().put("residentKey", "required").put("userVerification", "required"))
					.put("attestation", "none").put("timeout", 60000);
				if (in.getStringExtra("excl") != null) j.put("excludeCredentials", new JSONArray().put(new JSONObject().put("type", "public-key").put("id", in.getStringExtra("excl"))));
				cm.createCredentialAsync(this, new CreatePublicKeyCredentialRequest(j.toString()), new CancellationSignal(), getMainExecutor(),
					new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
						public void onResult(CreateCredentialResponse r) { show("RESULT create ok " + r.getData().getString("androidx.credentials.BUNDLE_KEY_REGISTRATION_RESPONSE_JSON")); }
						public void onError(CreateCredentialException e) { show("ERROR create " + e.getClass().getName() + " type=" + e.getType() + " msg=" + e.getMessage()); }
					});
			} else {
				JSONObject j = new JSONObject().put("rpId", rp).put("challenge", challenge).put("userVerification", "required").put("timeout", 60000);
				if (in.getStringExtra("allow") != null) j.put("allowCredentials", new JSONArray().put(new JSONObject().put("type", "public-key").put("id", in.getStringExtra("allow"))));
				GetCredentialRequest req = new GetCredentialRequest.Builder().addCredentialOption(new GetPublicKeyCredentialOption(j.toString())).build();
				cm.getCredentialAsync(this, req, new CancellationSignal(), getMainExecutor(),
					new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
						public void onResult(GetCredentialResponse r) { Credential c = r.getCredential(); show("RESULT get ok " + c.getData().getString("androidx.credentials.BUNDLE_KEY_AUTHENTICATION_RESPONSE_JSON")); }
						public void onError(GetCredentialException e) { show("ERROR get " + e.getClass().getName() + " type=" + e.getType() + " msg=" + e.getMessage()); }
					});
			}
		} catch (Throwable t) {
			show("ERROR thrown " + t);
		}
	}
}
