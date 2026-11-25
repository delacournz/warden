// swift-tools-version:6.0
import PackageDescription

// warden-simd: the iOS-simulator helper behind @delacour/warden-e2e.
//
// It links idb's *library package* (`../idb-libraries`, produced by `bun native/scripts/deps.ts`: the pinned
// release tarball, or a `--from-source` build of a shallow idb clone at the pinned tag). `FBSimulatorAX` pulls in
// FBSimulatorControl + FBControlCore + the private-framework stubs + FBSimulatorBridgeProtocol.
let package = Package(
  name: "warden-simd",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "warden-simd", targets: ["warden-simd"]),
    .executable(name: "warden-emud", targets: ["warden-emud"]),
  ],
  dependencies: [
    .package(name: "idb-libraries", path: "../idb-libraries")
  ],
  targets: [
    // The H.264 stream pieces (VideoToolbox encoder, pacer, AU framing, socket) shared by warden-simd (the
    // simulator display) and warden-emud (an Android emulator's gRPC frames). No idb dependency.
    .target(
      name: "WardenStream",
      path: "Sources/WardenStream"
    ),
    // An Android emulator's gRPC screenshot stream (h2c, MMAP frames) into WardenStream: the library warden-emud
    // serves and its tests drive against a fake bridge.
    .target(
      name: "WardenEmu",
      dependencies: ["WardenStream"],
      path: "Sources/WardenEmu"
    ),
    .executableTarget(
      name: "warden-emud",
      dependencies: ["WardenEmu"],
      path: "Sources/warden-emud"
    ),
    .executableTarget(
      name: "warden-simd",
      dependencies: [
        "WardenStream",
        .product(name: "FBSimulatorAX", package: "idb-libraries"),
      ],
      path: "Sources/warden-simd",
      // The stub frameworks (CoreSimulatorStub, AccessibilityPlatformTranslationStub) are staged next to the
      // binary and linked as `@rpath/...`. SwiftPM from Xcode 27 (Swift 6.2) no longer adds an rpath for the
      // binary's own directory, so without this dyld only searched /usr/lib/swift and the toolchain
      // (`Library not loaded`, exit 134). scripts/build.ts fails the build if the rpath is missing.
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path"])]
    ),
    .testTarget(
      name: "warden-simdTests",
      dependencies: ["warden-simd", "WardenStream"],
      path: "Tests/warden-simdTests"
    ),
    .testTarget(
      name: "warden-emudTests",
      dependencies: ["WardenEmu", "WardenStream"],
      path: "Tests/warden-emudTests"
    ),
  ]
)
