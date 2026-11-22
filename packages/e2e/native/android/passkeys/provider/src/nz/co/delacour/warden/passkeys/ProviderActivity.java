package nz.co.delacour.warden.passkeys;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.Signature;
import android.os.Bundle;
import android.util.Log;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.domerrors.InvalidStateError;
import androidx.credentials.exceptions.domerrors.NotAllowedError;
import androidx.credentials.exceptions.domerrors.NotSupportedError;
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException;
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException;
import androidx.credentials.provider.CallingAppInfo;
import androidx.credentials.provider.PendingIntentHandler;
import androidx.credentials.provider.ProviderCreateCredentialRequest;
import androidx.credentials.provider.ProviderGetCredentialRequest;
import org.json.JSONObject;

/** No-UI trampoline: completes the selected entry according to the store's mode, then finishes. */
public final class ProviderActivity extends Activity {
	/** `android:apk-key-hash:<b64url sha256 of the caller's first signing cert>`. */
	static String origin(CallingAppInfo info) {
		java.util.List<Signature> signers = info.getSigningInfoCompat().getApkContentsSigners();
		return "android:apk-key-hash:" + Authenticator.b64(Authenticator.sha256(signers.get(0).toByteArray()));
	}

	@Override
	protected void onCreate(Bundle b) {
		super.onCreate(b);
		Intent in = getIntent();
		Intent result = new Intent();
		try {
			JSONObject store = Authenticator.load(this);
			String mode = store.optString("mode", "auto");
			// a UV that does not match is a user who gave up on the biometric prompt: a cancellation
			if ("nomatch".equals(store.optString("uv", "match"))) mode = "cancel";
			if (WardenPasskeyService.ACTION_CREATE.equals(in.getAction())) {
				ProviderCreateCredentialRequest req = PendingIntentHandler.Companion.retrieveProviderCreateCredentialRequest(in);
				CreatePublicKeyCredentialRequest pk = (CreatePublicKeyCredentialRequest) req.getCallingRequest();
				JSONObject json = new JSONObject(pk.getRequestJson());
				String rpId = json.getJSONObject("rp").getString("id");
				String origin = origin(req.getCallingAppInfo());
				Log.i(WardenPasskeyService.TAG, "create rp=" + rpId + " origin=" + origin + " pkg=" + req.getCallingAppInfo().getPackageName() + " mode=" + mode + " clientDataHash=" + (pk.getClientDataHash() != null));
				if ("cancel".equals(mode)) {
					PendingIntentHandler.Companion.setCreateCredentialException(result, new CreateCredentialCancellationException("cancelled by warden"));
				} else if ("fail".equals(mode)) {
					PendingIntentHandler.Companion.setCreateCredentialException(result, new CreatePublicKeyCredentialDomException(new NotAllowedError(), "failed by warden"));
				} else if (!Authenticator.supportsEs256(json)) {
					PendingIntentHandler.Companion.setCreateCredentialException(result, new CreatePublicKeyCredentialDomException(new NotSupportedError(), "warden passkeys only do ES256"));
				} else if (Authenticator.excluded(store, json, rpId)) {
					PendingIntentHandler.Companion.setCreateCredentialException(result, new CreatePublicKeyCredentialDomException(new InvalidStateError(), "excluded"));
				} else {
					String resp = Authenticator.register(this, store, json, origin, req.getCallingAppInfo().getPackageName(), pk.getClientDataHash());
					PendingIntentHandler.Companion.setCreateCredentialResponse(result, new CreatePublicKeyCredentialResponse(resp));
				}
			} else {
				ProviderGetCredentialRequest req = PendingIntentHandler.Companion.retrieveProviderGetCredentialRequest(in);
				GetPublicKeyCredentialOption opt = (GetPublicKeyCredentialOption) req.getCredentialOptions().get(0);
				JSONObject json = new JSONObject(opt.getRequestJson());
				String origin = origin(req.getCallingAppInfo());
				String credId = in.getStringExtra(WardenPasskeyService.EXTRA_CRED);
				Log.i(WardenPasskeyService.TAG, "get cred=" + credId + " origin=" + origin + " mode=" + mode);
				if ("cancel".equals(mode)) {
					PendingIntentHandler.Companion.setGetCredentialException(result, new GetCredentialCancellationException("cancelled by warden"));
				} else if ("fail".equals(mode)) {
					PendingIntentHandler.Companion.setGetCredentialException(result, new GetPublicKeyCredentialDomException(new NotAllowedError(), "failed by warden"));
				} else {
					JSONObject cred = null;
					for (JSONObject c : Authenticator.matching(store, json)) if (c.getString("credentialId").equals(credId)) cred = c;
					String resp = Authenticator.assertion(store, cred, json, origin, req.getCallingAppInfo().getPackageName(), opt.getClientDataHash());
					PendingIntentHandler.Companion.setGetCredentialResponse(result, new GetCredentialResponse(new PublicKeyCredential(resp)));
				}
			}
			setResult(RESULT_OK, result);
		} catch (Throwable t) {
			Log.e(WardenPasskeyService.TAG, "activity failed", t);
			setResult(RESULT_CANCELED, result);
		}
		finish();
	}
}
