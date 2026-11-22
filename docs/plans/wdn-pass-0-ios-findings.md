# WDN-PASS PASS-0a iOS spike findings

Spike code (throwaway, not in the repo): `/private/tmp/claude-501/-Users-chris-orca-workspaces-warden-siren/fb1cc859-3a38-40a0-9f4c-fb5683c770a8/scratchpad/pass0/` (`dylib/PassSpike.m` fake authenticator, `dylib/dump.m` runtime class dump, `app/PassApp.m` ObjC test app, `sw/main.swift` Swift consumer shaped like react-native-passkey, `run.sh`, `out/*.txt`, `dump.txt`). `WardenInject.m` was NOT touched: the spike is a standalone dylib loaded with the same `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` mechanism.

## Verdict: works

Swizzling `ASAuthorizationController` and completing the delegate with a runtime-built fake `ASAuthorization` works end to end for registration and assertion, from ObjC and from a Swift consumer reading the same properties react-native-passkey reads. The assertion signature verified independently with `openssl dgst -sha256 -verify` against the registered public key. The injected path needs no associated-domains entitlement and no AASA (confirmed: app without entitlements, rpId `example.com`, succeeds).

Caveats (all manageable, listed under Risks): only iOS 27.2 runtimes are installed here (no old-runtime coverage); the `ASAuthorization` alloc uses a method that is `NS_UNAVAILABLE`-adjacent (`initWithProvider:credential:` is a real, non-public-header init); cancel/unavailable/uv semantics need a few deliberate choices (below).

## Runtimes tested

`xcrun simctl list runtimes` offers only iOS 27.2 (two builds: 24B8117 and 24B91016s); Xcode 27.2 (27B52). Tested: **iOS 27.2 (24B8117), iPhone 17 simulator (biometrics pool, Face ID enrolled)**. The "oldest warden supports" runtime is not installed on this machine, so older-OS behaviour is untested: PASS-2 must fall back gracefully (see "Alloc recipe" fallback) and the `native` signoff / CI should run on the oldest runtime CI provides.

## Class facts (runtime dump, iOS 27.2)

- `ASAuthorizationController` public `-performRequests` calls `-performRequestsWithOptions:` internally (the spike saw both on non-intercepted requests), which funnels to private `-_performRequestsWithStyle:options:`. Swizzle `-performRequestsWithOptions:` plus `-performRequests` and `-performAutoFillAssistedRequests` (autofill did not route through options in the spike). Not needed: private `_performRequestsWithStyle:options:`, `_completeWithAuthorization:`, `_failWithError:` (exist, avoid).
- `ASAuthorization` has `-initWithProvider:credential:` (works, see below), `-init`, `+new`, ivars `_provider`, `_credential`.
- `ASAuthorizationPlatformPublicKeyCredentialRegistration` / `...Assertion` (and the SecurityKey variants) are thin wrappers over a private `_coreCredential` (`ASCPlatformPublicKeyCredential*`) with `-initWithCoreCredential:` (core classes are in AuthenticationServicesCore, avoid). Properties are plain getters: registration `credentialID, rawClientDataJSON, rawAttestationObject, attachment(q), prf, largeBlob, __prfSwift, __largeBlobSwift`; assertion `credentialID, rawClientDataJSON, rawAuthenticatorData, signature, userID, attachment, prf, largeBlob, __prfSwift, __largeBlobSwift`.
- Request objects expose everything via getters (read with KVC or `respondsToSelector`): registration `relyingPartyIdentifier, challenge, userID, name, displayName, excludedCredentials, userVerificationPreference, attestationPreference, clientData, shouldShowHybridTransport, requestStyle, extensions`; assertion `relyingPartyIdentifier, challenge, allowedCredentials, userVerificationPreference, clientData, shouldShowHybridTransport, extensions`. Descriptors expose `credentialID`. Preference values are NSStrings (`required`/`preferred`/`discouraged`, attestation `none`). `challenge` is nil and `clientData` non-nil when the app used `...WithClientData:` (read `challenge`/`origin` off the clientData object). Security-key registration requests additionally have `credentialParameters`, `residentKeyPreference`. Password requests have none of these.

## Q1: Working alloc + swizzle recipe

Build both credential classes at runtime (no compile-time link to AuthenticationServices needed, `dlopen` it first if the host app has not loaded it):

```objc
// subclass + getters backed by an associated dictionary; nil for extension outputs
Class c = objc_allocateClassPair(objc_getClass("ASAuthorizationPlatformPublicKeyCredentialRegistration"), "WardenFakePlatformRegistration", 0);
for (NSString *p in @[@"credentialID", @"rawAttestationObject", @"rawClientDataJSON"])
  class_addMethod(c, NSSelectorFromString(p), imp_implementationWithBlock(^id(id s){ return [objc_getAssociatedObject(s, kProps) objectForKey:p]; }), "@@:");
for (NSString *p in @[@"prf", @"largeBlob", @"coreCredential"])   // nil
  class_addMethod(c, NSSelectorFromString(p), imp_implementationWithBlock(^id(id s){ return nil; }), "@@:");
class_addMethod(c, @selector(attachment), imp_implementationWithBlock(^NSInteger(id s){ return 0; }), "q@:");        // 0 = platform
class_addMethod(c, @selector(copyWithZone:), imp_implementationWithBlock(^id(id s, NSZone *z){ return s; }), "@@:^v");
objc_registerClassPair(c);
id cred = class_createInstance(c, 0);          // no -init: real init needs a core credential
objc_setAssociatedObject(cred, kProps, @{...}, OBJC_ASSOCIATION_RETAIN);
```

Assertion class is the same with `credentialID, rawAuthenticatorData, rawClientDataJSON, signature, userID`.

`ASAuthorization` (path A, works, no subclass needed):

```objc
id prov = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rp];   // via objc_msgSend
id auth = ((id(*)(id,SEL,id,id))objc_msgSend)([ASAuthorization alloc], @selector(initWithProvider:credential:), prov, cred);
// auth.credential / auth.provider return the fake credential and the real provider
```

Fallback if `initWithProvider:credential:` is missing on an older OS (not testable here): `class_createInstance` of a runtime subclass of `ASAuthorization` overriding `credential` and `provider`.

Delegate call, async on main like the real controller:

```objc
dispatch_async(dispatch_get_main_queue(), ^{
  ((void(*)(id,SEL,id,id))objc_msgSend)(ctl.delegate, @selector(authorizationController:didCompleteWithAuthorization:), ctl, auth);
});
```

Swizzles (all with `method_setImplementation`, original kept for pass-through):

```objc
performRequests, performRequestsWithOptions:(NSUInteger), performAutoFillAssistedRequests
// each: if (!intercept(self)) call the original
```

Checks that passed (iOS 27.2, ObjC app and Swift app): `isKindOfClass:` registration/assertion true, protocol conformance true (`ASAuthorizationPublicKeyCredentialRegistration/Assertion`), `authorization.credential` / `.provider` correct, Swift `switch authorization.credential { case let c as ASAuthorizationPlatformPublicKeyCredentialRegistration ... }` matches, Swift `c.prf` / `c.largeBlob` read nil without crashing (base impl messages nil `_coreCredential`; overriding `__prfSwift`/`__largeBlobSwift` to nil is still advisable for safety), `attachment.rawValue` 0.

Crypto used and verified (all inside the dylib, no dependencies): `SecKeyCreateRandomKey` P-256 (non-permanent), public key via `SecKeyCopyExternalRepresentation` (04||X||Y), `SecKeyCreateSignature(kSecKeyAlgorithmECDSASignatureMessageX962SHA256, authData || SHA256(clientDataJSON))` gives a DER signature (WebAuthn wants DER, no conversion), `CC_SHA256`, a ~25-line CBOR writer (maps, byte/text strings, ints). openssl verified the assertion signature against the registered public key. For `fmt: none` the attestationObject is `{"fmt":"none","attStmt":{},"authData":bytes}`.

## Real-OS reference output (for matching the fake)

Captured from the real iOS 27.2 passkey flow on a leased sim (see Q3 for how). The fake should mimic these:

| Item | Real value |
|---|---|
| Registration `authData` flags | `0x5d` = UP, UV, BE, BS, AT; signCount 0; AAGUID `fbfc3007-154e-4ecc-8c0b-6e020557d7bd` (iCloud Keychain); credentialId 20 bytes |
| Assertion `authData` flags | `0x1d` = UP, UV, BE, BS; 37 bytes; signCount 0; signature DER ECDSA (70-72 B) |
| `attestationObject` | CBOR `{fmt:"none", attStmt:{}, authData}` (3-key map) |
| `clientDataJSON` | `{"type":"webauthn.create"|"webauthn.get","challenge":"<b64url>","origin":"https://<rpId>"}` **with no `crossOrigin` field** (the plan's `crossOrigin:false` does not match iOS; the spike dropped it) |
| `attachment` | 0 (platform) |
| `userID` on assertion | the registered user handle |

Plan correction: the PASS-1/2 text "clientDataJSON `{ type, challenge, origin, crossOrigin: false }`" should be `{ type, challenge, origin }` for iOS.

## Q2: `-performAutoFillAssistedRequests`

Interceptable exactly like `performRequests`: the spike completed an assertion through it (`via=performAutoFillAssistedRequests`), delegate received the fake assertion. Requirements: only the swizzle; no presentation anchor is asked for and no focused field is needed on the fake path. Divergence to decide in PASS-2: the real conditional-UI flow stays pending until the user picks a passkey from the QuickType bar; the fake completes on the next main-queue turn. Apps showing a "waiting" UI see it flash. Recommended: in `auto` complete after a short fixed delay (default 0, configurable later); `cancel` in autofill mode should deliver nothing (real conditional UI never errors on dismissal) unless the app calls `cancel`. Not run on the real OS (needs QuickType interaction): untested.

## Q3: Real error domain/codes (no dylib)

Domain for all: `com.apple.AuthenticationServices.AuthorizationError` (`ASAuthorizationErrorDomain`).

| Situation | Code | userInfo / description |
|---|---|---|
| App without `application-identifier` (ad-hoc signed sim build, no entitlements) | 1004 | `NSLocalizedFailureReason` "The calling process does not have an application identifier. Make sure it is properly configured." Fails immediately for every request type, passwords included |
| App with `application-identifier` but no matching `webcredentials` associated domain / AASA | 1004 | "Application with identifier <id> is not associated with domain <rp>" (immediate). Needs a `.`-containing domain (swcd: "did not contain a period character") |
| Same, AASA fetch not yet done / failed | 1004 | "Unable to verify webcredentials association of <id> with domain <rp>. Please try again in a few seconds." |
| User cancel (sheet X, hybrid QR X, Face ID prompt then X), registration or assertion | **1001** | **empty userInfo**, description "The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)" |
| Assertion, no passkey for the rp / `allowedCredentials` matches none, normal mediation | no error yet | system sheet "There are no matching passkeys saved in Passwords for <app>" stays up (hybrid transport on: "Bluetooth Off" then a "Scan QR Code" sheet); the error arrives only when the user closes it: **1001, empty userInfo** |
| Same, `performRequests(options: .preferImmediatelyAvailableCredentials)` | **1001, immediate** | `NSLocalizedFailureReason` = "No credentials available for login." (description "The operation couldn't be completed. No credentials available for login."). react-native-passkey 3.6.2 keys off exactly this (the *presence* of a failure reason separates "no credential" from a genuine cancel, both 1001) |
| Password-only request, no saved password | 1001 | same failure reason "No credentials available for login." |
| Registration with `excludedCredentials` containing an existing credential | **1006** (`ASAuthorizationErrorMatchedExcludedCredential`) | empty userInfo. The registration sheet still shows first; the error is delivered after the user taps "Add Passkey" and Face ID matches |
| Face ID non-match (`warden ui biometrics fail`) on the registration sheet | **no error** | iOS shows "Face Not Recognized / Try Again" with "Try Face ID Again" and "Cancel"; Cancel returns to the sheet; the app is not called. The app only gets an error (1001) when the user closes the sheet itself |
| Face ID match (`warden ui biometrics match`) | success | credential as in the table above |

Consequence for `uv: "nomatch"` (plan item): the real OS has no immediate error for a failed biometric; it keeps the sheet open. The simulation that is faithful to what an app can observe is a retry that eventually ends as user cancel (**1001, empty userInfo**), which is what the spike's `uv: nomatch` returns. Document this: `nomatch` = "the user failed Face ID and gave up".

Entitlement / dylib: with the dylib the entitlement check is bypassed (confirmed: app signed with no entitlements at all, rpId `example.com`, `reg` then `assert` both succeeded, a `cancel` mode run returned 1001, `fail` 1004, `uv=nomatch` 1001). The real request never reaches the OS (original not called), so none of the 1004 association errors can occur in injected mode.

How the real flow was driven on a sim: `warden dev ios --json --no-build --no-eas --biometrics` lease; the test app got `application-identifier` + `com.apple.developer.associated-domains = webcredentials:<host>?mode=developer` embedded with `-Xlinker -sectcreate __TEXT __entitlements` (a codesign `--entitlements` signature fails to launch: AMFI kills it; the sectcreate route is what Xcode simulator builds do), a trusted local CA added with `xcrun simctl keychain <udid> add-root-cert`, `touch <sim data>/Containers/Data/InternalDaemon/*/com.apple.SharedWebCredentials/.developerMode`, a TLS server on :443 serving the AASA, and a dotted hostname resolving to 127.0.0.1 (`warden.127.0.0.1.nip.io`).
**Important for warden: slim sims disable swcd (the `web` category), so real associated-domain checks cannot work on a slimmed sim until `warden sim slim <udid> --restore`.** Irrelevant in injected mode, relevant when a user runs a spec against real passkeys.

## Q4: react-native-passkey (3.6.2, read from npm, plus a Swift mirror run on the sim)

- iOS native code is Swift (`Passkey.swift`, `PasskeyDelegate.swift`). It builds **both** a platform and a security-key request and passes `[platformRequest, securityKeyRequest]` in ONE controller by default (unless `forcePlatformKey` / `forceSecurityKey`). This is the dominant real-world shape, so the intercept rule must handle it (Q5).
- Calls `performRequests()` or `performRequests(options: .preferImmediatelyAvailableCredentials)` (iOS 16+) for `getImmediate`.
- Success path reads, for platform registration: `rawAttestationObject` (nil check, then force unwrap), `rawClientDataJSON`, `credentialID`, `largeBlob` (iOS 17: `largeBlob?.isSupported`), `prf` (iOS 18: `isSupported`, `first`, `second`); for platform assertion: `rawAuthenticatorData`, `rawClientDataJSON`, `credentialID`, `signature!`, `userID?`, `largeBlob?.result` (switch `.read/.write`), `prf?.first/second`. It does not read `attachment`.
- Dispatch is `switch authorization.credential { case let c as ASAuthorizationPlatformPublicKeyCredentialRegistration ...}` so the fake classes must subclass the real ones (they do).
- Error mapping it expects: 1001 → cancelled, except with immediate mediation and `localizedFailureReason != nil` → noCredentials; 1004 requestFailed; 1005 noCredentials; **1006 credentialAlreadyExists**; 4004 badConfiguration; 31 timedOut; 1 notSupported.
- Verified on the sim with a Swift app mirroring that exact shape (`[platform, securityKey]` registration, then `[platform, securityKey]` assertion with `.preferImmediatelyAvailableCredentials`), injected dylib: both succeed, `prf`/`largeBlob` read as nil, no crash. A full RN app run was not done (optional).
- The lib's own docs on the 1001 discrimination confirm the "No credentials available for login." reason string recorded above, so the `unavailable` simulation must set that failure reason when immediate mediation was requested.

- Confirmed against the repo copy `node_modules/react-native-passkey/ios/` (also 3.6.2, identical to the npm tarball read above). All bytes are encoded by `Data.toBase64URLEncodedString()` (`PasskeyHelper.swift`): standard base64, `+`→`-`, `/`→`_`, `=` stripped, so the fake's raw `NSData` values need no pre-encoding.
- `-performRequestsWithOptions:` (`getImmediate`, iOS 16+) is covered by the swizzle recipe (its own swizzle, option bit `1` = `preferImmediatelyAvailableCredentials`). Real behaviour with that option and no matching credential: **no sheet, immediate failure**, 1001 with `NSLocalizedFailureReason` "No credentials available for login." (table above, measured). With a matching credential the normal sheet shows. The fake must read the options argument to choose that error shape for `unavailable`.

Not checked: an Expo passkey module (none installed locally).

## Q5: Mixed request arrays: recommended intercept rule

Spike tested: `[platform assertion, password]` (intercepted, completed with the passkey), `[platform assertion, securityKey assertion]` via Swift (intercepted), security-key-only registration (not intercepted by the spike: fell through to the real OS and failed 1004), password-only (not intercepted, real 1001 "No credentials available for login.").

Rule for PASS-2:
1. Intercept iff the controller's `authorizationRequests` contains at least one `ASAuthorizationPlatformPublicKeyCredential{Registration,Assertion}Request`. Use the first such request (registration xor assertion; if both, the first).
2. Drop every other request in the array (password, Apple ID, security key): the passkey wins, which is what a user with a stored passkey sees as the top choice. Never forward a filtered controller to the real OS.
3. Not intercepted: security-key-only and password-only/Apple-ID-only arrays pass through to the real OS unchanged (they are out of v1 scope, document it). Optional later: `unavailable` for a security-key-only request.
4. An RN `forceSecurityKey` call therefore never sees a passkey (correct).

## Q6: Binding guidance

### PASS-2 (dylib)
- Gate on `WARDEN_PASSKEYS=1`; do the swizzles in the constructor after `dlopen("AuthenticationServices")` (the framework may not be loaded yet). Missing class/selector must be a no-op, never a crash (same rule as keyboard).
- Swizzle the three entry points above. Read request fields with `respondsToSelector` + KVC as the spike's `dumpRequest` does; handle the `clientData` variant (challenge/origin from the clientData object).
- Build credentials at runtime exactly as above; keep `__prfSwift`/`__largeBlobSwift` overrides nil. Set `attachment` 0 on both.
- Mode semantics (all errors in domain `com.apple.AuthenticationServices.AuthorizationError`, **userInfo empty** unless stated, delivered async on the main queue):
  - `auto`: success.
  - `cancel`: 1001, empty userInfo.
  - `fail`: 1004. (Real 1004 messages carry a failure reason; consider `NSLocalizedFailureReasonErrorKey`. Apps rarely read it.)
  - `unavailable` on an assertion: if options contain `preferImmediatelyAvailableCredentials` (value 1) → 1001 with `NSLocalizedFailureReasonErrorKey` "No credentials available for login." and `NSLocalizedDescriptionKey` "The operation couldn't be completed. No credentials available for login."; else → 1001 with EMPTY userInfo (the real OS keeps a sheet open and the user dismisses it). On a registration request `unavailable` has no real analogue: treat as `fail` (1004).
  - excluded credential on registration (an `excludedCredentials` id present in the store) → **1006**, empty userInfo (not `fail`).
  - `uv: "nomatch"` → 1001, empty userInfo. `uv: "skip"` → clear the UV bit (flags 0x59 reg / 0x19 asr).
- Authenticator outputs: copy the real shape from the reference table; use origin `https://<rpId>`, **omit `crossOrigin`**. Optionally use the iCloud Keychain AAGUID for fidelity (servers see it); the plan chose a warden AAGUID, but note a warden AAGUID breaks RP allowlists that accept Apple passkeys only; a config knob is cheap.
- Credential ids: real are 20 random bytes; 16 is fine.
- State: reuse the state file/ack (`passkeys:true`). Spike keeps keys in memory; the store file must contain the PKCS#8 private key (import with `SecKeyCreateWithData` kSecAttrKeyTypeECSECPrimeRandom, `kSecAttrKeyClassPrivate`; PKCS#8 is not accepted directly, strip the 26-byte P-256 PKCS#8 header to the raw `04||X||Y||D` ANSI X9.63 blob). Not exercised in the spike (generated keys only): PASS-2 needs its own test for importing a host-generated key.
- Pass-through must call the original IMP and survive re-entry (`performRequests` calls `performRequestsWithOptions:`: an intercepted request never calls the original, so no loop; a non-intercepted one is checked twice, harmless).
- Delegate nil → do nothing. Respect `-cancel` called before the async completion (real controller completes with 1001 if cancelled): not implemented in the spike, add it.

### PASS-3 (driver)
- App must launch with the dylib loaded: same relaunch rule as camera.
- Because injected mode bypasses entitlements, specs work with the repack/simulator builds that carry no associated-domains. No `warden sim slim --except web` needed.
- If a user runs real (non-injected) passkeys against a slim sim they get 1004 "not associated"; add a troubleshooting row (append, no renumber).

## Risks
- Only iOS 27.2 runtimes were available: untested on older OS. `ASAuthorization initWithProvider:credential:` is not in public headers (init unavailable); keep the subclass fallback and run the `native`/harness suite on the oldest CI runtime.
- Private-ish surface: relies on the credential classes' getters (public API) and the non-public `initWithProvider:credential:`. Property overrides are API-level, so risk is low and localised to `makeAuthorization`.
- AAGUID and attestation: `fmt: none` accepted by default; servers requiring attestation/allow-listed AAGUIDs reject it (already documented in the plan).
- Autofill/conditional UI timing divergence (Q2).
- UV non-match has no faithful single-shot error (documented above).
- Real-OS runs need the Face ID flow: sheet X and Cancel both end as 1001; there is no separate "biometric lockout" code observed.
- Untested: `ASAuthorizationController.cancel`, extension inputs (PRF/largeBlob values are ignored and nil outputs returned), registration with `attestationPreference: direct`, security-key request completion, multiple controllers in flight.
