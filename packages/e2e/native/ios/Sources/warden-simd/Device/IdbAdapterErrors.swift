import FBSimulatorAX
import FBSimulatorBridgeProtocol
import FBSimulatorControl
import Foundation

/// The one place idb's error types become `GuestError`s. Every adapter call goes through `IdbErrors.mapping`, so the
/// rest of the helper never sees an idb error.
enum IdbErrors {
  /// Runs `body`, turning any idb error it throws into a `GuestError`; other errors (cancellation, file system) pass.
  static func mapping<T>(_ body: () async throws -> T) async throws -> T {
    do {
      return try await body()
    } catch {
      throw map(error)
    }
  }

  static func mappingSync<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch {
      throw map(error)
    }
  }

  /// `error` as a `GuestError` when it is one of idb's, else `error` unchanged.
  static func map(_ error: any Error) -> any Error {
    if let error = error as? GuestError { return error }
    if let error = error as? AccessibilityError { return guest(accessibility: error) }
    if let error = error as? QuiescenceError { return guest(quiescence: error) }
    if let error = error as? UIAutomationError { return guest(automation: error) }
    if let error = error as? AXBridgeError { return guest(bridge: error) }
    if let error = error as? SimulatorApplicationLaunchError { return guest(launch: error) }
    if let error = error as? SimulatorLaunchCtlError { return guest(launchCtl: error) }
    if let error = error as? SimulatorLifecycleError { return guest(lifecycle: error) }
    if let display = error as? SimulatorDisplayError {
      switch display {
      case .changed, .transitioning: return GuestError.displayChanging(message: display.localizedDescription)
      default: return GuestError.failed(message: display.localizedDescription)
      }
    }
    if error is SimulatorHIDError { return GuestError.hid(message: error.localizedDescription) }
    return error
  }

  private static func guest(automation error: UIAutomationError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case .noElementAtPoint:
      return .noElementAtPoint(message: message)
    case .elementNotFound, .elementNotOnScreen, .frameUnavailable, .valueMismatch:
      return .noElement(message: message, retryable: false)
    case .elementMoved:
      return .noElement(message: message, retryable: true)
    case .timedOut:
      return .timeout(message: message)
    case .markerRequired, .pointOrMarkerRequired, .invalidPollInterval, .traversalCannotAnswer,
      .clientNeedsTranslatorVocabulary:
      return .invalidRequest(message: message)
    case .operationUnsupported:
      return .unsupported(message: message)
    case let .applicationUnavailable(_, pid, bundleID):
      return .appUnavailable(pid: pid, bundleID: bundleID, message: message)
    case let .applicationNotResponding(_, pid, bundleID):
      return .appNotResponding(pid: pid, bundleID: bundleID, message: message)
    case .writeUnconfirmed:
      return .failed(message: message)
    @unknown default:
      return .failed(message: message)
    }
  }

  private static func guest(accessibility error: AccessibilityError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case let .serviceNotAnswering(silence, elapsed, behind):
      var request: String?
      switch silence {
      case let .request(kind, _): request = kind
      case .query: request = "query"
      @unknown default: break
      }
      return .hostSilent(
        request: request, elapsedMs: Int(elapsed * 1000), behindAbandoned: Int(behind),
        frontmost: request == "frontmost", message: message)
    case let .noTranslationObject(query):
      return .hostUnavailable(
        frontmostMissing: query == nil || query == .frontmost, serviceAnswered: true, message: message)
    case .springBoardRestarting, .springBoardNotRunning, .accessibilityUnavailable, .dispatcherUnavailable:
      return .hostUnavailable(frontmostMissing: false, message: message)
    case .simulatorNotBooted:
      return .hostNotBooted(message: message)
    case .elementNotFound:
      return .hostNoElement(message: message)
    default:
      return .hostFailure(message: message)
    }
  }

  private static func guest(quiescence error: QuiescenceError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case .timedOut: return .timeout(message: message)
    case let .targetExited(pid): return .targetExited(pid: pid, message: message)
    case .streamEnded: return .axUnavailable(message: message)
    @unknown default: return .axUnavailable(message: message)
    }
  }

  private static func guest(bridge error: AXBridgeError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case let .applicationUnavailable(pid): return .appUnavailable(pid: pid, bundleID: nil, message: message)
    case let .applicationNotResponding(pid): return .appNotResponding(pid: pid, bundleID: nil, message: message)
    case .assertionFailed: return .noElement(message: message, retryable: false)
    case let .guestNotAnswering(after): return .guestNotAnswering(afterSeconds: after, message: message)
    case .bridgeUnavailable, .readerUnavailable, .guestDiedBeforeBinding, .guestFailure:
      return .bridgeUnavailable(message: message)
    case .frontmostUnresolved: return .frontmostUnresolved(message: message)
    case .socketPathTooLong: return .axUnavailable(message: message)
    @unknown default: return .axUnavailable(message: message)
    }
  }

  private static func guest(launch error: SimulatorApplicationLaunchError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case let .launchingUninstalledApplication(bundleID, _), let .noDataDirectory(bundleID):
      return .appNotInstalled(bundleID: bundleID, message: message)
    case let .applicationAlreadyRunning(bundleID, pid):
      return .appAlreadyRunning(bundleID: bundleID, pid: pid, message: message)
    case .foregroundIfRunningIncompatibleWithWaitForDebugger:
      return .invalidRequest(message: message)
    @unknown default:
      return .failed(message: message)
    }
  }

  private static func guest(launchCtl error: SimulatorLaunchCtlError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case .noMatchingProcesses: return .noRunningProcess(message: message)
    default: return .io(message: message)
    }
  }

  private static func guest(lifecycle error: SimulatorLifecycleError) -> GuestError {
    let message = error.localizedDescription
    switch error {
    case .openURLFailed: return .io(message: message)
    default: return .failed(message: message)
    }
  }
}
