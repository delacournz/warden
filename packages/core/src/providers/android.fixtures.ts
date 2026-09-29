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
