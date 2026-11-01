import FBSimulatorAX
import XCTest

@testable import warden_simd

/// The stuck-stream policy behind `settle`, driven with an injected clock (no simulator): a guest that reports
/// `busy(runLoopIdle, animationsInactive)` once and then goes silent must not burn the whole budget.
final class SettleTests: XCTestCase {
  private let both: QuiescenceState = .busy([.runLoopIdle, .animationsInactive])
  private let judge = SettleJudge()

  /// Replays a silent stream: state fixed, time advancing in 100 ms ticks. Returns the decisions with their time.
  private func replay(state: QuiescenceState?, since: Double = 0, begun: Double = 0, quietMs: Int = 250, until: Double)
    -> [(ms: Int, decision: SettleDecision)]
  {
    var tracker = StuckTracker()
    var restarted = false
    var out: [(Int, SettleDecision)] = []
    var tick = 0
    while begun + Double(tick) / 10 <= until {
      let now = begun + Double(tick) / 10
      let quiet = QuietClock.isSettled(state: state, since: max(since, begun), now: now, quietMs: quietMs)
      let stuck = tracker.observe(state, now: now)
      let decision = judge.decide(isQuiet: quiet, stuckForMs: stuck, restarted: restarted)
      if decision == .restartStream { restarted = true }
      out.append((Int(((now - begun) * 1000).rounded()), decision))
      tick += 1
    }
    return out
  }

  func testSilentStuckStreamRestartsOnceThenFallsBack() {
    let timeline = replay(state: both, until: 1.5)
    let restarts = timeline.filter { $0.decision == .restartStream }
    XCTAssertEqual(restarts.map(\.ms), [400])
    XCTAssertEqual(timeline.first { $0.decision == .fallback }?.ms, 700)
    XCTAssertTrue(timeline.prefix { $0.ms < 400 }.allSatisfy { $0.decision == .wait })
  }

  /// A guest that never answers must not cost the caller seconds: the fallback decides well inside a second, so
  /// with the 250 ms of identical reads it needs the settle answers in about a second, not 2.3.
  func testTheFallbackStartsWellInsideASecond() {
    XCTAssertLessThanOrEqual(SettleJudge().fallbackAfterMs, 700)
    XCTAssertLessThan(SettleJudge().restartAfterMs, SettleJudge().fallbackAfterMs, "the restart would never run")
  }

  func testQuietStreamNeverRestartsOrFallsBack() {
    let timeline = replay(state: .quiet, since: -10, until: 3)
    XCTAssertTrue(timeline.allSatisfy { $0.decision == .quiet || $0.decision == .wait })
    XCTAssertTrue(timeline.filter { $0.ms >= 300 }.allSatisfy { $0.decision == .quiet })
  }

  func testQuietIsCountedFromTheCallNotFromAStaleSample() {
    let timeline = replay(state: .quiet, since: -10, begun: 5, quietMs: 250, until: 5.5)
    XCTAssertEqual(timeline.first { $0.decision == .quiet }?.ms, 300)
  }

  func testOneBusySignalIsAnAppDoingWorkNotAStuckStream() {
    let timeline = replay(state: .busy([.animationsInactive]), until: 6)
    XCTAssertTrue(timeline.allSatisfy { $0.decision == .wait })
  }

  func testNoStateYetIsALaunchingAppNotAStuckStream() {
    let timeline = replay(state: nil, until: 6)
    XCTAssertTrue(timeline.allSatisfy { $0.decision == .wait })
  }

  func testAnAnswerResetsTheStuckClock() {
    var tracker = StuckTracker()
    XCTAssertEqual(tracker.observe(both, now: 0), 0)
    XCTAssertEqual(tracker.observe(both, now: 0.8), 800)
    XCTAssertNil(tracker.observe(.settling, now: 0.9))
    XCTAssertEqual(tracker.observe(both, now: 1.0), 0)
  }

  func testNoStateKeepsTheStuckClockRunning() {
    var tracker = StuckTracker()
    _ = tracker.observe(both, now: 0)
    XCTAssertEqual(tracker.observe(nil, now: 0.5), 500)
  }

  func testStuckTimeIsTheSameWhenTheStateEventRepeats() {
    var tracker = StuckTracker()
    _ = tracker.observe(both, now: 0)
    XCTAssertEqual(tracker.observe(.busy([.animationsInactive, .runLoopIdle]), now: 1.2), 1200)
  }

  func testFrameStabilityNeedsTwoEqualReadsApart() {
    var stability = FrameStability()
    let a = Data("a".utf8)
    let b = Data("b".utf8)
    XCTAssertFalse(stability.observe(a, now: 0, quietMs: 250))
    XCTAssertFalse(stability.observe(a, now: 0.2, quietMs: 250))
    XCTAssertFalse(stability.observe(b, now: 0.3, quietMs: 250))
    XCTAssertFalse(stability.observe(b, now: 0.5, quietMs: 250))
    XCTAssertTrue(stability.observe(b, now: 0.56, quietMs: 250))
  }

  func testCustomThresholds() {
    let quick = SettleJudge(restartAfterMs: 100, fallbackAfterMs: 200)
    XCTAssertEqual(quick.decide(isQuiet: false, stuckForMs: 100, restarted: false), .restartStream)
    XCTAssertEqual(quick.decide(isQuiet: false, stuckForMs: 100, restarted: true), .wait)
    XCTAssertEqual(quick.decide(isQuiet: false, stuckForMs: 200, restarted: true), .fallback)
    XCTAssertEqual(quick.decide(isQuiet: true, stuckForMs: 900, restarted: true), .quiet)
  }
}
