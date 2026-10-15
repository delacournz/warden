import Foundation

/// Command line of `warden-simd`. Exit codes: 0 ok / 2 args / 3 device bootstrap (after a `fatal` event) / 4 internal.
enum ExitCode {
  static let ok: Int32 = 0
  static let usage: Int32 = 2
  static let bootstrap: Int32 = 3
  static let internalFailure: Int32 = 4
}

struct Arguments: Equatable {
  enum Mode: Equatable {
    case serve
    case version
    case health
  }

  enum HIDChoice: String, Equatable {
    case indigo
    case dtuhid
  }

  enum AXChoice: String, Equatable {
    case axbridge
    case ax
  }

  var mode: Mode = .serve
  var udid: String?
  var resources: String?
  var log: String?
  var verbose = false
  /// Emits a `log` event per quiescence sample (`settle` diagnostics). `WARDEN_SIMD_TRACE=1` does the same.
  var trace = false
  var hid: HIDChoice?
  var ax: AXChoice?
  /// Socket mode: serve many clients on this unix socket instead of stdio.
  var socket: String?
  /// Seconds with no client and no op in flight before a socket-mode process exits (0 = never).
  var idleTimeout = Arguments.defaultIdleTimeout

  static let defaultIdleTimeout = 600

  static let usage = """
    usage: warden-simd --udid <UDID> [--socket <path> [--idle-timeout <s>]] [--resources <dir>] [--log <file>] [--verbose] [--trace]
                       [--hid indigo|dtuhid] [--ax axbridge|ax]
           warden-simd --health --udid <UDID>
           warden-simd --version
    """

  struct Failure: Error, Equatable {
    let message: String
  }

  static func parse(_ argv: [String]) -> Result<Arguments, Failure> {
    var result = Arguments()
    var index = 0
    var idleTimeoutGiven = false

    func value(for flag: String, inline: String?) -> Result<String, Failure> {
      if let inline { return .success(inline) }
      index += 1
      guard index < argv.count, !argv[index].hasPrefix("--") else {
        return .failure(Failure(message: "\(flag) needs a value"))
      }
      return .success(argv[index])
    }

    while index < argv.count {
      let raw = argv[index]
      var flag = raw
      var inline: String?
      if raw.hasPrefix("--"), let equals = raw.firstIndex(of: "=") {
        flag = String(raw[raw.startIndex..<equals])
        inline = String(raw[raw.index(after: equals)...])
      }
      switch flag {
      case "--version":
        result.mode = .version
      case "--health":
        result.mode = .health
      case "--trace":
        result.trace = true
      case "--verbose":
        result.verbose = true
      case "--udid", "--resources", "--log", "--hid", "--ax", "--socket", "--idle-timeout":
        switch value(for: flag, inline: inline) {
        case let .failure(failure): return .failure(failure)
        case let .success(text):
          switch flag {
          case "--udid": result.udid = text
          case "--resources": result.resources = text
          case "--log": result.log = text
          case "--socket": result.socket = text
          case "--idle-timeout":
            guard let seconds = Int(text), seconds >= 0 else {
              return .failure(Failure(message: "--idle-timeout must be a non-negative number of seconds"))
            }
            result.idleTimeout = seconds
            idleTimeoutGiven = true
          case "--hid":
            guard let choice = HIDChoice(rawValue: text) else {
              return .failure(Failure(message: "--hid must be indigo or dtuhid"))
            }
            result.hid = choice
          default:
            guard let choice = AXChoice(rawValue: text) else {
              return .failure(Failure(message: "--ax must be axbridge or ax"))
            }
            result.ax = choice
          }
        }
      default:
        return .failure(Failure(message: "unknown argument \(raw)"))
      }
      index += 1
    }

    if result.mode != .version, result.udid == nil || result.udid?.isEmpty == true {
      return .failure(Failure(message: "--udid is required"))
    }
    if idleTimeoutGiven, result.socket == nil {
      return .failure(Failure(message: "--idle-timeout only applies with --socket"))
    }
    if result.socket != nil, result.mode == .health {
      return .failure(Failure(message: "--health is a one-shot and cannot be combined with --socket"))
    }
    if let socket = result.socket, socket.utf8.count > UnixSocket.maxPathBytes {
      return .failure(Failure(message: "--socket path is over the \(UnixSocket.maxPathBytes)-byte unix socket limit"))
    }
    return .success(result)
  }
}
