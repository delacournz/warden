# Android emulator slim baseline — 2026-10-18 (WDN-ASLIM, phase ASLIM-0)

- **Host:** Mac16,7, Apple M4 Pro, 14 cores, 48 GB RAM, macOS 26.6.2
- **Toolchain:** Android emulator 37.1.11.0 (gfxstream), adb 1.0.41, bun 1.3.14, warden b582c0c (`feature/e2e-android-slim`)
- **Host load at start:** 4.27 (two foreign iOS sims booted and left alone; otherwise idle)
- **Device:** `emulator-5554`, AVD `Pixel_10` (android-37.1 `google_apis_playstore_ps16k` arm64, API 37 / Android 17), 4 cores; config.ini says 2048 MB RAM but the emulator forces 4096 MB for this image ("Increasing RAM size to 4096MB"), claimed via `warden claim android --label aslim`
- **Launch (warden's):** `emulator -avd Pixel_10 -port 5554 -no-window -read-only -no-snapshot-save -no-boot-anim`
- **Question:** `warden sim slim` disables launchd daemons on iOS sims. Is there an equivalent worth building for emulators, and which lever is it? Plan: `~/.claude/plans/i-think-the-better-serene-dragonfly.md`.

**Bar for "worth it"** (set before measuring): ≥ 10 percentage points of one host core sustained, **or** ≥ 300 MB qemu RSS per emulator, **or** ≥ 5 % suite wall time.

## Headline

1. **Every warden boot is a cold boot.** All 13 boots in `$WARDEN_HOME/logs/emulator-5554.log` print `Failed to load snapshot 'default_boot'`; the latest reason is `snapshot was created with gfxstream=0, but this emulator has gfxstream=1` (the AVD's `default_boot`, saved 2026-10-16 with `hw.gpu.mode = lavapipe`, is incompatible with warden's headless gfxstream launch). Boot completed in 11–15 s on this quiet host and 30–61 s in earlier, loaded sessions. Because `-no-snapshot-save` is set, the snapshot is never repaired, and every claim replays the first-boot job storm (Messages RCS provisioning, Photos, TTS, Play Store, `apps.restore` all wake). A compatible snapshot would turn that into a ~5 s restore of a settled image.
2. **The renderer is software.** `-gpu auto` under `-no-window` selected `gles_mode_selected:swangle` / `vulkan_mode_selected:lavapipe` (ANGLE on SwiftShader, llvmpipe Vulkan). Every guest frame is rendered on the CPU.
3. **The guest is idle; the cost is the emulator.** Steady-state guest CPU is ~4 % of 400 %; the qemu process still averages 12 % of a host core and holds **7.9 GB RSS**. Google's apps hold ~700 MB of guest PSS but burn no CPU once the boot storm settles. A package denylist cannot reach the bar on CPU, and freed guest pages do not shrink qemu's host RSS.
4. **Verifier settings were already off** on this AVD (`package_verifier_enable=0`, `verifier_verify_adb_installs=0`, `package_verifier_user_consent=-1` baked into its userdata by some earlier writable boot). ASLIM-1 makes that true for every emulator warden boots, which this measurement cannot show a delta for; see section D.

## Windows (host `top -l 150 -s 2 -pid <qemu>`, guest `top -b -n 150 -d 2`, 5 min each, no driver attached)

| window | emulator age | qemu CPU mean / p50 / p95 (% of one core) | qemu RSS | threads | guest CPU mean / p95 (% of 400) | guest procs |
|---|---|---|---|---|---|---|
| settle (stock) | 2–7 min | 18.4 / 14.4 / 43.7 | 7.87 GB | 144 | 5 / 13 | 313 |
| steady (stock) | 8–13 min | 12.3 / 10.9 / 19.7 | 7.88 GB | 123 | 4 / 6 | 303 |
| tier 1 disabled | 14–19 min | 7.0 / 6.1 / 13.1 | 7.89 GB | 122 | 2 / 4 | 294 |
| tier 1 + tier 2 disabled | 20–25 min | 7.1 / 6.2 / 13.5 | 7.90 GB | 121 | 2 / 4 | 290 |
| everything re-enabled (control) | 27–32 min | 8.1 / 5.9 / 24.5 | 7.96 GB | 121 | 2 / 6 | 302 |

Guest top consumers, stock steady window (mean % of 400, RSS): Messages 0.9 % / 52 MB (RCS provisioning retries), system_server 0.6 % / 95 MB, sensors HAL 0.5 %, composer 0.4 %, surfaceflinger 0.3 %, SystemUI 0.1 %, GMS family 0.1 % / 192 MB, Play Store 0.0 % / 108 MB, Google app 0.0 % / 50 MB, Android System Intelligence 0.0 % / 115 MB, Photos 0.0 % / 43 MB, TTS 0.0 % / 31 MB, Wellbeing 0.0 % / 31 MB.

Guest meminfo, settle: Total 4,062 MB, Used 2,435 MB (1,993 MB PSS + 442 MB kernel), Free 1,799 MB; swap 537 MB used. Top PSS: system 206 MB, gms 157 MB, Messages 154 MB (+57 MB `:rcs`), gms.persistent 130 MB, SystemUI 118 MB, Photos 116 MB, Google app 91 MB, launcher 87 MB, gms.unstable 79 MB, Gboard 79 MB, TTS 74 MB, ASI 74 MB (+30 MB `:captions`), Play Store 71 MB (+59 MB `:background` +36 MB `:quick_launch`).

## C. Package disables (by hand, `pm disable-user --user 0` + `am force-stop`)

Tier 1 (present on this image): `com.android.vending`, `com.google.android.googlequicksearchbox`, `com.google.android.apps.wellbeing`, `com.google.android.as`, `com.google.android.as.oss` (`com.google.android.apps.turbo` is not installed). Tier 2 (present): YouTube, YT Music, Gmail, Messages, Maps, Photos, Docs, Calendar, TTS, Feedback, Partner Setup, Android Auto, Safety Hub (Play Movies, Files, Meet, ARCore are not installed). GMS, GSF, Gboard, launcher, SystemUI, permissioncontroller, packageinstaller, WebView/Chrome, providers, telephony, mainline modules: never touched.

| | guest used RAM (PSS + kernel) | guest procs | qemu CPU mean | qemu RSS |
|---|---|---|---|---|
| stock, settle | 2,435 MB | 313 | 18.4 % | 7.87 GB |
| stock, steady | n/a | 303 | 12.3 % | 7.88 GB |
| tier 1 disabled | 1,566 MB | 294 | 7.0 % | 7.89 GB |
| tier 1 + 2 disabled | 1,502 MB | 290 | 7.1 % | 7.90 GB |
| re-enabled (control) | 2,103 MB | 302 | 8.1 % | 7.96 GB |

- Every `pm disable-user` killed its processes at once; `am force-stop` after it is belt-and-braces. GMS did **not** re-enable Play Store over 10 min; the disabled set was unchanged at the end of every window.
- Tier 1 freed ~870 MB of guest PSS and dropped guest CPU from 4 % to 2 % of 400 %. Tier 2 on top freed 64 MB more and nothing in CPU: those apps were already idle, their resident processes are just cached. Only GMS (three processes, 193 MB) and `com.android.providers.calendar` survived the tier-2 grep, as intended.
- **Host RSS never moved** (7.87 → 7.90 GB while the guest freed 930 MB): once qemu has touched a guest page it keeps it mapped. Guest savings do not reach the host without free-page reporting / ballooning, which this launch does not enable.
- The qemu CPU drop (12.3 → 7.0 %) was mostly the emulator ageing out of its boot storm: with everything re-enabled the control window averaged 8.1 % (p50 5.9 %). Tier 1 is worth about 1 point of one host core; tier 2 nothing. Guest used RAM rebounded to 2,103 MB within 5 min of re-enabling as the Google app and ASI restarted.

## D. Verifier settings and `adb install`

Example Release apk (110 MB), uninstall + `adb install` cycles, 3 each:

| verifier | install wall time |
|---|---|
| on (stock playstore defaults) | 4.76 s, 2.48 s, 2.17 s; a first `install -r` took 12.01 s |
| off (`package_verifier_enable 0`, `verifier_verify_adb_installs 0`, `package_verifier_user_consent -1`) | 1.28 s, 0.80 s, 0.81 s |

Off saves 1.4–3.5 s per install and up to ~11 s on the first one after boot. No Play Protect consent dialog appeared (focus stayed on the launcher), because this image has no Google account signed in. ASLIM-1 ships this as a default.

Side finding: `install -r` failed with `INSTALL_FAILED_INSUFFICIENT_STORAGE` once the settings flipped, because `/data` is 92 % full (469 MB free of the AVD's 6 GB data partition). A 110 MB reinstall needs room for both copies plus dexopt. Every warden emulator of this AVD inherits that full partition, so `warden app ensure` reinstalls can fail. Growing `disk.dataPartition.size` or wiping the AVD's userdata is a user decision.

## E. Launch flags on a hand-launched second emulator (not warden's)

A temporary second emulator of the same AVD on port 5556, launched by hand with warden's flags plus the extras, killed after each run. One run each. qemu was sampled 30–150 s after `sys.boot_completed`, so the numbers sit inside the cold-boot storm and are noisy.

| flags added | renderer | snapshot | wall to boot | qemu CPU mean | qemu RSS |
|---|---|---|---|---|---|
| none (warden's launch) | gfxstream, swangle | failed: "different renderer configured" | 11 s | 33.4 % | 7.87 GB |
| `-no-audio -no-metrics` | gfxstream, swangle | failed, same reason | 9 s | 24.1 % | 7.96 GB |
| `+ -camera-back none -camera-front none` | gfxstream, swangle | failed, same reason | 9 s | 30.1 % | 7.69 GB |
| `-gpu host` | gfxstream, host | failed, same reason | 58 s | 54.4 % | 7.41 GB |

- No flag fixes quickboot. The snapshot was saved under `hw.gpu.mode = lavapipe` without gfxstream, and every launch is refused on the renderer, whatever else changes.
- The audio, metrics and camera flags show no difference outside boot-storm noise in single runs. They are not worth a default on this evidence.
- `-gpu host` is slower to boot and busier early on. Keep `auto`.

## F. Driver smoke with tier 1 disabled

`bun test --preload @delacour/warden-e2e/preload ./e2e/sign-in.e2e.ts ./e2e/onboarding.e2e.ts` by hand on the leased emulator, with tier 1 disabled: **4 pass, 0 fail, 10.9 s**. That covers field fills, so typing through Gboard works, and it covers taps, waits and the app launch. `exec-out screencap -p` returned a 73 KB PNG. The crash buffer had 0 `FATAL` / "keeps stopping" entries. Every package was re-enabled before release, and the disabled set matched stock.

## Verdict

| lever | measured | bar met | recommendation |
|---|---|---|---|
| tier-1 denylist (Play Store, Google app, Wellbeing, ASI) | about −1 point of one host core vs control; −870 MB guest PSS; host RSS unchanged | **no** | do not build ASLIM-2..4 now |
| tier-2 denylist (consumer apps) | ~0 CPU, −64 MB guest PSS | **no** | drop |
| verifier settings | −1.4 to −3.5 s per install, up to −11 s on the first | yes, on suite wall time with app installs | **shipped as ASLIM-1** |
| `-no-audio`, `-no-metrics`, camera none | no difference outside noise | **no** | drop ASLIM-5 |
| `-gpu host` | slower boot, busier | **no** | keep `auto` |
| GMS restricted | GMS burns ~0.1 % at steady state | **no** | drop |
| **a compatible quickboot snapshot** | every claim cold-boots today (11–61 s, plus a 5–10 min storm at 12–18 % host CPU) | very likely | **next plan**, see below |

**Why an iOS-style slim does not carry over.** An iOS sim runs 200–250 daemons that keep burning. An emulator's guest is idle once its boot storm ends, at 2–4 % of 400 %. The host cost is qemu itself: about 8 GB RSS, which guest-side disables never hand back, and the software renderer. The real Android lever is boot, not packages. Today every warden claim is a cold boot that replays the storm, because the AVD's snapshot was saved under a different renderer and `-no-snapshot-save` never repairs it.

**Next plan (proposed, not started):** a warden-owned Android golden. It mirrors `warden golden` for iOS: warden copies the AVD as `warden-golden-<profile>`, boots it writable once with warden's exact launch flags, lets the storm settle, applies the boot settings, saves `default_boot`, and claims boot `-read-only` from it. That gives a snapshot that matches the renderer, a settled guest, and a reset point for the full `/data`. It never touches the user's own AVD.

## Side findings

- **Claim race (bug):** the first `warden claim android` of this session launched the emulator, then `provider.boot()` (`packages/core/src/claim.ts:187`) ran before adb listed the new serial and failed with "emulator-5554 is not running — android devices are created, not booted", leaving an unleased, warden-launched emulator running. The second claim reused it. `boot()` for Android should tolerate a serial adb has not registered yet (or claim should skip `boot` after `create`).
- `~/.warden/logs/<serial>.log` is appended across boots (13 boots in one file); a per-boot header or rotation would make "did the snapshot load" greppable per claim.
- A foreign app (`com.makingautoeasy.app`) is installed in the AVD's userdata and runs on every boot.
