import CoreGraphics
import Foundation

// The seams between warden-simd's ops and policy code and the simulator backend (today idb's FBSimulatorControl /
// FBSimulatorAX). Ops and policy are typed against the values and protocols in this file and in `Model/RawNode.swift`;
// `Device/IdbAdapter*.swift` are the only files that import the backend. Swapping a capability means writing another
// conformance, not touching an op.

// MARK: - HID

enum HIDDirection: Sendable, Equatable, Hashable {
  case down
  case up
}

enum HIDButton: Sendable, Equatable, Hashable {
  case home
  case lock
  case side
  case siri
  case volumeUp
  case volumeDown
  case applePay
}

/// One HID event, or a sequence of them. The composite cases (`longPress`, `swipe`, `drag`, `buttonPress`) are what the
/// backend builds itself from a few numbers; the rest are single contacts, key edges and pauses that ops compose.
indirect enum HIDEvent: Sendable, Equatable, Hashable {
  case touch(direction: HIDDirection, x: Double, y: Double)
  case twoFingerTouch(direction: HIDDirection, finger1: CGPoint, finger2: CGPoint)
  case keyboard(direction: HIDDirection, keyCode: UInt32)
  case delay(TimeInterval)
  case composite([HIDEvent])
  case longPress(x: Double, y: Double, duration: Double)
  case swipe(xStart: Double, yStart: Double, xEnd: Double, yEnd: Double, delta: Double, duration: Double)
  case drag(
    xStart: Double, yStart: Double, xEnd: Double, yEnd: Double, delta: Double, pressDuration: Double, duration: Double,
    releaseDuration: Double)
  case buttonPress(HIDButton)

  /// The events of a `composite`; nil for any other event.
  var subEvents: [HIDEvent]? {
    if case let .composite(events) = self { return events }
    return nil
  }
}

/// Sends HID events to one simulator. One `send(_:)` is one operation, drained before it returns.
protocol HIDSender: Sendable {
  func send(_ event: HIDEvent) async throws
  /// Delivers each event as the sequence yields it and drains once at the end (one HID operation).
  func send(stream: PacedKeyEvents) async throws
  func shake() async throws
  func close() async
}

// MARK: - Screen

struct ScreenCapture: Sendable {
  var imageData: Data
  var size: CGSize
}

protocol ScreenCapturer: Sendable {
  /// A PNG of the framebuffer; `scale` is a factor in (0, 1] of the native capture (1 = native).
  func capture(scale: Double) async throws -> ScreenCapture
}

// MARK: - Orientation

enum DeviceOrientation: String, Sendable, CaseIterable {
  case unknown
  case portrait
  case portraitUpsideDown
  case landscapeLeft
  case landscapeRight
  case faceUp
  case faceDown
}

protocol OrientationControl: Sendable {
  func current() async throws -> DeviceOrientation
  /// Writes one of the four settable orientations.
  func set(_ orientation: DeviceOrientation) async throws
}

// MARK: - Apps

struct AppLaunchSpec: Sendable, Equatable {
  var bundleID: String
  var arguments: [String]
  var environment: [String: String]
  /// End a running instance first (true), or bring it to the front and answer its pid (false).
  var terminateRunning: Bool
}

protocol AppLifecycle: Sendable {
  func launch(_ spec: AppLaunchSpec) async throws -> pid_t
  func terminate(bundleID: String) async throws
  func processID(bundleID: String) async throws -> pid_t
  func open(url: URL) async throws
}

// MARK: - Device

struct ScreenInfo: Sendable, Equatable {
  var widthPixels: Int
  var heightPixels: Int
  var scale: Double
}

protocol DeviceInfo: Sendable {
  /// `booted`, `shutdown`, `booting`, ... as the wire reports it.
  var stateName: String { get }
  var screenInfo: ScreenInfo? { get }
}

/// How the bridge guest finds the frontmost app (`WARDEN_SIMD_FRONTMOST_METHOD`).
enum FrontmostMethod: String, Sendable, CaseIterable {
  case centerPoint = "center-point"
  case windowServer = "window-server"
  case runningBoard = "runningboard"
}

/// What a backend hands `Session.open`: every capability the ops use, plus what `health` reports about it.
struct DeviceBackend: Sendable {
  var device: any DeviceInfo
  var hid: any HIDSender
  var hidTransport: String
  var screenshots: any ScreenCapturer
  var apps: any AppLifecycle
  var orientation: any OrientationControl
  /// The in-guest reader (`axbridge`); nil when it could not be built.
  var axBridge: (any AXReader)?
  /// The host-side reader (`ax`); nil when it could not be built.
  var axHost: (any AXReader)?
  var bridge: BridgeStatus
  var coreSimulatorVersion: String?
}
