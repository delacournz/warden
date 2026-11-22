#!/usr/bin/env bash
# PASS-0b spike: build provider.apk + caller.apk without Gradle.
# usage: build-spike.sh <libs-dir> <out-dir>   (libs-dir: credentials-classes.jar kotlin-stdlib-*.jar biometric-classes.jar)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIBS="$1"; OUT="$2"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/36.0.0"
AJAR="$SDK/platforms/android-36/android.jar"
mkdir -p "$OUT"
[ -f "$OUT/debug.keystore" ] || keytool -genkeypair -keystore "$OUT/debug.keystore" -storepass android -keypass android \
  -alias warden -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=warden passkeys debug" >/dev/null 2>&1
CP="$(ls "$LIBS"/*.jar | tr '\n' ':')"
build() { # name pkgdir
  local name="$1" dir="$HERE/$1" w="$OUT/$1"
  rm -rf "$w"; mkdir -p "$w/gen" "$w/classes"
  local res=()
  [ -d "$dir/res" ] && { "$BT/aapt2" compile --dir "$dir/res" -o "$w/res.zip"; res+=("$w/res.zip"); }
  # androidx.credentials needs its own R (3 drawables, 2 strings): compile the AAR's res and emit androidx/credentials/R.java
  "$BT/aapt2" compile --dir "$HERE/libres" -o "$w/libres.zip"; res+=("$w/libres.zip")
  "$BT/aapt2" link --extra-packages androidx.credentials -I "$AJAR" --manifest "$dir/AndroidManifest.xml" --java "$w/gen" --min-sdk-version 34 --target-sdk-version 34 --proguard "$w/aapt-rules.pro" \
    -o "$w/base.apk" ${res[@]+"${res[@]}"}
  javac -source 11 -target 11 -Xlint:-options -cp "$AJAR:$CP" -d "$w/classes" $(find "$dir/src" "$w/gen" -name '*.java') 2>&1 | grep -v "^Note:\|warning: unknown enum constant\|class file for androidx.annotation" || true
  if [ "${SHRINK:-0}" = 1 ]; then
    java -cp "$BT/lib/d8.jar" com.android.tools.r8.R8 --release --min-api 34 --lib "$AJAR" --output "$w" --no-minification \
      --pg-conf "$HERE/rules.pro" --pg-conf "$w/aapt-rules.pro" $(find "$w/classes" -name '*.class') $(ls "$LIBS"/*.jar) 2>"$w/d8.log" || { cat "$w/d8.log"; exit 1; }
  else
    "$BT/d8" --min-api 34 --lib "$AJAR" --output "$w" $(find "$w/classes" -name '*.class') $(ls "$LIBS"/*.jar) 2>"$w/d8.log" || { cat "$w/d8.log"; exit 1; }
  fi
  cp "$w/base.apk" "$w/unsigned.apk"
  (cd "$w" && zip -q -j unsigned.apk classes.dex)
  "$BT/zipalign" -f -p 4 "$w/unsigned.apk" "$w/aligned.apk"
  "$BT/apksigner" sign --ks "$OUT/debug.keystore" --ks-pass pass:android --key-pass pass:android --ks-key-alias warden \
    --out "$OUT/$name.apk" "$w/aligned.apk"
  ls -l "$OUT/$name.apk"
}
build provider
build caller
