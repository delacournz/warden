/** Real `adb devices -l` output: two emulators (one offline) + a physical phone. */
export const ADB_DEVICES_MIXED = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
emulator-5556          offline transport_id:3
R5CT1234ABC            device usb:1-1 product:a54xnaeea model:SM_A546E device:a54x transport_id:2

`;

export const ADB_DEVICES_EMPTY = `List of devices attached

`;

/** `adb -s emulator-5554 emu avd name` — the console echoes the name then `OK`. */
export const EMU_AVD_NAME_PIXEL_10 = "Pixel_10\r\nOK\r\n";

/** `emulator -list-avds` (newer emulators may print INFO lines first). */
export const EMULATOR_LIST_AVDS = `INFO    | Storing crashdata in: /tmp/android-chris/emu-crash-35.4.9.db
Pixel_10
Pixel_9_Pro_Store
`;

/** Phones in every adb state, a wireless-debugging phone, and a network emulator (`localhost:5555`). */
export const ADB_DEVICES_STATES = `List of devices attached
R5CT1234ABC            device usb:1-1 product:a54xnaeea model:SM_A546E device:a54x transport_id:2
0123456789ABCDEF       unauthorized usb:1-2 transport_id:4
FA7AB1234567           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html]
192.168.1.20:5555      device product:husky model:Pixel_8_Pro device:husky transport_id:5
adb-R5CT9999-abcdef._adb-tls-connect._tcp device product:b model:SM_S901 device:b transport_id:6
localhost:5555         device product:vbox86p model:Genymotion transport_id:7
ZY22OFFLINE            offline usb:1-3 transport_id:8
HEADROOM1              recovery usb:1-4 transport_id:9
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1

`;

/** `getprop ro.boot.qemu; ro.kernel.qemu; ro.serialno; ro.product.model; ro.build.version.sdk` on a real phone. */
export const PHONE_PROPS = "\n\nR5CT1234ABC\nSM-A546E\n34\n";
/** The same on a network emulator. */
export const EMULATOR_PROPS = "1\n1\nEMULATOR35X\nsdk_gphone64_x86_64\n35\n";
