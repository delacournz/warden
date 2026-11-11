import FBSimulatorAX
import Foundation

/// A step of the wedge check that could not run (the log could not be read, the restart failed).
struct AXWedgeStepFailed: Error, Equatable, LocalizedError, Sendable {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// The simulator's accessibility notification server (in backboardd) stopped answering: on a freshly booted iOS 27 sim
/// it now and then wedges on its first AX use, and every in-sim AX client (SpringBoard, the app, this helper's guest)
/// then blocks on its broadcasts for the life of that boot, so the bridge stalls and the host `ax` reader times out on
/// every read. The sim log says so (`marker`, never logged by a healthy sim). Ending the guests or SpringBoard does
/// not clear it; restarting backboardd does (`launchctl kickstart -k`, ~2 s, SpringBoard and the foreground app go
/// with it), after which a fresh guest reads again.
///
/// The check runs when both readers were silent on one read (`suspect`), in the background and single-flight: one
/// log read, and only when the marker is there AND a short host read still times out (a sim that logged the marker can
/// still answer) a restart, at most `maxRestarts` per helper
/// (`WARDEN_SIMD_AX_WEDGE_RESTARTS`, default 1, `0` = never). A `not-wedged` verdict (a slow sim) is not checked again
/// for `recheckSeconds`. After a restart it waits for a new SpringBoard and runs `afterRestart` (end the stale guests,
/// cold rules, warm-up), so the reads that follow go to a fresh guest.
final class AXWedgeRecovery: @unchecked Sendable {
  static let marker = "Could not auto-register for pid status change"
  static let backboarddService = "user/foreground/com.apple.backboardd"
  static let restartsEnv = "WARDEN_SIMD_AX_WEDGE_RESTARTS"
  static let defaultMaxRestarts = 1
  /// A sim found not wedged is not checked again (log read ~2-10 s on a loaded host) for this long, unless asked.
  static let recheckSeconds: Double = 60
  /// How long a new SpringBoard may take to show up after the restart (~2 s locally).
  static let springBoardWaitSeconds: Double = 15
  static let springBoardPollSeconds: Double = 0.25
  /// How long a read waits for a recovery in flight before it answers `ax_wedge_recovering`: inside the client's 10 s.
  static let waitWhileRecoveringMs = 5000
  /// The host read that confirms the silence before a restart: a healthy one answers in milliseconds.
  static let livenessReadMs = 4000

  enum Outcome: Sendable, Equatable {
    case restarted(ms: Int)
    case notWedged
    case failed(String)

    var name: String {
      switch self {
      case .restarted: return "restarted"
      case .notWedged: return "not-wedged"
      case .failed: return "failed"
      }
    }
  }

  /// What the check does to the simulator; injected so tests never touch one.
  struct Steps: Sendable {
    /// Whether the sim log holds `marker`; throws `AXWedgeStepFailed` when it could not be read.
    var markerLogged: @Sendable () async throws -> Bool
    /// Whether the host `ax` reader is still silent right now (a short read times out). The marker alone is no proof:
    /// a sim that logged it can still answer, and is then left alone.
    var readersSilent: @Sendable () async -> Bool = { true }
    /// The pids of this simulator's SpringBoard right now.
    var springBoards: @Sendable () -> Set<pid_t>
    /// `launchctl kickstart -k` backboardd; throws `AXWedgeStepFailed`.
    var restartBackboardd: @Sendable () async throws -> Void
    /// Runs once SpringBoard is back (or the wait ran out): end the stale guests and start over on fresh ones.
    var afterRestart: @Sendable () async -> Void
    var sleep: @Sendable (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
  }

  /// `WARDEN_SIMD_AX_WEDGE_RESTARTS`: a whole number >= 0; anything else keeps the default, with a warning.
  static func configuredMaxRestarts(
    _ environment: [String: String] = ProcessInfo.processInfo.environment, log: @Sendable (String) -> Void
  ) -> Int {
    guard let raw = environment[restartsEnv] else { return defaultMaxRestarts }
    if let count = Int(raw.trimmingCharacters(in: .whitespaces)), count >= 0 { return count }
    log("\(restartsEnv)=\"\(raw)\" is not a whole number >= 0; using the default \(defaultMaxRestarts)")
    return defaultMaxRestarts
  }

  /// `log show`'s predicate. `log show` logs its own invocation, args (so the marker) included: its lines are left out.
  static let logPredicate = "eventMessage CONTAINS \"\(marker)\" AND process != \"log\""

  /// Whether `log show` output has the marker on a line of its own (never `log`'s own invocation line).
  static func logNamesWedge(_ output: String) -> Bool {
    output.split(separator: "\n").contains { $0.contains(marker) && !$0.contains("log run noninteractively") }
  }

  /// The host reader's service did not answer in time (as opposed to an error it gave).
  static func isServiceSilent(_ error: any Error) -> Bool {
    if let error = error as? AccessibilityError, case .serviceNotAnswering = error { return true }
    return false
  }

  let maxRestarts: Int
  private let steps: Steps
  private let now: @Sendable () -> Double
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()
  private var spent = 0
  private var inFlight: Task<Outcome, Never>?
  private var latest: Task<Outcome, Never>?
  private var last: (outcome: Outcome, at: Double)?

  init(
    maxRestarts: Int, steps: Steps, now: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime },
    log: @escaping @Sendable (String) -> Void
  ) {
    self.maxRestarts = maxRestarts
    self.steps = steps
    self.now = now
    self.log = log
  }

  /// A recovery that never runs (no simulator to act on).
  static let off = AXWedgeRecovery(
    maxRestarts: 0,
    steps: Steps(markerLogged: { false }, springBoards: { [] }, restartBackboardd: {}, afterRestart: {}),
    log: { _ in })

  /// backboardd restarts this helper made.
  var restarts: Int { lock.withLock { spent } }
  var isRecovering: Bool { lock.withLock { inFlight != nil } }
  /// The check in flight, else the last one (tests wait on it).
  var current: Task<Outcome, Never>? { lock.withLock { inFlight ?? latest } }

  /// Both readers were silent on one read: check (or join the check in flight). Nil when the budget is spent, or the
  /// sim was found not wedged within `recheckSeconds`.
  @discardableResult
  func suspect() -> Task<Outcome, Never>? { check(force: false) }

  /// `force` (an explicit ask) skips the `recheckSeconds` window, never the budget.
  @discardableResult
  func check(force: Bool) -> Task<Outcome, Never>? {
    lock.withLock { () -> Task<Outcome, Never>? in
      if let inFlight { return inFlight }
      guard spent < maxRestarts else { return nil }
      if !force, let last, last.outcome == .notWedged, now() - last.at < Self.recheckSeconds { return nil }
      // strong: a check that started finishes (the task drops its closure when it ends)
      let task = Task<Outcome, Never> {
        let outcome = await self.run()
        self.finish(outcome)
        return outcome
      }
      inFlight = task
      latest = task
      return task
    }
  }

  private func finish(_ outcome: Outcome) {
    lock.withLock {
      inFlight = nil
      last = (outcome, now())
    }
  }

  private func run() async -> Outcome {
    let started = ContinuousClock.now
    do {
      guard try await steps.markerLogged() else {
        log("both AX readers silent, but the sim log has no accessibility-server wedge: a slow sim, not restarted")
        return .notWedged
      }
      guard await steps.readersSilent() else {
        log("the sim log names an accessibility-server wedge, but the ax reader answers: not restarted")
        return .notWedged
      }
      let before = steps.springBoards()
      log("both AX readers silent and the sim log says the accessibility server wedged: restarting backboardd")
      try await steps.restartBackboardd()
      lock.withLock { spent += 1 }
      await waitForSpringBoard(replacing: before)
      await steps.afterRestart()
      let ms = Session.elapsedMs(since: started)
      log(
        "restarted backboardd in \(ms) ms (\(restarts) of \(maxRestarts) this helper): the foreground app was quit, reads start on a fresh guest"
      )
      return .restarted(ms: ms)
    } catch {
      let message = (error as? AXWedgeStepFailed)?.message ?? error.localizedDescription
      log("accessibility-server wedge check failed: \(message)")
      return .failed(message)
    }
  }

  private func waitForSpringBoard(replacing before: Set<pid_t>) async {
    var waited = 0.0
    while waited < Self.springBoardWaitSeconds {
      if !steps.springBoards().subtracting(before).isEmpty { return }
      await steps.sleep(Self.springBoardPollSeconds)
      waited += Self.springBoardPollSeconds
    }
    log("no new SpringBoard within \(Int(Self.springBoardWaitSeconds)) s of the backboardd restart; reading on")
  }

  /// Waits up to `ms` for a check in flight; true when it is still running after that.
  func waitWhileRecovering(ms: Int) async -> Bool {
    guard let task = lock.withLock({ inFlight }) else { return false }
    let done = try? await withTimeout(milliseconds: ms, error: { WireError(.timeout, "still recovering") }) {
      await task.value
    }
    return done == nil && isRecovering
  }

  /// What a read gets while a check still runs: retryable, and not `E_AX_UNAVAILABLE` (the client restarts a helper
  /// after two of those in a row, which would end the recovery).
  func recoveringError() -> WireError {
    WireError(
      .timeout,
      "the simulator's accessibility service is being restarted (backboardd wedged); the foreground app is quit, relaunch it once reads answer again",
      retryable: true, detail: ["reason": "ax_wedge_recovering", "stage": "ax-wedge"])
  }

  /// `health.axWedge` and the `axWedge` op's reply: `{restarts, maxRestarts, recovering, last?: {outcome, agoMs,
  /// ms?, error?}}`.
  func state() -> JSON {
    let (count, recovering, last) = lock.withLock { (spent, inFlight != nil, last) }
    var fields: [String: JSON] = [
      "restarts": .int(count), "maxRestarts": .int(maxRestarts), "recovering": .bool(recovering),
    ]
    if let last {
      var entry: [String: JSON] = [
        "outcome": .string(last.outcome.name), "agoMs": .int(max(0, Int(((now() - last.at) * 1000).rounded()))),
      ]
      switch last.outcome {
      case let .restarted(ms): entry["ms"] = .int(ms)
      case let .failed(message): entry["error"] = .string(message)
      case .notWedged: break
      }
      fields["last"] = .object(entry)
    }
    return .object(fields)
  }
}

/// A finished host command.
struct CommandOutput: Sendable, Equatable {
  var exitCode: Int32
  var stdout: String
  var stderr: String

  /// The last line of stderr, or `exit <n>`.
  var failure: String {
    stderr.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").last.map(String.init)
      ?? "exit \(exitCode)"
  }
}

enum HostCommand {
  /// Runs `arguments` (argv[0] looked up on PATH via `/usr/bin/env`), killed after `timeoutSeconds` (exit -1).
  static func run(_ arguments: [String], timeoutSeconds: Double) async -> CommandOutput {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = arguments
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    process.standardInput = FileHandle.nullDevice
    let collected = Collected()
    out.fileHandleForReading.readabilityHandler = { collected.add(out: $0.availableData) }
    err.fileHandleForReading.readabilityHandler = { collected.add(err: $0.availableData) }
    let exit: Int32 = await withCheckedContinuation { continuation in
      process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
      do {
        try process.run()
      } catch {
        process.terminationHandler = nil
        continuation.resume(returning: -1)
        return
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds) {
        if process.isRunning { process.terminate() }
      }
    }
    out.fileHandleForReading.readabilityHandler = nil
    err.fileHandleForReading.readabilityHandler = nil
    collected.add(out: out.fileHandleForReading.readDataToEndOfFile())
    collected.add(err: err.fileHandleForReading.readDataToEndOfFile())
    return CommandOutput(exitCode: exit, stdout: collected.stdout, stderr: collected.stderr)
  }

  private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var outData = Data()
    private var errData = Data()
    func add(out data: Data) { lock.withLock { outData.append(data) } }
    func add(err data: Data) { lock.withLock { errData.append(data) } }
    var stdout: String { lock.withLock { String(decoding: outData, as: UTF8.self) } }
    var stderr: String { lock.withLock { String(decoding: errData, as: UTF8.self) } }
  }
}

extension Session {
  /// The wedge check's steps on this simulator: `simctl spawn … log show` for the marker, `launchctl kickstart -k`
  /// for backboardd, `ps` for SpringBoard, then `afterBackboarddRestart`.
  func axWedgeSteps(run: @escaping @Sendable ([String], Double) async -> CommandOutput = HostCommand.run)
    -> AXWedgeRecovery.Steps
  {
    let udid = udid
    let spawn = ["xcrun", "simctl", "spawn", udid]
    return AXWedgeRecovery.Steps(
      markerLogged: {
        let output = await run(
          spawn + [
            "log", "show", "--last", "5m", "--style", "compact", "--predicate", AXWedgeRecovery.logPredicate,
          ], 20)
        guard output.exitCode == 0 else { throw AXWedgeStepFailed("log show: \(output.failure)") }
        return AXWedgeRecovery.logNamesWedge(output.stdout)
      },
      readersSilent: { [weak self] in
        guard let reader = self?.axHostReader, let screen = self?.screen else { return true }
        let point = CGPoint(x: max(1, screen.width / 2), y: max(1, screen.height / 2))
        do {
          _ = try await withTimeout(
            milliseconds: AXWedgeRecovery.livenessReadMs, error: { WireError(.timeout, "ax liveness read") }
          ) { try await reader.hitTest(at: point, options: AccessibilityRequestOptions()) }
          return false
        } catch let error as WireError where error.code == .timeout {
          return true
        } catch {
          return AXWedgeRecovery.isServiceSilent(error)
        }
      },
      springBoards: { Set(GuestReaper.children(of: udid, in: GuestReaper.system.list(), matching: "/SpringBoard.app/SpringBoard")) },
      restartBackboardd: {
        let output = await run(spawn + ["launchctl", "kickstart", "-k", AXWedgeRecovery.backboarddService], 20)
        guard output.exitCode == 0 else { throw AXWedgeStepFailed("restart backboardd: \(output.failure)") }
      },
      afterRestart: { [weak self] in await self?.afterBackboarddRestart() })
  }

  /// After backboardd restarted: the guests still talk to the dead server, so they are ended (idb starts a fresh one on
  /// the next read), the stream is reopened, the gate forgets the stalls they caused, the guest gets cold rules and a
  /// background warm-up, and the pids of the app that was quit are forgotten.
  func afterBackboarddRestart(reaper: GuestReaper = .system) async {
    let ended = reaper.reap(udid: udid)
    quiescence.wedge.didReap()
    bundlePids.forgetAll()
    bridgeWarmth.markCold()
    bridgeStall.recordSuccess()
    bridgeHealth.recordSuccess()
    await quiescence.existing?.restart()
    OpLog.shared.log(.info, "ended \(ended.count) stale AX guest(s) after the backboardd restart", op: "axWedge")
    warmBridge()
  }

  /// `axWedge{recover?}`: the wedge check's state; `recover:true` runs the check now (or joins the one in flight) and
  /// answers when it is over, with `checked` = that check's outcome. Nothing runs (no `checked`) when the budget is spent.
  func axWedge(recover: Bool) async -> JSON {
    await Session.axWedge(axWedgeRecovery, recover: recover)
  }

  static func axWedge(_ recovery: AXWedgeRecovery, recover: Bool) async -> JSON {
    guard recover, let task = recovery.check(force: true) else { return recovery.state() }
    let outcome = await task.value
    var reply = recovery.state().objectValue ?? [:]
    reply["checked"] = .string(outcome.name)
    return .object(reply)
  }
}
