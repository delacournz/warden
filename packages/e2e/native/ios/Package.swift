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
    .executable(name: "warden-simd", targets: ["warden-simd"])
  ],
  dependencies: [
    .package(name: "idb-libraries", path: "../idb-libraries")
  ],
  targets: [
    .executableTarget(
      name: "warden-simd",
      dependencies: [
        .product(name: "FBSimulatorAX", package: "idb-libraries")
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
      dependencies: ["warden-simd"],
      path: "Tests/warden-simdTests"
    ),
  ]
)
