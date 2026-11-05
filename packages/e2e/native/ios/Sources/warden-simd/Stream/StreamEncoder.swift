import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// A real-time H.264 encoder over VideoToolbox: Constrained Baseline (every WebRTC peer decodes it, no B-frames),
/// no frame reordering, rate-controlled to `bitrate`, keyframes only on request (plus the first frame and one every
/// `maxKeyIntervalSeconds`). Each source frame is first copied (and scaled) into a pooled `width`×`height` NV12
/// buffer, so the simulator drawing into its IOSurface while the encoder reads can never tear a frame. Units reach
/// `sink` in encode order on VideoToolbox's callback thread.
final class StreamEncoder: @unchecked Sendable {
  typealias Sink = @Sendable (EncodedUnit) -> Void

  let width: Int
  let height: Int
  private let session: VTCompressionSession
  private let transfer: VTPixelTransferSession
  private let pool: CVPixelBufferPool
  private let sink: Sink
  private let lock = NSLock()
  private var wantKey = true
  private var failures = 0

  init(width: Int, height: Int, fps: Int, bitrate: Int, maxKeyIntervalSeconds: Int = 10, sink: @escaping Sink) throws {
    self.width = width
    self.height = height
    self.sink = sink
    var created: VTCompressionSession?
    let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
    let status = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
      encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &created)
    guard status == noErr, let created else { throw WireError(.internal, "VTCompressionSessionCreate: \(status)") }
    session = created
    var transferSession: VTPixelTransferSession?
    guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transferSession) == noErr,
      let transferSession
    else {
      VTCompressionSessionInvalidate(created)
      throw WireError(.internal, "VTPixelTransferSessionCreate failed")
    }
    VTSessionSetProperty(transferSession, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
    transfer = transferSession
    let poolAttributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    var createdPool: CVPixelBufferPool?
    guard
      CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey: 3] as CFDictionary, poolAttributes as CFDictionary, &createdPool)
        == kCVReturnSuccess, let createdPool
    else {
      VTCompressionSessionInvalidate(created)
      VTPixelTransferSessionInvalidate(transferSession)
      throw WireError(.internal, "CVPixelBufferPoolCreate failed")
    }
    pool = createdPool
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_AverageBitRate: bitrate,
      kVTCompressionPropertyKey_ExpectedFrameRate: fps,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: maxKeyIntervalSeconds,
      kVTCompressionPropertyKey_MaxFrameDelayCount: 0,
    ]
    for (key, value) in properties {
      let set = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
      // Low-latency rate control rejects some keys (MaxFrameDelayCount); the rest still apply.
      if set != noErr && key != kVTCompressionPropertyKey_MaxFrameDelayCount {
        VTCompressionSessionInvalidate(session)
        throw WireError(.internal, "VTSessionSetProperty \(key): \(set)")
      }
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
  }

  deinit {
    VTCompressionSessionInvalidate(session)
    VTPixelTransferSessionInvalidate(transfer)
  }

  /// The next encoded frame is an IDR.
  func requestKeyframe() {
    lock.withLock { wantKey = true }
  }

  /// Frames VideoToolbox handed back with an error (dropped).
  var errorCount: Int { lock.withLock { failures } }

  func encode(_ source: CVPixelBuffer, ptsMicros: UInt64) throws {
    var copy: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &copy) == kCVReturnSuccess, let pixels = copy else {
      throw WireError(.internal, "no free encoder buffer")
    }
    let copied = VTPixelTransferSessionTransferImage(transfer, from: source, to: pixels)
    guard copied == noErr else { throw WireError(.internal, "VTPixelTransferSessionTransferImage: \(copied)") }
    let key = lock.withLock {
      defer { wantKey = false }
      return wantKey
    }
    let options: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let pts = CMTime(value: CMTimeValue(ptsMicros), timescale: 1_000_000)
    let status = VTCompressionSessionEncodeFrame(
      session, imageBuffer: pixels, presentationTimeStamp: pts, duration: .invalid, frameProperties: options,
      infoFlagsOut: nil
    ) { [weak self] status, _, sample in
      self?.emit(status: status, sample: sample, ptsMicros: ptsMicros)
    }
    if status != noErr {
      if key { requestKeyframe() }
      throw WireError(.internal, "VTCompressionSessionEncodeFrame: \(status)")
    }
  }

  /// Wait for every frame in flight.
  func flush() {
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
  }

  private func emit(status: OSStatus, sample: CMSampleBuffer?, ptsMicros: UInt64) {
    guard status == noErr, let sample, let block = CMSampleBufferGetDataBuffer(sample) else {
      lock.withLock {
        failures += 1
        wantKey = true
      }
      return
    }
    let key = Self.isKeyframe(sample)
    var parameterSets: [Data] = []
    if key, let format = CMSampleBufferGetFormatDescription(sample) {
      parameterSets = Self.parameterSets(format)
    }
    var length = 0
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
      let pointer,
      let data = try? AUFraming.annexB(avcc: Data(bytes: pointer, count: length), parameterSets: parameterSets)
    else {
      lock.withLock { wantKey = true }
      return
    }
    var flags: AUFlags = key ? [.key] : []
    if !parameterSets.isEmpty { flags.insert(.config) }
    sink(EncodedUnit(data: data, flags: flags, ptsMicros: ptsMicros))
  }

  private static func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
      let first = attachments.first
    else { return true }
    return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
  }

  private static func parameterSets(_ format: CMFormatDescription) -> [Data] {
    var count = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count,
      nalUnitHeaderLengthOut: nil)
    return (0..<count).compactMap { index in
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
          parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer
      else { return nil }
      return Data(bytes: pointer, count: size)
    }
  }
}
