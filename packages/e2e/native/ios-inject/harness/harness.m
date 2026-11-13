// Test harness for libwarden-inject (macOS build): a line on stdin -> one JSON line describing what the injected
// process sees. Commands: `print`, `monitor` (start an NWPathMonitor and report each update), `quit`, and the `cam-*`
// commands that drive the simulated camera (`#pragma mark - camera` in WardenInject.m) through the real AVFoundation API.
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <sys/time.h>

static void emit(NSDictionary *d) {
  NSData *j = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  printf("%s\n", [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding].UTF8String);
  fflush(stdout);
}


#pragma mark - camera

static void spin(double seconds) {
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false);
}

static void write_png(CGImageRef img, NSString *path) {
  CGImageDestinationRef d = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], CFSTR("public.png"), 1, NULL);
  CGImageDestinationAddImage(d, img, NULL);
  CGImageDestinationFinalize(d);
  CFRelease(d);
}

static CGContextRef bitmap(size_t w, size_t h) {
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, cs, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGColorSpaceRelease(cs);
  return ctx;
}

static void make_solid(NSString *path, double r, double g, double b) {
  CGContextRef ctx = bitmap(320, 240);
  CGContextSetRGBFillColor(ctx, r / 255, g / 255, b / 255, 1);
  CGContextFillRect(ctx, CGRectMake(0, 0, 320, 240));
  CGImageRef img = CGBitmapContextCreateImage(ctx);
  write_png(img, path);
  CGImageRelease(img);
  CGContextRelease(ctx);
}

/** 640x480 white with a QR code of `text` on the left or right half. */
static void make_qr(NSString *path, NSString *text, BOOL left) {
  CIFilter *f = [CIFilter filterWithName:@"CIQRCodeGenerator"];
  [f setValue:[text dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
  [f setValue:@"M" forKey:@"inputCorrectionLevel"];
  CIImage *qr = [f.outputImage imageByApplyingTransform:CGAffineTransformMakeScale(8, 8)];
  CIContext *cc = [CIContext contextWithOptions:nil];
  CGImageRef qrImg = [cc createCGImage:qr fromRect:qr.extent];
  CGContextRef ctx = bitmap(640, 480);
  CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
  CGContextFillRect(ctx, CGRectMake(0, 0, 640, 480));
  CGContextSetInterpolationQuality(ctx, kCGInterpolationNone);
  CGContextDrawImage(ctx, CGRectMake(left ? 30 : 350, 100, 260, 260), qrImg);
  CGImageRef img = CGBitmapContextCreateImage(ctx);
  write_png(img, path);
  CGImageRelease(img);
  CGImageRelease(qrImg);
  CGContextRelease(ctx);
}

/** A short .mov: the grey level steps from dark to bright over `seconds`, so a looping reader is visibly alive. */
static void make_video(NSString *path, double seconds) {
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  AVAssetWriter *w = [AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:path] fileType:AVFileTypeQuickTimeMovie error:nil];
  AVAssetWriterInput *in = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{ AVVideoCodecKey: AVVideoCodecTypeH264, AVVideoWidthKey: @320, AVVideoHeightKey: @240 }];
  AVAssetWriterInputPixelBufferAdaptor *ad = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:in sourcePixelBufferAttributes:@{ (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferWidthKey: @320, (id)kCVPixelBufferHeightKey: @240 }];
  [w addInput:in];
  [w startWriting];
  [w startSessionAtSourceTime:kCMTimeZero];
  int frames = (int)(seconds * 30);
  for (int i = 0; i < frames; i++) {
    while (!in.isReadyForMoreMediaData) usleep(1000);
    CVPixelBufferRef pb = NULL;
    CVPixelBufferCreate(NULL, 320, 240, kCVPixelFormatType_32BGRA, NULL, &pb);
    CVPixelBufferLockBaseAddress(pb, 0);
    memset(CVPixelBufferGetBaseAddress(pb), 40 + (200 * i) / frames, CVPixelBufferGetBytesPerRow(pb) * 240);
    CVPixelBufferUnlockBaseAddress(pb, 0);
    [ad appendPixelBuffer:pb withPresentationTime:CMTimeMake(i, 30)];
    CVPixelBufferRelease(pb);
  }
  [in markAsFinished];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [w finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
}

@interface Collector : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureMetadataOutputObjectsDelegate, AVCapturePhotoCaptureDelegate, AVCaptureFileOutputRecordingDelegate>
@property (atomic) int frames;
@property (atomic) int width;
@property (atomic) int height;
@property (atomic) OSType format;
@property (atomic) int center0, center1, center2;
@property (atomic, strong) NSMutableArray *codes;
@property (atomic, strong) NSMutableArray *photoEvents;
@property (atomic, strong) NSData *photoData;
@property (atomic) BOOL hasPixelBuffer;
@property (atomic) BOOL started;
@property (atomic) BOOL finished;
@property (atomic, strong) NSString *recordError;
@end
@implementation Collector
- (instancetype)init {
  if ((self = [super init])) { _codes = [NSMutableArray array]; _photoEvents = [NSMutableArray array]; }
  return self;
}
- (void)captureOutput:(AVCaptureOutput *)o didOutputSampleBuffer:(CMSampleBufferRef)sb fromConnection:(AVCaptureConnection *)c {
  CVImageBufferRef pb = CMSampleBufferGetImageBuffer(sb);
  self.frames += 1;
  self.width = (int)CVPixelBufferGetWidth(pb);
  self.height = (int)CVPixelBufferGetHeight(pb);
  self.format = CVPixelBufferGetPixelFormatType(pb);
  if (self.format == kCVPixelFormatType_32BGRA) {
    CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    const uint8_t *base = CVPixelBufferGetBaseAddress(pb);
    size_t row = CVPixelBufferGetBytesPerRow(pb);
    const uint8_t *px = base + (self.height / 2) * row + (self.width / 2) * 4;
    self.center0 = px[0]; self.center1 = px[1]; self.center2 = px[2];
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
  }
}
- (void)captureOutput:(AVCaptureOutput *)o didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objs fromConnection:(AVCaptureConnection *)c {
  for (AVMetadataMachineReadableCodeObject *m in objs) {
    @synchronized (self) { [self.codes addObject:@{ @"type": m.type, @"value": m.stringValue ?: @"", @"x": @(m.bounds.origin.x), @"w": @(m.bounds.size.width) }]; }
  }
}
- (void)captureOutput:(AVCapturePhotoOutput *)o willBeginCaptureForResolvedSettings:(AVCaptureResolvedPhotoSettings *)s { [self.photoEvents addObject:@"willBegin"]; }
- (void)captureOutput:(AVCapturePhotoOutput *)o willCapturePhotoForResolvedSettings:(AVCaptureResolvedPhotoSettings *)s { [self.photoEvents addObject:@"willCapture"]; }
- (void)captureOutput:(AVCapturePhotoOutput *)o didCapturePhotoForResolvedSettings:(AVCaptureResolvedPhotoSettings *)s { [self.photoEvents addObject:@"didCapture"]; }
- (void)captureOutput:(AVCapturePhotoOutput *)o didFinishProcessingPhoto:(AVCapturePhoto *)p error:(NSError *)e {
  [self.photoEvents addObject:@"didFinishProcessing"];
  self.photoData = p.fileDataRepresentation;
  self.hasPixelBuffer = p.pixelBuffer != NULL;
}
- (void)captureOutput:(AVCapturePhotoOutput *)o didFinishCaptureForResolvedSettings:(AVCaptureResolvedPhotoSettings *)s error:(NSError *)e { [self.photoEvents addObject:@"didFinishCapture"]; }
- (void)captureOutput:(AVCaptureFileOutput *)o didStartRecordingToOutputFileAtURL:(NSURL *)u fromConnections:(NSArray<AVCaptureConnection *> *)c { self.started = YES; }
- (void)captureOutput:(AVCaptureFileOutput *)o didFinishRecordingToOutputFileAtURL:(NSURL *)u fromConnections:(NSArray<AVCaptureConnection *> *)c error:(NSError *)e {
  NSError *under = (NSError *)e.userInfo[NSUnderlyingErrorKey];
  self.recordError = e ? [NSString stringWithFormat:@"%@ [%@ %ld%@]", e.localizedDescription, e.domain, (long)e.code,
    under ? [NSString stringWithFormat:@" <- %@ %ld", under.domain, (long)under.code] : @""] : nil;
  self.finished = YES;
}
@end

static AVCaptureSession *g_session;
static Collector *g_collector;
static AVCaptureVideoDataOutput *g_video;
static AVCaptureMetadataOutput *g_meta;
static AVCapturePhotoOutput *g_photo;
static AVCaptureMovieFileOutput *g_movie;
static AVCaptureVideoPreviewLayer *g_layer;
static AVCaptureDeviceDiscoverySession *g_discovery;
static int g_discovery_kvo = 0;
static dispatch_queue_t g_cb_queue;

@interface DiscoveryObserver : NSObject
@end
@implementation DiscoveryObserver
- (void)observeValueForKeyPath:(NSString *)k ofObject:(id)o change:(NSDictionary *)c context:(void *)ctx { g_discovery_kvo += 1; }
@end
static DiscoveryObserver *g_observer;

static NSString *pos_name(AVCaptureDevicePosition p) { return p == AVCaptureDevicePositionFront ? @"front" : p == AVCaptureDevicePositionBack ? @"back" : @"unspecified"; }

static void cam_devices(void) {
  AVCaptureDevice *def = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  NSMutableArray *listed = [NSMutableArray array];
  for (AVCaptureDevice *d in [AVCaptureDevice devicesWithMediaType:AVMediaTypeVideo]) [listed addObject:pos_name(d.position)];
  NSMutableArray *back = [NSMutableArray array], *front = [NSMutableArray array];
  for (AVCaptureDevice *d in [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera ] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionBack].devices) [back addObject:d.uniqueID];
  for (AVCaptureDevice *d in [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera ] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionFront].devices) [front addObject:d.uniqueID];
  AVCaptureDevice *frontDev = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionFront];
  if (!g_discovery) {
    g_discovery = [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera ] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified];
    g_observer = [DiscoveryObserver new];
    [g_discovery addObserver:g_observer forKeyPath:@"devices" options:NSKeyValueObservingOptionNew context:NULL];
  }
  emit(@{
    @"event": @"devices",
    @"default": def ? pos_name(def.position) : [NSNull null],
    @"defaultId": def.uniqueID ?: [NSNull null],
    @"listed": listed,
    @"discoveryBack": back,
    @"discoveryFront": front,
    @"frontByType": frontDev ? pos_name(frontDev.position) : [NSNull null],
    @"watched": @(g_discovery.devices.count),
    @"kvo": @(g_discovery_kvo),
  });
}

static void cam_close(void) {
  [g_session stopRunning];
  g_session = nil; g_video = nil; g_meta = nil; g_photo = nil; g_movie = nil; g_layer = nil;
}

static void cam_open(BOOL front, BOOL yuv) {
  cam_close();
  g_collector = [Collector new];
  g_cb_queue = dispatch_queue_create("harness.cb", DISPATCH_QUEUE_SERIAL);
  AVCaptureDevice *dev = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera mediaType:AVMediaTypeVideo position:front ? AVCaptureDevicePositionFront : AVCaptureDevicePositionBack];
  if (!dev) { emit(@{ @"event": @"open", @"device": [NSNull null] }); return; }
  NSError *err = nil;
  AVCaptureDeviceInput *in = [AVCaptureDeviceInput deviceInputWithDevice:dev error:&err];
  g_session = [AVCaptureSession new];
  BOOL canAdd = [g_session canAddInput:in];
  [g_session addInput:in];
  g_video = [AVCaptureVideoDataOutput new];
  g_video.videoSettings = @{ (id)kCVPixelBufferPixelFormatTypeKey: @(yuv ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange : kCVPixelFormatType_32BGRA) };
  [g_video setSampleBufferDelegate:g_collector queue:g_cb_queue];
  g_photo = [AVCapturePhotoOutput new];
  g_meta = [AVCaptureMetadataOutput new];
  g_movie = [AVCaptureMovieFileOutput new];
  for (AVCaptureOutput *o in @[ g_video, g_photo, g_meta, g_movie ]) if ([g_session canAddOutput:o]) [g_session addOutput:o];
  [g_meta setMetadataObjectsDelegate:g_collector queue:g_cb_queue];
  BOOL runningBefore = g_session.isRunning;
  [g_session startRunning];
  spin(0.8);
  Collector *c = g_collector;
  emit(@{
    @"event": @"open",
    @"device": pos_name(dev.position),
    @"error": err.localizedDescription ?: [NSNull null],
    @"canAddInput": @(canAdd),
    @"inputs": @(g_session.inputs.count),
    @"outputs": @(g_session.outputs.count),
    @"runningBefore": @(runningBefore),
    @"running": @(g_session.isRunning),
    @"frames": @(c.frames),
    @"width": @(c.width),
    @"height": @(c.height),
    @"format": @(c.format),
    @"bgr": @[ @(c.center0), @(c.center1), @(c.center2) ],
    @"videoConnection": @([g_video connectionWithMediaType:AVMediaTypeVideo] != nil),
    @"photoCodecs": g_photo.availablePhotoCodecTypes,
  });
}

static void cam_frames(void) {
  int before = g_collector.frames;
  spin(0.6);
  emit(@{ @"event": @"frames", @"delta": @(g_collector.frames - before), @"bgr": @[ @(g_collector.center0), @(g_collector.center1), @(g_collector.center2) ], @"width": @(g_collector.width) });
}

static void cam_photo(BOOL heic) {
  g_collector.photoEvents = [NSMutableArray array];
  g_collector.photoData = nil;
  AVCapturePhotoSettings *settings = heic ? [AVCapturePhotoSettings photoSettingsWithFormat:@{ AVVideoCodecKey: AVVideoCodecTypeHEVC }] : [AVCapturePhotoSettings photoSettings];
  [g_photo capturePhotoWithSettings:settings delegate:g_collector];
  for (int i = 0; i < 40 && ![g_collector.photoEvents containsObject:@"didFinishCapture"]; i++) spin(0.05);
  NSData *d = g_collector.photoData;
  int w = 0, h = 0, b = -1, g = -1, r = -1;
  NSString *type = @"";
  if (d) {
    CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)d, NULL);
    type = (__bridge NSString *)CGImageSourceGetType(src);
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    if (img) {
      w = (int)CGImageGetWidth(img); h = (int)CGImageGetHeight(img);
      CGContextRef ctx = bitmap(w, h);
      CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img);
      const uint8_t *px = CGBitmapContextGetData(ctx);
      size_t row = CGBitmapContextGetBytesPerRow(ctx);
      const uint8_t *c = px + (h / 2) * row + (w / 2) * 4;
      b = c[0]; g = c[1]; r = c[2];
      CGContextRelease(ctx);
      CGImageRelease(img);
    }
    CFRelease(src);
  }
  emit(@{ @"event": @"photo", @"events": g_collector.photoEvents, @"bytes": @(d.length), @"type": type, @"width": @(w), @"height": @(h), @"bgr": @[ @(b), @(g), @(r) ], @"pixelBuffer": @(g_collector.hasPixelBuffer) });
}

static void cam_qr(NSArray<NSString *> *args) {
  g_meta.metadataObjectTypes = @[ AVMetadataObjectTypeQRCode ];
  CGRect roi = args.count >= 5 ? CGRectMake(args[1].doubleValue, args[2].doubleValue, args[3].doubleValue, args[4].doubleValue) : CGRectMake(0, 0, 1, 1);
  g_meta.rectOfInterest = roi;
  @synchronized (g_collector) { [g_collector.codes removeAllObjects]; }
  spin(1.6);
  NSArray *codes;
  @synchronized (g_collector) { codes = [g_collector.codes copy]; }
  emit(@{ @"event": @"qr", @"codes": codes, @"types": g_meta.metadataObjectTypes, @"available": g_meta.availableMetadataObjectTypes, @"roi": @[ @(g_meta.rectOfInterest.origin.x), @(g_meta.rectOfInterest.size.width) ] });
}

static void cam_movie(NSString *path, double seconds) {
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  g_collector.started = NO;
  g_collector.finished = NO;
  g_collector.recordError = nil;
  [g_movie startRecordingToOutputFileURL:[NSURL fileURLWithPath:path] recordingDelegate:g_collector];
  BOOL recording = g_movie.isRecording;
  spin(seconds);
  double duration = CMTimeGetSeconds(g_movie.recordedDuration);
  [g_movie stopRecording];
  BOOL recordingAfterStop = g_movie.isRecording;
  for (int i = 0; i < 60 && !g_collector.finished; i++) spin(0.05);
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  emit(@{
    @"event": @"movie", @"recording": @(recording), @"recordingAfterStop": @(recordingAfterStop), @"started": @(g_collector.started), @"finished": @(g_collector.finished),
    @"error": g_collector.recordError ?: [NSNull null], @"liveDuration": @(duration), @"duration": @(CMTimeGetSeconds(asset.duration)),
    @"tracks": @([asset tracksWithMediaType:AVMediaTypeVideo].count),
  });
}

static void cam_preview(void) {
  g_layer = [AVCaptureVideoPreviewLayer layerWithSession:g_session];
  g_layer.frame = CGRectMake(0, 0, 200, 100);
  g_layer.videoGravity = AVLayerVideoGravityResizeAspectFill;
  spin(0.6);
  CALayer *sub = nil;
  for (CALayer *l in g_layer.sublayers) if ([l.name isEqualToString:@"warden-camera-preview"]) sub = l;
  emit(@{ @"event": @"preview", @"sublayers": @(g_layer.sublayers.count), @"hasContents": @(sub.contents != nil), @"frame": @[ @(sub.frame.size.width), @(sub.frame.size.height) ], @"gravity": sub.contentsGravity ?: @"" });
}

/** Objects a swizzled `init…` hands back must be +1 like any init's: built in a drained pool, then used and dropped. */
static void cam_lifetimes(void) {
  AVCaptureDevice *dev = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  CALayer *layer = [CALayer layer];
  AVCaptureDeviceInput *input = nil;
  AVCaptureDeviceRotationCoordinator *coordinator = nil;
  @autoreleasepool {
    input = [[AVCaptureDeviceInput alloc] initWithDevice:dev error:nil];
    coordinator = [[AVCaptureDeviceRotationCoordinator alloc] initWithDevice:dev previewLayer:layer];
  }
  @autoreleasepool { spin(0.1); }
  BOOL inputOk = input.device == dev;
  BOOL coordOk = coordinator.device == dev && coordinator.previewLayer == layer;
  @autoreleasepool { input = nil; coordinator = nil; }
  @autoreleasepool { spin(0.1); }
  emit(@{ @"event": @"lifetimes", @"input": @(inputOk), @"coordinator": @(coordOk) });
}

static void cam_rotation(void) {
  AVCaptureDevice *dev = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  if (@available(macOS 14.0, *)) {
    AVCaptureDeviceRotationCoordinator *rc = [[AVCaptureDeviceRotationCoordinator alloc] initWithDevice:dev previewLayer:g_layer];
    emit(@{ @"event": @"rotation", @"preview": @(rc.videoRotationAngleForHorizonLevelPreview), @"capture": @(rc.videoRotationAngleForHorizonLevelCapture), @"sameDevice": @(rc.device == dev) });
    return;
  }
  emit(@{ @"event": @"rotation", @"unsupported": @YES });
}

static BOOL handle_camera(NSArray<NSString *> *a) {
  NSString *cmd = a[0];
  if ([cmd isEqualToString:@"cam-make-image"]) { make_solid(a[1], a[2].doubleValue, a[3].doubleValue, a[4].doubleValue); emit(@{ @"event": @"made" }); return YES; }
  if ([cmd isEqualToString:@"cam-make-qr"]) { make_qr(a[1], a[2], a.count > 3 && [a[3] isEqualToString:@"left"]); emit(@{ @"event": @"made" }); return YES; }
  if ([cmd isEqualToString:@"cam-make-video"]) { make_video(a[1], a[2].doubleValue); emit(@{ @"event": @"made" }); return YES; }
  if ([cmd isEqualToString:@"cam-devices"]) { spin(0.2); cam_devices(); return YES; }
  if ([cmd isEqualToString:@"cam-open"]) { cam_open([a[1] isEqualToString:@"front"], a.count > 2 && [a[2] isEqualToString:@"yuv"]); return YES; }
  if ([cmd isEqualToString:@"cam-frames"]) { cam_frames(); return YES; }
  if ([cmd isEqualToString:@"cam-photo"]) { cam_photo(a.count > 1 && [a[1] isEqualToString:@"heic"]); return YES; }
  if ([cmd isEqualToString:@"cam-qr"]) { cam_qr(a); return YES; }
  if ([cmd isEqualToString:@"cam-movie"]) { cam_movie(a[1], a[2].doubleValue); return YES; }
  if ([cmd isEqualToString:@"cam-preview"]) { cam_preview(); return YES; }
  if ([cmd isEqualToString:@"cam-rotation"]) { cam_rotation(); return YES; }
  if ([cmd isEqualToString:@"cam-lifetimes"]) { cam_lifetimes(); return YES; }
  if ([cmd isEqualToString:@"cam-close"]) { cam_close(); emit(@{ @"event": @"closed" }); return YES; }
  return NO;
}

static nw_path_monitor_t g_monitor;

int main(void) {
  @autoreleasepool {
    char buf[256];
    while (fgets(buf, sizeof buf, stdin)) {
      NSString *cmd = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if ([cmd isEqualToString:@"quit"]) break;
      if ([cmd hasPrefix:@"cam-"]) {
        if (!handle_camera([cmd componentsSeparatedByString:@" "])) emit(@{ @"error": @"unknown command" });
        continue;
      }
      if ([cmd isEqualToString:@"monitor"]) {
        g_monitor = nw_path_monitor_create();
        nw_path_monitor_set_queue(g_monitor, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
        nw_path_monitor_set_update_handler(g_monitor, ^(nw_path_t p) {
          emit(@{ @"event": @"path", @"status": @((int)nw_path_get_status(p)) });
        });
        nw_path_monitor_start(g_monitor);
        continue;
      }
      NSURLSessionConfiguration *c = NSURLSessionConfiguration.defaultSessionConfiguration;
      NSURLSessionConfiguration *e = NSURLSessionConfiguration.ephemeralSessionConfiguration;
      NSURLSessionConfiguration *bare = [e copy];
      bare.connectionProxyDictionary = nil;
      NSURLSession *s = [NSURLSession sessionWithConfiguration:bare];
      struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
      struct timeval tv; gettimeofday(&tv, NULL);
      SCNetworkReachabilityRef r = SCNetworkReachabilityCreateWithName(NULL, "example.com");
      SCNetworkReachabilityFlags flags = 0xdead;
      SCNetworkReachabilityGetFlags(r, &flags);
      nw_path_monitor_t m = nw_path_monitor_create();
      emit(@{
        @"defaultProxy": c.connectionProxyDictionary ?: [NSNull null],
        @"ephemeralProxy": e.connectionProxyDictionary ?: [NSNull null],
        @"sharedProxy": NSURLSession.sharedSession.configuration.connectionProxyDictionary ?: [NSNull null],
        @"sessionProxy": s.configuration.connectionProxyDictionary ?: [NSNull null],
        @"clockMs": @((long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000),
        @"todMs": @((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000),
        @"timeS": @((long long)time(NULL)),
        @"cfAbsS": @(CFAbsoluteTimeGetCurrent() + kCFAbsoluteTimeIntervalSince1970),
        @"reachFlags": @(flags),
        @"monotonicOk": @(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) > 0),
      });
      (void)m;
    }
  }
  return 0;
}
