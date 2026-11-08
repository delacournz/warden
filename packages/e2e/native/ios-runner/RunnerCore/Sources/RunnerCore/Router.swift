import Foundation

/// Runs one `RunnerCommand` against the device. The XCTest glue implements it; tests use a fake.
protocol CommandExecutor: AnyObject {
  func execute(_ command: RunnerCommand, op: String) -> Result<JSON, WireError>
}

/// Request line -> response. Ops run one at a time (the caller is the main run loop), and a malformed or unsupported
/// request is answered without touching the device.
enum Router {
  static func respond(to request: Request, executor: any CommandExecutor) -> Response {
    switch CommandParser.parse(request) {
    case let .failure(error):
      return .failure(id: request.id, error: error)
    case let .success(command):
      switch executor.execute(command, op: request.op) {
      case let .success(data): return .success(id: request.id, data: data)
      case let .failure(error): return .failure(id: request.id, error: error)
      }
    }
  }
}
