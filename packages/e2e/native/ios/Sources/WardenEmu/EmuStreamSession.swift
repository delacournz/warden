import CoreVideo
import Foundation
import WardenStream

/// `stream.start` for an emulator, validated: the iOS helper's ranges plus the gRPC endpoint and the frame size
/// (the caller sizes it from `wm size` and `maxEdge`; the emulator scales to it).
package struct EmuStartRequest: Equatable, Sendable {
  package var host: String
  package var port: Int
  package var width: Int
  package var height: Int
  package var fps: Int
  package var bitrate: Int
  package var keepaliveMs: Int
  package var path: String?
  package var firstFrameTimeoutMs: Int

  package init(
    host: String = "127.0.0.1", port: Int, width: Int, height: Int, fps: Int = 60, bitrate: Int = 4_000_000,
    keepaliveMs: Int = 1000, path: String? = nil, firstFrameTimeoutMs: Int = 5000
  ) {
    self.host = host
    self.port = port
    self.width = width
    self.height = height
    self.fps = fps
    self.bitrate = bitrate
    self.keepaliveMs = keepaliveMs
    self.path = path
    self.firstFrameTimeoutMs = firstFrameTimeoutMs
  }

  package static func parse(_ params: [String: Any]) throws -> EmuStartRequest {
    func int(_ key: String, _ fallback: Int?, _ range: ClosedRange<Int>) throws -> Int {
      guard let raw = params[key], !(raw is NSNull) else {
        guard let fallback else { throw StreamError(.badRequest, "\"\(key)\" is required") }
        return fallback
      }
      guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue == Double(number.intValue), range.contains(number.intValue)
      else { throw StreamError(.badRequest, "\"\(key)\" must be an integer in \(range.lowerBound)...\(range.upperBound)") }
      return number.intValue
    }
    let host = params["host"] as? String ?? "127.0.0.1"
    var path: String?
    if let raw = params["path"], !(raw is NSNull) {
      guard let value = raw as? String, !value.isEmpty else { throw StreamError(.badRequest, "\"path\" must be a non-empty string") }
      path = value
    }
    let width = try int("width", nil, 16...8192)
    let height = try int("height", nil, 16...8192)
    guard width % 2 == 0, height % 2 == 0 else { throw StreamError(.badRequest, "\"width\" and \"height\" must be even") }
    return EmuStartRequest(
      host: host, port: try int("port", nil, 1...65535), width: width, height: height, fps: try int("fps", 60, 1...60),
      bitrate: try int("bitrate", 4_000_000, 100_000...20_000_000), keepaliveMs: try int("keepaliveMs", 1000, 100...10_000),
      path: path, firstFrameTimeoutMs: try int("firstFrameTimeoutMs", 5000, 100...60_000))
  }
}

/// A frame file the emulator writes pixels into (`ImageTransport` MMAP): RGB888, top-down, `width * 3` per row.
final class FrameFile {
  let path: String
  let capacity: Int
  let base: UnsafeMutableRawPointer
  private let fd: Int32

  init(path: String, capacity: Int) throws {
    self.path = path
    self.capacity = capacity
    fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0o600)
    guard fd >= 0 else { throw StreamError(.io, "open \(path): errno \(errno)") }
    guard ftruncate(fd, off_t(capacity)) == 0 else {
      Darwin.close(fd)
      throw StreamError(.io, "ftruncate \(path): errno \(errno)")
    }
    let mapped = mmap(nil, capacity, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
    guard let mapped, mapped != MAP_FAILED else {
      Darwin.close(fd)
      throw StreamError(.io, "mmap \(path): errno \(errno)")
    }
    base = mapped
  }

  deinit {
    munmap(base, capacity)
    Darwin.close(fd)
    unlink(path)
  }
}

/// One live stream of an emulator's display: each `Image` the gRPC call reports is copied out of the frame file into
/// a pooled 24RGB buffer and marks the `FramePacer` rendered (the emulator only sends a frame when the screen
/// changed); each due frame is encoded (`StreamEncoder`, VideoToolbox, RGB to NV12 on the way in) and written to the
/// `AUSocket`. A reported size change (rotation) rebuilds the buffers and the encoder.
package final class EmuStreamSession: @unchecked Sendable {
  package let request: EmuStartRequest
  package let socket: AUSocket
  private let file: FrameFile
  private var call: ScreenshotCall?
  private let lock = NSLock()
  private var pacer: FramePacer
  private var latest: CVPixelBuffer?
  private var pool: CVPixelBufferPool?
  private var encoder: StreamEncoder?
  /// What the emulator sends.
  private var size = (width: 0, height: 0)
  /// What leaves the encoder: `size` with even sides.
  private var encodedSize = (width: 0, height: 0)
  private let queue = DispatchQueue(label: "warden-emud.stream", qos: .userInteractive)
  private var timer: DispatchSourceTimer?
  private var stopped = false
  private let startedAt = DispatchTime.now().uptimeNanoseconds
  private var received = 0
  private var seqSkipped: UInt64 = 0
  private var lastSeq: UInt64?
  private var encodedCount = 0
  private var keyCount = 0
  private var lastError: String?
  private var endReason: String?
  private let firstFrame = DispatchSemaphore(value: 0)

  /// Opens the call and waits for the first frame, so the reply carries the size the emulator really sends.
  package static func start(request: EmuStartRequest, token: String, defaultPath: String, frameDir: String) throws -> EmuStreamSession {
    let session = try EmuStreamSession(request: request, path: request.path ?? defaultPath, frameDir: frameDir)
    do {
      try session.open(token: token)
    } catch {
      session.stop()
      throw error
    }
    return session
  }

  private init(request: EmuStartRequest, path: String, frameDir: String) throws {
    self.request = request
    pacer = FramePacer(fps: request.fps, keepaliveMs: request.keepaliveMs)
    // Either orientation fits: a rotated emulator sends height x width.
    let side = max(request.width, request.height)
    file = try FrameFile(path: "\(frameDir)/wemu-\(getpid())-\(request.port).rgb", capacity: side * side * 3)
    let owner = WeakEmuStream()
    socket = try AUSocket(path: path, onNeedKeyframe: { owner.value?.forceKeyframe() })
    owner.value = self
  }

  private func open(token: String) throws {
    let endpoint = GrpcEndpoint(host: request.host, port: request.port, token: token)
    let screenshot = ScreenshotRequest(width: request.width, height: request.height, mmapPath: file.path)
    call = try ScreenshotCall(
      endpoint: endpoint, request: screenshot, onImage: { [weak self] header in self?.frame(header) },
      onEnd: { [weak self] reason in self?.ended(reason) })
    let waited = firstFrame.wait(timeout: .now() + .milliseconds(request.firstFrameTimeoutMs))
    let (gotFrame, reason) = lock.withLock { (received > 0, endReason) }
    guard waited == .success, gotFrame else {
      if let reason { throw StreamError(.io, "no frame from the emulator: \(reason)") }
      throw StreamError(.timeout, "no frame from the emulator in \(request.firstFrameTimeoutMs) ms")
    }
  }

  package var encodeSize: (width: Int, height: Int) { lock.withLock { encodedSize } }

  package func forceKeyframe() {
    lock.withLock {
      encoder?.requestKeyframe()
      pacer.force()
    }
    wake()
  }

  package func stop() {
    call?.cancel("stopped")
    queue.sync {
      stopped = true
      timer?.cancel()
      timer = nil
    }
    socket.close()
    // Never under `lock`: CompleteFrames waits on the output callback, which takes `lock` to count the unit.
    lock.withLock { encoder }?.flush()
  }

  package var stats: [String: Any] {
    let socketStats = socket.stats
    return lock.withLock { () -> [String: Any] in
      var out: [String: Any] = ["path": socket.path, "source": "grpc"]
      out["width"] = encodedSize.width
      out["height"] = encodedSize.height
      out["frameWidth"] = size.width
      out["frameHeight"] = size.height
      out["fps"] = request.fps
      out["bitrate"] = request.bitrate
      out["uptimeMs"] = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
      out["rendered"] = received
      out["seqSkipped"] = Int(seqSkipped)
      out["encoded"] = encodedCount
      out["keyframes"] = keyCount
      out["encodeErrors"] = encoder?.errorCount ?? 0
      out["encoderDropped"] = encoder?.droppedCount ?? 0
      out["sent"] = socketStats.sent
      out["sentBytes"] = socketStats.bytes
      out["dropped"] = socketStats.dropped
      out["connected"] = socketStats.connected
      out["lastError"] = lastError ?? endReason ?? NSNull()
      return out
    }
  }

  private func ended(_ reason: String) {
    lock.withLock { if endReason == nil { endReason = reason } }
    firstFrame.signal()
  }

  /// On the gRPC thread: copy the frame out of the file now, before the emulator writes the next one.
  private func frame(_ header: ImageHeader) {
    let width = header.width
    let height = header.height
    guard width > 0, height > 0, width * height * 3 <= file.capacity else {
      lock.withLock { lastError = "frame \(width)x\(height) does not fit the frame file" }
      return
    }
    do {
      try resize(width: width, height: height)
      guard let pool = lock.withLock({ self.pool }) else { return }
      var created: CVPixelBuffer?
      guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &created) == kCVReturnSuccess, let pixels = created else {
        lock.withLock { lastError = "no free frame buffer" }
        return
      }
      CVPixelBufferLockBaseAddress(pixels, [])
      if let destination = CVPixelBufferGetBaseAddress(pixels) {
        let stride = CVPixelBufferGetBytesPerRow(pixels)
        let row = width * 3
        if stride == row {
          memcpy(destination, file.base, row * height)
        } else {
          for y in 0..<height { memcpy(destination + y * stride, file.base + y * row, row) }
        }
      }
      CVPixelBufferUnlockBaseAddress(pixels, [])
      let first = lock.withLock { () -> Bool in
        if let lastSeq, header.seq > lastSeq + 1 { seqSkipped += header.seq - lastSeq - 1 }
        lastSeq = header.seq
        received += 1
        latest = pixels
        pacer.rendered()
        return received == 1
      }
      if first { firstFrame.signal() }
      wake()
    } catch {
      lock.withLock { lastError = "\(error)" }
    }
  }

  /// A new frame size (the first frame, a rotation): new buffers, a new encoder.
  private func resize(width: Int, height: Int) throws {
    let replaced = try lock.withLock { () -> StreamEncoder? in
      guard encoder == nil || size != (width, height) else { return nil }
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_24RGB, kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height, kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
      ]
      var created: CVPixelBufferPool?
      guard
        CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey: 3] as CFDictionary, attributes as CFDictionary, &created)
          == kCVReturnSuccess, let created
      else { throw StreamError(.internal, "CVPixelBufferPoolCreate (24RGB \(width)x\(height)) failed") }
      let socket = self.socket
      let old = encoder
      // The emulator keeps the display's aspect and may answer an odd side (570x1279 for 570x1280): H.264 wants
      // even, so the encoder's copy step scales a pixel off.
      encoder = try StreamEncoder(
        width: width & ~1, height: height & ~1, fps: request.fps, bitrate: request.bitrate,
        sink: { [weak self] unit in
          self?.counted(unit)
          socket.send(unit)
        })
      pool = created
      latest = nil
      size = (width, height)
      encodedSize = (width & ~1, height & ~1)
      pacer.force()
      return old
    }
    replaced?.flush()
  }

  private func counted(_ unit: EncodedUnit) {
    lock.withLock {
      encodedCount += 1
      if unit.flags.contains(.key) { keyCount += 1 }
    }
  }

  private func wake() {
    queue.async { [weak self] in self?.schedule() }
  }

  /// On `queue`: encode when a frame is due, else arm the timer for when one will be.
  private func schedule() {
    guard !stopped else { return }
    let now = DispatchTime.now().uptimeNanoseconds
    let (fire, due) = lock.withLock { () -> (Bool, UInt64?) in
      if pacer.fire(now: now) { return (true, nil) }
      return (false, pacer.deadline(now: now))
    }
    if fire {
      encodeLatest()
      schedule()
      return
    }
    timer?.cancel()
    timer = nil
    guard let due else { return }
    let source = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
    source.schedule(deadline: DispatchTime(uptimeNanoseconds: max(due, now)), leeway: .microseconds(500))
    source.setEventHandler { [weak self] in self?.schedule() }
    source.resume()
    timer = source
  }

  private func encodeLatest() {
    let (pixels, encoder) = lock.withLock { (latest, self.encoder) }
    guard let pixels, let encoder else { return }
    let micros = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1000
    do { try encoder.encode(pixels, ptsMicros: micros) } catch { lock.withLock { lastError = "\(error)" } }
  }
}

final class WeakEmuStream: @unchecked Sendable {
  weak var value: EmuStreamSession?
}
