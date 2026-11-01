import XCTest

@testable import warden_simd

private func launchd(_ pid: pid_t, udid: String) -> ProcessEntry {
  ProcessEntry(
    pid: pid, ppid: 1,
    command: "launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/\(udid)/data/var/run/launchd_bootstrap.plist")
}

private func guest(_ pid: pid_t, parent: pid_t) -> ProcessEntry {
  ProcessEntry(
    pid: pid, ppid: parent,
    command: "/x/Resources/SimulatorFrameworkBridge-iOS serve /var/folders/T/idb-sfb-v2/AAAA.sock --idle-timeout 300")
}

private final class EndedLog: @unchecked Sendable {
  private let lock = NSLock()
  private var ended: [pid_t] = []
  func add(_ pid: pid_t) { lock.withLock { ended.append(pid) } }
  var pids: [pid_t] { lock.withLock { ended } }
}

/// A guest wedges some 22-26 s after it starts, so the helper replaces guests that old when an app is relaunched
/// (`rebind`), where the wait for the stream to bind is already being paid. The settle-time reap stays as a backstop.
final class RecycleTests: XCTestCase {
  private let udid = "1A0EC51B-7069-4001-AF8A-432CA3B2D1FD"

  // MARK: policy

  func testGuestsAreRecycledOnceTheyReachTheConfiguredAge() {
    let policy = WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 18)
    XCTAssertFalse(policy.shouldRecycle(guestAge: 17.9, lastReapedAt: nil, now: 100))
    XCTAssertTrue(policy.shouldRecycle(guestAge: 18, lastReapedAt: nil, now: 100))
    XCTAssertTrue(policy.shouldRecycle(guestAge: 60, lastReapedAt: nil, now: 100))
  }

  func testNothingIsRecycledWhenTheAgeIsOff() {
    let policy = WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: nil)
    XCTAssertFalse(policy.shouldRecycle(guestAge: 1000, lastReapedAt: nil, now: 100))
  }

  func testRecyclingIsSpacedFromTheLastReap() {
    let policy = WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 1)
    XCTAssertFalse(policy.shouldRecycle(guestAge: 30, lastReapedAt: 98, now: 100))
    XCTAssertTrue(policy.shouldRecycle(guestAge: 30, lastReapedAt: 95, now: 100))
  }

  func testTheAgeComesFromTheEnvironment() {
    XCTAssertEqual(WedgePolicy.configured([:]).recycleAfterSeconds, 12)
    XCTAssertEqual(WedgePolicy.configured(["WARDEN_SIMD_GUEST_MAX_AGE_S": "30"]).recycleAfterSeconds, 30)
    XCTAssertEqual(WedgePolicy.configured(["WARDEN_SIMD_GUEST_MAX_AGE_S": "7.5"]).recycleAfterSeconds, 7.5)
    XCTAssertNil(WedgePolicy.configured(["WARDEN_SIMD_GUEST_MAX_AGE_S": "0"]).recycleAfterSeconds)
    XCTAssertEqual(WedgePolicy.configured(["WARDEN_SIMD_GUEST_MAX_AGE_S": "soon"]).recycleAfterSeconds, 12)
    XCTAssertEqual(WedgePolicy.configured(["WARDEN_SIMD_GUEST_MAX_AGE_S": "-3"]).recycleAfterSeconds, 12)
  }

  // MARK: guest age

  func testGuestAgeCountsFromTheWatchStartAndRestartsAtEveryReap() {
    let watch = WedgeWatch(now: 100, policy: WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 18))
    XCTAssertEqual(watch.guestAge(now: 100), 0)
    XCTAssertEqual(watch.guestAge(now: 117.5), 17.5, accuracy: 0.001)
    XCTAssertFalse(watch.wantsRecycle(now: 117.5))
    XCTAssertTrue(watch.wantsRecycle(now: 118))
    watch.didReap(now: 118)
    XCTAssertEqual(watch.guestAge(now: 120), 2, accuracy: 0.001)
    XCTAssertFalse(watch.wantsRecycle(now: 130))
    XCTAssertTrue(watch.wantsRecycle(now: 136))
  }

  // MARK: rebind prelude

  func testRebindForgetsTheBundlesRememberedPid() async {
    let pids = BundlePidMemory()
    pids.remember(4242, for: "a.b")
    pids.remember(7, for: "other.app")
    let recycled = await RebindPrelude.run(
      bundleId: "a.b", pids: pids, udid: udid, wedge: WedgeWatch(now: 0), reaper: GuestReaper(list: { [] }, end: { _ in }),
      monitor: nil, now: 1)
    XCTAssertFalse(recycled)
    XCTAssertNil(pids.pid(for: "a.b"), "a relaunch makes the remembered pid stale")
    XCTAssertEqual(pids.pid(for: "other.app"), 7, "other bundles keep theirs")
  }

  func testRebindEndsAgedGuestsAndRestartsTheStreamBeforeItWaits() async {
    let ended = EndedLog()
    let udid = self.udid
    let reaper = GuestReaper(
      list: { [launchd(100, udid: udid), guest(101, parent: 100), guest(102, parent: 100), guest(900, parent: 999)] },
      end: { ended.add($0) })
    let wedge = WedgeWatch(now: 0, policy: WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 18))
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)

    let recycled = await RebindPrelude.run(
      bundleId: "a.b", pids: BundlePidMemory(), udid: udid, wedge: wedge, reaper: reaper, monitor: monitor, now: 20,
      settleSeconds: 0)

    XCTAssertTrue(recycled)
    XCTAssertEqual(Set(ended.pids), [101, 102], "only this simulator's guests")
    XCTAssertEqual(wedge.reaps, 1)
    XCTAssertEqual(wedge.guestAge(now: 20), 0, accuracy: 0.001, "the new guests start now")
    await reader.waitOpened(2)
    XCTAssertEqual(reader.requests, 2, "the stream was reopened")
    await monitor.stop()
  }

  func testRebindLeavesYoungGuestsAlone() async {
    let ended = EndedLog()
    let udid = self.udid
    let reaper = GuestReaper(
      list: { [launchd(100, udid: udid), guest(101, parent: 100)] }, end: { ended.add($0) })
    let wedge = WedgeWatch(now: 0, policy: WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 18))
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)

    let recycled = await RebindPrelude.run(
      bundleId: "a.b", pids: BundlePidMemory(), udid: udid, wedge: wedge, reaper: reaper, monitor: monitor, now: 17,
      settleSeconds: 0)

    XCTAssertFalse(recycled)
    XCTAssertEqual(ended.pids, [])
    XCTAssertEqual(wedge.reaps, 0)
    XCTAssertEqual(reader.requests, 1, "the stream was not touched")
    await monitor.stop()
  }

  func testRebindWithRecyclingOffNeverEndsGuests() async {
    let ended = EndedLog()
    let udid = self.udid
    let reaper = GuestReaper(
      list: { [launchd(100, udid: udid), guest(101, parent: 100)] }, end: { ended.add($0) })
    let wedge = WedgeWatch(now: 0, policy: WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: nil))
    let monitor = QuiescenceMonitor(reader: FakeReader())
    let recycled = await RebindPrelude.run(
      bundleId: "a.b", pids: BundlePidMemory(), udid: udid, wedge: wedge, reaper: reaper, monitor: monitor, now: 500,
      settleSeconds: 0)
    XCTAssertFalse(recycled)
    XCTAssertEqual(ended.pids, [])
  }

  func testNoGuestsFoundIsNotARecycle() async {
    let wedge = WedgeWatch(now: 0, policy: WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 18))
    let reader = FakeReader()
    let monitor = QuiescenceMonitor(reader: reader)
    await monitor.start()
    await reader.waitOpened(1)
    let recycled = await RebindPrelude.run(
      bundleId: "a.b", pids: BundlePidMemory(), udid: udid, wedge: wedge, reaper: GuestReaper(list: { [] }, end: { _ in }),
      monitor: monitor, now: 40, settleSeconds: 0)
    XCTAssertFalse(recycled)
    XCTAssertEqual(wedge.reaps, 0, "nothing was ended, so the guests are not new")
    XCTAssertEqual(reader.requests, 1)
    await monitor.stop()
  }

  func testWithoutAStreamYetNothingIsRecycled() async {
    let ended = EndedLog()
    let udid = self.udid
    let reaper = GuestReaper(
      list: { [launchd(100, udid: udid), guest(101, parent: 100)] }, end: { ended.add($0) })
    let wedge = WedgeWatch(now: 0, policy: WedgePolicy(minIntervalSeconds: 5, recycleAfterSeconds: 18))
    let recycled = await RebindPrelude.run(
      bundleId: "a.b", pids: BundlePidMemory(), udid: udid, wedge: wedge, reaper: reaper, monitor: nil, now: 90,
      settleSeconds: 0)
    XCTAssertFalse(recycled)
    XCTAssertEqual(ended.pids, [], "no stream, so no guest has been started by this helper that could be stuck")
  }
}
