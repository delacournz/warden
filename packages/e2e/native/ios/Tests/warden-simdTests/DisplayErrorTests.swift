import FBSimulatorControl
import XCTest

@testable import warden_simd

/// A read taken while the simulator display is still rotating fails with idb's `SimulatorDisplayError`; it clears
/// once the rotation settles, so a polling caller must be told to look again rather than give up.
final class DisplayErrorTests: XCTestCase {
  func testADisplayStillChangingIsRetryable() {
    for error in [SimulatorDisplayError.changed, .transitioning] {
      let wire = WireError.from(error)
      XCTAssertEqual(wire.code, .internal, "\(error)")
      XCTAssertTrue(wire.retryable, "\(error)")
      XCTAssertEqual(wire.detail?["reason"], "display_changing", "\(error)")
    }
  }

  func testAMissingDisplayIsNotRetryable() {
    let wire = WireError.from(SimulatorDisplayError.noActiveIntegratedDisplay)
    XCTAssertEqual(wire.code, .internal)
    XCTAssertFalse(wire.retryable)
  }

  func testBothReadersFailingOnARotationStaysRetryable() {
    let wire = WireError.from(
      AXReadersFailed(bridgeReason: "display changed", host: SimulatorDisplayError.changed))
    XCTAssertTrue(wire.retryable)
  }
}
