import CoreVideo
import FBControlCore
import FBSimulatorControl
import Foundation
import IOSurface

/// One live stream of the simulator's main display: framebuffer events drive a `FramePacer`, each due frame is
/// encoded from the current IOSurface (`StreamEncoder`) and written to the `AUSocket`. A keyframe request, a new
/// reader or a dropped backlog forces the next frame as an IDR. A display size change (rotation) rebuilds the encoder.
final class StreamSession: @unchecked Sendable {
  let request: StreamStartRequest
  let socket: AUSocket
  /// Held for the stream's life: the attachment's events stop when the framebuffer is released.
  private let framebuffer: Framebuffer
  private let attachment: FramebufferAttachment
  private let lock = NSLock()
  private var pacer: FramePacer
  private var surface: IOSurface?
  private var encoder: StreamEncoder?
  private var encodeSize: StreamStartRequest.Size = .init(width: 0, height: 0)
  /// Serial: every pacing decision and every encode call happens here.
  private let queue = DispatchQueue(label: "warden-simd.stream", qos: .userInteractive)
  private var timer: DispatchSourceTimer?
  private var watcher: Task<Void, Never>?
  private var stopped = false
  private let startedAt = ContinuousClock.now
  private var renderedCount = 0
  private var encodedCount = 0
  private var keyCount = 0
  private var lastError: String?

  static func start(simulator: Simulator, request: StreamStartRequest, defaultPath: String) async throws -> StreamSession {
    let framebuffer = try await simulator.framebuffer.connect()
    let attachment = try framebuffer.attach()
    return try StreamSession(
      request: request, framebuffer: framebuffer, attachment: attachment, path: request.path ?? defaultPath)
  }

  private init(request: StreamStartRequest, framebuffer: Framebuffer, attachment: FramebufferAttachment, path: String) throws {
    self.request = request
    self.framebuffer = framebuffer
    self.attachment = attachment
    pacer = FramePacer(fps: request.fps, keepaliveMs: request.keepaliveMs)
    let owner = WeakStream()
    socket = try AUSocket(path: path, onNeedKeyframe: { owner.value?.forceKeyframe() })
    owner.value = self
    if let initial = attachment.initialSurface { try adopt(initial) }
    watcher = Task { [weak self] in await self?.watch() }
  }

  /// The size frames are encoded at (0×0 until the first surface).
  var size: StreamStartRequest.Size { lock.withLock { encodeSize } }

  func forceKeyframe() {
    lock.withLock {
      encoder?.requestKeyframe()
      pacer.force()
    }
    wake()
  }

  func stop() {
    attachment.cancel()
    watcher?.cancel()
    queue.sync {
      stopped = true
      timer?.cancel()
      timer = nil
    }
    socket.close()
    // Never under `lock`: CompleteFrames waits on the output callback, which takes `lock` to count the unit.
    lock.withLock { encoder }?.flush()
  }

  var stats: JSON {
    let socketStats = socket.stats
    return lock.withLock {
      let seconds = Double((ContinuousClock.now - startedAt).components.attoseconds) / 1e18
        + Double((ContinuousClock.now - startedAt).components.seconds)
      return .object([
        "path": .string(socket.path), "width": .int(encodeSize.width), "height": .int(encodeSize.height),
        "fps": .int(request.fps), "bitrate": .int(request.bitrate), "uptimeMs": .int(Int(seconds * 1000)),
        "rendered": .int(renderedCount), "encoded": .int(encodedCount), "keyframes": .int(keyCount),
        "encodeErrors": .int(encoder?.errorCount ?? 0), "sent": .int(socketStats.sent),
        "sentBytes": .int(socketStats.bytes), "dropped": .int(socketStats.dropped),
        "connected": .bool(socketStats.connected), "lastError": lastError.map { .string($0) } ?? .null,
      ])
    }
  }

  /// Use `surface` for the next frames; a size change rebuilds the encoder.
  private func adopt(_ next: IOSurface) throws {
    let width = IOSurfaceGetWidth(next)
    let height = IOSurfaceGetHeight(next)
    let size = StreamStartRequest.encodeSize(width: width, height: height, maxEdge: request.maxEdge)
    let replaced = try lock.withLock { () -> StreamEncoder? in
      surface = next
      pacer.force()
      guard encoder == nil || size != encodeSize else { return nil }
      let socket = self.socket
      let old = encoder
      encoder = try StreamEncoder(
        width: size.width, height: size.height, fps: request.fps, bitrate: request.bitrate,
        sink: { [weak self] unit in
          self?.counted(unit)
          socket.send(unit)
        })
      encodeSize = size
      return old
    }
    // Outside `lock`, for the same reason as in `stop()`.
    replaced?.flush()
    wake()
  }

  private func counted(_ unit: EncodedUnit) {
    lock.withLock {
      encodedCount += 1
      if unit.flags.contains(.key) { keyCount += 1 }
    }
  }

  private func watch() async {
    for await event in attachment.events {
      switch event {
      case .frameRendered:
        lock.withLock {
          renderedCount += 1
          pacer.rendered()
        }
        wake()
      case let .surfaceChanged(next):
        if let next {
          do { try adopt(next) } catch { lock.withLock { lastError = "\(error)" } }
        }
      case .configurationChanged:
        continue
      case let .ended(reason):
        lock.withLock { lastError = "display ended: \(reason)" }
        return
      @unknown default:
        continue
      }
    }
  }

  private func nowNanos() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

  private func wake() {
    queue.async { [weak self] in self?.schedule() }
  }

  /// On `queue`: encode when a frame is due, else arm the timer for when one will be.
  private func schedule() {
    guard !stopped else { return }
    let now = nowNanos()
    let (fire, due) = lock.withLock { () -> (Bool, UInt64?) in
      if pacer.fire(now: now) { return (true, nil) }
      return (false, pacer.deadline(now: now))
    }
    if fire {
      encodeCurrent()
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

  private func encodeCurrent() {
    let (surface, encoder) = lock.withLock { (self.surface, self.encoder) }
    guard let surface, let encoder else { return }
    var unmanaged: Unmanaged<CVPixelBuffer>?
    guard CVPixelBufferCreateWithIOSurface(nil, surface, nil, &unmanaged) == kCVReturnSuccess,
      let pixels = unmanaged?.takeRetainedValue()
    else {
      lock.withLock { lastError = "could not wrap the display surface" }
      return
    }
    let micros = UInt64(Double((ContinuousClock.now - startedAt).components.attoseconds) / 1e12)
      + UInt64((ContinuousClock.now - startedAt).components.seconds) * 1_000_000
    do { try encoder.encode(pixels, ptsMicros: micros) } catch { lock.withLock { lastError = "\(error)" } }
  }
}

/// Lets the socket reach its session without retaining it (the session owns the socket).
final class WeakStream: @unchecked Sendable {
  weak var value: StreamSession?
}
