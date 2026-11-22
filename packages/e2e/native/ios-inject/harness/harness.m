// Test harness for libwarden-inject (macOS build): a line on stdin -> one JSON line describing what the injected
// process sees. Commands: `print`, `monitor` (start an NWPathMonitor and report each update), `quit`, and the `cam-*`
// `pk-run` command that drives the virtual authenticator through the real AuthenticationServices API, and the `cam-*`
// commands that drive the simulated camera (`#pragma mark - camera` in WardenInject.m) through the real AVFoundation API,
// and the `kacl-*` commands that drive the Keychain ACL shim against a fake Keychain and evaluator.
#import <AVFoundation/AVFoundation.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <dlfcn.h>
#import <objc/message.h>
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
  // Frames start asynchronously: a video feed decodes its first frame after startRunning, and on a 3-vCPU CI runner
  // that can land after the fixed 0.8 s above, which then reported 0 frames for a working feed. Wait for the first
  // frame itself; the bound only stops a feed that never delivers from hanging the harness (it still reports 0).
  for (int i = 0; i < 100 && g_collector.frames == 0; i++) spin(0.05);
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


#pragma mark - passkeys

static NSString *b64u(NSData *d) {
  NSString *s = [d base64EncodedStringWithOptions:0];
  s = [[s stringByReplacingOccurrencesOfString:@"+" withString:@"-"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  while ([s hasSuffix:@"="]) s = [s substringToIndex:s.length - 1];
  return s;
}

static NSData *unb64u(NSString *s) {
  NSMutableString *m = [[[s stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"] mutableCopy];
  while (m.length % 4) [m appendString:@"="];
  return [[NSData alloc] initWithBase64EncodedString:m options:0];
}

static NSObject *pk_obj(id o, NSString *key) {
  SEL s = NSSelectorFromString(key);
  if (![o respondsToSelector:s]) return nil;
  return ((id (*)(id, SEL))objc_msgSend)(o, s);
}

static NSString *pk_b64(id o, NSString *key) {
  id v = pk_obj(o, key);
  return [v isKindOfClass:[NSData class]] ? b64u(v) : nil;
}

@interface PkDelegate : NSObject <ASAuthorizationControllerDelegate>
@property (nonatomic, strong) NSDictionary *result;
@property (nonatomic) int calls;
@end

@implementation PkDelegate
- (void)authorizationController:(ASAuthorizationController *)c didCompleteWithAuthorization:(ASAuthorization *)auth {
  self.calls++;
  id cred = auth.credential;
  NSMutableDictionary *d = [@{
    @"kind": @"auth",
    @"onMain": @(NSThread.isMainThread),
    @"isRegistration": @([cred isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]),
    @"isAssertion": @([cred isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]]),
    @"providerIsPlatform": @([auth.provider isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialProvider class]]),
    @"attachment": @([[cred valueForKey:@"attachment"] integerValue]),
    @"prfNil": @((BOOL)(pk_obj(cred, @"prf") == nil)),
    @"largeBlobNil": @((BOOL)(pk_obj(cred, @"largeBlob") == nil)),
  } mutableCopy];
  for (NSString *k in @[@"credentialID", @"rawClientDataJSON", @"rawAttestationObject", @"rawAuthenticatorData", @"signature", @"userID"]) {
    NSString *v = pk_b64(cred, k);
    if (v) d[k] = v;
  }
  self.result = d;
}
- (void)authorizationController:(ASAuthorizationController *)c didCompleteWithError:(NSError *)error {
  self.calls++;
  NSString *reason = error.userInfo[NSLocalizedFailureReasonErrorKey];
  self.result = @{
    @"kind": @"error", @"onMain": @(NSThread.isMainThread), @"domain": error.domain, @"code": @(error.code),
    @"userInfoCount": @(error.userInfo.count), @"reason": reason ?: [NSNull null], @"description": error.localizedDescription ?: @"",
  };
}
@end

static NSMutableArray *g_pk_keep;

/**
 * `pk-run {json}`: one ASAuthorizationController through the real API. Keys: kind reg|asr, rp, challenge (b64url), name,
 * userId (b64url), allow / exclude ([b64url ids]), extra (["password","securityKey"] added to the request array), via
 * perform|options|autofill, options (number), clientData (bool: the `...WithClientData:` request), cancel (bool: call
 * -cancel right after), wait (seconds to wait for a callback, default 1). Emits {event:"pk", kind:auth|error|none, ...}.
 */
static void pk_run(NSString *json) {
  NSDictionary *a = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  NSString *rp = a[@"rp"];
  NSData *challenge = unb64u(a[@"challenge"] ?: @"AAAA");
  NSMutableArray *requests = [NSMutableArray array];
  ASAuthorizationPlatformPublicKeyCredentialProvider *prov = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rp];
  BOOL clientData = [a[@"clientData"] boolValue];
  ASPublicKeyCredentialClientData *cd = clientData ? [[ASPublicKeyCredentialClientData alloc] initWithChallenge:challenge origin:[@"https://" stringByAppendingString:rp]] : nil;
  if (a[@"kind"] && ![a[@"kind"] isEqual:@"none"]) {
    if ([a[@"kind"] isEqual:@"reg"]) {
      NSData *uid = unb64u(a[@"userId"] ?: @"AQID");
      ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *r = clientData
        ? [prov createCredentialRegistrationRequestWithClientData:cd name:a[@"name"] ?: @"user" userID:uid]
        : [prov createCredentialRegistrationRequestWithChallenge:challenge name:a[@"name"] ?: @"user" userID:uid];
      NSMutableArray *ex = [NSMutableArray array];
      for (NSString *i in a[@"exclude"] ?: @[]) [ex addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:unb64u(i)]];
      if (ex.count) r.excludedCredentials = ex;
      [requests addObject:r];
    } else {
      ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *r = clientData
        ? [prov createCredentialAssertionRequestWithClientData:cd]
        : [prov createCredentialAssertionRequestWithChallenge:challenge];
      NSMutableArray *al = [NSMutableArray array];
      for (NSString *i in a[@"allow"] ?: @[]) [al addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:unb64u(i)]];
      if (al.count) r.allowedCredentials = al;
      [requests addObject:r];
    }
  }
  for (NSString *e in a[@"extra"] ?: @[]) {
    if ([e isEqual:@"password"]) [requests addObject:[[[ASAuthorizationPasswordProvider alloc] init] createRequest]];
    if ([e isEqual:@"securityKey"]) {
      ASAuthorizationSecurityKeyPublicKeyCredentialProvider *sk = [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rp];
      [requests addObject:[sk createCredentialAssertionRequestWithChallenge:challenge]];
    }
  }
  ASAuthorizationController *ctl = [[ASAuthorizationController alloc] initWithAuthorizationRequests:requests];
  PkDelegate *del = [PkDelegate new];
  ctl.delegate = del;
  if (!g_pk_keep) g_pk_keep = [NSMutableArray array];
  [g_pk_keep addObject:ctl];
  [g_pk_keep addObject:del];
  NSString *via = a[@"via"] ?: @"perform";
  if ([via isEqual:@"options"]) [ctl performRequestsWithOptions:(ASAuthorizationControllerRequestOptions)[a[@"options"] unsignedIntegerValue]];
  else if ([via isEqual:@"autofill"]) {
    // iOS only: the selector is unavailable to the macOS compiler, and the dylib only swizzles it where it exists
    SEL autofill = NSSelectorFromString(@"performAutoFillAssistedRequests");
    if (![ctl respondsToSelector:autofill]) { emit(@{ @"event": @"pk", @"kind": @"unsupported" }); return; }
    ((void (*)(id, SEL))objc_msgSend)(ctl, autofill);
  }
  else [ctl performRequests];
  BOOL syncCalled = del.calls > 0;
  if ([a[@"cancel"] boolValue]) [ctl cancel];
  NSDate *until = [NSDate dateWithTimeIntervalSinceNow:[a[@"wait"] doubleValue] ?: 1.0];
  while (del.calls == 0 && [until timeIntervalSinceNow] > 0) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
  NSMutableDictionary *out = [(del.result ?: @{ @"kind": @"none" }) mutableCopy];
  out[@"event"] = @"pk";
  out[@"calledSynchronously"] = @(syncCalled);
  out[@"calls"] = @(del.calls);
  emit(out);
}

#pragma mark - keychain acl
// `kacl-parse` / `kacl-parse-text <desc>` / `kacl-run <json>` / `kacl-add <json>` drive the Keychain ACL shim (`#pragma mark - keychain acl`
// in WardenInject.m). The Keychain and LocalAuthentication are fakes installed through the host build's test hooks:
// a Mac cannot hold an access-controlled item without entitlements, and a test must never show a real dialog.

typedef OSStatus (*KaclCopyFn)(CFDictionaryRef, CFTypeRef *);
typedef OSStatus (*KaclAddFn)(CFDictionaryRef, CFTypeRef *);
typedef void (*KaclEvalFn)(id ctx, NSInteger policy, NSString *reason, void (^reply)(BOOL, NSError *));
typedef NSInteger (*KaclCanEvalFn)(id ctx, NSInteger policy);
typedef void (*KaclHooksFn)(KaclCopyFn, KaclAddFn, KaclEvalFn, KaclCanEvalFn);
typedef NSString *(*KaclParseFn)(NSString *);

static NSArray *g_k_items;            // of NSString (acl name) | NSNull (plain item)
static NSDictionary *g_k_query;       // the app's own query: a call with exactly it is the read, anything else a probe
static NSMutableArray *g_k_probes, *g_k_reads, *g_k_evals;
static NSInteger g_k_eval_code = 0;
static NSDictionary *g_k_can;
static NSString *g_k_who = @"shim";
static NSObject *g_k_lock;

static NSDictionary *k_flags(void) {
  return @{
    @"currentSet": @(kSecAccessControlBiometryCurrentSet),
    @"any": @(kSecAccessControlBiometryAny),
    @"passcode": @(kSecAccessControlDevicePasscode),
    @"presence": @(kSecAccessControlUserPresence),
    @"currentSet-or-passcode": @(kSecAccessControlBiometryCurrentSet | kSecAccessControlOr | kSecAccessControlDevicePasscode),
    @"any-or-passcode": @(kSecAccessControlBiometryAny | kSecAccessControlOr | kSecAccessControlDevicePasscode),
    @"currentSet-and-passcode": @(kSecAccessControlBiometryCurrentSet | kSecAccessControlAnd | kSecAccessControlDevicePasscode),
    @"appPassword": @(kSecAccessControlApplicationPassword),
    @"keyUsage": @(kSecAccessControlPrivateKeyUsage),
    @"none": @0,
  };
}

static id k_access_control(NSString *name) {
  NSNumber *flags = k_flags()[name];
  if (!flags) return nil;
  return CFBridgingRelease(SecAccessControlCreateWithFlags(NULL, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, (SecAccessControlCreateFlags)flags.unsignedLongValue, NULL));
}

/** What a Keychain hands back for item `i`: the app's attributes plus the ones the system assigns (`agrp`, `sync`). */
static NSDictionary *k_attrs(id item, NSUInteger i) {
  NSMutableDictionary *d = [@{
    (id)kSecClass: (id)kSecClassGenericPassword,
    (id)kSecAttrService: @"svc",
    (id)kSecAttrAccount: [NSString stringWithFormat:@"a%lu", (unsigned long)i],
    (id)kSecAttrAccessGroup: @"TEAM.example",
    (id)kSecAttrSynchronizable: @0,
  } mutableCopy];
  if ([item isKindOfClass:[NSString class]]) d[(id)kSecAttrAccessControl] = k_access_control(item);
  return d;
}

static NSArray *k_keys(NSDictionary *q) {
  NSMutableArray *keys = [NSMutableArray array];
  for (id k in q) [keys addObject:[k description]];
  return [keys sortedArrayUsingSelector:@selector(compare:)];
}

static OSStatus k_fake_copy(CFDictionaryRef query, CFTypeRef *result) {
  NSDictionary *q = (__bridge NSDictionary *)query;
  BOOL all = [q[(id)kSecMatchLimit] isEqual:(id)kSecMatchLimitAll];
  BOOL data = [q[(id)kSecReturnData] boolValue];
  BOOL attrs = [q[(id)kSecReturnAttributes] boolValue];
  BOOL isRead = g_k_query && [q isEqualToDictionary:g_k_query];
  @synchronized(g_k_lock) {
    if (isRead) [g_k_reads addObject:@{ @"keys": k_keys(q) }];
    else [g_k_probes addObject:@{ @"keys": k_keys(q), @"limit": all ? @"all" : @"one", @"returnAttributes": @(attrs) }];
  }
  NSMutableArray *out = [NSMutableArray array];
  for (NSUInteger i = 0; i < g_k_items.count; i++) {
    NSDictionary *attrs = k_attrs(g_k_items[i], i);
    // a query naming an account matches only that item (the shim's read-back after an add does)
    if (q[(id)kSecAttrAccount] && ![q[(id)kSecAttrAccount] isEqual:attrs[(id)kSecAttrAccount]]) continue;
    [out addObject:data ? (id)[@"secret" dataUsingEncoding:NSUTF8StringEncoding] : attrs];
  }
  if (out.count == 0) return errSecItemNotFound;
  if (result) *result = CFBridgingRetain(all ? out : out.firstObject);
  return errSecSuccess;
}

static NSMutableArray *g_k_adds;
static BOOL g_k_duplicate;

static OSStatus k_fake_add(CFDictionaryRef attributes, CFTypeRef *result) {
  NSDictionary *a = (__bridge NSDictionary *)attributes;
  @synchronized(g_k_lock) {
    [g_k_adds addObject:@{ @"account": a[(id)kSecAttrAccount] ?: @"", @"accessControl": a[(id)kSecAttrAccessControl] ? @YES : @NO }];
  }
  if (result) *result = NULL;
  return g_k_duplicate ? errSecDuplicateItem : errSecSuccess;
}

static void k_fake_eval(id ctx, NSInteger policy, NSString *reason, void (^reply)(BOOL, NSError *)) {
  @synchronized(g_k_lock) { [g_k_evals addObject:@{ @"policy": @(policy), @"reason": reason ?: @"", @"context": g_k_who }]; }
  NSInteger code = g_k_eval_code;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    reply(code == 0, code == 0 ? nil : [NSError errorWithDomain:@"com.apple.LocalAuthentication" code:code userInfo:nil]);
  });
}

static NSInteger k_fake_can(id ctx, NSInteger policy) {
  return [g_k_can[[NSString stringWithFormat:@"%ld", (long)policy]] integerValue];
}

static BOOL k_install_hooks(void) {
  KaclHooksFn hooks = (KaclHooksFn)dlsym(RTLD_DEFAULT, "warden_inject_kacl_test_hooks");
  if (!hooks) return NO;
  hooks(k_fake_copy, k_fake_add, k_fake_eval, k_fake_can);
  return YES;
}

static NSDictionary *k_parse(NSString *desc) {
  KaclParseFn parse = (KaclParseFn)dlsym(RTLD_DEFAULT, "warden_inject_kacl_parse");
  if (!parse) return @{ @"error": @"no warden_inject_kacl_parse" };
  return [NSJSONSerialization JSONObjectWithData:[parse(desc) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}

static void kacl_parse_table(void) {
  NSMutableDictionary *rows = [NSMutableDictionary dictionary];
  for (NSString *name in k_flags()) {
    NSString *desc = CFBridgingRelease(CFCopyDescription((__bridge CFTypeRef)k_access_control(name)));
    rows[name] = @{ @"desc": desc, @"parsed": k_parse(desc) };
  }
  emit(@{ @"event": @"kacl-parse", @"rows": rows });
}

static void kacl_run(NSString *json) {
  NSDictionary *a = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (!g_k_lock) g_k_lock = [NSObject new];
  BOOL hooks = k_install_hooks();
  g_k_items = [a[@"items"] isKindOfClass:[NSArray class]] ? a[@"items"] : @[];
  g_k_probes = [NSMutableArray array];
  g_k_reads = [NSMutableArray array];
  g_k_evals = [NSMutableArray array];
  g_k_eval_code = [a[@"evalCode"] integerValue];
  g_k_can = [a[@"canEval"] isKindOfClass:[NSDictionary class]] ? a[@"canEval"] : @{};

  NSMutableDictionary *q = [@{ (id)kSecClass: (id)kSecClassGenericPassword, (id)kSecAttrService: @"svc" } mutableCopy];
  if ([a[@"returnData"] boolValue]) q[(id)kSecReturnData] = @YES;
  if ([a[@"returnAttributes"] boolValue]) q[(id)kSecReturnAttributes] = @YES;
  q[(id)kSecMatchLimit] = [a[@"matchLimit"] isEqual:@"all"] ? (id)kSecMatchLimitAll : (id)kSecMatchLimitOne;
  NSDictionary *ui = @{ @"allow": (id)kSecUseAuthenticationUIAllow, @"fail": (id)kSecUseAuthenticationUIFail, @"skip": (id)kSecUseAuthenticationUISkip };
  if (ui[a[@"authUI"]]) q[(id)kSecUseAuthenticationUI] = ui[a[@"authUI"]];
  if ([a[@"prompt"] isKindOfClass:[NSString class]]) q[(id)kSecUseOperationPrompt] = a[@"prompt"];
  NSDictionary *c = [a[@"context"] isKindOfClass:[NSDictionary class]] ? a[@"context"] : nil;
  if (c) {
    LAContext *ctx = [LAContext new];
    if ([c[@"evaluate"] integerValue]) {
      g_k_who = @"app";
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      [ctx evaluatePolicy:(LAPolicy)[c[@"evaluate"] integerValue] localizedReason:@"app" reply:^(BOOL ok, NSError *e) { dispatch_semaphore_signal(done); }];
      dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    }
    ctx.interactionNotAllowed = [c[@"interactionNotAllowed"] boolValue];
    q[(id)kSecUseAuthenticationContext] = ctx;
  }
  g_k_who = @"shim";
  g_k_query = [q copy];

  __block OSStatus status = 0;
  __block CFTypeRef result = NULL;
  if ([a[@"background"] boolValue]) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      status = SecItemCopyMatching((__bridge CFDictionaryRef)g_k_query, &result);
      dispatch_semaphore_signal(done);
    });
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  } else {
    status = SecItemCopyMatching((__bridge CFDictionaryRef)g_k_query, &result);
  }
  id value = result ? CFBridgingRelease(result) : nil;
  if ([value isKindOfClass:[NSArray class]]) value = [value firstObject];
  NSString *data = [value isKindOfClass:[NSData class]] ? [[NSString alloc] initWithData:value encoding:NSUTF8StringEncoding] : nil;
  g_k_query = nil;
  emit(@{
    @"event": @"kacl", @"status": @(status), @"data": data ?: [NSNull null], @"hooks": @(hooks),
    @"evals": g_k_evals, @"probes": g_k_probes, @"reads": g_k_reads,
  });
}

/** `kacl-add <json>`: the app adds account `a<account>` with `acl` (null = none) through the interposed `SecItemAdd`. */
static void kacl_add(NSString *json) {
  NSDictionary *a = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (!g_k_lock) g_k_lock = [NSObject new];
  k_install_hooks();
  g_k_items = [a[@"items"] isKindOfClass:[NSArray class]] ? a[@"items"] : @[];
  g_k_probes = [NSMutableArray array];
  g_k_reads = [NSMutableArray array];
  g_k_evals = [NSMutableArray array];
  g_k_adds = [NSMutableArray array];
  g_k_duplicate = [a[@"duplicate"] boolValue];
  g_k_query = nil;
  NSMutableDictionary *attrs = [@{
    (id)kSecClass: (id)kSecClassGenericPassword,
    (id)kSecAttrService: @"svc",
    (id)kSecAttrAccount: [NSString stringWithFormat:@"a%ld", (long)[a[@"account"] integerValue]],
    (id)kSecValueData: [@"secret" dataUsingEncoding:NSUTF8StringEncoding],
  } mutableCopy];
  if ([a[@"acl"] isKindOfClass:[NSString class]]) attrs[(id)kSecAttrAccessControl] = k_access_control(a[@"acl"]);
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)attrs, NULL);
  emit(@{ @"event": @"kacl-add", @"status": @(status), @"adds": g_k_adds, @"probes": g_k_probes });
}

static nw_path_monitor_t g_monitor;

int main(void) {
  @autoreleasepool {
    static char buf[16384];
    while (fgets(buf, sizeof buf, stdin)) {
      NSString *cmd = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if ([cmd isEqualToString:@"quit"]) break;
      if ([cmd hasPrefix:@"pk-run "]) { pk_run([cmd substringFromIndex:7]); continue; }
      if ([cmd isEqualToString:@"kacl-parse"]) { kacl_parse_table(); continue; }
      if ([cmd hasPrefix:@"kacl-parse-text "]) { emit(@{ @"event": @"kacl-parse-text", @"parsed": k_parse([cmd substringFromIndex:16]) }); continue; }
      if ([cmd hasPrefix:@"kacl-run "]) { kacl_run([cmd substringFromIndex:9]); continue; }
      if ([cmd hasPrefix:@"kacl-add "]) { kacl_add([cmd substringFromIndex:9]); continue; }
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
