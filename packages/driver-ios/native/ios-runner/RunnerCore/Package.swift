// swift-tools-version:6.0
import PackageDescription

// RunnerCore: everything `warden-runner` does that does not need XCTest, so `swift test` covers it on macOS:
// request validation, element type -> role, landscape -> portrait-up frames, usage id -> keyboard key, the
// snapshot encoder, error classification and the NDJSON/TCP server.
//
// `Sources/RunnerCore/Shared/*` are symlinks to the files `warden-simd` owns (Protocol/Wire.swift, Protocol/NDJSON.swift,
// Model/Element.swift, Model/RoleMap.swift), so the wire format and the role map cannot drift between the two helpers.
// The Xcode project (../WardenRunner.xcodeproj) compiles the same files by path instead of linking this package.
let package = Package(
  name: "RunnerCore",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "RunnerCore", targets: ["RunnerCore"])
  ],
  targets: [
    .target(name: "RunnerCore", path: "Sources/RunnerCore"),
    .testTarget(
      name: "RunnerCoreTests",
      dependencies: ["RunnerCore"],
      path: "Tests/RunnerCoreTests",
      exclude: ["Fixtures"]
    ),
  ],
  swiftLanguageModes: [.v5]
)
