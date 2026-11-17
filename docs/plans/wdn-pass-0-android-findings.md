# WDN-PASS PASS-0b: Android findings

Spike run 2026-11-16 on a leased `warden dev android` emulator: Pixel_10, **API 37 (Android 17), google_apis_playstore image, Play Services present, no Google account**. It was the only API 34+ device in the pool (the other AVD, `Pixel_9_Pro_Store`, has no usable target). API 34/35/36 were **not** run: everything below is verified on 37 only; API-specific claims for 34-36 are marked *unverified*.

## Verdict

**GO.** A Gradle-free, debug-signed APK with a `CredentialProviderService` serves passkey create and get to an unmodified `androidx.credentials` caller. The registration and assertion responses verify with Node `crypto` (rpIdHash, flags, ES256 signature over `authData || SHA256(clientDataJSON)` against the registration public key). Seeding, mode switching and listing work from `adb shell content call`, restricted to the shell. Install, enable, restore and uninstall are clean once the prior settings are restored explicitly.

Things the plan must change or add (details below):

1. **Create always shows a sheet.** One tap on `Continue`. The driver must tap it in `auto`/`cancel`/`fail` (decision stands).
2. **Get with exactly one matching entry shows no sheet** (auto-select). With 2+ entries a chooser appears; tap an entry or `Close`.
3. **Zero entries on a Play image is not `NoCredentialException`.** GMS's always-on `RemoteService` provider (not controlled by `credential_service`) makes the system show GMS `CredentialChooserActivity` ("Sign in another way" bar for get, "Create passkey on another device?" for create). Dismissing it gives the *cancellation* exception. So `mode: unavailable` cannot produce `NoCredentialException` on Play images; it means "chooser appears, warden dismisses it, caller sees cancellation". This is identical to what a real Google-account device does with no passkey. Update the plan's `unavailable` line for Android.
4. **Uninstalling the provider leaves `credential_service=` and `credential_service_primary=` as empty strings**, which disables GMS too. Restore must write the saved prior values back (or `settings delete` when the prior was absent). Never rely on uninstall.
5. **No stable resource ids on the system sheet.** It is Compose; only `text` and a few content descriptions are addressable. Key on text/role (see Sheet handling), not ids.
6. **APK size is ~38 KB with R8** (840 KB with d8 only). Embed it; no release-asset download needed.

## 1. Build recipe (no Gradle)

Sources: `packages/e2e/native/android/passkeys/` (`provider/`, `caller/`, `libres/`, `rules.pro`, `build-spike.sh`). Tools: SDK build-tools 36.0.0 (`aapt2`, `d8`, `zipalign`, `apksigner`, `lib/d8.jar` for R8), `platforms/android-36/android.jar`, JDK `javac` / `keytool`.

Libraries (all fetched once, class jars only): `androidx.credentials:credentials:1.5.0` AAR `classes.jar` (620 KB), `kotlin-stdlib-1.8.22.jar`, `androidx.biometric:biometric:1.1.0` AAR `classes.jar` (referenced by credentials classes; never executed). `androidx.annotation` is not needed (class-retention only; javac warns). The provider/caller compile against `androidx.credentials` rather than hand-rolling the slice/bundle protocol between system and provider: the framework `CreateEntry`/`CredentialEntry` take opaque `Slice`s in an androidx-defined format (hint strings such as `androidx.credentials.provider.credentialEntry.SLICE_HINT_*`), and the activity result/extras protocol is androidx-defined too. R8 then strips the library to what is reachable (see size). **Hand-rolling is possible but not worth it** for a 38 KB result.

`androidx.credentials` needs its own `R` (3 drawables, 2 strings; `NoClassDefFoundError: androidx/credentials/R$drawable` otherwise, thrown in the caller's `CredentialManager.create`). The AAR's `res/drawable` + `res/values` (default locale only, ~5 KB) are copied to `libres/` and linked with `--extra-packages androidx.credentials`.

Steps (from `build-spike.sh`, per module):

```bash
KS=debug.keystore   # generated at build time
keytool -genkeypair -keystore $KS -storepass android -keypass android -alias warden -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=warden passkeys debug"
aapt2 compile --dir provider/res -o res.zip ; aapt2 compile --dir libres -o libres.zip
aapt2 link --extra-packages androidx.credentials -I android.jar --manifest provider/AndroidManifest.xml \
  --java gen --min-sdk-version 34 --target-sdk-version 34 --proguard aapt-rules.pro -o base.apk res.zip libres.zip
javac -source 11 -target 11 -cp android.jar:libs/*.jar -d classes $(find provider/src gen -name '*.java')
java -cp $BT/lib/d8.jar com.android.tools.r8.R8 --release --min-api 34 --lib android.jar --output out --no-minification \
  --pg-conf rules.pro --pg-conf aapt-rules.pro $(find classes -name '*.class') libs/*.jar     # d8 alone: same args via `d8`, no --pg-conf
cp base.apk unsigned.apk && zip -j unsigned.apk out/classes.dex
zipalign -f -p 4 unsigned.apk aligned.apk
apksigner sign --ks $KS --ks-pass pass:android --key-pass pass:android --ks-key-alias warden --out provider.apk aligned.apk
```

`SHRINK=1 ./build-spike.sh <libs-dir> <out-dir>` runs the R8 variant. `aapt2 --proguard` supplies keep rules for the manifest's service/activity/provider; `rules.pro` only adds `-dontwarn` and `-dontobfuscate`.

| Artifact | d8 only | R8 |
|---|---|---|
| provider.apk | 840,464 B | **37,648 B** (classes.dex 50.7 KB) |
| caller.apk (test-only, not shipped) | 836,233 B | 29,321 B |

Base64 of the R8 provider is ~50 KB: well under the ~200 KB npm-lag threshold. The R8 build was re-verified on the device (create + get OK). The debug key is generated when warden builds the APK, so a given embedded APK has one fixed signature; the driver compares APK sha256, not signature.

## Manifest + provider xml that worked

`provider/AndroidManifest.xml` (essentials):

```xml
<uses-sdk android:minSdkVersion="34" android:targetSdkVersion="34" />
<application android:label="Warden passkeys" android:icon="@drawable/ic_key" android:allowBackup="false">
  <service android:name=".WardenPasskeyService" android:exported="true" android:label="Warden passkeys"
           android:icon="@drawable/ic_key" android:permission="android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE">
    <intent-filter><action android:name="android.service.credentials.CredentialProviderService" /></intent-filter>
    <meta-data android:name="android.credentials.provider" android:resource="@xml/provider" />
  </service>
  <activity android:name=".ProviderActivity" android:exported="false" android:excludeFromRecents="true"
            android:theme="@android:style/Theme.Translucent.NoTitleBar" />
  <provider android:name=".SeedProvider" android:authorities="nz.co.delacour.warden.passkeys"
            android:exported="true" android:permission="android.permission.DUMP" />
</application>
```

`res/xml/provider.xml`:

```xml
<credential-provider xmlns:android="http://schemas.android.com/apk/res/android">
  <capabilities><capability name="androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL" /></capabilities>
</credential-provider>
```

No `settingsActivity` or `settingsSubtitle` needed. The trampoline activity does not need to be exported: the system launches it through the `PendingIntent` the service created (`FLAG_MUTABLE | FLAG_UPDATE_CURRENT`; mutable so the system can attach the request).

Provider flow as built: `onBeginCreateCredentialRequest` returns one `CreateEntry` (account name "Warden passkeys") when the request is `BeginCreatePublicKeyCredentialRequest`; `onBeginGetCredentialRequest` returns one `PublicKeyCredentialEntry` per store credential that matches `rpId` and `allowCredentials` (title = userName), each with its own `PendingIntent` (distinct request code, credentialId in an extra), `setAutoSelectAllowed(true)`. `ProviderActivity` reads `PendingIntentHandler.Companion.retrieveProviderCreate/GetCredentialRequest`, applies the mode, and returns `setCreateCredentialResponse(new CreatePublicKeyCredentialResponse(json))` / `setGetCredentialResponse(new GetCredentialResponse(new PublicKeyCredential(json)))` or an exception, then `setResult(RESULT_OK, intent); finish()`. From Java, the Kotlin companion is reached as `PendingIntentHandler.Companion.x(...)`.

### Response JSON that satisfied the caller and verified with Node

Registration (`CreatePublicKeyCredentialResponse(registrationResponseJson)`):

```json
{"id":"<b64url credId>","rawId":"<same>","type":"public-key","authenticatorAttachment":"platform",
 "response":{"clientDataJSON":"<b64url>","attestationObject":"<b64url CBOR {fmt:none, attStmt:{}, authData}>",
  "transports":["internal"],"authenticatorData":"<b64url>","publicKeyAlgorithm":-7,"publicKey":"<b64url SPKI DER>"},
 "clientExtensionResults":{}}
```

Assertion (`PublicKeyCredential(authenticationResponseJson)`):

```json
{"id":"…","rawId":"…","type":"public-key","authenticatorAttachment":"platform",
 "response":{"clientDataJSON":"…","authenticatorData":"…","signature":"<b64url DER ECDSA>","userHandle":"<b64url>"},
 "clientExtensionResults":{}}
```

`clientDataJSON` = `{"type":"webauthn.create|get","challenge":"<as in request>","origin":"android:apk-key-hash:…","crossOrigin":false,"androidPackageName":"<caller pkg>"}` (the spike adds `androidPackageName` like Google PM; the plan's JSON omits it, both parse). `authData` per the plan (flags observed `0x5d` = UP|UV|BE|BS|AT on create; assertion flags without AT; counter 0; the spike AAGUID is ASCII `warden-passkey\0\1`). Verified host-side: rpIdHash matches `SHA256("example.com")`, signature verifies against the SPKI from the registration response. Java side: `KeyPairGenerator "EC"` `secp256r1`, `Signature "SHA256withECDSA"` (output is already ASN.1 DER, as WebAuthn wants), x/y from `ECPublicKey.getW()` padded to 32 bytes, 30-line CBOR writer (map/int/bytes/text).

## 2. Enabling the provider (settings keys)

Verified on the API 37 image. Secure settings: `credential_service` (all enabled providers, `:`-separated component names) and `credential_service_primary` (the selected primary). `autofill_service` is untouched and unaffected (our provider declares no autofill; its value stayed `com.google.android.gms/.autofill.service.AutofillService` throughout).

| Key | API 34 | API 35 | API 36 | API 37 (verified) |
|---|---|---|---|---|
| `credential_service` | *unverified* (key introduced in 34) | *unverified* | *unverified* | `:`-list; prior = `com.google.android.gms/com.google.android.gms.auth.api.credentials.credman.service.PasswordAndPasskeyService` |
| `credential_service_primary` | *unverified* | *unverified* | *unverified* | same single value as prior |
| `autofill_service` | not needed | not needed | not needed | unchanged (GMS) |

Prior values on this image: `credential_service` = `credential_service_primary` = the GMS `PasswordAndPasskeyService` component above, `autofill_service` = GMS. Settings are in userdata, so they persist across emulator restarts and are **not** per-lease unless warden restores them: restore is mandatory.

Enable (device shell, component = `<pkg>/<fully-qualified class>`; `adb shell` re-parses its argv, so wrap the whole command):

```bash
C=nz.co.delacour.warden.passkeys/nz.co.delacour.warden.passkeys.WardenPasskeyService
adb -s $S shell "settings put secure credential_service '$C'; settings put secure credential_service_primary '$C'"
```

Choice made: **ours only** (replace the list), not `ours:gms`. With `ours:gms` and ours primary, create/get still routed to ours and worked. Ours-only is not strictly more deterministic: GMS's `RemoteService` provider runs regardless (below), so the only effect of keeping GMS enabled is that GMS may also offer its own entries (none without an account). Use ours-only to keep GMS Password Manager out of the sheet; either works.

Undo (what PASS-5 must implement): before enabling, record `settings get secure credential_service` and `credential_service_primary` (`null` = key absent). Undo = `settings put secure <k> <value>` for each, or `settings delete secure <k>` when the recorded value was `null`; then `pm uninstall`. Verified: restoring the two values and uninstalling returned `settings list secure | grep -iE 'cred|autofill_service='` to exactly the pre-spike output, no package left (`pm list packages`, `dumpsys package`), nothing under `/data/data`. **Order matters**: after `pm uninstall` the system rewrites both keys to empty strings (`credential_service=`), so a restore done before uninstall is clobbered only if it contained our component; restore-then-uninstall worked, and uninstall-then-restore also works. Either way an unrestored device ends with GMS passkeys disabled.

The consent dialog some builds show when a user picks a provider in Settings is bypassed by `settings put`.

## 3. Calling app, system sheet, auto-select

Caller (`passkeys/caller/`): framework-level `androidx.credentials.CredentialManager` (`createCredentialAsync` / `getCredentialAsync`, `CreatePublicKeyCredentialRequest`, `GetPublicKeyCredentialOption`) from an Activity launched with `adb shell am start -S -n <pkg>/.CallerActivity --es op create|get --es rp example.com [--es excl <id>] [--es allow <id>]`; results to logcat tag `WPKC`. This is the same entry point `react-native-passkey` uses on Android.

| Flow | System UI observed | Skippable? |
|---|---|---|
| create (any mode) | bottom sheet "Create passkey to sign in to <app>?" with entry (user displayName / `userName • Passkey`), `Save another way`, `Continue`, `Close` | **No.** `CreateEntry.setAutoSelectAllowed(true)` had no effect. One `Continue` tap. |
| get, 1 matching entry | **none** (resolved in ~150 ms, activity result returned directly) | yes: automatic when exactly one passkey entry and `PublicKeyCredentialEntry.setAutoSelectAllowed(true)`. Not isolated whether the entry flag is required. |
| get, 2+ entries | sheet "Choose a saved passkey for <app>" with one button per entry, `Sign-in options`, `Close` | no: tap an entry |
| get / create, zero entries (`unavailable`) | GMS `CredentialChooserActivity`: get = bottom bar "Sign in another way" / "View options" / "Dismiss"; create = sheet "Create passkey on another device?" with `Close` | warden must dismiss |

Sheet text and structure from `warden ui snapshot --all` (Compose, **no resource ids**, only these `id`/label facts):

```
Create sheet:  [text] "Passkey caller"  [button] (close, child group label "Close")
               [text] "Create passkey to sign in to Passkey caller?"  [text] <entry description>
               [button] entry (children text "Alice", "alice • Passkey")
               [button] child text "Save another way"   [button] child text "Continue"
Get sheet:     [text] "Choose a saved passkey for Passkey caller"  [button] per entry (children text <displayName>, <userName>)
               [button] child text "Sign-in options"
GMS empty:     [button] label "Close sheet" (full-screen scrim)  [text] "Sign in another way" [text] "View options" [group] label "Dismiss"
```

Selectors that worked with `warden ui press`: `text=Continue`, `label=Close` (the X in create/get sheets), `text=<userName>` (get entry), `label=Dismiss` (GMS bar). `text=...` selectors with spaces/apostrophes are fine only when passed as one token. The accessible text of the entry rows comes from the credential, so key on role + position or the known userName, not on a fixed string. The sheet's `text` is localized; `label=Close` etc. are English-only. **Recipe for the driver (auto/cancel/fail):** after the caller triggers the call, poll the snapshot (<= ~2 s); if a node with text `Continue` exists tap it (create); else if a node with text of a credential userName inside a button exists and there is more than one entry tap the first by `createdAt`/`--pick`; else if `label=Dismiss` / `Close sheet` exists, mode is `unavailable`/`cancel`: tap it. Timing is an issue: warden does not know when the app calls, so the handler must be a watcher that runs while the spec awaits, keyed on the sheet's package (`com.google.android.gms` chooser activity / the system UI), not a one-shot. Reading the sheet's package/activity: `dumpsys activity activities | grep topResumedActivity` showed the GMS chooser as `com.google.android.gms/.identitycredentials.ui.CredentialChooserActivity`; the create/get sheets above are drawn by the system credential selector UI (task not attributed to GMS in these spikes, treat it as the system selector).

Alternative worth costing in PASS-4/5 (not tried): drive the chooser through the exported `ProviderActivity` instead. The trampoline already completes without UI once the user picks; a driver watcher is only needed for the system's own sheet, which Credential Manager always owns. There is no supported way for a provider to bypass it.

Note: a 2nd, unrelated hazard seen: `warden dev android` leaves the example app foreground with a runtime permission dialog (`permission_deny_button`) that sits on top of the sheet and swallows taps. The spike dismissed it with `id=permission_deny_button`.

## 4. Seeding from the shell

```bash
U=content://nz.co.delacour.warden.passkeys
adb -s $S shell content call --uri $U --method setMode --extra mode:s:auto --extra uv:s:match
adb -s $S shell content call --uri $U --method add --extra b64:s:<std-base64 of the credential record JSON>
adb -s $S shell content call --uri $U --method remove --arg <credentialId>
adb -s $S shell content call --uri $U --method clear
adb -s $S shell content call --uri $U --method list
```

Result is printed as `Result: Bundle[{result={"mode":"auto","uv":"match","credentials":[…]}}]` (the whole store); errors as `Bundle[{error=…}]`. Parse with a regex on `result=` up to the final `}]`.

- **Pass JSON as base64.** `--extra json:s:{...}` fails: `adb shell` re-parses its argv on the device, strips the quotes and splits, giving `Binding not well formed: json:s:credentialId:AAAA...`. `b64:s:<std base64>` has no shell metacharacters (`+ / =` are safe) and avoids quoting entirely. Provider supports both keys.
- **Shell-only restriction.** The `<provider>` has `android:exported="true" android:permission="android.permission.DUMP"` (shell holds DUMP; a normal app cannot). Tested from the caller app (uid 10233, with `<queries>` so the authority is visible): `SecurityException: Permission Denial: opening provider … requires android.permission.DUMP`. Without `<queries>` a third-party app cannot even resolve the authority (`Unknown authority`) on API 30+ package visibility. `call()` additionally rejects any uid other than 2000 (shell), 0 (root) or the provider's own. Both layers are in the spike.
- Store is one JSON file in the app-private `files/store.json` written tmp + rename; the service and provider run in the same process.

## 5. Exceptions seen by the caller (androidx.credentials 1.5.0 over the API 37 framework)

| Situation | How produced | Caller exception (class, `type`) |
|---|---|---|
| user closes sheet (create) | tap `Close` | `androidx.credentials.exceptions.CreateCredentialCancellationException`, `TYPE_USER_CANCELED`, msg "User cancelled the selector" |
| user closes sheet (get) | tap `Close` | `GetCredentialCancellationException`, `TYPE_USER_CANCELED`, "User cancelled the selector" |
| `cancel` mode | activity sets `CreateCredentialCancellationException` / `GetCredentialCancellationException` | same two classes, msg from the provider ("cancelled by warden") |
| `fail` mode | activity sets `CreatePublicKeyCredentialDomException(NotAllowedError)` / `GetPublicKeyCredentialDomException(NotAllowedError)` | `…publickeycredential.CreatePublicKeyCredentialDomException` type `androidx.credentials.TYPE_CREATE_PUBLIC_KEY_CREDENTIAL_DOM_EXCEPTION/androidx.credentials.TYPE_NOT_ALLOWED_ERROR`; get: `GetPublicKeyCredentialDomException`, `…TYPE_GET_PUBLIC_KEY_CREDENTIAL_DOM_EXCEPTION/androidx.credentials.TYPE_NOT_ALLOWED_ERROR`; message preserved |
| excluded credential | activity sets `CreatePublicKeyCredentialDomException(InvalidStateError)` | `CreatePublicKeyCredentialDomException`, `…/androidx.credentials.TYPE_INVALID_STATE_ERROR`, message preserved |
| `unavailable` (no entries) | provider returns an empty `BeginGetCredentialResponse` (or `onError(NoCredentialException)`: identical) | GMS chooser shown; after warden dismisses it: `GetCredentialCancellationException` / `CreateCredentialCancellationException`, "User cancelled the selector". **`NoCredentialException` was never observed** on this Play image. `NoCreateOption` from the provider likewise gives the GMS "another device" sheet. |
| activity crash / `RESULT_CANCELED` | e.g. unusable private key | `GetCredentialCancellationException` ("User cancelled the selector"), i.e. a swallowed error looks like a cancel |

On an AOSP / non-GMS image the empty case would likely surface `NoCredentialException` / `CreateCredentialNoCreateOptionException`; not testable here. Providers can only return credential-manager exception types: `onError(NoCredentialException)` reaches the framework as status `CANCELED` and the UI still opens because GMS reports data.

DOM error exceptions carry `domError.type`, so apps and `react-native-passkey` map `NotAllowedError` / `InvalidStateError` as on a real device.

## 6. CallingAppInfo and the origin

`ProviderCreateCredentialRequest.getCallingAppInfo()` / `ProviderGetCredentialRequest.getCallingAppInfo()` (and `BeginCreateCredentialRequest.getCallingAppInfo()` in the service) expose `getPackageName()`, `getSigningInfoCompat().getApkContentsSigners()` (and `.getSigningCertificateHistory()`), `getOrigin(privilegedAllowlist)` (null for non-privileged callers). The spike builds the origin exactly as Google Password Manager does:

`android:apk-key-hash:` + base64url-nopad(SHA-256(signers[0].toByteArray()))

Verified: the value in the response, `android:apk-key-hash:1qzXV2HNgNWbTTwtPaDfN25Q3x2na162BbdYpNFHoSo`, equals `keytool -exportcert … | openssl dgst -sha256 -binary | base64url` of the caller's cert. Server-side tests (`@simplewebauthn/server` `expectedOrigin`) must use the **app's** signing cert hash (example app debug/Gradle keystore, or the repacked app's signer), not the provider's.

Not exercised: a **privileged** caller (browser / Custom Tab / some WebView hosts) passes `clientDataHash` (non-null on the request) and an origin through the privileged allowlist; the response must then be built from the given hash and `clientDataJSON` handled per Google's rules. The spike logs `clientDataHash=false` for the non-privileged test app. PASS-4 must handle `clientDataHash != null` (sign over the supplied hash, omit/skip building clientDataJSON) or document that Android WebView/Custom Tab passkeys are out of v1. `crossOrigin` stays `false`.

## 7. Cleanup and leftovers

Verified end state on the device: both keys restored to the GMS value, `autofill_service` unchanged, `pm list packages` shows no `nz.co.delacour.warden.passkeys*`, no `/data/data` dir, `dumpsys package` unknown. The only side effect of an unrestored uninstall is the two empty-string settings (above). Lease released with `warden release` for both lease ids from `warden dev android`; the `warden dev` process held no other state (Metro on its own port).

Golden snapshots: **Android has no golden for warden** (`golden key/export/import` refuse `--platform android`); pooled AVDs persist userdata between leases, including secure settings and installed packages, so an install-per-lease and a restore-on-release are required exactly as the plan says. Never bake the provider into an AVD image or cold-boot snapshot.

## Risks

- Verified on API 37 + Play image only; 34/35/36 and AOSP images untested (`NoCredentialException` behavior, `credential_service` key semantics, selector layout). Plan to rerun the spike (build recipe + `settings` + the two table rows) once an API 34 emulator is in the pool.
- Sheet UI is Compose with no ids; text is localized and may change with Play services / system updates. The empty-result chooser belongs to GMS (`Dismiss` label), different from the main selector.
- Create always needs a tap; the driver needs a watcher running concurrently with the app's request, not before it.
- `unavailable` is a cancel on GMS images. A spec cannot distinguish it from `cancel` through exception type; spec docs must say so.
- Privileged callers / `clientDataHash` flow untested.
- Settings are global to the AVD user: a crashed run that never restores leaves GMS passkeys disabled for the next lease. The condition record must persist the prior values (not just in memory) and `warden gc` / lease reclaim must run the undo.
- Credential store file lives in app data and dies with uninstall: per-lease lifetime matches the decision. `adb install` is incremental on this emulator ("Performing Incremental Install"); `install -r` keeps `files/store.json` (spike relied on it), a fresh install does not.

## Binding guidance

**PASS-4 (provider APK)**
- Ship the R8 build (~38 KB) as an embedded base64 TS module as planned; no release-asset download. Build with `aapt2 + javac + R8(d8.jar) + zipalign + apksigner`; port `build-spike.sh` to `scripts/build-passkeys.ts` using `findToolchain` from `build.ts` plus `aapt2`/`zipalign`/`apksigner`. Add `platforms/android-34+` requirement (the existing `MIN_PLATFORM = 30` is too low; require >= 34).
- Depend on `androidx.credentials` + `kotlin-stdlib` + `biometric` class jars and `libres` (pin versions and sha256 in a lock file like `atf.lock.json`); the provider class jars are not in the repo today. Alternative to avoid vendoring them: hand-write the `Slice` builders and `PendingIntentHandler` extras (undocumented format, rejected).
- Keep `SeedProvider` permission `android.permission.DUMP` + uid check; keep `call()` methods `setMode/add/remove/clear/list`; take JSON via `b64`. Return the whole store on every call so the host can mirror it.
- Handle `clientDataHash != null`. Make `unavailable` return an empty response (equivalent to `onError(NoCredentialException)`); it surfaces as the GMS chooser on Play images.
- ES256 only; a request without `{alg:-7}` in `pubKeyCredParams` should return `NotSupportedError`.
- Keep the stored record shape from the plan; spike's `privateKey` is std base64 PKCS#8 (plan's store: PKCS#8 base64; keep one flavour across platforms).
- Origin from `getApkContentsSigners()[0]`; document that expected origin = app-signature hash.

**PASS-5 (driver)**
- API check: `getprop ro.build.version.sdk` < 34 -> `E_PASSKEY_API`. Verified only >= 37; do not claim 34-36 until the spike is rerun.
- Install: `adb -s <serial> install -r provider.apk` (sha-compare to decide staleness; use `-r` so `files/store.json` survives upgrades). Enable with the two `settings put secure` calls (ours only). **Record prior values first** into the condition record (`null` -> `settings delete` on undo). Undo order: restore settings, `pm uninstall`; also correct an empty-string leftover.
- Never on foreign devices (existing rule).
- Seeding through `content call` with `b64`; parse `Result: Bundle[{result=...}]`.
- Sheet handling: a background watcher during the app call, per the recipe above. `auto`: create -> tap `text=Continue`; get with 1 entry -> nothing to do; get with >1 entry -> tap the picked entry (`--pick`, else newest); `cancel`/`fail`: the provider returns the error after the same taps (the entry tap/Continue is still required because the provider activity only runs after selection). `unavailable`: tap `label=Dismiss` / `Close sheet`. Poll, do not sleep; give up after the call's own timeout.
- Dismiss any foreground permission dialog (`id=permission_deny_button`) only if it is warden-owned state; otherwise report it, do not tap blindly.
- A passkey call with the sheet left open leaves a GMS task across caller restarts (`topResumedActivity` stays the chooser): always dismiss and `am force-stop` the caller in spec cleanup.

## Reproduce

```bash
# libs (once): credentials-1.5.0.aar (classes.jar), kotlin-stdlib-1.8.22.jar, biometric-1.1.0.aar (classes.jar) -> <libs>/*.jar
SHRINK=1 packages/e2e/native/android/passkeys/build-spike.sh <libs> <out>
# device: warden dev android --json (background) -> serial
adb -s $S install -r <out>/provider.apk && adb -s $S install -r <out>/caller.apk
# enable (record prior values first), seed, then:
adb -s $S shell am start -S -n nz.co.delacour.warden.passkeys.caller/.CallerActivity --es op create --es rp example.com
adb -s $S logcat -d -s WPKC WPK
```
