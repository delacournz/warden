import Darwin
import Foundation

// Socket mode tells whoever spawned the process that it is accepting connections: one `ready` line on stdout, as soon
// as the socket is listening. The spawner (`warden`) reads it instead of polling for the socket file, then connects
// once. The line is the process-level twin of the per-connection `ready` event: same identity fields, plus the socket
// path and the helper's pid. It never waits for the quiescence stream: that opens in the background (`warmQuiescence`)
// and the first `settle` / relaunched read waits for it, not the handshake.

enum Announce {
  /// `{"event":"ready","socket":…,"pid":…,…identity fields}`.
  static func readyEvent(fields: [String: JSON], socket: String, pid: Int32) -> Event {
    var merged = fields
    merged["socket"] = .string(socket)
    merged["pid"] = .int(Int(pid))
    return .ready(merged)
  }

  /// A pipe or socket on stdout belongs to the spawner, which may stop reading (or exit) while this process stays
  /// resident; a regular file or a terminal never goes away.
  static func isDetachable(mode: mode_t) -> Bool {
    let kind = mode & S_IFMT
    return kind == S_IFIFO || kind == S_IFSOCK
  }

  /// After the ready line, point a pipe `descriptor` at `target` (stderr, the log file `warden` gave us) so later
  /// events land in the log and not in a pipe nobody drains, which would block this process once the pipe fills.
  /// Returns whether it redirected.
  @discardableResult
  static func detach(_ descriptor: Int32, onto target: Int32) -> Bool {
    var info = stat()
    guard fstat(descriptor, &info) == 0, isDetachable(mode: info.st_mode) else { return false }
    return dup2(target, descriptor) >= 0
  }
}
