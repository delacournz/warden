import Foundation

/// Device orientation as the wire spells it (`orientation` op, `OrientationData`).
enum DeviceOrientation: String, Equatable, Sendable {
  case portrait, portraitUpsideDown, landscapeLeft, landscapeRight, faceUp, faceDown, unknown

  /// `UIDeviceOrientation.rawValue`: unknown 0, portrait 1, portraitUpsideDown 2, landscapeLeft 3, landscapeRight 4,
  /// faceUp 5, faceDown 6.
  init(uiDeviceOrientationRaw raw: Int) {
    switch raw {
    case 1: self = .portrait
    case 2: self = .portraitUpsideDown
    case 3: self = .landscapeLeft
    case 4: self = .landscapeRight
    case 5: self = .faceUp
    case 6: self = .faceDown
    default: self = .unknown
    }
  }
}

/// XCUITest reports frames in the *interface* orientation's space: in landscape an app's root frame is `[0,0,956,440]`
/// (PHY-0). The wire contract is portrait-up points, like the simulator helper, so every frame read is converted with
/// `toPortrait` and every coordinate sent back converted with `toInterface`.
///
/// `device` is the physical orientation (`UIDeviceOrientation`). `landscapeLeft` (home edge / top rotated to the left)
/// shows the interface rotated clockwise, `landscapeRight` the other way. A flat device (`faceUp`/`faceDown`/`unknown`)
/// says nothing about the interface, so the root frame decides portrait vs landscape, and landscape then assumes
/// `landscapeLeft`.
struct FrameSpace: Equatable, Sendable {
  enum Interface: Equatable, Sendable {
    case portrait, portraitUpsideDown, landscapeLeft, landscapeRight
  }

  var interface: Interface
  /// Screen size in portrait-up points.
  var width: Double
  var height: Double

  init(interface: Interface, width: Double, height: Double) {
    self.interface = interface
    self.width = width
    self.height = height
  }

  /// `rootFrame` is the foreground application's frame as XCUITest reports it now.
  static func resolve(device: DeviceOrientation, rootFrame: Rect) -> FrameSpace {
    let short = min(rootFrame.width, rootFrame.height)
    let long = max(rootFrame.width, rootFrame.height)
    let landscape = rootFrame.width > rootFrame.height
    let interface: Interface
    if landscape {
      interface = device == .landscapeRight ? .landscapeRight : .landscapeLeft
    } else {
      interface = device == .portraitUpsideDown ? .portraitUpsideDown : .portrait
    }
    return FrameSpace(interface: interface, width: short, height: long)
  }

  /// A rect in interface space -> portrait-up space.
  func toPortrait(_ rect: Rect) -> Rect {
    switch interface {
    case .portrait:
      return rect
    case .portraitUpsideDown:
      return Rect(x: width - (rect.x + rect.width), y: height - (rect.y + rect.height), width: rect.width, height: rect.height)
    case .landscapeLeft:
      return Rect(x: width - (rect.y + rect.height), y: rect.x, width: rect.height, height: rect.width)
    case .landscapeRight:
      return Rect(x: rect.y, y: height - (rect.x + rect.width), width: rect.height, height: rect.width)
    }
  }

  /// A point in portrait-up space -> interface space (the inverse of `toPortrait` for points).
  func toInterface(_ point: Point) -> Point {
    switch interface {
    case .portrait: return point
    case .portraitUpsideDown: return Point(x: width - point.x, y: height - point.y)
    case .landscapeLeft: return Point(x: point.y, y: width - point.x)
    case .landscapeRight: return Point(x: height - point.y, y: point.x)
    }
  }

  /// A point in interface space -> portrait-up space.
  func toPortrait(_ point: Point) -> Point {
    switch interface {
    case .portrait: return point
    case .portraitUpsideDown: return Point(x: width - point.x, y: height - point.y)
    case .landscapeLeft: return Point(x: width - point.y, y: point.x)
    case .landscapeRight: return Point(x: point.y, y: height - point.x)
    }
  }
}
