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

/// A guest that reports every process busy is cleared by ending the simulator's AX guests, but only when the guests
/// have shown they can report quiet, not back to back, and never another simulator's guests.
final class WedgeTests: XCTestCase {
  private let udid = "1A0EC51B-7069-4001-AF8A-432CA3B2D1FD"
  private let otherUdid = "66853073-902D-40F2-803C-64A29A062F17"

  func testAFreshGuestThatNeverReportedQuietIsNotReaped() {
    let policy = WedgePolicy()
    XCTAssertFalse(policy.shouldReap(streamQuiets: 0, lastReapedAt: nil, now: 100))
    XCTAssertFalse(policy.shouldReap(streamQuiets: 0, lastReapedAt: 1, now: 100))
  }

  func testGuestsThatReportedQuietBeforeAreReapedOnTheFirstFallback() {
    XCTAssertTrue(WedgePolicy().shouldReap(streamQuiets: 3, lastReapedAt: nil, now: 0))
  }

  func testReapsAreSpacedOut() {
    let policy = WedgePolicy(minIntervalSeconds: 5)
    XCTAssertFalse(policy.shouldReap(streamQuiets: 1, lastReapedAt: 10, now: 14.9))
    XCTAssertTrue(policy.shouldReap(streamQuiets: 1, lastReapedAt: 10, now: 15))
  }

  func testTheWatchWantsAReapOnlyAfterAQuietAndNotRightAfterOne() {
    let watch = WedgeWatch()
    XCTAssertFalse(watch.wantsReap(now: 0))
    watch.noteStreamQuiet()
    XCTAssertTrue(watch.wantsReap(now: 0))
    watch.didReap(now: 10)
    XCTAssertEqual(watch.reaps, 1)
    XCTAssertFalse(watch.wantsReap(now: 100), "the new guests have not reported quiet yet")
    watch.noteStreamQuiet()
    XCTAssertFalse(watch.wantsReap(now: 12), "too soon after the last reap")
    XCTAssertTrue(watch.wantsReap(now: 16))
  }

  func testOnlyTheGuestsOfTheSimulatorsOwnLaunchdAreFound() {
    let processes = [
      launchd(100, udid: udid), launchd(200, udid: otherUdid),
      guest(101, parent: 100), guest(102, parent: 100), guest(201, parent: 200),
      ProcessEntry(pid: 103, ppid: 100, command: "/usr/libexec/other-daemon"),
    ]
    XCTAssertEqual(Set(GuestReaper.guests(of: udid, in: processes)), [101, 102])
    XCTAssertEqual(GuestReaper.guests(of: otherUdid, in: processes), [201])
  }

  func testNothingIsFoundWhenTheSimulatorHasNoLaunchd() {
    XCTAssertEqual(GuestReaper.guests(of: udid, in: [launchd(200, udid: otherUdid), guest(201, parent: 200)]), [])
    XCTAssertEqual(GuestReaper.guests(of: udid, in: [guest(201, parent: 200)]), [])
  }

  func testAUdidIsNotMatchedByAPrefixOfAnother() {
    let processes = [launchd(100, udid: udid + "-copy"), guest(101, parent: 100)]
    XCTAssertEqual(GuestReaper.guests(of: udid, in: processes), [])
  }

  func testReapEndsExactlyTheSimulatorsGuests() {
    let ended = PidLog()
    let udid = self.udid
    let reaper = GuestReaper(
      list: { [launchd(100, udid: udid), guest(101, parent: 100), guest(201, parent: 999)] },
      end: { ended.add($0) })
    XCTAssertEqual(reaper.reap(udid: udid), [101])
    XCTAssertEqual(ended.pids, [101])
  }

  func testPsOutputIsParsedIntoPidParentAndCommand() {
    let output = """
        1     0 /sbin/launchd
    81900 77034   /x/SimulatorFrameworkBridge-iOS serve /tmp/a.sock --exit-on-disconnect 1
    not a line
    """
    XCTAssertEqual(
      GuestReaper.parse(output),
      [
        ProcessEntry(pid: 1, ppid: 0, command: "/sbin/launchd"),
        ProcessEntry(
          pid: 81900, ppid: 77034, command: "/x/SimulatorFrameworkBridge-iOS serve /tmp/a.sock --exit-on-disconnect 1"),
      ])
  }
}

private final class PidLog: @unchecked Sendable {
  private let lock = NSLock()
  private var ended: [pid_t] = []
  func add(_ pid: pid_t) { lock.withLock { ended.append(pid) } }
  var pids: [pid_t] { lock.withLock { ended } }
}
