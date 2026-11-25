import Foundation

/// What the stream pieces throw. The codes are the helper wire's (`E_*`), so a host maps one onto its own error
/// type by name (`warden-simd` `WireError.from`, `warden-emud`'s replies).
package struct StreamError: Error, Equatable, Sendable, CustomStringConvertible {
  package enum Code: String, Sendable {
    case badRequest = "E_BAD_REQUEST"
    case timeout = "E_TIMEOUT"
    case io = "E_IO"
    case unsupported = "E_UNSUPPORTED"
    case `internal` = "E_INTERNAL"
  }

  package let code: Code
  package let message: String

  package init(_ code: Code, _ message: String) {
    self.code = code
    self.message = message
  }

  package var description: String { "\(code.rawValue): \(message)" }
}
