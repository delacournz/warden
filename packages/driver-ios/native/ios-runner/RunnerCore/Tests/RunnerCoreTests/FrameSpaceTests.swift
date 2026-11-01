import XCTest

@testable import RunnerCore

final class FrameSpaceTests: XCTestCase {
  private let portrait = FrameSpace(interface: .portrait, width: 440, height: 956)

  func testResolveReadsPortraitSizeFromALandscapeRootFrame() {
    let space = FrameSpace.resolve(device: .landscapeLeft, rootFrame: Rect(x: 0, y: 0, width: 956, height: 440))
    XCTAssertEqual(space, FrameSpace(interface: .landscapeLeft, width: 440, height: 956))
  }

  func testResolveFollowsTheRootFrameWhenTheDeviceLiesFlat() {
    let landscape = FrameSpace.resolve(device: .faceUp, rootFrame: Rect(x: 0, y: 0, width: 956, height: 440))
    XCTAssertEqual(landscape.interface, .landscapeLeft)
    let upright = FrameSpace.resolve(device: .faceDown, rootFrame: Rect(x: 0, y: 0, width: 440, height: 956))
    XCTAssertEqual(upright.interface, .portrait)
  }

  func testResolveIgnoresALandscapeDeviceOrientationForAPortraitOnlyApp() {
    let space = FrameSpace.resolve(device: .landscapeRight, rootFrame: Rect(x: 0, y: 0, width: 440, height: 956))
    XCTAssertEqual(space.interface, .portrait)
  }

  func testPortraitIsTheIdentity() {
    let rect = Rect(x: 10, y: 20, width: 30, height: 40)
    XCTAssertEqual(portrait.toPortrait(rect), rect)
    XCTAssertEqual(portrait.toInterface(Point(x: 5, y: 6)), Point(x: 5, y: 6))
  }

  func testLandscapeLeftRectToPortrait() {
    let space = FrameSpace(interface: .landscapeLeft, width: 440, height: 956)
    // The full-screen root: [0,0,956,440] -> [0,0,440,956].
    XCTAssertEqual(space.toPortrait(Rect(x: 0, y: 0, width: 956, height: 440)), Rect(x: 0, y: 0, width: 440, height: 956))
    // Portrait (24,200,392,48) is (200, 440-(24+392), 48, 392) = (200,24,48,392) in landscapeLeft.
    XCTAssertEqual(
      space.toPortrait(Rect(x: 200, y: 24, width: 48, height: 392)), Rect(x: 24, y: 200, width: 392, height: 48))
  }

  func testLandscapeRightRectToPortrait() {
    let space = FrameSpace(interface: .landscapeRight, width: 440, height: 956)
    // Portrait (24,200,392,48) is (956-(200+48), 24, 48, 392) = (708,24,48,392) in landscapeRight.
    XCTAssertEqual(
      space.toPortrait(Rect(x: 708, y: 24, width: 48, height: 392)), Rect(x: 24, y: 200, width: 392, height: 48))
  }

  func testUpsideDownRectToPortrait() {
    let space = FrameSpace(interface: .portraitUpsideDown, width: 440, height: 956)
    XCTAssertEqual(space.toPortrait(Rect(x: 24, y: 708, width: 392, height: 48)), Rect(x: 24, y: 200, width: 392, height: 48))
  }

  func testPointsRoundTripInEveryInterface() {
    let point = Point(x: 123, y: 456)
    for interface in [FrameSpace.Interface.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight] {
      let space = FrameSpace(interface: interface, width: 440, height: 956)
      XCTAssertEqual(space.toPortrait(space.toInterface(point)), point, "\(interface)")
    }
  }

  func testPointAgreesWithRectCentre() {
    let rect = Rect(x: 24, y: 200, width: 392, height: 48)
    for interface in [FrameSpace.Interface.portraitUpsideDown, .landscapeLeft, .landscapeRight] {
      let space = FrameSpace(interface: interface, width: 440, height: 956)
      let centre = space.toInterface(rect.center)
      // The interface-space rect whose portrait image is `rect` has its centre at `toInterface(centre)`.
      let rotated = Rect(x: centre.x - 1, y: centre.y - 1, width: 2, height: 2)
      let back = space.toPortrait(rotated)
      XCTAssertEqual(back.center.x, rect.center.x, accuracy: 1e-9, "\(interface)")
      XCTAssertEqual(back.center.y, rect.center.y, accuracy: 1e-9, "\(interface)")
    }
  }

  func testDeviceOrientationRawValues() {
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 1), .portrait)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 2), .portraitUpsideDown)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 3), .landscapeLeft)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 4), .landscapeRight)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 5), .faceUp)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 6), .faceDown)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 0), .unknown)
    XCTAssertEqual(DeviceOrientation(uiDeviceOrientationRaw: 99), .unknown)
  }
}
