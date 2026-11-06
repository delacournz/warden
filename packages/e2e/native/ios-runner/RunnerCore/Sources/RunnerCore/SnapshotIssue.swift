import Foundation

/// The accessibility server refusing or dropping one snapshot read (`kAXError*`, "Failed to get matching snapshot") on
/// a busy or deep screen. It is transient: the next read usually works. The runner mutes the XCTest issue it records
/// (a recorded issue ends `testServe`), retries the read once, and otherwise answers `E_AX_UNAVAILABLE` (retryable).
/// Kept narrow on purpose: "Timed out while evaluating UI query." and every other issue still record.
enum SnapshotIssue {
  static func isTransient(_ message: String) -> Bool {
    message.contains("kAXError") || message.lowercased().contains("failed to get matching snapshot")
  }

  static func isTransient(error: any Error) -> Bool {
    if let wire = error as? WireError { return wire.code == .axUnavailable }
    return isTransient(String(describing: error)) || isTransient((error as NSError).localizedDescription)
  }

  /// Runs `body`; on a failure `isTransient` accepts, `pause`s and runs it once more. The second failure is thrown.
  static func retryOnce<T>(
    isTransient: (any Error) -> Bool, pause: () -> Void, _ body: () throws -> T
  ) throws -> T {
    do {
      return try body()
    } catch where isTransient(error) {
      pause()
      return try body()
    }
  }
}
