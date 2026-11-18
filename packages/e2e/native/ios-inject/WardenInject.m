// libwarden-inject: injected into an iOS-simulator app by `DYLD_INSERT_LIBRARIES` (SIMCTL_CHILD_*), whenever warden
// launches it with a condition active (network, clock, camera, software keyboard: the default, so nearly always).
// Without the env below it is never loaded.
//
// Env (set by warden at launch):
//   WARDEN_NET_PROXY=127.0.0.1:<port>   route NSURLSession HTTP+HTTPS through the lease's shaping proxy
//   WARDEN_INJECT_STATE=<file>          control file, watched live: {"seq":n,"offline":bool,"clockOffsetMs":n,"clockFrozenMs":n?,"keyboard":"software"|"hardware"?,"camera":{"back"?:{kind,path,loop},"front"?:…},"passkeys"?:{mode,uv,storePath},"keychainAcl"?:{enabled,generation,itemsPath}}
//   WARDEN_CLOCK_OFFSET_MS=<n>          initial wall-clock offset (the state file overrides it)
//   WARDEN_CLOCK_FROZEN_MS=<n>          initial frozen wall time, ms since the epoch (the state file overrides it)
//   WARDEN_CAMERA=1                     fake the AVFoundation capture stack from the state file's `camera` feeds (see "camera")
//   WARDEN_PASSKEYS=1                   answer platform passkey requests with a virtual authenticator from the state file's `passkeys` (see "passkeys")
//   WARDEN_KEYCHAIN_ACL=1               make data reads of access-controlled Keychain items prompt like a device (see "keychain acl");
//                                       `keychainAcl.generation` is the biometric enrolment generation, `itemsPath` the
//                                       sidecar where the dylib (its only writer) records the generation each ACL item was added at
//   WARDEN_KEYBOARD=software|hardware   initial keyboard mode (the state file's `keyboard` overrides it live); see "keyboard"
//   WARDEN_INJECT_DEBUG=1               log to stderr
//
// Control channel: the simulator shares the host filesystem, so the channel is a file. The host replaces
// `WARDEN_INJECT_STATE` atomically (write + rename); a vnode watch on its directory fires, the new state is applied
// and `<file>.ack` is written with `{"seq":n,"pid":p,"proxy":bool,"camera":bool,"passkeys":bool,"keychainAcl":bool,"bundle":id}` (`proxy`: launched with WARDEN_NET_PROXY; `camera`: launched with WARDEN_CAMERA=1; `passkeys`: launched with WARDEN_PASSKEYS=1; `keychainAcl`: launched with WARDEN_KEYCHAIN_ACL=1; `bundle`: so the host ignores another injected app). No sockets, no polling, nothing running while idle.
//
// Accessibility read (A11Y-1): a state with `"a11yRead":true` makes the app walk its UIKit accessibility tree on the main
// thread and write `<file>.a11y` = {"req":seq,"nodes":[{cls,ae,label,hint,value,id,traits:"0x..",frame:[x,y,w,h] (screen
// points),actions:[names],order?:n}]} (traversal order; `order` = index in the container's accessibilityElements, only
// when the app set that array) BEFORE the ack for that seq is written. Hidden views (hidden, alpha 0,
// accessibilityElementsHidden) are skipped with their subtree; if the main thread does not answer in 3 s the file says
// {"req":seq,"error":"main thread busy"}. Not iOS (the macOS test harness): {"req":seq,"nodes":[],"unsupported":true}.
//
// Accessibility events (A11Y-8): `UIAccessibilityPostNotification` is interposed (the original is always called) and
// announcements (argument NSString or NSAttributedString), screen-changed and layout-changed are appended as JSON lines
// {"kind":"announcement"|"screen-changed"|"layout-changed","text"?:s,"at":epoch ms} to `<file>.events` (append-only;
// the host's cursor is a byte offset, and a line is only complete once it ends in a newline). Needs WARDEN_INJECT_STATE.
//
// Keyboard (KBD-2): HID typing makes iOS treat a hardware keyboard as attached and minimise the on-screen keyboard. In
// `software` mode `-[UIKeyboardImpl isMinimized]` answers NO, so the keyboard stays up while warden types; `hardware`
// answers YES (it never depends on whether iOS has seen a HID keyboard event). Every mode change runs `reloadInputViews` on the main thread, so the keyboard shows or hides at
// once, no relaunch. The initial mode is `WARDEN_KEYBOARD`; a state file without a `keyboard` field leaves the mode as is.
// A state with `"dismissKeyboard":true` resigns the first responder (a one-shot, like `a11yRead`): the keyboard goes away
// without a Return that could submit the focused form.
// Private API: re-verify on each iOS release (a missing class or selector makes the mode a no-op, never a crash).
//
// Covered: NSURLSession (default/ephemeral/background configurations and sessionWithConfiguration:*), network path
// APIs (nw_path_get_status, nw_path_uses_interface_type, NWPathMonitor update handlers re-fired on change),
// SCNetworkReachability (flags, callbacks re-fired on change), wall clocks (clock_gettime(CLOCK_REALTIME),
// gettimeofday, time, CFAbsoluteTimeGetCurrent), shifted by an offset or held at a fixed instant (`clockFrozenMs`). NSURLSession.sharedSession is replaced by a session on the routed
// default configuration (sharing the shared session's cache, cookie and credential stores). Not covered: raw sockets / NWConnection / CFStream (they bypass the proxy), monotonic clocks (left real on purpose).
#import <TargetConditionals.h>
#import <Foundation/Foundation.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif
#import <Network/Network.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>
#import <stdatomic.h>
#import <os/lock.h>
#import <fcntl.h>
#import <sys/time.h>
#import <time.h>
#import <unistd.h>

static _Atomic int g_offline = 0;
static _Atomic long long g_clock_offset_ms = 0;
static _Atomic int g_clock_frozen = 0;
static _Atomic long long g_clock_frozen_ms = 0;
static _Atomic long long g_applied_seq = -1;
static BOOL g_debug = NO;
static NSString *g_state_path = nil;
static dispatch_source_t g_state_source = nil;

#define DLOG(...) do { if (g_debug) { fprintf(stderr, "[warden-inject] "); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

#define INTERPOSE(rep, orig) \
  __attribute__((used)) static struct { const void *r; const void *o; } _interpose_##rep \
  __attribute__((section("__DATA,__interpose"))) = { (const void *)(unsigned long)&rep, (const void *)(unsigned long)&orig }

#pragma mark - proxy routing

static NSDictionary *g_proxy_dict = nil;

static NSURLSessionConfiguration *routed(NSURLSessionConfiguration *config) {
  if (!g_proxy_dict || !config || config.connectionProxyDictionary) return config;
  NSURLSessionConfiguration *copy = [config copy];
  copy.connectionProxyDictionary = g_proxy_dict;
  return copy;
}

static void install_proxy(NSString *hostPort) {
  NSArray<NSString *> *parts = [hostPort componentsSeparatedByString:@":"];
  if (parts.count != 2) return;
  NSString *host = parts[0];
  NSNumber *port = @([parts[1] intValue]);
  g_proxy_dict = @{
    @"HTTPEnable": @1, @"HTTPProxy": host, @"HTTPPort": port,
    @"HTTPSEnable": @1, @"HTTPSProxy": host, @"HTTPSPort": port,
  };

  Class cfg = [NSURLSessionConfiguration class];
  for (NSString *name in @[ @"defaultSessionConfiguration", @"ephemeralSessionConfiguration" ]) {
    SEL sel = NSSelectorFromString(name);
    Method m = class_getClassMethod(cfg, sel);
    if (!m) continue;
    NSURLSessionConfiguration *(*orig)(id, SEL) = (void *)method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^NSURLSessionConfiguration *(id self_) {
      NSURLSessionConfiguration *c = orig(self_, sel);
      c.connectionProxyDictionary = g_proxy_dict;
      return c;
    }));
  }
  {
    SEL sel = @selector(backgroundSessionConfigurationWithIdentifier:);
    Method m = class_getClassMethod(cfg, sel);
    if (m) {
      NSURLSessionConfiguration *(*orig)(id, SEL, NSString *) = (void *)method_getImplementation(m);
      method_setImplementation(m, imp_implementationWithBlock(^NSURLSessionConfiguration *(id self_, NSString *ident) {
        NSURLSessionConfiguration *c = orig(self_, sel, ident);
        c.connectionProxyDictionary = g_proxy_dict;
        return c;
      }));
    }
  }
  Class session = [NSURLSession class];
  {
    SEL sel = @selector(sessionWithConfiguration:);
    Method m = class_getClassMethod(session, sel);
    if (m) {
      NSURLSession *(*orig)(id, SEL, NSURLSessionConfiguration *) = (void *)method_getImplementation(m);
      method_setImplementation(m, imp_implementationWithBlock(^NSURLSession *(id self_, NSURLSessionConfiguration *c) {
        return orig(self_, sel, routed(c));
      }));
    }
  }
  {
    SEL sel = @selector(sessionWithConfiguration:delegate:delegateQueue:);
    Method m = class_getClassMethod(session, sel);
    if (m) {
      NSURLSession *(*orig)(id, SEL, NSURLSessionConfiguration *, id, NSOperationQueue *) = (void *)method_getImplementation(m);
      method_setImplementation(m, imp_implementationWithBlock(
        ^NSURLSession *(id self_, NSURLSessionConfiguration *c, id d, NSOperationQueue *q) {
          return orig(self_, sel, routed(c), d, q);
        }));
    }
  }
  // +sharedSession is built from the system proxy settings, not from a configuration we can patch: hand out one
  // delegate-less session on the routed default configuration instead (same cache, cookies and credentials stores).
  {
    SEL sel = @selector(sharedSession);
    Method m = class_getClassMethod(session, sel);
    if (m) {
      static NSURLSession *routedShared = nil;
      static dispatch_once_t once;
      NSURLSession *(*orig)(id, SEL) = (void *)method_getImplementation(m);
      method_setImplementation(m, imp_implementationWithBlock(^NSURLSession *(id self_) {
        dispatch_once(&once, ^{
          NSURLSession *real = orig(self_, sel);
          NSURLSessionConfiguration *c = [NSURLSessionConfiguration defaultSessionConfiguration];
          c.URLCache = real.configuration.URLCache;
          c.HTTPCookieStorage = real.configuration.HTTPCookieStorage;
          c.URLCredentialStorage = real.configuration.URLCredentialStorage;
          routedShared = [NSURLSession sessionWithConfiguration:c];
        });
        return routedShared;
      }));
    }
  }
  DLOG("routing NSURLSession via %s", hostPort.UTF8String);
}

#pragma mark - offline: Network.framework

static NSMutableArray *g_monitors = nil;  // of NSMutableDictionary: monitor, handler, last, queue
static NSObject *g_lock = nil;

static NSMutableDictionary *entry_for(nw_path_monitor_t m) {
  for (NSMutableDictionary *e in g_monitors) if (e[@"monitor"] == (id)m) return e;
  NSMutableDictionary *e = [NSMutableDictionary dictionaryWithObject:m forKey:@"monitor"];
  [g_monitors addObject:e];
  return e;
}

static void rep_set_update_handler(nw_path_monitor_t m, nw_path_monitor_update_handler_t h) {
  nw_path_monitor_update_handler_t wrapped = ^(nw_path_t path) {
    @synchronized (g_lock) { entry_for(m)[@"last"] = path; }
    if (h) h(path);
  };
  @synchronized (g_lock) { entry_for(m)[@"handler"] = [wrapped copy]; }
  nw_path_monitor_set_update_handler(m, wrapped);
}
INTERPOSE(rep_set_update_handler, nw_path_monitor_set_update_handler);

static void rep_set_queue(nw_path_monitor_t m, dispatch_queue_t q) {
  @synchronized (g_lock) { entry_for(m)[@"queue"] = q; }
  nw_path_monitor_set_queue(m, q);
}
INTERPOSE(rep_set_queue, nw_path_monitor_set_queue);

static nw_path_status_t rep_path_status(nw_path_t path) {
  return atomic_load(&g_offline) ? nw_path_status_unsatisfied : nw_path_get_status(path);
}
INTERPOSE(rep_path_status, nw_path_get_status);

static bool rep_uses_interface_type(nw_path_t path, nw_interface_type_t type) {
  return atomic_load(&g_offline) ? false : nw_path_uses_interface_type(path, type);
}
INTERPOSE(rep_uses_interface_type, nw_path_uses_interface_type);

#pragma mark - offline: SCNetworkReachability

static NSMutableArray *g_reach = nil;  // of NSDictionary: target, callback (NSValue), info (NSValue)

static Boolean rep_reach_flags(SCNetworkReachabilityRef t, SCNetworkReachabilityFlags *flags) {
  if (atomic_load(&g_offline)) {
    if (flags) *flags = 0;
    return true;
  }
  return SCNetworkReachabilityGetFlags(t, flags);
}
INTERPOSE(rep_reach_flags, SCNetworkReachabilityGetFlags);

static Boolean rep_reach_callback(SCNetworkReachabilityRef t, SCNetworkReachabilityCallBack cb, SCNetworkReachabilityContext *ctx) {
  if (cb) {
    @synchronized (g_lock) {
      [g_reach addObject:@{ @"target": (__bridge id)t, @"cb": [NSValue valueWithPointer:(const void *)cb],
                            @"info": [NSValue valueWithPointer:ctx ? ctx->info : NULL] }];
    }
  }
  return SCNetworkReachabilitySetCallback(t, cb, ctx);
}
INTERPOSE(rep_reach_callback, SCNetworkReachabilitySetCallback);

// Re-fire what the app registered, so a live offline switch reaches NetInfo-style listeners without a relaunch.
static void notify_connectivity_changed(void) {
  NSArray *monitors, *reach;
  @synchronized (g_lock) { monitors = [g_monitors copy]; reach = [g_reach copy]; }
  for (NSDictionary *e in monitors) {
    nw_path_t last = e[@"last"];
    nw_path_monitor_update_handler_t handler = e[@"handler"];
    dispatch_queue_t q = e[@"queue"];
    if (last && handler && q) dispatch_async(q, ^{ handler(last); });
  }
  for (NSDictionary *e in reach) {
    SCNetworkReachabilityRef target = (__bridge SCNetworkReachabilityRef)e[@"target"];
    SCNetworkReachabilityCallBack cb = [e[@"cb"] pointerValue];
    void *info = [e[@"info"] pointerValue];
    dispatch_async(dispatch_get_main_queue(), ^{
      SCNetworkReachabilityFlags flags = 0;
      rep_reach_flags(target, &flags);
      cb(target, flags, info);
    });
  }
}

#pragma mark - wall clock

static inline long long offset_ms(void) { return atomic_load(&g_clock_offset_ms); }

// Shift a (sec, sub-second) pair by `off` ms; `unit` is the sub-second ticks per second (1e9 ns, 1e6 us).
static void shift(long long *sec, long long *sub, long long unit, long long off) {
  long long per_ms = unit / 1000;
  long long total = *sec * unit + *sub + off * per_ms;
  long long s = total / unit, r = total % unit;
  if (r < 0) { r += unit; s -= 1; }
  *sec = s;
  *sub = r;
}

static int rep_clock_gettime(clockid_t clk, struct timespec *ts) {
  int rc = clock_gettime(clk, ts);
  long long off = offset_ms();
  if (rc == 0 && clk == CLOCK_REALTIME && ts && atomic_load(&g_clock_frozen)) {
    long long ms = atomic_load(&g_clock_frozen_ms);
    ts->tv_sec = (time_t)(ms / 1000);
    ts->tv_nsec = (long)((ms % 1000) * 1000000LL);
  } else if (rc == 0 && off != 0 && clk == CLOCK_REALTIME && ts) {
    long long s = ts->tv_sec, n = ts->tv_nsec;
    shift(&s, &n, 1000000000LL, off);
    ts->tv_sec = (time_t)s;
    ts->tv_nsec = (long)n;
  }
  return rc;
}
INTERPOSE(rep_clock_gettime, clock_gettime);

static int rep_gettimeofday(struct timeval *tv, void *tz) {
  int rc = gettimeofday(tv, tz);
  long long off = offset_ms();
  if (rc == 0 && tv && atomic_load(&g_clock_frozen)) {
    long long ms = atomic_load(&g_clock_frozen_ms);
    tv->tv_sec = (time_t)(ms / 1000);
    tv->tv_usec = (suseconds_t)((ms % 1000) * 1000);
  } else if (rc == 0 && off != 0 && tv) {
    long long s = tv->tv_sec, u = tv->tv_usec;
    shift(&s, &u, 1000000LL, off);
    tv->tv_sec = (time_t)s;
    tv->tv_usec = (suseconds_t)u;
  }
  return rc;
}
INTERPOSE(rep_gettimeofday, gettimeofday);

// time() and CFAbsoluteTimeGetCurrent() are rebuilt from the original clock_gettime plus the offset, not from the
// originals: CoreFoundation and libc reach gettimeofday/clock_gettime through interposable stubs, so shifting their
// result again would shift it twice.
static struct timespec real_now(void) {
  struct timespec ts;
  if (atomic_load(&g_clock_frozen)) {
    long long ms = atomic_load(&g_clock_frozen_ms);
    ts.tv_sec = (time_t)(ms / 1000);
    ts.tv_nsec = (long)((ms % 1000) * 1000000LL);
    return ts;
  }
  clock_gettime(CLOCK_REALTIME, &ts);
  long long s = ts.tv_sec, n = ts.tv_nsec;
  shift(&s, &n, 1000000000LL, offset_ms());
  ts.tv_sec = (time_t)s;
  ts.tv_nsec = (long)n;
  return ts;
}

static time_t rep_time(time_t *out) {
  time_t t = real_now().tv_sec;
  if (out) *out = t;
  return t;
}
INTERPOSE(rep_time, time);

static CFAbsoluteTime rep_cf_abs(void) {
  struct timespec ts = real_now();
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9 - kCFAbsoluteTimeIntervalSince1970;
}
INTERPOSE(rep_cf_abs, CFAbsoluteTimeGetCurrent);

#pragma mark - accessibility read

#if TARGET_OS_IOS
#define A11Y_MAX_NODES 5000
#define A11Y_MAX_DEPTH 80

static NSString *nz(NSString *s) { return s.length ? s : nil; }

static void a11y_visit(id node, NSInteger order, int depth, NSMutableArray *out) {
  if (!node || depth > A11Y_MAX_DEPTH || out.count >= A11Y_MAX_NODES) return;
  if ([node isKindOfClass:[UIView class]]) {
    UIView *v = node;
    if (v.hidden || v.alpha < 0.01 || v.accessibilityElementsHidden) return;
  }
  BOOL ae = [node isAccessibilityElement];
  NSString *label = nz([node accessibilityLabel]);
  NSString *hint = nz([node accessibilityHint]);
  NSString *value = nz([node accessibilityValue]);
  NSString *ident = nil;
  if ([node conformsToProtocol:@protocol(UIAccessibilityIdentification)]) ident = nz([(id<UIAccessibilityIdentification>)node accessibilityIdentifier]);
  NSMutableArray *actions = [NSMutableArray array];
  for (UIAccessibilityCustomAction *a in [node accessibilityCustomActions] ?: @[]) if (a.name.length) [actions addObject:a.name];
  if (ae || label || hint || ident || actions.count) {
    CGRect f = [node accessibilityFrame];
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    d[@"cls"] = NSStringFromClass([node class]);
    d[@"ae"] = @(ae);
    if (label) d[@"label"] = label;
    if (hint) d[@"hint"] = hint;
    if (value) d[@"value"] = value;
    if (ident) d[@"id"] = ident;
    d[@"traits"] = [NSString stringWithFormat:@"0x%llx", (unsigned long long)[node accessibilityTraits]];
    d[@"frame"] = @[ @(f.origin.x), @(f.origin.y), @(f.size.width), @(f.size.height) ];
    if (actions.count) d[@"actions"] = actions;
    if (order >= 0) d[@"order"] = @(order);
    [out addObject:d];
  }
  // what VoiceOver walks: the explicit order, else the container protocol, else the subviews
  NSArray *explicitOrder = [node respondsToSelector:@selector(accessibilityElements)] ? [node accessibilityElements] : nil;
  if (explicitOrder.count) {
    NSInteger i = 0;
    for (id child in explicitOrder) a11y_visit(child, i++, depth + 1, out);
    return;
  }
  NSInteger count = [node accessibilityElementCount];
  if (count != NSNotFound && count > 0) {
    for (NSInteger i = 0; i < count; i++) a11y_visit([node accessibilityElementAtIndex:i], -1, depth + 1, out);
    return;
  }
  if ([node isKindOfClass:[UIView class]]) for (UIView *sub in ((UIView *)node).subviews) a11y_visit(sub, -1, depth + 1, out);
}

static NSArray *a11y_collect(void) {
  NSMutableArray *out = [NSMutableArray array];
  for (UIWindow *w in UIApplication.sharedApplication.windows) a11y_visit(w, -1, 0, out);
  return out;
}
#endif

static void write_a11y(long long seq) {
  NSMutableDictionary *body = [NSMutableDictionary dictionaryWithObject:@(seq) forKey:@"req"];
#if TARGET_OS_IOS
  __block NSArray *nodes = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_main_queue(), ^{ nodes = a11y_collect(); dispatch_semaphore_signal(done); });
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) == 0) body[@"nodes"] = nodes;
  else body[@"error"] = @"main thread busy";
#else
  body[@"nodes"] = @[];
  body[@"unsupported"] = @YES;
#endif
  NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
  [data writeToFile:[g_state_path stringByAppendingString:@".a11y"] atomically:YES];
}

#if TARGET_OS_IOS
#pragma mark - accessibility events

static void append_a11y_event(NSString *kind, NSString *text) {
  if (!g_state_path) return;
  struct timespec now = real_now();
  long long at = (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
  NSMutableDictionary *line = [NSMutableDictionary dictionaryWithObjectsAndKeys:kind, @"kind", @(at), @"at", nil];
  if (text.length) line[@"text"] = text;
  NSData *json = [NSJSONSerialization dataWithJSONObject:line options:0 error:nil];
  if (!json) return;
  NSMutableData *out = [json mutableCopy];
  [out appendBytes:"\n" length:1];
  int fd = open([g_state_path stringByAppendingString:@".events"].fileSystemRepresentation, O_WRONLY | O_APPEND | O_CREAT, 0644);
  if (fd < 0) return;
  (void)write(fd, out.bytes, out.length);  // one write on an O_APPEND fd: lines never interleave
  close(fd);
}

static void rep_post_notification(UIAccessibilityNotifications n, id argument) {
  @try {
    if (n == UIAccessibilityAnnouncementNotification) {
      NSString *text = [argument isKindOfClass:[NSAttributedString class]] ? [(NSAttributedString *)argument string]
                     : [argument isKindOfClass:[NSString class]] ? argument : nil;
      append_a11y_event(@"announcement", text);
    } else if (n == UIAccessibilityScreenChangedNotification) {
      append_a11y_event(@"screen-changed", nil);
    } else if (n == UIAccessibilityLayoutChangedNotification) {
      append_a11y_event(@"layout-changed", nil);
    }
  } @catch (NSException *e) {
    DLOG("a11y event skipped: %s", e.reason.UTF8String);
  }
  UIAccessibilityPostNotification(n, argument);
}
INTERPOSE(rep_post_notification, UIAccessibilityPostNotification);
#endif

#pragma mark - camera
// A simulated camera: the simulator has no camera hardware, so AVFoundation answers "no device". With WARDEN_CAMERA=1
// the capture stack is shadowed: fake back/front `AVCaptureDevice`s, a fake `AVCaptureDeviceInput`, and sessions that
// never connect to them (a real `addInput:` of a fake device reaches private selectors). A running shadow session
// pumps frames of the staged image or video to the app's outputs, preview layers, photo and movie outputs and QR
// metadata output. Feeds come from the `camera` key of the state file and change live. Nothing here is installed, and
// nothing runs, unless WARDEN_CAMERA=1; an idle session costs nothing.
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>
#import <TargetConditionals.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif

static BOOL g_camera_enabled = NO;
static NSObject *g_cam_lock = nil;

enum { WC_BACK = 0, WC_FRONT = 1 };

#define WC_ASSOC_GET(obj, key) objc_getAssociatedObject((obj), &(key))
#define WC_ASSOC_SET(obj, key, val) objc_setAssociatedObject((obj), &(key), (val), OBJC_ASSOCIATION_RETAIN_NONATOMIC)

#pragma mark camera: feeds and frame sources

@interface WCFeed : NSObject
@property (nonatomic, copy) NSString *path;
@property (nonatomic) BOOL video;
@property (nonatomic) BOOL loop;
@end
@implementation WCFeed
@end

static WCFeed *g_feed[2];
static id g_source[2];  // WCSource, rebuilt when the feed changes

static WCFeed *wc_feed(int facing) {
  @synchronized (g_cam_lock) { return g_feed[facing]; }
}

static CVPixelBufferRef wc_make_pixel_buffer(size_t w, size_t h, OSType format) {
  NSDictionary *attrs = @{
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
    (id)kCVPixelBufferCGImageCompatibilityKey: @YES,
    (id)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES,
  };
  CVPixelBufferRef pb = NULL;
  if (CVPixelBufferCreate(kCFAllocatorDefault, w, h, format, (__bridge CFDictionaryRef)attrs, &pb) != kCVReturnSuccess) return NULL;
  return pb;
}

/** A +1 CGImage copy of a BGRA pixel buffer. */
static CGImageRef wc_image_from_pixel_buffer(CVPixelBufferRef pb) {
  if (CVPixelBufferGetPixelFormatType(pb) != kCVPixelFormatType_32BGRA) return NULL;
  CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pb), CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb), 8,
    CVPixelBufferGetBytesPerRow(pb), cs, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGImageRef img = ctx ? CGBitmapContextCreateImage(ctx) : NULL;
  if (ctx) CGContextRelease(ctx);
  CGColorSpaceRelease(cs);
  CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
  return img;
}

/** Re-render a BGRA frame in `format` (apps that ask a video output for 420f / 420v); the BGRA frame itself on failure. +1. */
static CVPixelBufferRef wc_convert(CVPixelBufferRef pb, OSType format) {
  if (format == 0 || format == CVPixelBufferGetPixelFormatType(pb)) return (CVPixelBufferRef)CFRetain(pb);
  static CIContext *ctx;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ ctx = [CIContext contextWithOptions:nil]; });
  CVPixelBufferRef dst = wc_make_pixel_buffer(CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb), format);
  if (!dst) return (CVPixelBufferRef)CFRetain(pb);
  [ctx render:[CIImage imageWithCVPixelBuffer:pb] toCVPixelBuffer:dst];
  return dst;
}

/** One staged asset. A still image is decoded once; a video is read by an `AVAssetReader` that follows the clock (so every consumer sees the same frame at the same time) and restarts at the end when it loops. */
@interface WCSource : NSObject
@property (nonatomic, readonly) BOOL still;
@property (nonatomic, readonly) double fps;
- (instancetype)initWithFeed:(WCFeed *)feed;
- (CVPixelBufferRef)copyFrameAt:(CFTimeInterval)now;  // +1, NULL when the asset cannot be read
- (CGImageRef)copyStillImage;                         // +1, only for a still
@end

@implementation WCSource {
  WCFeed *_feed;
  NSLock *_lock;
  CVPixelBufferRef _frame;       // the still, or the video's current frame
  CGImageRef _stillImage;
  double _framePts;
  CVPixelBufferRef _next;
  double _nextPts;
  double _base;
  double _duration;
  CFTimeInterval _start;
  AVAssetReader *_reader;
  AVAssetReaderTrackOutput *_out;
  AVAssetTrack *_track;
  AVAsset *_asset;
}

static size_t wc_even(size_t n) { return n < 2 ? 2 : n & ~(size_t)1; }

- (instancetype)initWithFeed:(WCFeed *)feed {
  if (!(self = [super init])) return nil;
  _feed = feed;
  _lock = [NSLock new];
  _start = CACurrentMediaTime();
  _fps = 30;
  NSURL *url = [NSURL fileURLWithPath:feed.path];
  if (!feed.video) {
    _still = YES;
    CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!src) return self;
    NSDictionary *opts = @{
      (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
      (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
      (id)kCGImageSourceThumbnailMaxPixelSize: @4096,
    };
    CGImageRef img = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
    CFRelease(src);
    if (!img) return self;
    size_t w = wc_even(CGImageGetWidth(img)), h = wc_even(CGImageGetHeight(img));
    CVPixelBufferRef pb = wc_make_pixel_buffer(w, h, kCVPixelFormatType_32BGRA);
    if (pb) {
      CVPixelBufferLockBaseAddress(pb, 0);
      CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
      CGContextRef ctx = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pb), w, h, 8, CVPixelBufferGetBytesPerRow(pb), cs,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
      if (ctx) {
        CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img);
        CGContextRelease(ctx);
      }
      CGColorSpaceRelease(cs);
      CVPixelBufferUnlockBaseAddress(pb, 0);
      _frame = pb;
      _stillImage = wc_image_from_pixel_buffer(pb);
    }
    CGImageRelease(img);
    return self;
  }
  _asset = [AVURLAsset URLAssetWithURL:url options:nil];
  _track = [_asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  _duration = CMTimeGetSeconds(_asset.duration);
  if (_track && _track.nominalFrameRate >= 1) _fps = MIN(60, _track.nominalFrameRate);
  return self;
}

- (void)dealloc {
  if (_frame) CVPixelBufferRelease(_frame);
  if (_next) CVPixelBufferRelease(_next);
  if (_stillImage) CGImageRelease(_stillImage);
}

- (CGImageRef)copyStillImage { return _stillImage ? CGImageRetain(_stillImage) : NULL; }

- (void)readNext {
  if (_next) { CVPixelBufferRelease(_next); _next = NULL; }
  CMSampleBufferRef sb = [_out copyNextSampleBuffer];
  if (!sb) return;
  CVImageBufferRef ib = CMSampleBufferGetImageBuffer(sb);
  if (ib) {
    _next = CVPixelBufferRetain(ib);
    _nextPts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb));
  }
  CFRelease(sb);
}

- (void)openReader {
  [_reader cancelReading];
  _reader = nil;
  _out = nil;
  if (_frame) { CVPixelBufferRelease(_frame); _frame = NULL; }
  if (_next) { CVPixelBufferRelease(_next); _next = NULL; }
  _framePts = -1;
  if (!_track) return;
  NSError *err = nil;
  AVAssetReader *r = [AVAssetReader assetReaderWithAsset:_asset error:&err];
  if (!r) return;
  AVAssetReaderTrackOutput *o = [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:_track outputSettings:@{
    (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
  }];
  o.alwaysCopiesSampleData = NO;
  if (![r canAddOutput:o]) return;
  [r addOutput:o];
  if (![r startReading]) return;
  _reader = r;
  _out = o;
  [self readNext];
  _base = _next ? _nextPts : 0;
  if (_next) _nextPts = 0;
}

- (CVPixelBufferRef)copyFrameAt:(CFTimeInterval)now {
  [_lock lock];
  CVPixelBufferRef result = NULL;
  if (_still) {
    result = _frame ? CVPixelBufferRetain(_frame) : NULL;
  } else if (_track) {
    double elapsed = now - _start;
    if (_duration > 0) elapsed = _feed.loop ? fmod(elapsed, _duration) : MIN(elapsed, _duration);
    if (!_reader || elapsed < _framePts) [self openReader];
    while (_next && _nextPts <= elapsed) {
      if (_frame) CVPixelBufferRelease(_frame);
      _frame = _next;
      _framePts = _nextPts;
      _next = NULL;
      CMSampleBufferRef sb = [_out copyNextSampleBuffer];
      if (sb) {
        CVImageBufferRef ib = CMSampleBufferGetImageBuffer(sb);
        if (ib) {
          _next = CVPixelBufferRetain(ib);
          _nextPts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) - _base;
        }
        CFRelease(sb);
      }
    }
    if (!_frame && _next) {  // asked before the first frame's time
      _frame = _next;
      _framePts = _nextPts;
      _next = NULL;
    }
    result = _frame ? CVPixelBufferRetain(_frame) : NULL;
  }
  [_lock unlock];
  return result;
}
@end

static WCSource *wc_source(int facing) {
  @synchronized (g_cam_lock) {
    WCFeed *feed = g_feed[facing];
    if (!feed) return nil;
    if (!g_source[facing]) g_source[facing] = [[WCSource alloc] initWithFeed:feed];
    return g_source[facing];
  }
}

/** The frame of `facing` right now, +1 (NULL: no feed, or unreadable). */
static CVPixelBufferRef wc_current_frame(int facing) {
  WCSource *s = wc_source(facing);
  return s ? [s copyFrameAt:CACurrentMediaTime()] : NULL;
}

#pragma mark camera: fake device, input, connection

static char kWCOutputState;

@interface WCDevice : AVCaptureDevice {
@public
  int _facing;
  AVCaptureFocusMode _focusMode;
  AVCaptureExposureMode _exposureMode;
  AVCaptureWhiteBalanceMode _wbMode;
  AVCaptureTorchMode _torchMode;
  double _zoom;
  CGPoint _focusPoi, _exposurePoi;
  BOOL _monitoring, _lowLight;
}
@end

@implementation WCDevice
- (NSString *)uniqueID { return _facing == WC_FRONT ? @"warden-camera-front" : @"warden-camera-back"; }
- (NSString *)localizedName { return _facing == WC_FRONT ? @"Warden Front Camera" : @"Warden Back Camera"; }
- (NSString *)modelID { return @"warden-camera"; }
- (NSString *)manufacturer { return @"Warden"; }
- (AVCaptureDevicePosition)position { return _facing == WC_FRONT ? AVCaptureDevicePositionFront : AVCaptureDevicePositionBack; }
- (AVCaptureDeviceType)deviceType { return AVCaptureDeviceTypeBuiltInWideAngleCamera; }
- (BOOL)hasMediaType:(AVMediaType)t { return [t isEqualToString:AVMediaTypeVideo]; }
- (BOOL)isConnected { return wc_feed(_facing) != nil; }
- (BOOL)isSuspended { return NO; }
- (BOOL)isInUseByAnotherApplication { return NO; }
- (BOOL)lockForConfiguration:(NSError **)e { return YES; }
- (void)unlockForConfiguration {}
- (id)copyWithZone:(NSZone *)z { return self; }
- (NSString *)description { return [NSString stringWithFormat:@"<WardenCamera %@>", self.uniqueID]; }
- (NSArray *)formats { return @[]; }
- (AVCaptureDeviceFormat *)activeFormat { return nil; }
- (void)setActiveFormat:(AVCaptureDeviceFormat *)f {}
- (BOOL)supportsAVCaptureSessionPreset:(AVCaptureSessionPreset)p { return YES; }
- (CMTime)activeVideoMinFrameDuration { return CMTimeMake(1, 30); }
- (CMTime)activeVideoMaxFrameDuration { return CMTimeMake(1, 30); }
- (void)setActiveVideoMinFrameDuration:(CMTime)t {}
- (void)setActiveVideoMaxFrameDuration:(CMTime)t {}
- (BOOL)hasTorch { return YES; }
- (BOOL)hasFlash { return YES; }
- (BOOL)isTorchAvailable { return YES; }
- (BOOL)isTorchActive { return _torchMode != 0; }
- (float)torchLevel { return _torchMode ? 1 : 0; }
- (AVCaptureTorchMode)torchMode { return _torchMode; }
- (void)setTorchMode:(AVCaptureTorchMode)m { _torchMode = m; }
- (BOOL)isTorchModeSupported:(AVCaptureTorchMode)m { return YES; }
- (BOOL)setTorchModeOnWithLevel:(float)l error:(NSError **)e { _torchMode = 1; return YES; }
- (BOOL)isFlashAvailable { return YES; }
- (BOOL)isFlashActive { return NO; }
- (AVCaptureFocusMode)focusMode { return _focusMode; }
- (void)setFocusMode:(AVCaptureFocusMode)m { _focusMode = m; }
- (BOOL)isFocusModeSupported:(AVCaptureFocusMode)m { return YES; }
- (BOOL)isFocusPointOfInterestSupported { return YES; }
- (CGPoint)focusPointOfInterest { return _focusPoi; }
- (void)setFocusPointOfInterest:(CGPoint)p { _focusPoi = p; }
- (BOOL)isAdjustingFocus { return NO; }
- (AVCaptureAutoFocusRangeRestriction)autoFocusRangeRestriction { return 0; }
- (void)setAutoFocusRangeRestriction:(AVCaptureAutoFocusRangeRestriction)r {}
- (BOOL)isAutoFocusRangeRestrictionSupported { return NO; }
- (BOOL)isSmoothAutoFocusSupported { return NO; }
- (BOOL)isSmoothAutoFocusEnabled { return NO; }
- (void)setSmoothAutoFocusEnabled:(BOOL)b {}
- (AVCaptureExposureMode)exposureMode { return _exposureMode; }
- (void)setExposureMode:(AVCaptureExposureMode)m { _exposureMode = m; }
- (BOOL)isExposureModeSupported:(AVCaptureExposureMode)m { return YES; }
- (BOOL)isExposurePointOfInterestSupported { return YES; }
- (CGPoint)exposurePointOfInterest { return _exposurePoi; }
- (void)setExposurePointOfInterest:(CGPoint)p { _exposurePoi = p; }
- (BOOL)isAdjustingExposure { return NO; }
- (float)exposureTargetBias { return 0; }
- (float)minExposureTargetBias { return -8; }
- (float)maxExposureTargetBias { return 8; }
- (void)setExposureTargetBias:(float)b completionHandler:(void (^)(CMTime))h { if (h) h(kCMTimeZero); }
- (float)ISO { return 100; }
- (float)lensAperture { return 1.8f; }
- (AVCaptureWhiteBalanceMode)whiteBalanceMode { return _wbMode; }
- (void)setWhiteBalanceMode:(AVCaptureWhiteBalanceMode)m { _wbMode = m; }
- (BOOL)isWhiteBalanceModeSupported:(AVCaptureWhiteBalanceMode)m { return YES; }
- (BOOL)isAdjustingWhiteBalance { return NO; }
- (CGFloat)videoZoomFactor { return _zoom < 1 ? 1 : _zoom; }
- (void)setVideoZoomFactor:(CGFloat)z { _zoom = z; }
- (CGFloat)minAvailableVideoZoomFactor { return 1; }
- (CGFloat)maxAvailableVideoZoomFactor { return 5; }
- (CGFloat)dualCameraSwitchOverVideoZoomFactor { return 1; }
- (void)rampToVideoZoomFactor:(CGFloat)z withRate:(float)r { _zoom = z; }
- (void)cancelVideoZoomRamp {}
- (BOOL)isRampingVideoZoom { return NO; }
- (BOOL)isSubjectAreaChangeMonitoringEnabled { return _monitoring; }
- (void)setSubjectAreaChangeMonitoringEnabled:(BOOL)b { _monitoring = b; }
- (BOOL)isLowLightBoostSupported { return NO; }
- (BOOL)isLowLightBoostEnabled { return NO; }
- (BOOL)automaticallyEnablesLowLightBoostWhenAvailable { return _lowLight; }
- (void)setAutomaticallyEnablesLowLightBoostWhenAvailable:(BOOL)b { _lowLight = b; }
- (BOOL)isVideoHDRSupported { return NO; }
- (BOOL)isVideoHDREnabled { return NO; }
- (void)setVideoHDREnabled:(BOOL)b {}
- (BOOL)automaticallyAdjustsVideoHDREnabled { return NO; }
- (void)setAutomaticallyAdjustsVideoHDREnabled:(BOOL)b {}
- (BOOL)isGeometricDistortionCorrectionSupported { return NO; }
- (BOOL)isGeometricDistortionCorrectionEnabled { return NO; }
- (void)setGeometricDistortionCorrectionEnabled:(BOOL)b {}
- (NSArray *)constituentDevices { return @[]; }
- (BOOL)isVirtualDevice { return NO; }
@end

@interface WCInput : AVCaptureDeviceInput {
@public
  AVCaptureDevice *_wcDevice;
}
@end
@implementation WCInput
- (AVCaptureDevice *)device { return _wcDevice; }
- (NSArray *)ports { return @[]; }
- (CMTime)videoMinFrameDurationOverride { return kCMTimeInvalid; }
- (void)setVideoMinFrameDurationOverride:(CMTime)t {}
- (BOOL)unifiedAutoExposureDefaultsEnabled { return NO; }
- (void)setUnifiedAutoExposureDefaultsEnabled:(BOOL)b {}
- (BOOL)isMultiCamFunctionalityEnabled { return NO; }
@end

@interface WCConnection : AVCaptureConnection {
@public
  AVCaptureOutput *_wcOutput;
  AVCaptureVideoOrientation _orientation;
  CGFloat _angle;
  BOOL _mirrored;
}
@end
@implementation WCConnection
- (AVCaptureOutput *)output { return _wcOutput; }
- (NSArray *)inputPorts { return @[]; }
- (AVCaptureVideoPreviewLayer *)videoPreviewLayer { return nil; }
- (BOOL)isEnabled { return YES; }
- (void)setEnabled:(BOOL)e {}
- (BOOL)isActive { return YES; }
- (BOOL)isVideoOrientationSupported { return YES; }
- (AVCaptureVideoOrientation)videoOrientation { return _orientation ? _orientation : AVCaptureVideoOrientationPortrait; }
- (void)setVideoOrientation:(AVCaptureVideoOrientation)o { _orientation = o; }
- (BOOL)isVideoRotationAngleSupported:(CGFloat)a { return YES; }
- (CGFloat)videoRotationAngle { return _angle; }
- (void)setVideoRotationAngle:(CGFloat)a { _angle = a; }
- (BOOL)isVideoMirroringSupported { return YES; }
- (BOOL)isVideoMirrored { return _mirrored; }
- (void)setVideoMirrored:(BOOL)m { _mirrored = m; }
- (BOOL)automaticallyAdjustsVideoMirroring { return NO; }
- (void)setAutomaticallyAdjustsVideoMirroring:(BOOL)b {}
- (BOOL)isVideoStabilizationSupported { return NO; }
- (BOOL)isVideoStabilizationEnabled { return NO; }
- (AVCaptureVideoStabilizationMode)activeVideoStabilizationMode { return 0; }
- (AVCaptureVideoStabilizationMode)preferredVideoStabilizationMode { return 0; }
- (void)setPreferredVideoStabilizationMode:(AVCaptureVideoStabilizationMode)m {}
- (BOOL)isVideoMinFrameDurationSupported { return NO; }
- (BOOL)isVideoMaxFrameDurationSupported { return NO; }
- (CGFloat)videoScaleAndCropFactor { return 1; }
- (void)setVideoScaleAndCropFactor:(CGFloat)f {}
- (CGFloat)videoMaxScaleAndCropFactor { return 1; }
- (BOOL)isCameraIntrinsicMatrixDeliverySupported { return NO; }
- (BOOL)isCameraIntrinsicMatrixDeliveryEnabled { return NO; }
- (void)setCameraIntrinsicMatrixDeliveryEnabled:(BOOL)b {}
- (NSArray *)audioChannels { return @[]; }
@end

static WCDevice *wc_device(int facing) {
  static WCDevice *devs[2];
  @synchronized (g_cam_lock) {
    if (!devs[facing]) {
      WCDevice *d = class_createInstance([WCDevice class], 0);
      d->_facing = facing;
      d->_zoom = 1;
      d->_focusPoi = d->_exposurePoi = CGPointMake(0.5, 0.5);
      devs[facing] = d;
    }
    return devs[facing];
  }
}

/** The fake device of `facing` when a feed is set for it, else nil: a facing left out of the state has no camera. */
static WCDevice *wc_present(int facing) { return wc_feed(facing) ? wc_device(facing) : nil; }

static NSArray<AVCaptureDevice *> *wc_present_devices(void) {
  NSMutableArray *a = [NSMutableArray array];
  if (wc_present(WC_BACK)) [a addObject:wc_device(WC_BACK)];
  if (wc_present(WC_FRONT)) [a addObject:wc_device(WC_FRONT)];
  return a;
}

static int wc_facing_of(WCDevice *d) { return d->_facing; }

#pragma mark camera: frame pump

static char kWCConnection, kWCDiscovery, kWCMetaTypes, kWCMetaRoi, kWCRecorderKey, kWCPreviewSub, kWCDraining;

@interface WCRecorder : NSObject
@property (nonatomic, readonly) AVAssetWriter *writer;
@property (nonatomic, readonly) NSURL *url;
@property (nonatomic, readonly) BOOL ready;
- (instancetype)initWithURL:(NSURL *)url width:(size_t)w height:(size_t)h;
- (void)append:(CVPixelBufferRef)pb;
- (CMTime)duration;
- (void)finish:(void (^)(NSError *))done;
@end

@implementation WCRecorder {
  AVAssetWriter *_writer;
  AVAssetWriterInput *_input;
  AVAssetWriterInputPixelBufferAdaptor *_adaptor;
  NSURL *_url;
  CFTimeInterval _t0;
  CMTime _last;
  BOOL _started, _ready, _finishing;
  /** samples the writer took; a session that ends with none fails the file (-11800 <- -16364) */
  long _samples;
  /** the newest frame dropped while the encoder was not ready yet, kept until one sample landed */
  CVPixelBufferRef _held;
  /** AVAssetWriter is not thread-safe: the pump queue appends, `startRecording` appends its first frame and
      `stopRecording` finishes on the main thread. Every writer call goes through this one serial queue. */
  dispatch_queue_t _q;
}
@synthesize writer = _writer, url = _url, ready = _ready;
- (void)dealloc {
  if (_held) CVPixelBufferRelease(_held);
}
- (instancetype)initWithURL:(NSURL *)url width:(size_t)w height:(size_t)h {
  if (!(self = [super init])) return nil;
  _q = dispatch_queue_create("nz.co.delacour.warden.camera.recorder", DISPATCH_QUEUE_SERIAL);
  _url = url;
  [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
  NSError *err = nil;
  _writer = [AVAssetWriter assetWriterWithURL:url fileType:AVFileTypeQuickTimeMovie error:&err];
  if (!_writer) return self;
  _input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
    AVVideoCodecKey: AVVideoCodecTypeH264, AVVideoWidthKey: @(wc_even(w)), AVVideoHeightKey: @(wc_even(h)),
  }];
  _input.expectsMediaDataInRealTime = YES;
  _adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:_input
    sourcePixelBufferAttributes:@{ (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA) }];
  if (![_writer canAddInput:_input]) return self;
  [_writer addInput:_input];
  _ready = [_writer startWriting];
  _last = kCMTimeZero;
  return self;
}
- (void)append:(CVPixelBufferRef)pb {
  CFTimeInterval now = CACurrentMediaTime();
  dispatch_sync(_q, ^{
    if (!self->_ready || self->_finishing || self->_writer.status != AVAssetWriterStatusWriting) return;
    if (!self->_started) {
      self->_started = YES;
      self->_t0 = now;
      [self->_writer startSessionAtSourceTime:kCMTimeZero];
    }
    CMTime t = CMTimeMakeWithSeconds(now - self->_t0, 600);
    if (self->_samples > 0 && CMTimeCompare(t, self->_last) <= 0) t = CMTimeAdd(self->_last, CMTimeMake(1, 600));
    if (!self->_input.isReadyForMoreMediaData) {
      if (self->_samples == 0) {
        if (self->_held) CVPixelBufferRelease(self->_held);
        self->_held = CVPixelBufferRetain(pb);
      }
      return;
    }
    [self appendOnQueue:pb at:t];
  });
}
/** On `_q` only. */
- (void)appendOnQueue:(CVPixelBufferRef)pb at:(CMTime)t {
  if (![_adaptor appendPixelBuffer:pb withPresentationTime:t]) return;
  _last = t;
  _samples += 1;
  if (_held) { CVPixelBufferRelease(_held); _held = NULL; }
}
- (CMTime)duration {
  __block CMTime d;
  dispatch_sync(_q, ^{ d = self->_last; });
  return d;
}
- (void)finish:(void (^)(NSError *))done {
  dispatch_async(_q, ^{
    if (self->_finishing) return;
    self->_finishing = YES;
    if (!self->_ready || !self->_started) {
      NSError *e = self->_writer.error ?: [NSError errorWithDomain:@"warden.camera" code:1 userInfo:@{ NSLocalizedDescriptionKey: @"no frames were recorded" }];
      if (self->_writer.status == AVAssetWriterStatusWriting) [self->_writer cancelWriting];
      done(e);
      return;
    }
    // a take stopped before the encoder took a frame still holds the frame it started on: wait for the encoder
    // (a fresh or busy VideoToolbox session) rather than end a session with no samples, which fails the file
    if (self->_samples == 0 && self->_held) {
      for (int i = 0; i < 400 && !self->_input.isReadyForMoreMediaData && self->_writer.status == AVAssetWriterStatusWriting; i++) usleep(5000);
      if (self->_input.isReadyForMoreMediaData) [self appendOnQueue:self->_held at:kCMTimeZero];
    }
    if (self->_samples == 0) {
      NSError *e = self->_writer.error ?: [NSError errorWithDomain:@"warden.camera" code:1 userInfo:@{ NSLocalizedDescriptionKey: @"no frames were recorded" }];
      if (self->_writer.status == AVAssetWriterStatusWriting) [self->_writer cancelWriting];
      done(e);
      return;
    }
    [self->_input markAsFinished];
    AVAssetWriter *w = self->_writer;
    [w endSessionAtSourceTime:CMTimeAdd(self->_last, CMTimeMake(1, 30))];
    [w finishWritingWithCompletionHandler:^{ done(w.status == AVAssetWriterStatusCompleted ? nil : w.error); }];
  });
}
@end

@interface WCSessionRec : NSObject
@property (nonatomic, weak) AVCaptureSession *session;
@property (nonatomic, strong) WCInput *input;
@property (nonatomic) BOOL running;
@property (nonatomic, strong) id pump;
@end
@implementation WCSessionRec
@end

static NSMapTable<AVCaptureSession *, WCSessionRec *> *g_sessions = nil;
static NSHashTable<AVCaptureVideoPreviewLayer *> *g_previews = nil;
/** Bumped on every preview layer registration, so a still feed repaints a layer that arrived after its last push. */
static _Atomic long g_previews_gen = 0;
static NSHashTable<AVCaptureDeviceDiscoverySession *> *g_discoveries = nil;
static dispatch_queue_t g_detect_queue = nil;

static WCSessionRec *wc_rec(AVCaptureSession *s, BOOL create) {
  @synchronized (g_cam_lock) {
    WCSessionRec *r = [g_sessions objectForKey:s];
    if (!r && create) {
      r = [WCSessionRec new];
      r.session = s;
      [g_sessions setObject:r forKey:s];
    }
    return r;
  }
}

/** The shadow session that owns `output` (a running one preferred). */
static WCSessionRec *wc_rec_for_output(AVCaptureOutput *output) {
  WCSessionRec *found = nil;
  NSArray *recs;
  @synchronized (g_cam_lock) { recs = g_sessions.objectEnumerator.allObjects; }
  for (WCSessionRec *r in recs) {
    AVCaptureSession *s = r.session;
    if (!s || !r.input || ![s.outputs containsObject:output]) continue;
    if (r.running) return r;
    found = r;
  }
  return found;
}

static AVCaptureConnection *wc_connection(AVCaptureOutput *out) {
  WCConnection *c = WC_ASSOC_GET(out, kWCConnection);
  if (!c) {
    c = class_createInstance([WCConnection class], 0);
    c->_wcOutput = out;
    WC_ASSOC_SET(out, kWCConnection, c);
  }
  return c;
}

/** Deliver `block` for `output`'s per-frame callbacks: at most 2 in flight, the rest are dropped like a slow real consumer. */
@interface WCInFlight : NSObject {
@public
  _Atomic int n;
}
@end
@implementation WCInFlight
@end

static WCInFlight *wc_inflight(AVCaptureOutput *out) {
  @synchronized (g_cam_lock) {
    WCInFlight *f = WC_ASSOC_GET(out, kWCOutputState);
    if (!f) {
      f = [WCInFlight new];
      WC_ASSOC_SET(out, kWCOutputState, f);
    }
    return f;
  }
}

static CMSampleBufferRef wc_sample_buffer(CVPixelBufferRef pb, double fps) {
  CMVideoFormatDescriptionRef fd = NULL;
  if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pb, &fd) != noErr) return NULL;
  CMSampleTimingInfo timing = { .duration = CMTimeMakeWithSeconds(1.0 / fps, 1000000),
    .presentationTimeStamp = CMClockGetTime(CMClockGetHostTimeClock()), .decodeTimeStamp = kCMTimeInvalid };
  CMSampleBufferRef sb = NULL;
  CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pb, fd, &timing, &sb);
  CFRelease(fd);
  return sb;
}

static CIDetector *wc_qr_detector(void) {
  static CIDetector *d;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ d = [CIDetector detectorOfType:CIDetectorTypeQRCode context:nil options:@{ CIDetectorAccuracy: CIDetectorAccuracyHigh }]; });
  return d;
}

@interface WCCodeObject : AVMetadataMachineReadableCodeObject {
@public
  NSString *_wcString;
  CGRect _wcBounds;
  NSArray *_wcCorners;
  CMTime _wcTime;
}
@end
@implementation WCCodeObject
- (AVMetadataObjectType)type { return AVMetadataObjectTypeQRCode; }
- (NSString *)stringValue { return _wcString; }
- (CGRect)bounds { return _wcBounds; }
- (NSArray *)corners { return _wcCorners; }
- (CMTime)time { return _wcTime; }
- (CMTime)duration { return CMTimeMake(1, 30); }
- (id)descriptor { return nil; }
- (NSString *)description { return [NSString stringWithFormat:@"<WardenQR %@>", _wcString]; }
@end

static CGRect wc_roi(AVCaptureMetadataOutput *m) {
  NSDictionary *d = WC_ASSOC_GET(m, kWCMetaRoi);
  CGRect r = CGRectMake(0, 0, 1, 1);
  if (d) CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)d, &r);
  return CGRectIntersection(r, CGRectMake(0, 0, 1, 1));
}

/** QR codes in `pb` within the normalised (top-left origin) rect `roi`, as metadata objects; run on the detect queue. */
static NSArray *wc_detect_qr(CVPixelBufferRef pb, CGRect roi) {
  CGFloat W = (CGFloat)CVPixelBufferGetWidth(pb), H = (CGFloat)CVPixelBufferGetHeight(pb);
  CIImage *image = [CIImage imageWithCVPixelBuffer:pb];
  CGRect crop = CGRectMake(roi.origin.x * W, (1 - roi.origin.y - roi.size.height) * H, roi.size.width * W, roi.size.height * H);
  if (crop.size.width < 16 || crop.size.height < 16) return @[];
  CIImage *cropped = [image imageByCroppingToRect:crop];
  NSMutableArray *objects = [NSMutableArray array];
  for (CIFeature *f in [wc_qr_detector() featuresInImage:cropped]) {
    if (![f isKindOfClass:[CIQRCodeFeature class]]) continue;
    CIQRCodeFeature *q = (CIQRCodeFeature *)f;
    if (!q.messageString) continue;
    CGPoint pts[4] = { q.topLeft, q.topRight, q.bottomRight, q.bottomLeft };
    NSMutableArray *corners = [NSMutableArray array];
    CGFloat minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (int i = 0; i < 4; i++) {
      CGPoint p = CGPointMake(pts[i].x / W, 1 - pts[i].y / H);
      minX = MIN(minX, p.x); maxX = MAX(maxX, p.x); minY = MIN(minY, p.y); maxY = MAX(maxY, p.y);
      [corners addObject:CFBridgingRelease(CGPointCreateDictionaryRepresentation(p))];
    }
    WCCodeObject *o = class_createInstance([WCCodeObject class], 0);
    o->_wcString = q.messageString;
    o->_wcBounds = CGRectMake(minX, minY, maxX - minX, maxY - minY);
    o->_wcCorners = corners;
    o->_wcTime = CMClockGetTime(CMClockGetHostTimeClock());
    [objects addObject:o];
  }
  return objects;
}

@interface WCPump : NSObject
- (instancetype)initWithRec:(WCSessionRec *)rec;
- (void)start;
- (void)stop;
- (CVPixelBufferRef)copyLatest;  // +1
@end

static void wc_update_previews(AVCaptureSession *session, int facing, CGImageRef image);

@implementation WCPump {
  __weak WCSessionRec *_rec;
  dispatch_queue_t _queue;
  dispatch_source_t _timer;
  CVPixelBufferRef _latest;
  double _fps;
  CFTimeInterval _lastDetect;
  _Atomic int _detecting;
  CGImageRef _lastPreview;
  _Atomic int _previewPending;
  long _previewGen;
}
- (instancetype)initWithRec:(WCSessionRec *)rec {
  if (!(self = [super init])) return nil;
  _rec = rec;
  _queue = dispatch_queue_create("nz.co.delacour.warden.camera.pump", DISPATCH_QUEUE_SERIAL);
  return self;
}
- (void)dealloc {
  if (_latest) CVPixelBufferRelease(_latest);
  if (_lastPreview) CGImageRelease(_lastPreview);
}
- (CVPixelBufferRef)copyLatest {
  __block CVPixelBufferRef r = NULL;
  dispatch_sync(_queue, ^{ r = self->_latest ? CVPixelBufferRetain(self->_latest) : NULL; });
  return r;
}
- (int)facing {
  WCInput *in = _rec.input;
  return in ? wc_facing_of((WCDevice *)in->_wcDevice) : WC_BACK;
}
- (void)start {
  dispatch_async(_queue, ^{
    if (self->_timer) return;
    dispatch_source_t t = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self->_queue);
    self->_fps = 30;
    dispatch_source_set_timer(t, dispatch_time(DISPATCH_TIME_NOW, 0), NSEC_PER_SEC / 30, NSEC_PER_MSEC);
    __weak WCPump *weak = self;
    dispatch_source_set_event_handler(t, ^{ [weak tick]; });
    self->_timer = t;
    dispatch_resume(t);
  });
}
- (void)stop {
  dispatch_async(_queue, ^{
    if (self->_timer) { dispatch_source_cancel(self->_timer); self->_timer = nil; }
  });
}

- (void)tick {
  WCSessionRec *rec = _rec;
  AVCaptureSession *session = rec.session;
  if (!rec || !session || !rec.input) return;
  int facing = [self facing];
  WCSource *src = wc_source(facing);
  if (!src) return;
  CVPixelBufferRef pb = [src copyFrameAt:CACurrentMediaTime()];
  if (!pb) return;
  if (_latest) CVPixelBufferRelease(_latest);
  _latest = CVPixelBufferRetain(pb);
  double fps = src.fps;
  BOOL wantPreview = NO;
  @synchronized (g_cam_lock) { wantPreview = g_previews.count > 0; }
  if (wantPreview && !atomic_load(&_previewPending)) {
    CGImageRef img = src.still ? [src copyStillImage] : wc_image_from_pixel_buffer(pb);
    long gen = atomic_load(&g_previews_gen);
    if (img && (img != _lastPreview || gen != _previewGen)) {
      _previewGen = gen;
      if (_lastPreview) CGImageRelease(_lastPreview);
      _lastPreview = CGImageRetain(img);
      atomic_store(&_previewPending, 1);
      dispatch_async(dispatch_get_main_queue(), ^{
        wc_update_previews(session, facing, img);
        CGImageRelease(img);
        atomic_store(&self->_previewPending, 0);
      });
    } else if (img) {
      CGImageRelease(img);
    }
  }
  for (AVCaptureOutput *out in session.outputs) {
    if ([out isKindOfClass:[AVCaptureVideoDataOutput class]]) {
      [self deliverVideo:(AVCaptureVideoDataOutput *)out frame:pb fps:fps];
    } else if ([out isKindOfClass:[AVCaptureMetadataOutput class]]) {
      [self detect:(AVCaptureMetadataOutput *)out frame:pb];
    } else if ([out isKindOfClass:[AVCaptureMovieFileOutput class]]) {
      WCRecorder *r = WC_ASSOC_GET(out, kWCRecorderKey);
      if (r) [r append:pb];
    }
  }
  CVPixelBufferRelease(pb);
}

- (void)deliverVideo:(AVCaptureVideoDataOutput *)out frame:(CVPixelBufferRef)pb fps:(double)fps {
  id<AVCaptureVideoDataOutputSampleBufferDelegate> del = out.sampleBufferDelegate;
  dispatch_queue_t q = out.sampleBufferCallbackQueue;
  if (!del || !q || ![del respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) return;
  WCInFlight *flight = wc_inflight(out);
  if (atomic_load(&flight->n) >= 2) return;
  OSType want = [out.videoSettings[(id)kCVPixelBufferPixelFormatTypeKey] unsignedIntValue];
  CVPixelBufferRef frame = wc_convert(pb, want);
  CMSampleBufferRef sb = wc_sample_buffer(frame, fps);
  CVPixelBufferRelease(frame);
  if (!sb) return;
  AVCaptureConnection *conn = wc_connection(out);
  atomic_fetch_add(&flight->n, 1);
  dispatch_async(q, ^{
    [del captureOutput:out didOutputSampleBuffer:sb fromConnection:conn];
    CFRelease(sb);
    atomic_fetch_sub(&flight->n, 1);
  });
}

- (void)detect:(AVCaptureMetadataOutput *)out frame:(CVPixelBufferRef)pb {
  id<AVCaptureMetadataOutputObjectsDelegate> del = out.metadataObjectsDelegate;
  dispatch_queue_t q = out.metadataObjectsCallbackQueue;
  NSArray *types = WC_ASSOC_GET(out, kWCMetaTypes);
  if (!del || !q || ![types containsObject:AVMetadataObjectTypeQRCode]) return;
  if (![del respondsToSelector:@selector(captureOutput:didOutputMetadataObjects:fromConnection:)]) return;
  CFTimeInterval now = CACurrentMediaTime();
  if (now - _lastDetect < 0.12 || atomic_load(&_detecting)) return;
  _lastDetect = now;
  atomic_store(&_detecting, 1);
  CVPixelBufferRef held = CVPixelBufferRetain(pb);
  CGRect roi = wc_roi(out);
  AVCaptureConnection *conn = wc_connection(out);
  dispatch_async(g_detect_queue, ^{
    NSArray *found = wc_detect_qr(held, roi);
    CVPixelBufferRelease(held);
    atomic_store(&self->_detecting, 0);
    if (found.count == 0) return;
    dispatch_async(q, ^{ [del captureOutput:out didOutputMetadataObjects:found fromConnection:conn]; });
  });
}
@end

#pragma mark camera: preview layers

static NSString *wc_gravity(AVLayerVideoGravity g) {
  if ([g isEqualToString:AVLayerVideoGravityResizeAspect]) return kCAGravityResizeAspect;
  if ([g isEqualToString:AVLayerVideoGravityResize]) return kCAGravityResize;
  return kCAGravityResizeAspectFill;
}

static void wc_update_previews(AVCaptureSession *session, int facing, CGImageRef image) {
  NSArray *layers;
  @synchronized (g_cam_lock) { layers = g_previews.allObjects; }
  for (AVCaptureVideoPreviewLayer *layer in layers) {
    if (layer.session != session) continue;
    CALayer *sub = WC_ASSOC_GET(layer, kWCPreviewSub);
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    if (!sub) {
      sub = [CALayer layer];
      sub.name = @"warden-camera-preview";
      layer.masksToBounds = YES;
      [layer addSublayer:sub];
      WC_ASSOC_SET(layer, kWCPreviewSub, sub);
    }
    sub.frame = layer.bounds;
    sub.contentsGravity = wc_gravity(layer.videoGravity);
    sub.transform = facing == WC_FRONT ? CATransform3DMakeScale(-1, 1, 1) : CATransform3DIdentity;
    if (image && sub.contents != (__bridge id)image) sub.contents = (__bridge id)image;
    [CATransaction commit];
  }
}

#pragma mark camera: photo

@interface WCResolved : AVCaptureResolvedPhotoSettings {
@public
  int64_t _wcID;
  CMVideoDimensions _wcDims;
}
@end
@implementation WCResolved
- (int64_t)uniqueID { return _wcID; }
- (CMVideoDimensions)photoDimensions { return _wcDims; }
- (CMVideoDimensions)previewDimensions { return (CMVideoDimensions){ 0, 0 }; }
- (CMVideoDimensions)embeddedThumbnailDimensions { return (CMVideoDimensions){ 0, 0 }; }
- (CMVideoDimensions)rawPhotoDimensions { return (CMVideoDimensions){ 0, 0 }; }
- (CMVideoDimensions)livePhotoMovieDimensions { return (CMVideoDimensions){ 0, 0 }; }
- (NSUInteger)expectedPhotoCount { return 1; }
- (BOOL)isFlashEnabled { return NO; }
- (BOOL)isRedEyeReductionEnabled { return NO; }
- (BOOL)isStillImageStabilizationEnabled { return NO; }
- (BOOL)isVirtualDeviceFusionEnabled { return NO; }
- (BOOL)isDualCameraFusionEnabled { return NO; }
- (BOOL)isFastCapturePhotoDeliveryEnabled { return NO; }
@end

@interface WCPhoto : AVCapturePhoto {
@public
  NSData *_wcData;
  CVPixelBufferRef _wcPixels;
  CGImageRef _wcImage;
  NSDictionary *_wcMeta;
  CMTime _wcTime;
}
@end
@implementation WCPhoto
- (void)dealloc {
  if (_wcPixels) CVPixelBufferRelease(_wcPixels);
  if (_wcImage) CGImageRelease(_wcImage);
}
- (NSData *)fileDataRepresentation { return _wcData; }
- (NSData *)fileDataRepresentationWithCustomizer:(id)c { return _wcData; }
- (CVPixelBufferRef)pixelBuffer { return _wcPixels; }
- (CVPixelBufferRef)previewPixelBuffer { return NULL; }
- (CGImageRef)CGImageRepresentation { return _wcImage; }
- (CGImageRef)previewCGImageRepresentation { return NULL; }
- (NSDictionary *)metadata { return _wcMeta; }
- (CMTime)timestamp { return _wcTime; }
- (BOOL)isRawPhoto { return NO; }
- (NSInteger)photoCount { return 1; }
- (NSInteger)sequenceCount { return 1; }
- (id)depthData { return nil; }
- (id)portraitEffectsMatte { return nil; }
- (id)cameraCalibrationData { return nil; }
- (NSString *)description { return @"<WardenPhoto>"; }
@end

static NSData *wc_encode(CGImageRef img, BOOL heic) {
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dest = heic ? CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.heic"), 1, NULL) : NULL;
  if (!dest) dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, NULL);
  if (!dest) return nil;
  CGImageDestinationAddImage(dest, img, (__bridge CFDictionaryRef)@{ (id)kCGImageDestinationLossyCompressionQuality: @0.92 });
  BOOL done = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  return done ? data : nil;
}

static BOOL wc_wants_heic(AVCapturePhotoSettings *settings) {
  NSString *codec = settings.format[AVVideoCodecKey];
  if ([codec isEqualToString:AVVideoCodecTypeHEVC]) return YES;
  return [settings.processedFileType isEqualToString:AVFileTypeHEIC];
}

/** Run the full photo delegate sequence for a frame of `rec`'s camera. */
static void wc_capture_photo(AVCapturePhotoOutput *output, AVCapturePhotoSettings *settings, id<AVCapturePhotoCaptureDelegate> del, WCSessionRec *rec) {
  CVPixelBufferRef pb = [(WCPump *)rec.pump copyLatest];
  if (!pb) pb = wc_current_frame(wc_facing_of((WCDevice *)rec.input->_wcDevice));
  BOOL heic = wc_wants_heic(settings);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    CGImageRef img = pb ? wc_image_from_pixel_buffer(pb) : NULL;
    NSData *data = img ? wc_encode(img, heic) : nil;
    WCResolved *resolved = class_createInstance([WCResolved class], 0);
    resolved->_wcID = settings.uniqueID;
    if (pb) resolved->_wcDims = (CMVideoDimensions){ (int32_t)CVPixelBufferGetWidth(pb), (int32_t)CVPixelBufferGetHeight(pb) };
    WCPhoto *photo = class_createInstance([WCPhoto class], 0);
    photo->_wcData = data;
    photo->_wcPixels = pb;
    photo->_wcImage = img;
    photo->_wcMeta = @{ (id)kCGImagePropertyOrientation: @1,
      (id)kCGImagePropertyPixelWidth: @(resolved->_wcDims.width), (id)kCGImagePropertyPixelHeight: @(resolved->_wcDims.height) };
    photo->_wcTime = CMClockGetTime(CMClockGetHostTimeClock());
    NSError *error = data ? nil : [NSError errorWithDomain:AVFoundationErrorDomain code:AVErrorNoDataCaptured userInfo:@{ NSLocalizedDescriptionKey: @"the simulated camera has no frame" }];
    dispatch_async(dispatch_get_main_queue(), ^{
      if ([del respondsToSelector:@selector(captureOutput:willBeginCaptureForResolvedSettings:)]) [del captureOutput:output willBeginCaptureForResolvedSettings:resolved];
      if ([del respondsToSelector:@selector(captureOutput:willCapturePhotoForResolvedSettings:)]) [del captureOutput:output willCapturePhotoForResolvedSettings:resolved];
      if ([del respondsToSelector:@selector(captureOutput:didCapturePhotoForResolvedSettings:)]) [del captureOutput:output didCapturePhotoForResolvedSettings:resolved];
      if ([del respondsToSelector:@selector(captureOutput:didFinishProcessingPhoto:error:)]) [del captureOutput:output didFinishProcessingPhoto:photo error:error];
      if ([del respondsToSelector:@selector(captureOutput:didFinishCaptureForResolvedSettings:error:)]) [del captureOutput:output didFinishCaptureForResolvedSettings:resolved error:error];
    });
  });
}

#pragma mark camera: movie file output (CAM-9)

static void wc_finish_recording(AVCaptureMovieFileOutput *out, id<AVCaptureFileOutputRecordingDelegate> del) {
  WCRecorder *r = WC_ASSOC_GET(out, kWCRecorderKey);
  if (!r) return;
  NSURL *url = r.url;
  // the output stops reporting `isRecording` the moment stop is asked for, while the writer drains
  WC_ASSOC_SET(out, kWCRecorderKey, nil);
  WC_ASSOC_SET(out, kWCDraining, r);
  [r finish:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      WC_ASSOC_SET(out, kWCDraining, nil);
      if ([del respondsToSelector:@selector(captureOutput:didFinishRecordingToOutputFileAtURL:fromConnections:error:)]) {
        [del captureOutput:out didFinishRecordingToOutputFileAtURL:url fromConnections:@[ wc_connection(out) ] error:error];
      }
    });
  }];
}

static char kWCMovieDelegate;

#pragma mark camera: install

typedef struct { Class cls; SEL sel; IMP imp; } WCOrig;
static WCOrig g_origs[1024];
static int g_orig_n = 0;

static void wc_register_orig(Class cls, SEL sel, IMP imp) {
  @synchronized (g_cam_lock) {
    if (g_orig_n < (int)(sizeof g_origs / sizeof g_origs[0])) g_origs[g_orig_n++] = (WCOrig){ cls, sel, imp };
  }
}

/** The implementation `self_`'s class (or the nearest superclass we replaced) had before we replaced it. */
static IMP wc_orig(id self_, SEL sel) {
  @synchronized (g_cam_lock) {
    for (Class c = object_getClass(self_); c; c = class_getSuperclass(c)) {
      for (int i = 0; i < g_orig_n; i++) if (g_origs[i].cls == c && g_origs[i].sel == sel) return g_origs[i].imp;
    }
  }
  return NULL;
}

/** Every loaded class, as a plain C array (not an NSArray: retaining arbitrary runtime classes is not safe). */
static Class *wc_all_classes(unsigned int *count) {
  static Class *all;
  static unsigned int n;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ all = objc_copyClassList(&n); });
  *count = n;
  return all;
}

static BOOL wc_inherits(Class k, Class base) {
  for (Class c = class_getSuperclass(k); c; c = class_getSuperclass(c)) if (c == base) return YES;
  return NO;
}

static void wc_swz_class(Class target, SEL sel, IMP imp) {
  Method m = class_getInstanceMethod(target, sel);
  if (!m) return;
  wc_register_orig(target, sel, method_getImplementation(m));
  if (!class_addMethod(target, sel, imp, method_getTypeEncoding(m))) method_setImplementation(m, imp);
}

/** `target` and the loaded private subclasses that implement `sel` themselves get `imp`. */
static void wc_swz_tree(Class target, BOOL meta, SEL sel, IMP imp) {
  unsigned int count = 0;
  Class *classes = wc_all_classes(&count);
  for (unsigned int i = 0; i < count; i++) {
    Class k = classes[i];
    Class kk = meta ? object_getClass(k) : k;
    if (kk == target || !wc_inherits(kk, target)) continue;
    if (strncmp(class_getName(kk), "WC", 2) == 0) continue;
    Method own = class_getInstanceMethod(kk, sel), up = class_getInstanceMethod(class_getSuperclass(kk), sel);
    if (own && own != up) wc_swz_class(kk, sel, imp);
  }
  wc_swz_class(target, sel, imp);
}

/**
 * Install `block` as `name` on `cls` (or its metaclass for `meta`). An inherited method is overridden on `cls`
 * itself, never replaced on the superclass; so are the loaded private subclasses that implement it themselves.
 * Each class keeps its own original, see `wc_orig`. macOS (the test harness) hands out `<Class>_Tundra` instances
 * that are not subclasses at all: those get the same treatment.
 */
static void wc_swz(Class cls, BOOL meta, NSString *name, id block) {
  Class target = meta ? object_getClass(cls) : cls;
  SEL sel = NSSelectorFromString(name);
  if (!class_getInstanceMethod(target, sel)) { DLOG("camera: no %s method %s", meta ? "class" : "instance", name.UTF8String); return; }
  IMP imp = imp_implementationWithBlock(block);
  wc_swz_tree(target, meta, sel, imp);
  Class alt = NSClassFromString([NSStringFromClass(cls) stringByAppendingString:@"_Tundra"]);
  if (alt && alt != cls) {
    Class altTarget = meta ? object_getClass(alt) : alt;
    if (class_getInstanceMethod(altTarget, sel)) wc_swz_tree(altTarget, meta, sel, imp);
  }
}
/**
 * What a swizzled `init…` returns. A block IMP is not an init-family method, so ARC hands its result back +0, while the
 * caller of an `init…` owns the result (+1) and releases it later: without this the object is released one time too
 * many (expo-camera crashed in `objc_release` on its rotation coordinator). The receiver `self_` the caller allocated
 * is left alone (a never-initialised AVFoundation object is not safe to release), a small leak per fake object.
 */
static id wc_owned(id obj) {
  return obj ? (__bridge id)(__bridge_retained void *)obj : nil;
}

#define WC_SWZ_C(cls, selname, ...) wc_swz((cls), YES, (selname), __VA_ARGS__)
#define WC_SWZ_I(cls, selname, ...) wc_swz((cls), NO, (selname), __VA_ARGS__)

static IMP wc_orig_i(Class cls, NSString *selname) {
  Method m = class_getInstanceMethod(cls, NSSelectorFromString(selname));
  return m ? method_getImplementation(m) : NULL;
}
static IMP wc_orig_c(Class cls, NSString *selname) {
  Method m = class_getClassMethod(cls, NSSelectorFromString(selname));
  return m ? method_getImplementation(m) : NULL;
}

static BOOL wc_is_video(AVMediaType t) { return [t isEqualToString:AVMediaTypeVideo]; }

static void wc_set_running(AVCaptureSession *s, WCSessionRec *rec, BOOL running) {
  if (rec.running == running) return;
  [s willChangeValueForKey:@"running"];
  rec.running = running;
  [s didChangeValueForKey:@"running"];
  [[NSNotificationCenter defaultCenter] postNotificationName:running ? AVCaptureSessionDidStartRunningNotification : AVCaptureSessionDidStopRunningNotification object:s];
}

static void wc_install_devices(void) {
  Class D = [AVCaptureDevice class];
  IMP origDefault = wc_orig_c(D, @"defaultDeviceWithMediaType:");
  WC_SWZ_C(D, @"defaultDeviceWithMediaType:", ^id(id self_, AVMediaType t) {
    if (!wc_is_video(t)) return origDefault ? ((id (*)(id, SEL, id))wc_orig(self_, NSSelectorFromString(@"defaultDeviceWithMediaType:")))(self_, NSSelectorFromString(@"defaultDeviceWithMediaType:"), t) : nil;
    return wc_present(WC_BACK) ?: wc_present(WC_FRONT);
  });
  IMP origTyped = wc_orig_c(D, @"defaultDeviceWithDeviceType:mediaType:position:");
  WC_SWZ_C(D, @"defaultDeviceWithDeviceType:mediaType:position:", ^id(id self_, AVCaptureDeviceType dt, AVMediaType t, AVCaptureDevicePosition p) {
    if (!wc_is_video(t)) {
      return origTyped ? ((id (*)(id, SEL, id, id, NSInteger))wc_orig(self_, NSSelectorFromString(@"defaultDeviceWithDeviceType:mediaType:position:")))(self_, NSSelectorFromString(@"defaultDeviceWithDeviceType:mediaType:position:"), dt, t, p) : nil;
    }
    if (dt && ![dt isEqualToString:AVCaptureDeviceTypeBuiltInWideAngleCamera]) return nil;
    if (p == AVCaptureDevicePositionFront) return wc_present(WC_FRONT);
    if (p == AVCaptureDevicePositionBack) return wc_present(WC_BACK);
    return wc_present(WC_BACK) ?: wc_present(WC_FRONT);
  });
  IMP origList = wc_orig_c(D, @"devicesWithMediaType:");
  WC_SWZ_C(D, @"devicesWithMediaType:", ^id(id self_, AVMediaType t) {
    if (!wc_is_video(t)) return origList ? ((id (*)(id, SEL, id))wc_orig(self_, NSSelectorFromString(@"devicesWithMediaType:")))(self_, NSSelectorFromString(@"devicesWithMediaType:"), t) : @[];
    return wc_present_devices();
  });
  WC_SWZ_C(D, @"deviceWithUniqueID:", ^id(id self_, NSString *uid) {
    for (AVCaptureDevice *d in wc_present_devices()) if ([d.uniqueID isEqualToString:uid]) return d;
    return nil;
  });
  WC_SWZ_C(D, @"systemPreferredCamera", ^id(id self_) { return wc_present(WC_BACK) ?: wc_present(WC_FRONT); });
  WC_SWZ_C(D, @"userPreferredCamera", ^id(id self_) { return nil; });
  WC_SWZ_C(D, @"setUserPreferredCamera:", ^(id self_, id cam) {});

  Class DS = [AVCaptureDeviceDiscoverySession class];
  WC_SWZ_C(DS, @"discoverySessionWithDeviceTypes:mediaType:position:", ^id(id self_, NSArray *types, AVMediaType t, AVCaptureDevicePosition p) {
    AVCaptureDeviceDiscoverySession *s = ((id (*)(id, SEL, id, id, NSInteger))wc_orig(self_, NSSelectorFromString(@"discoverySessionWithDeviceTypes:mediaType:position:")))(self_, NSSelectorFromString(@"discoverySessionWithDeviceTypes:mediaType:position:"), types, t, p);
    if (s) {
      NSDictionary *query = @{ @"types": types ?: @[], @"media": t ?: [NSNull null], @"position": @(p) };
      WC_ASSOC_SET(s, kWCDiscovery, query);
      @synchronized (g_cam_lock) { [g_discoveries addObject:s]; }
    }
    return s;
  });
  WC_SWZ_I(DS, @"devices", ^id(AVCaptureDeviceDiscoverySession *s) {
    NSDictionary *q = WC_ASSOC_GET(s, kWCDiscovery);
    id media = q[@"media"];
    if (q && [media isKindOfClass:[NSString class]] && !wc_is_video(media)) return ((id (*)(id, SEL))wc_orig(s, NSSelectorFromString(@"devices")))(s, NSSelectorFromString(@"devices"));
    NSArray *types = q[@"types"];
    if (types.count && ![types containsObject:AVCaptureDeviceTypeBuiltInWideAngleCamera]) return @[];
    NSInteger p = [q[@"position"] integerValue];
    NSMutableArray *a = [NSMutableArray array];
    for (AVCaptureDevice *d in wc_present_devices()) if (p == AVCaptureDevicePositionUnspecified || d.position == p) [a addObject:d];
    return a;
  });
  WC_SWZ_I(DS, @"supportedMultiCamDeviceSets", ^id(id s) { return @[]; });

  Class I = [AVCaptureDeviceInput class];
  WC_SWZ_C(I, @"deviceInputWithDevice:error:", ^id(id self_, AVCaptureDevice *d, NSError **e) {
    if ([d isKindOfClass:[WCDevice class]]) {
      WCInput *in = class_createInstance([WCInput class], 0);
      in->_wcDevice = d;
      return in;
    }
    return ((id (*)(id, SEL, id, NSError **))wc_orig(self_, NSSelectorFromString(@"deviceInputWithDevice:error:")))(self_, NSSelectorFromString(@"deviceInputWithDevice:error:"), d, e);
  });
  WC_SWZ_I(I, @"initWithDevice:error:", ^id(id self_, AVCaptureDevice *d, NSError **e) {
    if ([d isKindOfClass:[WCDevice class]]) {
      WCInput *in = class_createInstance([WCInput class], 0);
      in->_wcDevice = d;
      return wc_owned(in);
    }
    return ((id (*)(id, SEL, id, NSError **))wc_orig(self_, NSSelectorFromString(@"initWithDevice:error:")))(self_, NSSelectorFromString(@"initWithDevice:error:"), d, e);
  });
}

static void wc_install_session(void) {
  Class S = [AVCaptureSession class];
  WC_SWZ_I(S, @"canAddInput:", ^BOOL(AVCaptureSession *s, AVCaptureInput *i) {
    return [i isKindOfClass:[WCInput class]] ? YES : ((BOOL (*)(id, SEL, id))wc_orig(s, NSSelectorFromString(@"canAddInput:")))(s, NSSelectorFromString(@"canAddInput:"), i);
  });
  WC_SWZ_I(S, @"addInput:", ^(AVCaptureSession *s, AVCaptureInput *i) {
    if (![i isKindOfClass:[WCInput class]]) { ((void (*)(id, SEL, id))wc_orig(s, NSSelectorFromString(@"addInput:")))(s, NSSelectorFromString(@"addInput:"), i); return; }
    WCSessionRec *rec = wc_rec(s, YES);
    [s willChangeValueForKey:@"inputs"];
    rec.input = (WCInput *)i;
    [s didChangeValueForKey:@"inputs"];
    if (rec.running && !rec.pump) { rec.pump = [[WCPump alloc] initWithRec:rec]; [(WCPump *)rec.pump start]; }
  });
  WC_SWZ_I(S, @"removeInput:", ^(AVCaptureSession *s, AVCaptureInput *i) {
    if (![i isKindOfClass:[WCInput class]]) { ((void (*)(id, SEL, id))wc_orig(s, NSSelectorFromString(@"removeInput:")))(s, NSSelectorFromString(@"removeInput:"), i); return; }
    WCSessionRec *rec = wc_rec(s, NO);
    if (!rec || rec.input != i) return;
    [s willChangeValueForKey:@"inputs"];
    rec.input = nil;
    [s didChangeValueForKey:@"inputs"];
  });
  WC_SWZ_I(S, @"inputs", ^id(AVCaptureSession *s) {
    NSArray *real = ((id (*)(id, SEL))wc_orig(s, NSSelectorFromString(@"inputs")))(s, NSSelectorFromString(@"inputs"));
    WCSessionRec *rec = wc_rec(s, NO);
    return rec.input ? [real arrayByAddingObject:rec.input] : real;
  });
  WC_SWZ_I(S, @"startRunning", ^(AVCaptureSession *s) {
    WCSessionRec *rec = wc_rec(s, NO);
    if (!rec || !rec.input) { ((void (*)(id, SEL))wc_orig(s, NSSelectorFromString(@"startRunning")))(s, NSSelectorFromString(@"startRunning")); return; }
    if (!rec.pump) rec.pump = [[WCPump alloc] initWithRec:rec];
    [(WCPump *)rec.pump start];
    wc_set_running(s, rec, YES);
  });
  WC_SWZ_I(S, @"stopRunning", ^(AVCaptureSession *s) {
    WCSessionRec *rec = wc_rec(s, NO);
    if (!rec || !rec.running) { ((void (*)(id, SEL))wc_orig(s, NSSelectorFromString(@"stopRunning")))(s, NSSelectorFromString(@"stopRunning")); return; }
    [(WCPump *)rec.pump stop];
    rec.pump = nil;
    for (AVCaptureOutput *o in s.outputs) {
      if ([o isKindOfClass:[AVCaptureMovieFileOutput class]]) {
        id del = WC_ASSOC_GET(o, kWCMovieDelegate);
        if (WC_ASSOC_GET(o, kWCRecorderKey)) wc_finish_recording((AVCaptureMovieFileOutput *)o, del);
      }
    }
    wc_set_running(s, rec, NO);
  });
  WC_SWZ_I(S, @"isRunning", ^BOOL(AVCaptureSession *s) {
    WCSessionRec *rec = wc_rec(s, NO);
    return (rec && rec.running) ? YES : ((BOOL (*)(id, SEL))wc_orig(s, NSSelectorFromString(@"isRunning")))(s, NSSelectorFromString(@"isRunning"));
  });
}

static void wc_install_outputs(void) {
  Class O = [AVCaptureOutput class];
  IMP origConn = wc_orig_i(O, @"connectionWithMediaType:");
  WC_SWZ_I(O, @"connectionWithMediaType:", ^id(AVCaptureOutput *o, AVMediaType t) {
    id real = origConn ? ((id (*)(id, SEL, id))wc_orig(o, NSSelectorFromString(@"connectionWithMediaType:")))(o, NSSelectorFromString(@"connectionWithMediaType:"), t) : nil;
    if (real || !wc_is_video(t) || !wc_rec_for_output(o)) return real;
    return wc_connection(o);
  });

  Class P = [AVCapturePhotoOutput class];
  WC_SWZ_I(P, @"capturePhotoWithSettings:delegate:", ^(AVCapturePhotoOutput *o, AVCapturePhotoSettings *settings, id<AVCapturePhotoCaptureDelegate> del) {
    WCSessionRec *rec = wc_rec_for_output(o);
    if (!rec || !rec.running) { ((void (*)(id, SEL, id, id))wc_orig(o, NSSelectorFromString(@"capturePhotoWithSettings:delegate:")))(o, NSSelectorFromString(@"capturePhotoWithSettings:delegate:"), settings, del); return; }
    wc_capture_photo(o, settings, del, rec);
  });
  WC_SWZ_I(P, @"availablePhotoCodecTypes", ^id(id o) { return @[ AVVideoCodecTypeJPEG, AVVideoCodecTypeHEVC ]; });
  WC_SWZ_I(P, @"availablePhotoFileTypes", ^id(id o) { return @[ AVFileTypeJPEG, AVFileTypeHEIC ]; });
  WC_SWZ_I(P, @"availablePhotoPixelFormatTypes", ^id(id o) { return @[ @(kCVPixelFormatType_32BGRA) ]; });
  WC_SWZ_I(P, @"supportedFlashModes", ^id(id o) { return @[ @0 ]; });
  WC_SWZ_I(P, @"isFlashScene", ^BOOL(id o) { return NO; });
  WC_SWZ_I(P, @"setHighResolutionCaptureEnabled:", ^(id o, BOOL b) {});
  WC_SWZ_I(P, @"setMaxPhotoQualityPrioritization:", ^(id o, NSInteger v) {});
  WC_SWZ_I(P, @"maxPhotoQualityPrioritization", ^NSInteger(id o) { return 2; });
  WC_SWZ_I(P, @"setMaxPhotoDimensions:", ^(id o, CMVideoDimensions d) {});
  WC_SWZ_I(P, @"maxPhotoDimensions", ^CMVideoDimensions(id o) { return (CMVideoDimensions){ 4032, 3024 }; });

  Class M = [AVCaptureMetadataOutput class];
  WC_SWZ_I(M, @"availableMetadataObjectTypes", ^id(id o) { return @[ AVMetadataObjectTypeQRCode ]; });
  WC_SWZ_I(M, @"setMetadataObjectTypes:", ^(id o, NSArray *t) { WC_ASSOC_SET(o, kWCMetaTypes, [t copy]); });
  WC_SWZ_I(M, @"metadataObjectTypes", ^id(id o) { return WC_ASSOC_GET(o, kWCMetaTypes) ?: @[]; });
  WC_SWZ_I(M, @"setRectOfInterest:", ^(id o, CGRect r) { WC_ASSOC_SET(o, kWCMetaRoi, CFBridgingRelease(CGRectCreateDictionaryRepresentation(r))); });
  WC_SWZ_I(M, @"rectOfInterest", ^CGRect(id o) { return wc_roi(o); });

  Class V = [AVCaptureVideoPreviewLayer class];
  for (NSString *name in @[ @"layerWithSession:", @"layerWithSessionWithNoConnection:" ]) {
    IMP orig = wc_orig_c(V, name);
    SEL sel = NSSelectorFromString(name);
    if (!orig) continue;
    WC_SWZ_C(V, name, ^id(id self_, AVCaptureSession *s) {
      id layer = ((id (*)(id, SEL, id))wc_orig(self_, sel))(self_, sel, s);
      if (layer) @synchronized (g_cam_lock) { [g_previews addObject:layer]; atomic_fetch_add(&g_previews_gen, 1); }
      return layer;
    });
  }
  for (NSString *name in @[ @"initWithSession:", @"initWithSessionWithNoConnection:" ]) {
    IMP orig = wc_orig_i(V, name);
    SEL sel = NSSelectorFromString(name);
    if (!orig) continue;
    WC_SWZ_I(V, name, ^id(id self_, AVCaptureSession *s) {
      id layer = ((id (*)(id, SEL, id))wc_orig(self_, sel))(self_, sel, s);
      if (layer) @synchronized (g_cam_lock) { [g_previews addObject:layer]; atomic_fetch_add(&g_previews_gen, 1); }
      return layer;
    });
  }
  for (NSString *name in @[ @"setSession:", @"setSessionWithNoConnection:" ]) {
    IMP orig = wc_orig_i(V, name);
    SEL sel = NSSelectorFromString(name);
    if (!orig) continue;
    WC_SWZ_I(V, name, ^(id self_, AVCaptureSession *s) {
      ((void (*)(id, SEL, id))wc_orig(self_, sel))(self_, sel, s);
      if (s) @synchronized (g_cam_lock) { [g_previews addObject:self_]; atomic_fetch_add(&g_previews_gen, 1); }
    });
  }
  WC_SWZ_I(V, @"transformedMetadataObjectForMetadataObject:", ^id(id l, id o) { return o; });
  WC_SWZ_I(V, @"captureDevicePointOfInterestForPoint:", ^CGPoint(AVCaptureVideoPreviewLayer *l, CGPoint p) {
    CGSize s = l.bounds.size;
    return CGPointMake(s.width > 0 ? p.x / s.width : 0.5, s.height > 0 ? p.y / s.height : 0.5);
  });
  WC_SWZ_I(V, @"pointForCaptureDevicePointOfInterest:", ^CGPoint(AVCaptureVideoPreviewLayer *l, CGPoint p) {
    CGSize s = l.bounds.size;
    return CGPointMake(p.x * s.width, p.y * s.height);
  });

  Class F = [AVCaptureMovieFileOutput class];
  WC_SWZ_I(F, @"startRecordingToOutputFileURL:recordingDelegate:", ^(AVCaptureMovieFileOutput *o, NSURL *url, id<AVCaptureFileOutputRecordingDelegate> del) {
    WCSessionRec *rec = wc_rec_for_output(o);
    if (!rec || !rec.running) { ((void (*)(id, SEL, id, id))wc_orig(o, NSSelectorFromString(@"startRecordingToOutputFileURL:recordingDelegate:")))(o, NSSelectorFromString(@"startRecordingToOutputFileURL:recordingDelegate:"), url, del); return; }
    if (WC_ASSOC_GET(o, kWCRecorderKey)) return;
    CVPixelBufferRef pb = [(WCPump *)rec.pump copyLatest];
    if (!pb) pb = wc_current_frame(wc_facing_of((WCDevice *)rec.input->_wcDevice));
    WCRecorder *r = [[WCRecorder alloc] initWithURL:url width:pb ? CVPixelBufferGetWidth(pb) : 640 height:pb ? CVPixelBufferGetHeight(pb) : 480];
    if (pb) { [r append:pb]; CVPixelBufferRelease(pb); }
    WC_ASSOC_SET(o, kWCMovieDelegate, del);
    WC_ASSOC_SET(o, kWCRecorderKey, r);
    dispatch_async(dispatch_get_main_queue(), ^{
      if ([del respondsToSelector:@selector(captureOutput:didStartRecordingToOutputFileAtURL:fromConnections:)]) {
        [del captureOutput:o didStartRecordingToOutputFileAtURL:url fromConnections:@[ wc_connection(o) ]];
      }
    });
  });
  WC_SWZ_I(F, @"stopRecording", ^(AVCaptureMovieFileOutput *o) {
    if (!WC_ASSOC_GET(o, kWCRecorderKey)) { ((void (*)(id, SEL))wc_orig(o, NSSelectorFromString(@"stopRecording")))(o, NSSelectorFromString(@"stopRecording")); return; }
    wc_finish_recording(o, WC_ASSOC_GET(o, kWCMovieDelegate));
  });
  WC_SWZ_I(F, @"isRecording", ^BOOL(AVCaptureMovieFileOutput *o) {
    return WC_ASSOC_GET(o, kWCRecorderKey) ? YES : ((BOOL (*)(id, SEL))wc_orig(o, NSSelectorFromString(@"isRecording")))(o, NSSelectorFromString(@"isRecording"));
  });
  WC_SWZ_I(F, @"recordedDuration", ^CMTime(AVCaptureMovieFileOutput *o) {
    WCRecorder *r = WC_ASSOC_GET(o, kWCRecorderKey);
    return r ? [r duration] : ((CMTime (*)(id, SEL))wc_orig(o, NSSelectorFromString(@"recordedDuration")))(o, NSSelectorFromString(@"recordedDuration"));
  });
  WC_SWZ_I(F, @"recordedFileSize", ^int64_t(AVCaptureMovieFileOutput *o) {
    WCRecorder *r = WC_ASSOC_GET(o, kWCRecorderKey);
    if (!r) return ((int64_t (*)(id, SEL))wc_orig(o, NSSelectorFromString(@"recordedFileSize")))(o, NSSelectorFromString(@"recordedFileSize"));
    return [[[NSFileManager defaultManager] attributesOfItemAtPath:r.url.path error:nil][NSFileSize] longLongValue];
  });
}

/** `AVCaptureDeviceRotationCoordinator` (iOS 17) built from the fake device: a stand-in subclass made at runtime, so the dylib still loads where the class does not exist. Angle 0: frames are already upright. */
static void wc_install_rotation(void) {
  Class R = NSClassFromString(@"AVCaptureDeviceRotationCoordinator");
  if (!R) return;
  Class sub = objc_allocateClassPair(R, "WCRotationCoordinator", sizeof(void *) * 2);
  if (!sub) return;
  class_addIvar(sub, "wcDevice", sizeof(id), sizeof(id) == 8 ? 3 : 2, "@");
  class_addIvar(sub, "wcLayer", sizeof(id), sizeof(id) == 8 ? 3 : 2, "@");
  objc_registerClassPair(sub);
  Ivar devIvar = class_getInstanceVariable(sub, "wcDevice"), layerIvar = class_getInstanceVariable(sub, "wcLayer");
  class_addMethod(sub, NSSelectorFromString(@"device"), imp_implementationWithBlock(^id(id s) { return object_getIvar(s, devIvar); }), "@@:");
  class_addMethod(sub, NSSelectorFromString(@"previewLayer"), imp_implementationWithBlock(^id(id s) { return object_getIvar(s, layerIvar); }), "@@:");
  class_addMethod(sub, NSSelectorFromString(@"videoRotationAngleForHorizonLevelPreview"), imp_implementationWithBlock(^CGFloat(id s) { return 0; }), "d@:");
  class_addMethod(sub, NSSelectorFromString(@"videoRotationAngleForHorizonLevelCapture"), imp_implementationWithBlock(^CGFloat(id s) { return 0; }), "d@:");
  IMP origInit = wc_orig_i(R, @"initWithDevice:previewLayer:");
  if (!origInit) return;
  WC_SWZ_I(R, @"initWithDevice:previewLayer:", ^id(id self_, AVCaptureDevice *d, CALayer *layer) {
    if (![d isKindOfClass:[WCDevice class]]) return ((id (*)(id, SEL, id, id))wc_orig(self_, NSSelectorFromString(@"initWithDevice:previewLayer:")))(self_, NSSelectorFromString(@"initWithDevice:previewLayer:"), d, layer);
    id c = class_createInstance(sub, 0);
    object_setIvarWithStrongDefault(c, devIvar, d);
    object_setIvarWithStrongDefault(c, layerIvar, layer);
    return wc_owned(c);
  });
}

#if TARGET_OS_IOS
#pragma mark camera: UIImagePickerController

static char kWCPickerRec, kWCPickerOverlay;

static int wc_picker_facing(UIImagePickerController *p) {
  int want = p.cameraDevice == UIImagePickerControllerCameraDeviceFront ? WC_FRONT : WC_BACK;
  return wc_feed(want) ? want : (want == WC_BACK ? WC_FRONT : WC_BACK);
}

static UIImage *wc_picker_image(UIImagePickerController *p) {
  CVPixelBufferRef pb = wc_current_frame(wc_picker_facing(p));
  if (!pb) return nil;
  CGImageRef cg = wc_image_from_pixel_buffer(pb);
  CVPixelBufferRelease(pb);
  if (!cg) return nil;
  UIImage *img = [UIImage imageWithCGImage:cg];
  CGImageRelease(cg);
  return img;
}

static void wc_picker_finish(UIImagePickerController *p, NSDictionary *info) {
  id<UIImagePickerControllerDelegate, UINavigationControllerDelegate> del = p.delegate;
  if ([del respondsToSelector:@selector(imagePickerController:didFinishPickingMediaWithInfo:)]) [del imagePickerController:p didFinishPickingMediaWithInfo:info];
  else [p dismissViewControllerAnimated:YES completion:nil];
}

static void wc_picker_cancel(UIImagePickerController *p) {
  id<UIImagePickerControllerDelegate, UINavigationControllerDelegate> del = p.delegate;
  if ([del respondsToSelector:@selector(imagePickerControllerDidCancel:)]) [del imagePickerControllerDidCancel:p];
  else [p dismissViewControllerAnimated:YES completion:nil];
}

static void wc_picker_take_photo(UIImagePickerController *p) {
  UIImage *img = wc_picker_image(p);
  if (!img) return;
  NSData *jpeg = UIImageJPEGRepresentation(img, 0.92);
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"warden-camera-%@.jpg", NSUUID.UUID.UUIDString]]];
  [jpeg writeToURL:url atomically:YES];
  wc_picker_finish(p, @{
    UIImagePickerControllerMediaType: @"public.image",
    UIImagePickerControllerOriginalImage: img,
    UIImagePickerControllerImageURL: url,
    UIImagePickerControllerMediaMetadata: @{},
  });
}

@interface WCPickerRecording : NSObject
@property (nonatomic, strong) WCRecorder *recorder;
@property (nonatomic, strong) NSTimer *timer;
@end
@implementation WCPickerRecording
@end

static void wc_picker_start_video(UIImagePickerController *p) {
  if (WC_ASSOC_GET(p, kWCPickerRec)) return;
  int facing = wc_picker_facing(p);
  CVPixelBufferRef pb = wc_current_frame(facing);
  if (!pb) return;
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"warden-camera-%@.mov", NSUUID.UUID.UUIDString]]];
  WCPickerRecording *rec = [WCPickerRecording new];
  rec.recorder = [[WCRecorder alloc] initWithURL:url width:CVPixelBufferGetWidth(pb) height:CVPixelBufferGetHeight(pb)];
  [rec.recorder append:pb];
  CVPixelBufferRelease(pb);
  WCRecorder *recorder = rec.recorder;
  rec.timer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 30 repeats:YES block:^(NSTimer *t) {
    CVPixelBufferRef f = wc_current_frame(facing);
    if (f) { [recorder append:f]; CVPixelBufferRelease(f); }
  }];
  WC_ASSOC_SET(p, kWCPickerRec, rec);
}

static void wc_picker_stop_video(UIImagePickerController *p) {
  WCPickerRecording *rec = WC_ASSOC_GET(p, kWCPickerRec);
  if (!rec) return;
  WC_ASSOC_SET(p, kWCPickerRec, nil);
  [rec.timer invalidate];
  NSURL *url = rec.recorder.url;
  [rec.recorder finish:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error) { wc_picker_cancel(p); return; }
      wc_picker_finish(p, @{ UIImagePickerControllerMediaType: @"public.movie", UIImagePickerControllerMediaURL: url });
    });
  }];
}

static BOOL wc_picker_video_mode(UIImagePickerController *p) {
  return p.cameraCaptureMode == UIImagePickerControllerCameraCaptureModeVideo;
}

/** Warden's own camera UI for a picker whose controls are on: the feed full screen, a shutter and a cancel. */
@interface WCPickerOverlay : UIView
- (instancetype)initWithPicker:(UIImagePickerController *)picker showControls:(BOOL)controls;
@end
@implementation WCPickerOverlay {
  __weak UIImagePickerController *_picker;
  UIImageView *_preview;
  UIButton *_shutter, *_cancel;
  NSTimer *_timer;
  BOOL _recording;
  UIImage *_still;
}
- (instancetype)initWithPicker:(UIImagePickerController *)picker showControls:(BOOL)controls {
  if (!(self = [super initWithFrame:picker.view.bounds])) return nil;
  _picker = picker;
  self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.backgroundColor = controls ? UIColor.blackColor : UIColor.clearColor;
  _preview = [[UIImageView alloc] initWithFrame:self.bounds];
  _preview.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  _preview.contentMode = UIViewContentModeScaleAspectFill;
  _preview.clipsToBounds = YES;
  _preview.userInteractionEnabled = NO;
  [self addSubview:_preview];
  if (controls) {
    _shutter = [UIButton buttonWithType:UIButtonTypeCustom];
    _shutter.frame = CGRectMake(0, 0, 72, 72);
    _shutter.backgroundColor = UIColor.whiteColor;
    _shutter.layer.cornerRadius = 36;
    _shutter.layer.borderWidth = 4;
    _shutter.layer.borderColor = [UIColor colorWithWhite:0.8 alpha:1].CGColor;
    _shutter.isAccessibilityElement = YES;
    _shutter.accessibilityIdentifier = @"warden-camera-shutter";
    _shutter.accessibilityLabel = wc_picker_video_mode(picker) ? @"Record" : @"Take Photo";
    [_shutter addTarget:self action:@selector(shutterTapped) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:_shutter];
    _cancel = [UIButton buttonWithType:UIButtonTypeSystem];
    [_cancel setTitle:@"Cancel" forState:UIControlStateNormal];
    [_cancel setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    _cancel.titleLabel.font = [UIFont systemFontOfSize:18];
    _cancel.frame = CGRectMake(0, 0, 90, 44);
    _cancel.isAccessibilityElement = YES;
    _cancel.accessibilityIdentifier = @"warden-camera-cancel";
    _cancel.accessibilityLabel = @"Cancel";
    [_cancel addTarget:self action:@selector(cancelTapped) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:_cancel];
  }
  _timer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 15 target:self selector:@selector(refresh) userInfo:nil repeats:YES];
  [self refresh];
  return self;
}
- (void)dealloc { [_timer invalidate]; }
- (void)layoutSubviews {
  [super layoutSubviews];
  CGRect b = self.bounds;
  UIEdgeInsets safe = self.safeAreaInsets;
  _shutter.center = CGPointMake(CGRectGetMidX(b), CGRectGetMaxY(b) - safe.bottom - 70);
  _cancel.center = CGPointMake(45 + 8, CGRectGetMaxY(b) - safe.bottom - 70);
  [self bringSubviewToFront:_shutter];
  [self bringSubviewToFront:_cancel];
}
- (void)refresh {
  UIImagePickerController *p = _picker;
  if (!p) return;
  WCSource *src = wc_source(wc_picker_facing(p));
  if (src.still && _still) return;
  UIImage *img = wc_picker_image(p);
  if (!img) return;
  if (src.still) _still = img;
  _preview.image = img;
}
- (void)shutterTapped {
  UIImagePickerController *p = _picker;
  if (!p) return;
  if (!wc_picker_video_mode(p)) { wc_picker_take_photo(p); return; }
  if (_recording) { _recording = NO; wc_picker_stop_video(p); }
  else { _recording = YES; wc_picker_start_video(p); }
}
- (void)cancelTapped {
  UIImagePickerController *p = _picker;
  if (p) wc_picker_cancel(p);
}
@end

static BOOL wc_any_feed(void) { return wc_feed(WC_BACK) != nil || wc_feed(WC_FRONT) != nil; }

static void wc_install_picker(void) {
  Class P = [UIImagePickerController class];
  WC_SWZ_C(P, @"isSourceTypeAvailable:", ^BOOL(id self_, UIImagePickerControllerSourceType t) {
    if (t == UIImagePickerControllerSourceTypeCamera) return wc_any_feed();
    return ((BOOL (*)(id, SEL, NSInteger))wc_orig(self_, NSSelectorFromString(@"isSourceTypeAvailable:")))(self_, NSSelectorFromString(@"isSourceTypeAvailable:"), t);
  });
  IMP origDev = wc_orig_c(P, @"isCameraDeviceAvailable:");
  WC_SWZ_C(P, @"isCameraDeviceAvailable:", ^BOOL(id self_, UIImagePickerControllerCameraDevice d) {
    return wc_feed(d == UIImagePickerControllerCameraDeviceFront ? WC_FRONT : WC_BACK) != nil
      || (origDev && ((BOOL (*)(id, SEL, NSInteger))wc_orig(self_, NSSelectorFromString(@"isCameraDeviceAvailable:")))(self_, NSSelectorFromString(@"isCameraDeviceAvailable:"), d));
  });
  WC_SWZ_C(P, @"isFlashAvailableForCameraDevice:", ^BOOL(id self_, NSInteger d) { return NO; });
  WC_SWZ_C(P, @"availableCaptureModesForCameraDevice:", ^id(id self_, NSInteger d) {
    return @[ @(UIImagePickerControllerCameraCaptureModePhoto), @(UIImagePickerControllerCameraCaptureModeVideo) ];
  });
  IMP origTypes = wc_orig_c(P, @"availableMediaTypesForSourceType:");
  WC_SWZ_C(P, @"availableMediaTypesForSourceType:", ^id(id self_, UIImagePickerControllerSourceType t) {
    if (t == UIImagePickerControllerSourceTypeCamera && wc_any_feed()) return @[ @"public.image", @"public.movie" ];
    return origTypes ? ((id (*)(id, SEL, NSInteger))wc_orig(self_, NSSelectorFromString(@"availableMediaTypesForSourceType:")))(self_, NSSelectorFromString(@"availableMediaTypesForSourceType:"), t) : @[];
  });
  WC_SWZ_I(P, @"viewDidAppear:", ^(UIImagePickerController *p, BOOL animated) {
    ((void (*)(id, SEL, BOOL))wc_orig(p, NSSelectorFromString(@"viewDidAppear:")))(p, NSSelectorFromString(@"viewDidAppear:"), animated);
    if (p.sourceType != UIImagePickerControllerSourceTypeCamera || WC_ASSOC_GET(p, kWCPickerOverlay) || !wc_any_feed()) return;
    BOOL controls = p.showsCameraControls;
    WCPickerOverlay *overlay = [[WCPickerOverlay alloc] initWithPicker:p showControls:controls];
    WC_ASSOC_SET(p, kWCPickerOverlay, overlay);
    if (controls) {
      p.showsCameraControls = NO;
      p.cameraOverlayView = overlay;
    } else if (p.cameraOverlayView) {
      overlay.frame = p.cameraOverlayView.bounds;
      [p.cameraOverlayView insertSubview:overlay atIndex:0];
    } else {
      p.cameraOverlayView = overlay;
    }
  });
  WC_SWZ_I(P, @"takePicture", ^BOOL(UIImagePickerController *p) {
    if (p.sourceType != UIImagePickerControllerSourceTypeCamera || !wc_any_feed()) return ((BOOL (*)(id, SEL))wc_orig(p, NSSelectorFromString(@"takePicture")))(p, NSSelectorFromString(@"takePicture"));
    dispatch_async(dispatch_get_main_queue(), ^{ wc_picker_take_photo(p); });
    return YES;
  });
  WC_SWZ_I(P, @"startVideoCapture", ^BOOL(UIImagePickerController *p) {
    if (p.sourceType != UIImagePickerControllerSourceTypeCamera || !wc_any_feed()) return ((BOOL (*)(id, SEL))wc_orig(p, NSSelectorFromString(@"startVideoCapture")))(p, NSSelectorFromString(@"startVideoCapture"));
    wc_picker_start_video(p);
    return YES;
  });
  WC_SWZ_I(P, @"stopVideoCapture", ^(UIImagePickerController *p) {
    if (!WC_ASSOC_GET(p, kWCPickerRec)) { ((void (*)(id, SEL))wc_orig(p, NSSelectorFromString(@"stopVideoCapture")))(p, NSSelectorFromString(@"stopVideoCapture")); return; }
    wc_picker_stop_video(p);
  });
}
#endif

static void camera_install(void) {
  g_cam_lock = [NSObject new];
  g_sessions = [NSMapTable weakToStrongObjectsMapTable];
  g_previews = [NSHashTable weakObjectsHashTable];
  g_discoveries = [NSHashTable weakObjectsHashTable];
  g_detect_queue = dispatch_queue_create("nz.co.delacour.warden.camera.detect", DISPATCH_QUEUE_SERIAL);
  wc_install_devices();
  wc_install_session();
  wc_install_outputs();
  wc_install_rotation();
#if TARGET_OS_IOS
  wc_install_picker();
#endif
  DLOG("camera: installed");
}

/** Apply the state file's `camera` object (`{"back": {kind, path, loop}, "front": …}`); a facing left out has no camera. */
static void camera_apply(NSDictionary *camera) {
  if (!g_camera_enabled) return;
  BOOL presence[2] = { NO, NO };
  @synchronized (g_cam_lock) {
    BOOL before[2] = { g_feed[0] != nil, g_feed[1] != nil };
    NSArray *names = @[ @"back", @"front" ];
    for (int i = 0; i < 2; i++) {
      NSDictionary *d = [camera[names[i]] isKindOfClass:[NSDictionary class]] ? camera[names[i]] : nil;
      NSString *path = [d[@"path"] isKindOfClass:[NSString class]] ? d[@"path"] : nil;
      WCFeed *next = nil;
      if (path.length) {
        next = [WCFeed new];
        next.path = path;
        next.video = [d[@"kind"] isEqual:@"video"];
        next.loop = [d[@"loop"] respondsToSelector:@selector(boolValue)] ? [d[@"loop"] boolValue] : YES;
      }
      WCFeed *prev = g_feed[i];
      BOOL same = prev && next && [prev.path isEqualToString:next.path] && prev.video == next.video && prev.loop == next.loop;
      if (!same) { g_feed[i] = next; g_source[i] = nil; }
      presence[i] = next != nil;
    }
    if (before[0] == presence[0] && before[1] == presence[1]) return;
  }
  BOOL backNow = presence[0], frontNow = presence[1];
  // devices appeared or went away: tell the KVO observers of every discovery session, and the connect notifications
  dispatch_async(dispatch_get_main_queue(), ^{
    NSArray *sessions;
    @synchronized (g_cam_lock) { sessions = g_discoveries.allObjects; }
    for (AVCaptureDeviceDiscoverySession *s in sessions) {
      [s willChangeValueForKey:@"devices"];
      [s didChangeValueForKey:@"devices"];
    }
    for (int i = 0; i < 2; i++) {
      [[NSNotificationCenter defaultCenter] postNotificationName:(i == 0 ? backNow : frontNow) ? AVCaptureDeviceWasConnectedNotification : AVCaptureDeviceWasDisconnectedNotification object:wc_device(i)];
    }
  });
}

#pragma mark - passkeys
// A virtual authenticator (WDN-PASS): with WARDEN_PASSKEYS=1 the app's platform passkey calls on
// `ASAuthorizationController` are answered in-process with a software P-256 authenticator instead of reaching the OS,
// so an app signed without associated domains, on a simulator with no iCloud account, still registers and signs in.
// Facts it is built on are in docs/plans/wdn-pass-0-ios-findings.md (iOS 27.2 only was run; every selector below that
// is missing on another OS makes the feature a no-op, never a crash).
//
// State (the `passkeys` key of the state file, absent = authenticator off = the real OS answers):
//   {"mode":"auto"|"cancel"|"fail"|"unavailable","uv":"match"|"nomatch"|"skip","storePath":"<store.json>"}
// Credentials live in the store file (`{version:1,credentials:[{credentialId,rpId,userHandle,userName,displayName,
// privateKey (PKCS#8 DER, base64url),signCount,createdAt,backupEligible,backupState}]}`), read on every request and
// appended to (tmp + rename) when the app registers, so the host's `add` / `list` see the same credentials.
//
// Intercepted: -[ASAuthorizationController performRequests], -performRequestsWithOptions: and
// -performAutoFillAssistedRequests, iff the controller holds at least one platform passkey request (the first one is
// answered, every other request is dropped). Security-key-only, password-only and Apple ID requests reach the OS.
// The delegate is called asynchronously on the main queue, like the real controller; -cancel before that completes
// with 1001. Conditional UI (autofill) stays pending like the real QuickType flow for cancel / unavailable / nomatch.
#define PK_ERR_DOMAIN @"com.apple.AuthenticationServices.AuthorizationError"

static BOOL g_passkeys_enabled = NO;
static NSObject *g_pk_lock;
static BOOL g_pk_active = NO;
static NSString *g_pk_mode = @"auto";
static NSString *g_pk_uv = @"match";
static NSString *g_pk_store = nil;

static NSString *pk_b64u(NSData *d) {
  NSString *s = [d base64EncodedStringWithOptions:0];
  s = [[s stringByReplacingOccurrencesOfString:@"+" withString:@"-"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  while ([s hasSuffix:@"="]) s = [s substringToIndex:s.length - 1];
  return s;
}

static NSData *pk_unb64u(NSString *s) {
  NSMutableString *m = [[[s stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"] mutableCopy];
  while (m.length % 4) [m appendString:@"="];
  return [[NSData alloc] initWithBase64EncodedString:m options:0];
}

static NSData *pk_sha256(NSData *d) {
  uint8_t h[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(d.bytes, (CC_LONG)d.length, h);
  return [NSData dataWithBytes:h length:sizeof h];
}

// a minimal CBOR writer: unsigned / negative ints, byte and text strings, map and array heads
static void pk_cbor_head(NSMutableData *o, uint8_t major, uint64_t n) {
  uint8_t b[5];
  size_t l;
  if (n < 24) { b[0] = (uint8_t)((major << 5) | n); l = 1; }
  else if (n < 256) { b[0] = (uint8_t)((major << 5) | 24); b[1] = (uint8_t)n; l = 2; }
  else if (n < 65536) { b[0] = (uint8_t)((major << 5) | 25); b[1] = (uint8_t)(n >> 8); b[2] = (uint8_t)n; l = 3; }
  else { b[0] = (uint8_t)((major << 5) | 26); b[1] = (uint8_t)(n >> 24); b[2] = (uint8_t)(n >> 16); b[3] = (uint8_t)(n >> 8); b[4] = (uint8_t)n; l = 5; }
  [o appendBytes:b length:l];
}
static void pk_cbor_text(NSMutableData *o, NSString *s) { NSData *d = [s dataUsingEncoding:NSUTF8StringEncoding]; pk_cbor_head(o, 3, d.length); [o appendData:d]; }
static void pk_cbor_bytes(NSMutableData *o, NSData *d) { pk_cbor_head(o, 2, d.length); [o appendData:d]; }
static void pk_cbor_int(NSMutableData *o, int64_t n) { if (n >= 0) pk_cbor_head(o, 0, (uint64_t)n); else pk_cbor_head(o, 1, (uint64_t)(-1 - n)); }

/** rpIdHash || flags || signCount [|| AAGUID || credId length || credId || COSE_Key (ES256) when `pub65` is given]. */
static NSData *pk_auth_data(NSString *rp, uint8_t flags, uint32_t signCount, NSData *credId, NSData *pub65) {
  NSMutableData *a = [NSMutableData data];
  [a appendData:pk_sha256([rp dataUsingEncoding:NSUTF8StringEncoding])];
  [a appendBytes:&flags length:1];
  uint8_t sc[4] = { (uint8_t)(signCount >> 24), (uint8_t)(signCount >> 16), (uint8_t)(signCount >> 8), (uint8_t)signCount };
  [a appendBytes:sc length:4];
  if (pub65) {
    // warden's AAGUID: "warden-passkey" 00 01
    static const uint8_t aaguid[16] = { 0x77, 0x61, 0x72, 0x64, 0x65, 0x6e, 0x2d, 0x70, 0x61, 0x73, 0x73, 0x6b, 0x65, 0x79, 0x00, 0x01 };
    [a appendBytes:aaguid length:16];
    uint8_t l[2] = { (uint8_t)(credId.length >> 8), (uint8_t)credId.length };
    [a appendBytes:l length:2];
    [a appendData:credId];
    NSMutableData *k = [NSMutableData data];
    pk_cbor_head(k, 5, 5);
    pk_cbor_int(k, 1); pk_cbor_int(k, 2);       // kty EC2
    pk_cbor_int(k, 3); pk_cbor_int(k, -7);      // alg ES256
    pk_cbor_int(k, -1); pk_cbor_int(k, 1);      // crv P-256
    pk_cbor_int(k, -2); pk_cbor_bytes(k, [pub65 subdataWithRange:NSMakeRange(1, 32)]);
    pk_cbor_int(k, -3); pk_cbor_bytes(k, [pub65 subdataWithRange:NSMakeRange(33, 32)]);
    [a appendData:k];
  }
  return a;
}

/** UP | UV (unless uv=skip) | BE | BS (per credential) [| AT]: 0x5d on registration and 0x1d on assertion, like iOS. */
static uint8_t pk_flags(NSString *uv, BOOL be, BOOL bs, BOOL attested) {
  uint8_t f = 0x01;
  if (![uv isEqualToString:@"skip"]) f |= 0x04;
  if (be) f |= 0x08;
  if (bs) f |= 0x10;
  if (attested) f |= 0x40;
  return f;
}

#pragma mark passkeys: keys and store

/**
 * A PKCS#8 P-256 key (what the store holds) as the `04||X||Y||D` blob SecKeyCreateWithData takes. PKCS#8 itself is not
 * accepted, so the ECPrivateKey inside is located (`02 01 01 04 20 <D>`, then an optional `a0` parameters block, then
 * `a1 44 03 42 00 <04||X||Y>`). A key without its public point (SEC1 without the optional field) cannot be imported.
 */
static NSData *pk_raw_key(NSData *der, NSData **pub65) {
  const uint8_t *b = der.bytes;
  NSUInteger n = der.length;
  static const uint8_t head[5] = { 0x02, 0x01, 0x01, 0x04, 0x20 };
  for (NSUInteger i = 0; i + 5 + 32 <= n; i++) {
    if (memcmp(b + i, head, 5) != 0) continue;
    NSUInteger p = i + 5;
    NSData *d = [der subdataWithRange:NSMakeRange(p, 32)];
    p += 32;
    if (p + 2 <= n && b[p] == 0xa0) p += 2 + b[p + 1];
    static const uint8_t pubHead[5] = { 0xa1, 0x44, 0x03, 0x42, 0x00 };
    if (p + 5 + 65 > n || memcmp(b + p, pubHead, 5) != 0 || b[p + 5] != 0x04) return nil;
    NSData *pub = [der subdataWithRange:NSMakeRange(p + 5, 65)];
    if (pub65) *pub65 = pub;
    NSMutableData *raw = [pub mutableCopy];
    [raw appendData:d];
    return raw;
  }
  return nil;
}

/** The PKCS#8 DER OpenSSL / node write for a P-256 key (`04||X||Y||D` in), so the host's `crypto.createPrivateKey` reads the store. */
static NSData *pk_pkcs8(NSData *raw97) {
  static const uint8_t pre[36] = {
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20 };
  static const uint8_t mid[5] = { 0xa1, 0x44, 0x03, 0x42, 0x00 };
  NSMutableData *o = [NSMutableData dataWithBytes:pre length:sizeof pre];
  [o appendData:[raw97 subdataWithRange:NSMakeRange(65, 32)]];
  [o appendBytes:mid length:sizeof mid];
  [o appendData:[raw97 subdataWithRange:NSMakeRange(0, 65)]];
  return o;
}

/** The store's credentials; NO when the file exists and does not parse (a missing file is an empty store). */
static BOOL pk_load(NSString *path, NSArray<NSDictionary *> **out) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (!data) { *out = @[]; return YES; }
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSArray *list = [json isKindOfClass:[NSDictionary class]] ? ((NSDictionary *)json)[@"credentials"] : nil;
  if (![list isKindOfClass:[NSArray class]]) return NO;
  NSMutableArray *ok = [NSMutableArray array];
  for (id c in list) {
    if (![c isKindOfClass:[NSDictionary class]]) return NO;
    [ok addObject:c];
  }
  *out = ok;
  return YES;
}

/** Add `cred` to the store (read, append, tmp + rename, 0600); NO when the existing store is unreadable or the write fails. */
static BOOL pk_append(NSString *path, NSDictionary *cred) {
  NSArray<NSDictionary *> *all = nil;
  if (!pk_load(path, &all)) return NO;
  NSData *body = [NSJSONSerialization dataWithJSONObject:@{ @"version": @1, @"credentials": [all arrayByAddingObject:cred] } options:0 error:nil];
  if (!body) return NO;
  NSFileManager *fm = NSFileManager.defaultManager;
  if (![fm createDirectoryAtPath:[path stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:nil]) return NO;
  NSString *tmp = [NSString stringWithFormat:@"%@.%d.tmp", path, getpid()];
  if (![fm createFileAtPath:tmp contents:body attributes:@{ NSFilePosixPermissions: @0600 }]) return NO;
  if (rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation) != 0) { unlink(tmp.fileSystemRepresentation); return NO; }
  return YES;
}

#pragma mark passkeys: credential and authorization objects

static const void *kPkProps = &kPkProps;
static const void *kPkPending = &kPkPending;
static const void *kPkCancelled = &kPkCancelled;
static Class g_pk_reg_cred, g_pk_asr_cred, g_pk_auth_class;

/** A subclass of `super` whose getters answer from an associated dictionary; `nilProps` answer nil (extension outputs). */
static Class pk_cred_class(const char *name, Class super_, NSArray<NSString *> *props, NSArray<NSString *> *nilProps) {
  Class c = objc_allocateClassPair(super_, name, 0);
  if (!c) return Nil;
  for (NSString *p in props) {
    class_addMethod(c, NSSelectorFromString(p), imp_implementationWithBlock(^id(id self_) { return [objc_getAssociatedObject(self_, kPkProps) objectForKey:p]; }), "@@:");
  }
  for (NSString *p in nilProps) {
    class_addMethod(c, NSSelectorFromString(p), imp_implementationWithBlock(^id(id self_) { (void)self_; return nil; }), "@@:");
  }
  class_addMethod(c, NSSelectorFromString(@"attachment"), imp_implementationWithBlock(^NSInteger(id self_) { (void)self_; return 0; }), "q@:");  // platform
  class_addMethod(c, NSSelectorFromString(@"copyWithZone:"), imp_implementationWithBlock(^id(id self_, NSZone *z) { (void)z; return self_; }), "@@:^v");
  objc_registerClassPair(c);
  return c;
}

static BOOL pk_make_classes(void) {
  static dispatch_once_t once;
  static BOOL ok = NO;
  dispatch_once(&once, ^{
    Class reg = NSClassFromString(@"ASAuthorizationPlatformPublicKeyCredentialRegistration");
    Class asr = NSClassFromString(@"ASAuthorizationPlatformPublicKeyCredentialAssertion");
    if (!reg || !asr) return;
    NSArray *nilProps = @[@"prf", @"largeBlob", @"__prfSwift", @"__largeBlobSwift", @"coreCredential"];
    g_pk_reg_cred = pk_cred_class("WardenFakePlatformRegistration", reg, @[@"credentialID", @"rawAttestationObject", @"rawClientDataJSON"], nilProps);
    g_pk_asr_cred = pk_cred_class("WardenFakePlatformAssertion", asr, @[@"credentialID", @"rawAuthenticatorData", @"rawClientDataJSON", @"signature", @"userID"], nilProps);
    ok = g_pk_reg_cred != Nil && g_pk_asr_cred != Nil;
  });
  return ok;
}

static id pk_make_cred(Class c, NSDictionary *props) {
  id o = class_createInstance(c, 0);  // no -init: the real inits need a core credential
  objc_setAssociatedObject(o, kPkProps, props, OBJC_ASSOCIATION_RETAIN);
  return o;
}

/** `-[ASAuthorization initWithProvider:credential:]` (not in the public headers), else a runtime subclass answering `credential` / `provider`. */
static id pk_make_authorization(id credential, NSString *rp) {
  Class pc = NSClassFromString(@"ASAuthorizationPlatformPublicKeyCredentialProvider");
  Class ac = NSClassFromString(@"ASAuthorization");
  if (!pc || !ac) return nil;
  id prov = ((id (*)(id, SEL, id))objc_msgSend)([pc alloc], NSSelectorFromString(@"initWithRelyingPartyIdentifier:"), rp);
  SEL init = NSSelectorFromString(@"initWithProvider:credential:");
  if ([ac instancesRespondToSelector:init]) return ((id (*)(id, SEL, id, id))objc_msgSend)([ac alloc], init, prov, credential);
  if (!g_pk_auth_class) {
    Class c = objc_allocateClassPair(ac, "WardenFakeAuthorization", 0);
    if (!c) return nil;
    class_addMethod(c, NSSelectorFromString(@"credential"), imp_implementationWithBlock(^id(id self_) { return objc_getAssociatedObject(self_, kPkProps); }), "@@:");
    class_addMethod(c, NSSelectorFromString(@"provider"), imp_implementationWithBlock(^id(id self_) { return objc_getAssociatedObject(self_, kPkPending); }), "@@:");
    objc_registerClassPair(c);
    g_pk_auth_class = c;
  }
  id auth = class_createInstance(g_pk_auth_class, 0);
  objc_setAssociatedObject(auth, kPkProps, credential, OBJC_ASSOCIATION_RETAIN);
  objc_setAssociatedObject(auth, kPkPending, prov, OBJC_ASSOCIATION_RETAIN);
  return auth;
}

#pragma mark passkeys: completion

/** An error as the real controller delivers it: empty userInfo, except `reason` for "No credentials available for login.". */
static NSError *pk_error(NSInteger code, BOOL noCredentials) {
  NSDictionary *info = noCredentials ? @{
    NSLocalizedFailureReasonErrorKey: @"No credentials available for login.",
    NSLocalizedDescriptionKey: @"The operation couldn’t be completed. No credentials available for login.",
  } : @{};
  return [NSError errorWithDomain:PK_ERR_DOMAIN code:code userInfo:info];
}

/** Call the delegate on the next main-queue turn, exactly one of `auth` / `error`; a -cancel that came first wins (1001). */
static void pk_deliver(id ctl, id auth, NSError *error) {
  objc_setAssociatedObject(ctl, kPkPending, @YES, OBJC_ASSOCIATION_RETAIN);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!objc_getAssociatedObject(ctl, kPkPending)) return;
    objc_setAssociatedObject(ctl, kPkPending, nil, OBJC_ASSOCIATION_RETAIN);
    id a = auth;
    NSError *e = error;
    if (objc_getAssociatedObject(ctl, kPkCancelled)) { a = nil; e = pk_error(1001, NO); }
    id delegate = [ctl respondsToSelector:NSSelectorFromString(@"delegate")] ? [ctl valueForKey:@"delegate"] : nil;
    if (!delegate) return;
    if (a) {
      SEL s = NSSelectorFromString(@"authorizationController:didCompleteWithAuthorization:");
      if ([delegate respondsToSelector:s]) ((void (*)(id, SEL, id, id))objc_msgSend)(delegate, s, ctl, a);
    } else {
      SEL s = NSSelectorFromString(@"authorizationController:didCompleteWithError:");
      if ([delegate respondsToSelector:s]) ((void (*)(id, SEL, id, id))objc_msgSend)(delegate, s, ctl, e);
    }
  });
}

#pragma mark passkeys: the authenticator

typedef NS_ENUM(int, PkVia) { PK_VIA_PERFORM = 0, PK_VIA_OPTIONS = 1, PK_VIA_AUTOFILL = 2 };

static NSData *pk_random(NSUInteger n) {
  NSMutableData *d = [NSMutableData dataWithLength:n];
  arc4random_buf(d.mutableBytes, n);
  return d;
}

static NSData *pk_data_prop(id obj, NSString *key) {
  if (![obj respondsToSelector:NSSelectorFromString(key)]) return nil;
  id v = [obj valueForKey:key];
  return [v isKindOfClass:[NSData class]] ? v : nil;
}

static NSString *pk_string_prop(id obj, NSString *key) {
  if (![obj respondsToSelector:NSSelectorFromString(key)]) return nil;
  id v = [obj valueForKey:key];
  return [v isKindOfClass:[NSString class]] ? v : nil;
}

/** The credential ids of a request's allowed / excluded descriptors, base64url. */
static NSSet<NSString *> *pk_descriptor_ids(id request, NSString *key) {
  NSMutableSet *ids = [NSMutableSet set];
  if (![request respondsToSelector:NSSelectorFromString(key)]) return ids;
  id list = [request valueForKey:key];
  if (![list isKindOfClass:[NSArray class]]) return ids;
  for (id d in list) {
    NSData *cid = pk_data_prop(d, @"credentialID");
    if (cid) [ids addObject:pk_b64u(cid)];
  }
  return ids;
}

/** Answer the platform passkey request `pk` of `ctl`; the mode / uv rules of the plan, errors per the findings. */
static void pk_answer(id ctl, id pk, PkVia via, NSUInteger options, NSString *mode, NSString *uv, NSString *storePath) {
  BOOL autofill = via == PK_VIA_AUTOFILL;
  NSString *rp = pk_string_prop(pk, @"relyingPartyIdentifier");
  BOOL isReg = [pk respondsToSelector:NSSelectorFromString(@"excludedCredentials")];
  if (!rp.length || !pk_make_classes()) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
  if ([mode isEqualToString:@"cancel"]) { if (!autofill) pk_deliver(ctl, nil, pk_error(1001, NO)); return; }
  if ([mode isEqualToString:@"fail"]) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
  if ([mode isEqualToString:@"unavailable"]) {
    if (isReg) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
    if (!autofill) pk_deliver(ctl, nil, pk_error(1001, (options & 1) != 0));
    return;
  }
  if ([uv isEqualToString:@"nomatch"]) { if (!autofill) pk_deliver(ctl, nil, pk_error(1001, NO)); return; }

  NSData *challenge = pk_data_prop(pk, @"challenge");
  if (!challenge) {
    id clientData = [pk respondsToSelector:NSSelectorFromString(@"clientData")] ? [pk valueForKey:@"clientData"] : nil;
    challenge = pk_data_prop(clientData, @"challenge");
  }
  if (!challenge) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
  // {type, challenge, origin}: iOS writes no crossOrigin
  NSData *cdj = [[NSString stringWithFormat:@"{\"type\":\"webauthn.%@\",\"challenge\":\"%@\",\"origin\":\"https://%@\"}", isReg ? @"create" : @"get", pk_b64u(challenge), rp] dataUsingEncoding:NSUTF8StringEncoding];

  NSArray<NSDictionary *> *all = nil;
  if (!storePath.length || !pk_load(storePath, &all)) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }

  if (isReg) {
    NSSet *excluded = pk_descriptor_ids(pk, @"excludedCredentials");
    for (NSDictionary *c in all) {
      if ([excluded containsObject:c[@"credentialId"]] && [c[@"rpId"] isEqual:rp]) { pk_deliver(ctl, nil, pk_error(1006, NO)); return; }
    }
    NSDictionary *attrs = @{ (id)kSecAttrKeyType: (id)kSecAttrKeyTypeECSECPrimeRandom, (id)kSecAttrKeySizeInBits: @256 };
    SecKeyRef priv = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attrs, NULL);
    NSData *raw = priv ? CFBridgingRelease(SecKeyCopyExternalRepresentation(priv, NULL)) : nil;
    if (priv) CFRelease(priv);
    if (raw.length != 97) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
    NSData *pub = [raw subdataWithRange:NSMakeRange(0, 65)];
    NSData *credId = pk_random(16);
    NSData *userId = pk_data_prop(pk, @"userID") ?: [NSData data];
    NSString *name = pk_string_prop(pk, @"name") ?: @"";
    NSString *display = pk_string_prop(pk, @"displayName") ?: name;
    NSDictionary *record = @{
      @"credentialId": pk_b64u(credId), @"rpId": rp, @"userHandle": pk_b64u(userId), @"userName": name, @"displayName": display,
      @"privateKey": pk_b64u(pk_pkcs8(raw)), @"signCount": @0, @"createdAt": @((long long)([NSDate date].timeIntervalSince1970 * 1000)),
      @"backupEligible": @YES, @"backupState": @YES,
    };
    if (!pk_append(storePath, record)) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
    NSMutableData *att = [NSMutableData data];
    pk_cbor_head(att, 5, 3);
    pk_cbor_text(att, @"fmt"); pk_cbor_text(att, @"none");
    pk_cbor_text(att, @"attStmt"); pk_cbor_head(att, 5, 0);
    pk_cbor_text(att, @"authData"); pk_cbor_bytes(att, pk_auth_data(rp, pk_flags(uv, YES, YES, YES), 0, credId, pub));
    id cred = pk_make_cred(g_pk_reg_cred, @{ @"credentialID": credId, @"rawAttestationObject": att, @"rawClientDataJSON": cdj });
    id auth = pk_make_authorization(cred, rp);
    pk_deliver(ctl, auth, auth ? nil : pk_error(1004, NO));
    return;
  }

  NSSet *allowed = pk_descriptor_ids(pk, @"allowedCredentials");
  NSDictionary *pick = nil;
  for (NSDictionary *c in all) {
    if (![c[@"rpId"] isEqual:rp]) continue;
    if (allowed.count && ![allowed containsObject:c[@"credentialId"]]) continue;
    if (!pick || [c[@"createdAt"] longLongValue] > [pick[@"createdAt"] longLongValue]) pick = c;
  }
  if (!pick) { if (!autofill) pk_deliver(ctl, nil, pk_error(1001, (options & 1) != 0)); return; }
  NSData *der = pk_unb64u(pick[@"privateKey"] ?: @"");
  NSData *raw = der ? pk_raw_key(der, NULL) : nil;
  SecKeyRef key = raw ? SecKeyCreateWithData((__bridge CFDataRef)raw, (__bridge CFDictionaryRef)@{ (id)kSecAttrKeyType: (id)kSecAttrKeyTypeECSECPrimeRandom, (id)kSecAttrKeyClass: (id)kSecAttrKeyClassPrivate }, NULL) : NULL;
  if (!key) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
  NSData *authData = pk_auth_data(rp, pk_flags(uv, [pick[@"backupEligible"] boolValue], [pick[@"backupState"] boolValue], NO), (uint32_t)[pick[@"signCount"] unsignedIntValue], nil, nil);
  NSMutableData *signed_ = [authData mutableCopy];
  [signed_ appendData:pk_sha256(cdj)];
  NSData *sig = CFBridgingRelease(SecKeyCreateSignature(key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256, (__bridge CFDataRef)signed_, NULL));
  CFRelease(key);
  NSData *credId = pk_unb64u(pick[@"credentialId"]);
  NSData *userId = pk_unb64u(pick[@"userHandle"] ?: @"") ?: [NSData data];
  if (!sig || !credId) { pk_deliver(ctl, nil, pk_error(1004, NO)); return; }
  id cred = pk_make_cred(g_pk_asr_cred, @{ @"credentialID": credId, @"rawAuthenticatorData": authData, @"rawClientDataJSON": cdj, @"signature": sig, @"userID": userId });
  id auth = pk_make_authorization(cred, rp);
  pk_deliver(ctl, auth, auth ? nil : pk_error(1004, NO));
}

/** Intercept `ctl` iff the authenticator is on and it holds a platform passkey request; YES when it did (the original must not run). */
static BOOL pk_intercept(id ctl, PkVia via, NSUInteger options) {
  NSString *mode, *uv, *store;
  @synchronized(g_pk_lock) {
    if (!g_pk_active) return NO;
    mode = g_pk_mode; uv = g_pk_uv; store = g_pk_store;
  }
  Class regReq = NSClassFromString(@"ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest");
  Class asrReq = NSClassFromString(@"ASAuthorizationPlatformPublicKeyCredentialAssertionRequest");
  if (!regReq || !asrReq || ![ctl respondsToSelector:NSSelectorFromString(@"authorizationRequests")]) return NO;
  id requests = [ctl valueForKey:@"authorizationRequests"];
  if (![requests isKindOfClass:[NSArray class]]) return NO;
  id pk = nil;
  for (id r in requests) {
    if ([r isKindOfClass:regReq] || [r isKindOfClass:asrReq]) { pk = r; break; }
  }
  if (!pk) return NO;
  DLOG("passkeys: intercepting %s mode=%s uv=%s", NSStringFromClass([pk class]).UTF8String, mode.UTF8String, uv.UTF8String);
  pk_answer(ctl, pk, via, options, mode, uv, store);
  return YES;
}

static IMP g_pk_o_perform, g_pk_o_options, g_pk_o_autofill, g_pk_o_cancel;

static void pk_install(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    g_pk_lock = [NSObject new];
    dlopen("/System/Library/Frameworks/AuthenticationServices.framework/AuthenticationServices", RTLD_NOW);
    Class c = NSClassFromString(@"ASAuthorizationController");
    if (!c) { DLOG("passkeys: no ASAuthorizationController"); return; }
    Method perform = class_getInstanceMethod(c, NSSelectorFromString(@"performRequests"));
    Method options = class_getInstanceMethod(c, NSSelectorFromString(@"performRequestsWithOptions:"));
    Method autofill = class_getInstanceMethod(c, NSSelectorFromString(@"performAutoFillAssistedRequests"));
    Method cancel = class_getInstanceMethod(c, NSSelectorFromString(@"cancel"));
    if (perform) {
      g_pk_o_perform = method_setImplementation(perform, imp_implementationWithBlock(^void(id self_) {
        if (!pk_intercept(self_, PK_VIA_PERFORM, 0)) ((void (*)(id, SEL))g_pk_o_perform)(self_, NSSelectorFromString(@"performRequests"));
      }));
    }
    if (options) {
      g_pk_o_options = method_setImplementation(options, imp_implementationWithBlock(^void(id self_, NSUInteger o) {
        if (!pk_intercept(self_, PK_VIA_OPTIONS, o)) ((void (*)(id, SEL, NSUInteger))g_pk_o_options)(self_, NSSelectorFromString(@"performRequestsWithOptions:"), o);
      }));
    }
    if (autofill) {
      g_pk_o_autofill = method_setImplementation(autofill, imp_implementationWithBlock(^void(id self_) {
        if (!pk_intercept(self_, PK_VIA_AUTOFILL, 0)) ((void (*)(id, SEL))g_pk_o_autofill)(self_, NSSelectorFromString(@"performAutoFillAssistedRequests"));
      }));
    }
    if (cancel) {
      g_pk_o_cancel = method_setImplementation(cancel, imp_implementationWithBlock(^void(id self_) {
        if (objc_getAssociatedObject(self_, kPkPending)) objc_setAssociatedObject(self_, kPkCancelled, @YES, OBJC_ASSOCIATION_RETAIN);
        ((void (*)(id, SEL))g_pk_o_cancel)(self_, NSSelectorFromString(@"cancel"));
      }));
    }
    DLOG("passkeys: installed");
  });
}

/** Apply the state file's `passkeys` object; anything else (absent, malformed) turns the authenticator off. */
static void pk_apply(id passkeys) {
  if (!g_passkeys_enabled) return;
  NSDictionary *d = [passkeys isKindOfClass:[NSDictionary class]] ? passkeys : nil;
  NSString *store = [d[@"storePath"] isKindOfClass:[NSString class]] ? d[@"storePath"] : nil;
  NSString *mode = [d[@"mode"] isKindOfClass:[NSString class]] ? d[@"mode"] : @"auto";
  NSString *uv = [d[@"uv"] isKindOfClass:[NSString class]] ? d[@"uv"] : @"match";
  if (![@[@"auto", @"cancel", @"fail", @"unavailable"] containsObject:mode]) mode = @"auto";
  if (![@[@"match", @"nomatch", @"skip"] containsObject:uv]) uv = @"match";
  @synchronized(g_pk_lock) {
    g_pk_active = d != nil && store.length > 0;
    g_pk_mode = mode; g_pk_uv = uv; g_pk_store = [store copy];
  }
  DLOG("passkeys: %s mode=%s uv=%s", g_pk_active ? "on" : "off", mode.UTF8String, uv.UTF8String);
}

#pragma mark - keychain acl
// The simulator ignores `SecAccessControl` on Keychain items: a read of an item behind `.biometryCurrentSet` or
// `.devicePasscode` answers 0 with the data, no prompt, also with `interactionNotAllowed` and after Face ID was
// unenrolled; `evaluateAccessControl` fails with LAError -1020 ("not supported on iOS Simulator"). With
// WARDEN_KEYCHAIN_ACL=1 a data read of an access-controlled item runs the item's policy through `-[LAContext
// evaluatePolicy:localizedReason:reply:]` first (the real Face ID / passcode sheet, driven by `warden ui biometrics`)
// and answers the OSStatus a device is expected to give. It emulates the prompt and the codes; it proves nothing about
// real enforcement, which only a device has (WDN-KACL).
//
// ACL text (`CFCopyDescription`, private; identical on the iOS 27.2 simulator and macOS 26; re-verify per iOS release):
//   .biometryCurrentSet                  od(cbio(pbioc()pbioh()))
//   .biometryAny                         od(cbio(pbioc()))
//   .devicePasscode                      od(cup(true))
//   .userPresence                        od(cpo(DeviceOwnerAuthentication))
//   .biometryCurrentSet .or .passcode    od(pkofn(1)cup(true)cbio(pbioc()pbioh()))
//   .biometryAny .or .passcode           od(pkofn(1)cup(true)cbio(pbioc()))
//   .biometryCurrentSet .and .passcode   od(pkofn(2)cup(true)cbio(pbioc()pbioh()))   -> unknown, untouched
//   .applicationPassword                 prp(true);dacl(true)                         -> unknown, untouched
//   .privateKeyUsage                     ock(true);osgn(true);…                       -> unknown, untouched
//   no flags                             dacl(true)                                   -> unknown, untouched
// Tokens are matched by prefix (`pbioh(`, not `pbioh()`): an item read back may carry its hashes. Anything not in this
// table leaves the read untouched (never block an app on a parse failure).
//
// Read gate (`kacl_copy_matching`, a data read only: `kSecReturnData`): probe the match's attributes (no data, no
// context, no prompt), and for a known ACL:
//   kSecUseAuthenticationUIFail or ctx.interactionNotAllowed (and ctx not evaluated)  -> -25308 errSecInteractionNotAllowed
//   kSecUseAuthenticationUISkip                                                       -> -25300 errSecItemNotFound
//   biometry only and canEvaluatePolicy(biometrics) fails (-5/-6/-7, -8 lockout too)  -> -25300 errSecItemNotFound
//   ctx already evaluated (by the app or an earlier read) a policy that covers the item -> the read, no prompt
//   evaluatePolicy: ok -> the read; -2/-4/-9 cancel -> -128 errSecUserCanceled; anything else -> -25293 errSecAuthFailed
// Policy: biometry only -> .deviceOwnerAuthenticationWithBiometrics (1); a passcode path, or .userPresence -> .deviceOwnerAuthentication (2).
//
// Enrolment generation (`warden ui biometrics reenroll` bumps the state's `keychainAcl.generation`): the interposed
// `SecItemAdd` of an item with `kSecAttrAccessControl` records `sha256(class|service|account|accessGroup|server|sync)
// -> generation` in the sidecar at `keychainAcl.itemsPath` (`{"<hex>": n}`, atomic write; the dylib is its only
// writer). The key comes from the item's attributes as the Keychain hands them back (a read-back after the add, the
// probe on a read), so system-assigned `agrp` / `sync` match. A duplicate add leaves the record; no record = 0. A
// `.biometryCurrentSet` item recorded below the current generation reads like a device whose Face ID set changed:
//   no passcode path                     -> -25300 errSecItemNotFound, no prompt
//   a passcode path (`.or .devicePasscode`) -> .deviceOwnerAuthentication (2) only, an evaluated context does not count
// `.biometryAny` and passcode-only items ignore the generation.
// Not covered: SecItemUpdate / SecItemDelete on ACL items, SecKey operations, evaluateAccessControl.
#define KACL_POLICY_BIO 1
#define KACL_POLICY_OWNER 2

static BOOL g_kacl_enabled = NO;   // launched with WARDEN_KEYCHAIN_ACL=1 (interposed, swizzled)
static _Atomic int g_kacl_active = 1; // the state file's `keychainAcl.enabled` (a state without the key keeps it)
static IMP g_kacl_orig_eval = NULL;
static IMP g_kacl_orig_can = NULL;
static Class g_kacl_context_class = Nil;
static const void *kKaclEvaluated = &kKaclEvaluated;
static _Thread_local int g_kacl_depth = 0;
static _Atomic long g_kacl_generation = 0;     // the state's `keychainAcl.generation`
static NSString *g_kacl_items_path = nil;      // the state's `keychainAcl.itemsPath` (under g_kacl_lock)
static os_unfair_lock g_kacl_lock = OS_UNFAIR_LOCK_INIT;  // the path and the sidecar's read-modify-write

typedef OSStatus (*KaclCopyFn)(CFDictionaryRef, CFTypeRef *);
typedef OSStatus (*KaclAddFn)(CFDictionaryRef, CFTypeRef *);
typedef void (*KaclEvalFn)(id ctx, NSInteger policy, NSString *reason, void (^reply)(BOOL, NSError *));
typedef NSInteger (*KaclCanEvalFn)(id ctx, NSInteger policy);

static void kacl_eval_real(id ctx, NSInteger policy, NSString *reason, void (^reply)(BOOL, NSError *)) {
  ((void (*)(id, SEL, NSInteger, NSString *, void (^)(BOOL, NSError *)))g_kacl_orig_eval)(ctx, NSSelectorFromString(@"evaluatePolicy:localizedReason:reply:"), policy, reason, reply);
}
static NSInteger kacl_can_real(id ctx, NSInteger policy) {
  NSError *error = nil;
  BOOL ok = ((BOOL (*)(id, SEL, NSInteger, NSError **))g_kacl_orig_can)(ctx, NSSelectorFromString(@"canEvaluatePolicy:error:"), policy, &error);
  return ok ? 0 : (error ? error.code : -1);
}

static KaclCopyFn g_kacl_copy = SecItemCopyMatching;
static KaclAddFn g_kacl_add = SecItemAdd;
static KaclEvalFn g_kacl_eval = kacl_eval_real;
static KaclCanEvalFn g_kacl_can = kacl_can_real;

typedef enum { KACL_BIO_NONE = 0, KACL_BIO_ANY = 1, KACL_BIO_CURRENT_SET = 2 } KaclBiometry;
typedef struct {
  BOOL known;
  KaclBiometry biometry;
  BOOL passcode;
  BOOL presence;
} KaclAcl;

/** The balanced `name(…)` argument at `s[*at]` (which must be `(`); advances `*at` past the closing paren. nil when unbalanced. */
static NSString *kacl_group(NSString *s, NSUInteger *at) {
  if (*at >= s.length || [s characterAtIndex:*at] != '(') return nil;
  NSUInteger depth = 0, start = *at + 1;
  for (NSUInteger i = *at; i < s.length; i++) {
    unichar c = [s characterAtIndex:i];
    if (c == '(') depth++;
    else if (c == ')' && --depth == 0) {
      *at = i + 1;
      return [s substringWithRange:NSMakeRange(start, i - start)];
    }
  }
  return nil;
}

/** Pure: the access control a `CFCopyDescription(SecAccessControlRef)` text describes (table above). */
static KaclAcl kacl_parse(NSString *desc) {
  KaclAcl acl = { NO, KACL_BIO_NONE, NO, NO };
  NSRange od = [desc rangeOfString:@"od("];
  if (od.location == NSNotFound) return acl;
  NSUInteger at = od.location + 2;
  NSString *body = kacl_group(desc, &at);
  if (!body) return acl;
  NSUInteger i = 0, constraints = 0;
  long kofn = 1;
  while (i < body.length) {
    NSUInteger open = [body rangeOfString:@"(" options:0 range:NSMakeRange(i, body.length - i)].location;
    if (open == NSNotFound) return acl;
    NSString *name = [body substringWithRange:NSMakeRange(i, open - i)];
    NSUInteger next = open;
    NSString *arg = kacl_group(body, &next);
    if (!arg) return acl;
    if ([name isEqualToString:@"pkofn"]) {
      kofn = arg.integerValue;
    } else if ([name isEqualToString:@"cup"]) {
      acl.passcode = YES; constraints++;
    } else if ([name isEqualToString:@"cpo"]) {
      if (![arg isEqualToString:@"DeviceOwnerAuthentication"]) return acl;
      acl.presence = YES; constraints++;
    } else if ([name isEqualToString:@"cbio"]) {
      if (![arg hasPrefix:@"pbioc("]) return acl;
      acl.biometry = [arg containsString:@"pbioh("] ? KACL_BIO_CURRENT_SET : KACL_BIO_ANY;
      constraints++;
    } else {
      return acl;  // a constraint this table does not know
    }
    i = next;
  }
  // `.and` (k of n with k > 1) needs every factor at once, which no LAPolicy expresses
  if (constraints == 0 || (constraints > 1 && kofn != 1)) return acl;
  acl.known = YES;
  return acl;
}

static NSInteger kacl_policy(KaclAcl acl) {
  return (acl.passcode || acl.presence) ? KACL_POLICY_OWNER : KACL_POLICY_BIO;
}

/** Whether `evaluated` (the policy a context evaluated successfully) covers an item that needs `policy`. */
static BOOL kacl_covers(NSNumber *evaluated, NSInteger policy) {
  if (!evaluated) return NO;
  return policy == KACL_POLICY_OWNER || evaluated.integerValue == KACL_POLICY_BIO;
}

static void kacl_eval_swizzled(id self_, SEL _cmd, NSInteger policy, NSString *reason, void (^reply)(BOOL, NSError *)) {
  g_kacl_eval(self_, policy, reason, ^(BOOL ok, NSError *error) {
    if (ok) objc_setAssociatedObject(self_, kKaclEvaluated, @(policy), OBJC_ASSOCIATION_RETAIN);
    if (reply) reply(ok, error);
  });
}

/** Run `policy` on `ctx` (through the swizzle, so a success is remembered) and wait: 0 = ok, else the LAError code. */
static NSInteger kacl_evaluate(id ctx, NSInteger policy, NSString *reason) {
  __block NSInteger code = -1;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  ((void (*)(id, SEL, NSInteger, NSString *, void (^)(BOOL, NSError *)))objc_msgSend)(
    ctx, NSSelectorFromString(@"evaluatePolicy:localizedReason:reply:"), policy, reason, ^(BOOL ok, NSError *error) {
      code = ok ? 0 : (error ? error.code : -1);
      dispatch_semaphore_signal(done);
    });
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  return code;
}

static OSStatus kacl_status_for(NSInteger code) {
  switch (code) {
    case 0: return errSecSuccess;
    case -2: case -4: case -9: return errSecUserCanceled;  // userCancel, systemCancel, appCancel
    default: return errSecAuthFailed;                      // -1 failed, -3 fallback, -8 lockout, unknown (-1020)
  }
}

/** The first access-controlled match the probe found, as a known ACL (its attributes in `*matched`); `known` NO when there is none to gate. */
static KaclAcl kacl_probe(NSDictionary *query, NSDictionary **matched) {
  KaclAcl none = { NO, KACL_BIO_NONE, NO, NO };
  NSMutableDictionary *probe = [query mutableCopy];
  for (id key in @[ (id)kSecReturnData, (id)kSecReturnRef, (id)kSecReturnPersistentRef, (id)kSecUseAuthenticationContext,
                    (id)kSecUseOperationPrompt, (id)kSecUseAuthenticationUI ]) {
    [probe removeObjectForKey:key];
  }
  BOOL all = [query[(id)kSecMatchLimit] isEqual:(id)kSecMatchLimitAll];
  probe[(id)kSecReturnAttributes] = @YES;
  probe[(id)kSecMatchLimit] = all ? (id)kSecMatchLimitAll : (id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  if (g_kacl_copy((__bridge CFDictionaryRef)probe, &found) != errSecSuccess || !found) return none;
  id attrs = (__bridge_transfer id)found;
  NSArray *matches = [attrs isKindOfClass:[NSArray class]] ? attrs : @[ attrs ];
  for (id match in matches) {
    if (![match isKindOfClass:[NSDictionary class]]) continue;
    id ac = match[(id)kSecAttrAccessControl];
    if (!ac) continue;
    NSString *desc = (__bridge_transfer NSString *)CFCopyDescription((__bridge CFTypeRef)ac);
    KaclAcl acl = kacl_parse(desc);
    DLOG("keychain acl: item acl %s known=%d bio=%d passcode=%d presence=%d", desc.UTF8String, acl.known, acl.biometry, acl.passcode, acl.presence);
    if (acl.known) {
      *matched = match;
      return acl;
    }
  }
  return none;
}

/** The sidecar key of an item: sha256 over its identifying attributes as the Keychain hands them back. */
static NSString *kacl_item_key(NSDictionary *attrs) {
  NSMutableArray *parts = [NSMutableArray array];
  for (id key in @[ (id)kSecClass, (id)kSecAttrService, (id)kSecAttrAccount, (id)kSecAttrAccessGroup, (id)kSecAttrServer,
                    (id)kSecAttrSynchronizable ]) {
    id v = attrs[key];
    [parts addObject:v ? [v description] : @""];
  }
  NSData *bytes = [[parts componentsJoinedByString:@"|"] dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

/** The sidecar at `path` (call under g_kacl_lock); missing or unreadable = empty. */
static NSMutableDictionary *kacl_read_records(NSString *path) {
  NSData *data = path ? [NSData dataWithContentsOfFile:path] : nil;
  id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [json isKindOfClass:[NSDictionary class]] ? [json mutableCopy] : [NSMutableDictionary dictionary];
}

/** The generation item `attrs` was recorded at; no sidecar or no record = 0. */
static long kacl_recorded_generation(NSDictionary *attrs) {
  os_unfair_lock_lock(&g_kacl_lock);
  NSString *path = g_kacl_items_path;
  id value = path ? kacl_read_records(path)[kacl_item_key(attrs)] : nil;
  os_unfair_lock_unlock(&g_kacl_lock);
  return [value respondsToSelector:@selector(longValue)] ? [value longValue] : 0;
}

/** A `.biometryCurrentSet` item from before the latest re-enrolment. */
static BOOL kacl_invalidated(KaclAcl acl, NSDictionary *attrs) {
  if (acl.biometry != KACL_BIO_CURRENT_SET) return NO;
  long current = atomic_load(&g_kacl_generation);
  return current > 0 && kacl_recorded_generation(attrs) < current;
}

/** Record the item the app just added (read back for its stored attributes) at the current generation. */
static void kacl_record_add(NSDictionary *added) {
  NSMutableDictionary *lookup = [NSMutableDictionary dictionary];
  for (id key in @[ (id)kSecClass, (id)kSecAttrService, (id)kSecAttrAccount, (id)kSecAttrAccessGroup, (id)kSecAttrServer,
                    (id)kSecAttrSynchronizable ]) {
    if (added[key]) lookup[key] = added[key];
  }
  if (!lookup[(id)kSecAttrSynchronizable]) lookup[(id)kSecAttrSynchronizable] = (id)kSecAttrSynchronizableAny;
  lookup[(id)kSecReturnAttributes] = @YES;
  lookup[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  id stored = g_kacl_copy((__bridge CFDictionaryRef)lookup, &found) == errSecSuccess && found ? (__bridge_transfer id)found : nil;
  NSDictionary *attrs = [stored isKindOfClass:[NSDictionary class]] ? stored : added;
  NSString *key = kacl_item_key(attrs);
  long generation = atomic_load(&g_kacl_generation);
  os_unfair_lock_lock(&g_kacl_lock);
  NSString *path = g_kacl_items_path;
  if (path) {
    NSMutableDictionary *records = kacl_read_records(path);
    records[key] = @(generation);
    NSData *json = [NSJSONSerialization dataWithJSONObject:records options:0 error:nil];
    // atomically: a temp file in the same directory, then rename (a reader never sees half a file)
    if (![json writeToFile:path atomically:YES]) DLOG("keychain acl: cannot write %s", path.UTF8String);
  }
  os_unfair_lock_unlock(&g_kacl_lock);
  DLOG("keychain acl: recorded item %s at generation %ld", key.UTF8String, generation);
}

static OSStatus kacl_gate(NSDictionary *q, CFDictionaryRef query, CFTypeRef *result) {
  NSDictionary *matched = nil;
  KaclAcl acl = kacl_probe(q, &matched);
  if (!acl.known) return g_kacl_copy(query, result);
  NSInteger policy = kacl_policy(acl);
  BOOL invalidated = kacl_invalidated(acl, matched);
  if (invalidated) {
    BOOL passcodePath = acl.passcode || acl.presence;
    DLOG("keychain acl: .biometryCurrentSet item from before a re-enrolment (%s)", passcodePath ? "passcode only" : "gone");
    if (!passcodePath) return errSecItemNotFound;
    policy = KACL_POLICY_OWNER;
  }
  id ui = q[(id)kSecUseAuthenticationUI];
  if ([ui isEqual:(id)kSecUseAuthenticationUISkip]) return errSecItemNotFound;
  id given = q[(id)kSecUseAuthenticationContext];
  id ctx = [given isKindOfClass:g_kacl_context_class] ? given : [g_kacl_context_class new];
  if (policy == KACL_POLICY_BIO) {
    NSInteger can = g_kacl_can(ctx, KACL_POLICY_BIO);
    if (can != 0) {
      DLOG("keychain acl: biometry-only item, biometry unusable (%ld)", (long)can);
      return errSecItemNotFound;
    }
  }
  // an invalidated item wants the passcode now: an evaluation the app made (with the new Face ID) does not unlock it
  if (!invalidated && kacl_covers(objc_getAssociatedObject(ctx, kKaclEvaluated), policy)) return g_kacl_copy(query, result);
  BOOL noUI = [ui isEqual:(id)kSecUseAuthenticationUIFail] ||
              ((BOOL (*)(id, SEL))objc_msgSend)(ctx, NSSelectorFromString(@"interactionNotAllowed"));
  if (noUI) return errSecInteractionNotAllowed;
  NSString *reason = [q[(id)kSecUseOperationPrompt] isKindOfClass:[NSString class]] ? q[(id)kSecUseOperationPrompt] : nil;
  if (!reason.length) {
    NSString *own = ((NSString * (*)(id, SEL))objc_msgSend)(ctx, NSSelectorFromString(@"localizedReason"));
    reason = own.length ? own : @"Authenticate to access this item";
  }
  NSInteger code = kacl_evaluate(ctx, policy, reason);
  DLOG("keychain acl: policy %ld -> %ld", (long)policy, (long)code);
  return code == 0 ? g_kacl_copy(query, result) : kacl_status_for(code);
}

static OSStatus kacl_copy_matching(CFDictionaryRef query, CFTypeRef *result) {
  // off (and a Keychain call made from inside the gate) is the real function: no hook, no ObjC, no allocation
  if (!g_kacl_enabled || !atomic_load(&g_kacl_active) || g_kacl_depth > 0 || !query) return SecItemCopyMatching(query, result);
  NSDictionary *q = (__bridge NSDictionary *)query;
  if (![q[(id)kSecReturnData] respondsToSelector:@selector(boolValue)] || ![q[(id)kSecReturnData] boolValue]) {
    return g_kacl_copy(query, result);
  }
  g_kacl_depth++;
  OSStatus status;
  @autoreleasepool { status = kacl_gate(q, query, result); }
  g_kacl_depth--;
  return status;
}
INTERPOSE(kacl_copy_matching, SecItemCopyMatching);

static OSStatus kacl_add(CFDictionaryRef attributes, CFTypeRef *result) {
  // off (and an add made from inside the shim) is the real function: no hook, no ObjC, no allocation
  if (!g_kacl_enabled || !atomic_load(&g_kacl_active) || g_kacl_depth > 0 || !attributes) return SecItemAdd(attributes, result);
  NSDictionary *a = (__bridge NSDictionary *)attributes;
  OSStatus status = g_kacl_add(attributes, result);
  if (status != errSecSuccess || !a[(id)kSecAttrAccessControl]) return status;
  g_kacl_depth++;
  @autoreleasepool { kacl_record_add(a); }
  g_kacl_depth--;
  return status;
}
INTERPOSE(kacl_add, SecItemAdd);

static void kacl_install(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    dlopen("/System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication", RTLD_NOW);
    Class c = NSClassFromString(@"LAContext");
    Method eval = c ? class_getInstanceMethod(c, NSSelectorFromString(@"evaluatePolicy:localizedReason:reply:")) : NULL;
    Method can = c ? class_getInstanceMethod(c, NSSelectorFromString(@"canEvaluatePolicy:error:")) : NULL;
    if (!eval || !can) { DLOG("keychain acl: no LAContext, off"); return; }
    g_kacl_context_class = c;
    g_kacl_orig_can = method_getImplementation(can);
    g_kacl_orig_eval = method_setImplementation(eval, (IMP)kacl_eval_swizzled);
    g_kacl_enabled = YES;
    DLOG("keychain acl: installed");
  });
}

/** Apply the state file's `keychainAcl` (`{enabled, generation, itemsPath}`); absent or malformed keeps what was. */
static void kacl_apply(id value) {
  if (!g_kacl_enabled || ![value isKindOfClass:[NSDictionary class]]) return;
  NSDictionary *d = value;
  if ([d[@"enabled"] respondsToSelector:@selector(boolValue)]) atomic_store(&g_kacl_active, [d[@"enabled"] boolValue] ? 1 : 0);
  long generation = [d[@"generation"] respondsToSelector:@selector(longValue)] ? [d[@"generation"] longValue] : 0;
  atomic_store(&g_kacl_generation, generation > 0 ? generation : 0);
  NSString *path = [d[@"itemsPath"] isKindOfClass:[NSString class]] && [d[@"itemsPath"] length] ? [d[@"itemsPath"] copy] : nil;
  os_unfair_lock_lock(&g_kacl_lock);
  g_kacl_items_path = path;
  os_unfair_lock_unlock(&g_kacl_lock);
  DLOG("keychain acl: %s, generation %ld", atomic_load(&g_kacl_active) ? "on" : "off", atomic_load(&g_kacl_generation));
}

#ifdef WARDEN_INJECT_TEST_HOOKS
// Host (macOS) build only: the harness swaps the Keychain and the policy evaluation for fakes (a Mac cannot hold an
// access-controlled item without entitlements, and a test must never show a real dialog). NULL keeps the real one.
__attribute__((visibility("default"))) void warden_inject_kacl_test_hooks(KaclCopyFn copy, KaclAddFn add, KaclEvalFn eval, KaclCanEvalFn can) {
  g_kacl_copy = copy ?: SecItemCopyMatching;
  g_kacl_add = add ?: SecItemAdd;
  g_kacl_eval = eval ?: kacl_eval_real;
  g_kacl_can = can ?: kacl_can_real;
}

/** The parse of `desc` as JSON (`{known,biometry,passcode,presence}`), for the harness's parser table. */
__attribute__((visibility("default"))) NSString *warden_inject_kacl_parse(NSString *desc) {
  KaclAcl acl = kacl_parse(desc);
  NSString *bio = acl.biometry == KACL_BIO_CURRENT_SET ? @"currentSet" : acl.biometry == KACL_BIO_ANY ? @"any" : @"none";
  return [NSString stringWithFormat:@"{\"known\":%s,\"biometry\":\"%@\",\"passcode\":%s,\"presence\":%s}", acl.known ? "true" : "false", bio, acl.passcode ? "true" : "false", acl.presence ? "true" : "false"];
}
#endif

#pragma mark - control channel

static void write_ack(long long seq) {
  NSString *ack = [g_state_path stringByAppendingString:@".ack"];
  NSString *bundle = [[NSBundle mainBundle] bundleIdentifier] ?: @"";  // reverse-DNS: nothing to escape
  NSString *body = [NSString stringWithFormat:@"{\"seq\":%lld,\"pid\":%d,\"proxy\":%s,\"camera\":%s,\"passkeys\":%s,\"keychainAcl\":%s,\"bundle\":\"%@\"}", seq, getpid(), g_proxy_dict ? "true" : "false", g_camera_enabled ? "true" : "false", g_passkeys_enabled ? "true" : "false", g_kacl_enabled ? "true" : "false", bundle];
  [body writeToFile:ack atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

#if TARGET_OS_IOS
// 0 = unset (iOS decides: the original answer), 1 = software (never minimised), 2 = hardware (always minimised). Hardware
// must not depend on whether iOS has seen a HID keyboard event in this process, so it forces YES instead of asking.
static _Atomic int g_keyboard_mode = 0;

static void keyboard_install_swizzle(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class c = NSClassFromString(@"UIKeyboardImpl");
    SEL sel = NSSelectorFromString(@"isMinimized");
    Method m = c ? class_getInstanceMethod(c, sel) : NULL;
    if (!m) return;
    BOOL (*orig)(id, SEL) = (void *)method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^BOOL(id self_) {
      int mode = atomic_load(&g_keyboard_mode);
      if (mode == 1) return NO;
      if (mode == 2) return YES;
      return orig(self_, sel);
    }));
  });
}

static void keyboard_apply(NSString *mode) {
  int next = [mode isEqualToString:@"software"] ? 1 : ([mode isEqualToString:@"hardware"] ? 2 : 0);
  int was = atomic_exchange(&g_keyboard_mode, next);
  keyboard_install_swizzle();
  DLOG("keyboard=%s (was %d)", mode.UTF8String, was);
  if (was == next) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIApplication.sharedApplication sendAction:NSSelectorFromString(@"reloadInputViews") to:nil from:nil forEvent:nil];
  });
}

// `"dismissKeyboard":true` (one-shot): resign the first responder on the main thread. Unlike Return it cannot
// trigger onSubmitEditing, so a spec dismissing a covering keyboard never submits a form.
static void keyboard_dismiss(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIApplication.sharedApplication sendAction:@selector(resignFirstResponder) to:nil from:nil forEvent:nil];
    DLOG("keyboard dismissed");
  });
}
#endif

static void apply_state_file(void) {
  NSData *data = [NSData dataWithContentsOfFile:g_state_path];
  if (!data) return;
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) return;
  NSDictionary *state = json;
  long long seq = [state[@"seq"] respondsToSelector:@selector(longLongValue)] ? [state[@"seq"] longLongValue] : 0;
  if (seq == atomic_load(&g_applied_seq)) return;
  int wasOffline = atomic_load(&g_offline);
  int offline = [state[@"offline"] respondsToSelector:@selector(boolValue)] ? [state[@"offline"] boolValue] : 0;
  long long off = [state[@"clockOffsetMs"] respondsToSelector:@selector(longLongValue)] ? [state[@"clockOffsetMs"] longLongValue] : 0;
  atomic_store(&g_offline, offline);
  atomic_store(&g_clock_offset_ms, off);
  BOOL frozen = [state[@"clockFrozenMs"] respondsToSelector:@selector(longLongValue)];
  if (frozen) atomic_store(&g_clock_frozen_ms, [state[@"clockFrozenMs"] longLongValue]);
  atomic_store(&g_clock_frozen, frozen ? 1 : 0);
  atomic_store(&g_applied_seq, seq);
#if TARGET_OS_IOS
  if ([state[@"keyboard"] isKindOfClass:[NSString class]]) keyboard_apply(state[@"keyboard"]);
  if ([state[@"dismissKeyboard"] respondsToSelector:@selector(boolValue)] && [state[@"dismissKeyboard"] boolValue]) keyboard_dismiss();
#endif
  if (g_camera_enabled) camera_apply([state[@"camera"] isKindOfClass:[NSDictionary class]] ? state[@"camera"] : @{});
  pk_apply(state[@"passkeys"]);
  kacl_apply(state[@"keychainAcl"]);
  if ([state[@"a11yRead"] respondsToSelector:@selector(boolValue)] && [state[@"a11yRead"] boolValue]) write_a11y(seq);
  DLOG("state seq=%lld offline=%d clockOffsetMs=%lld frozen=%d", seq, offline, off, frozen);
  if (wasOffline != offline) notify_connectivity_changed();
  write_ack(seq);
}

static void watch_state(void) {
  NSString *dir = [g_state_path stringByDeletingLastPathComponent];
  int fd = open(dir.fileSystemRepresentation, O_EVTONLY);
  if (fd < 0) return;
  dispatch_queue_t q = dispatch_queue_create("nz.co.delacour.warden.inject", DISPATCH_QUEUE_SERIAL);
  dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd,
    DISPATCH_VNODE_WRITE | DISPATCH_VNODE_EXTEND | DISPATCH_VNODE_RENAME | DISPATCH_VNODE_LINK, q);
  dispatch_source_set_event_handler(src, ^{ apply_state_file(); });
  dispatch_source_set_cancel_handler(src, ^{ close(fd); });
  dispatch_resume(src);
  g_state_source = src;
  dispatch_async(q, ^{ apply_state_file(); });
}

__attribute__((constructor)) static void warden_inject_init(void) {
  @autoreleasepool {
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    g_debug = [env[@"WARDEN_INJECT_DEBUG"] isEqualToString:@"1"];
    g_lock = [NSObject new];
    g_monitors = [NSMutableArray array];
    g_reach = [NSMutableArray array];
    NSString *initial = env[@"WARDEN_CLOCK_OFFSET_MS"];
    if (initial) atomic_store(&g_clock_offset_ms, initial.longLongValue);
    NSString *frozen = env[@"WARDEN_CLOCK_FROZEN_MS"];
    if (frozen) {
      atomic_store(&g_clock_frozen_ms, frozen.longLongValue);
      atomic_store(&g_clock_frozen, 1);
    }
    NSString *proxy = env[@"WARDEN_NET_PROXY"];
    if (proxy.length) install_proxy(proxy);
#if TARGET_OS_IOS
    if ([env[@"WARDEN_KEYBOARD"] isEqualToString:@"software"] || [env[@"WARDEN_KEYBOARD"] isEqualToString:@"hardware"]) {
      atomic_store(&g_keyboard_mode, [env[@"WARDEN_KEYBOARD"] isEqualToString:@"software"] ? 1 : 2);
      keyboard_install_swizzle();
    }
#endif
    NSString *state = env[@"WARDEN_INJECT_STATE"];
    if ([env[@"WARDEN_CAMERA"] isEqualToString:@"1"]) {
      g_camera_enabled = YES;
      camera_install();
    }
    if ([env[@"WARDEN_PASSKEYS"] isEqualToString:@"1"]) {
      g_passkeys_enabled = YES;
      pk_install();
    }
    if ([env[@"WARDEN_KEYCHAIN_ACL"] isEqualToString:@"1"]) kacl_install();
    if (state.length) {
      g_state_path = [state copy];
      // the camera must have its feeds, and the authenticator its mode, before the app's first look: apply the staged state now
      if (g_camera_enabled || g_passkeys_enabled || g_kacl_enabled) apply_state_file();
      watch_state();
    }
    DLOG("loaded in pid %d", getpid());
  }
}
