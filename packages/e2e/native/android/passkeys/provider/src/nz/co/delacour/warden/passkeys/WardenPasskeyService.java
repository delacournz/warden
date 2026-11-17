package nz.co.delacour.warden.passkeys;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.CancellationSignal;
import android.os.OutcomeReceiver;
import android.util.Log;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialUnknownException;
import androidx.credentials.provider.BeginCreateCredentialRequest;
import androidx.credentials.provider.BeginCreateCredentialResponse;
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest;
import androidx.credentials.provider.BeginGetCredentialOption;
import androidx.credentials.provider.BeginGetCredentialRequest;
import androidx.credentials.provider.BeginGetCredentialResponse;
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption;
import androidx.credentials.provider.CreateEntry;
import androidx.credentials.provider.CredentialProviderService;
import androidx.credentials.provider.ProviderClearCredentialStateRequest;
import androidx.credentials.provider.PublicKeyCredentialEntry;
import org.json.JSONObject;

/** Warden's virtual passkey provider: lists entries, the real work is in {@link ProviderActivity}. */
public final class WardenPasskeyService extends CredentialProviderService {
	static final String TAG = "WPK";
	static final String ACTION_CREATE = "nz.co.delacour.warden.passkeys.CREATE";
	static final String ACTION_GET = "nz.co.delacour.warden.passkeys.GET";
	static final String EXTRA_CRED = "wpk.credentialId";

	/** `unavailable` and `off` both answer with no entries (the system then shows GMS's own chooser on Play images). */
	private static boolean dormant(JSONObject store) {
		String mode = store.optString("mode");
		return "unavailable".equals(mode) || "off".equals(mode);
	}

	private PendingIntent pending(Context c, String action, int code, String credId) {
		Intent i = new Intent(action).setClass(c, ProviderActivity.class).setPackage(c.getPackageName());
		if (credId != null) i.putExtra(EXTRA_CRED, credId);
		// FLAG_MUTABLE: the system attaches the request to the intent before launching it.
		return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
	}

	@Override
	public void onBeginCreateCredentialRequest(BeginCreateCredentialRequest request, CancellationSignal signal,
			OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException> callback) {
		JSONObject store = Authenticator.load(this);
		Log.i(TAG, "beginCreate type=" + request.getType() + " from=" + (request.getCallingAppInfo() == null ? null : request.getCallingAppInfo().getPackageName()) + " mode=" + store.optString("mode"));
		if (!(request instanceof BeginCreatePublicKeyCredentialRequest) || dormant(store)) {
			callback.onError(new CreateCredentialNoCreateOptionException("no create option"));
			return;
		}
		CreateEntry entry = new CreateEntry.Builder("Warden passkeys", pending(this, ACTION_CREATE, 1, null))
			.setDescription("Virtual authenticator").setIcon(Icon.createWithResource(this, R.drawable.ic_key))
			.setAutoSelectAllowed(true).build();
		callback.onResult(new BeginCreateCredentialResponse.Builder().addCreateEntry(entry).build());
	}

	@Override
	public void onBeginGetCredentialRequest(BeginGetCredentialRequest request, CancellationSignal signal,
			OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException> callback) {
		try {
			JSONObject store = Authenticator.load(this);
			BeginGetCredentialResponse.Builder out = new BeginGetCredentialResponse.Builder();
			boolean unavailable = dormant(store);
			int code = 100;
			for (BeginGetCredentialOption opt : request.getBeginGetCredentialOptions()) {
				if (!(opt instanceof BeginGetPublicKeyCredentialOption) || unavailable) continue;
				BeginGetPublicKeyCredentialOption pk = (BeginGetPublicKeyCredentialOption) opt;
				for (JSONObject cred : Authenticator.matching(store, new JSONObject(pk.getRequestJson()))) {
					PublicKeyCredentialEntry e = new PublicKeyCredentialEntry.Builder(this,
						cred.optString("userName", "passkey"), pending(this, ACTION_GET, code++, cred.getString("credentialId")), pk)
						.setDisplayName(cred.optString("displayName", null)).setIcon(Icon.createWithResource(this, R.drawable.ic_key))
						.setAutoSelectAllowed(true).build();
					out.addCredentialEntry(e);
				}
			}
			Log.i(TAG, "beginGet options=" + request.getBeginGetCredentialOptions().size() + " unavailable=" + unavailable);
			callback.onResult(out.build());
		} catch (Exception e) {
			Log.e(TAG, "beginGet failed", e);
			callback.onError(new GetCredentialUnknownException(String.valueOf(e)));
		}
	}

	@Override
	public void onClearCredentialStateRequest(ProviderClearCredentialStateRequest request, CancellationSignal signal,
			OutcomeReceiver<Void, ClearCredentialException> callback) {
		callback.onResult(null);
	}
}
