// libwarden-inject: injected into an iOS-simulator app by `DYLD_INSERT_LIBRARIES` (SIMCTL_CHILD_*), only when a
// network or clock condition is active for the lease. Without the env below it is never loaded, so a run with no
// condition pays nothing.
//
// Env (set by warden at launch):
//   WARDEN_NET_PROXY=127.0.0.1:<port>   route NSURLSession HTTP+HTTPS through the lease's shaping proxy
//   WARDEN_INJECT_STATE=<file>          control file, watched live: {"seq":n,"offline":bool,"clockOffsetMs":n,"clockFrozenMs":n?}
//   WARDEN_CLOCK_OFFSET_MS=<n>          initial wall-clock offset (the state file overrides it)
//   WARDEN_CLOCK_FROZEN_MS=<n>          initial frozen wall time, ms since the epoch (the state file overrides it)
//   WARDEN_INJECT_DEBUG=1               log to stderr
//
// Control channel: the simulator shares the host filesystem, so the channel is a file. The host replaces
// `WARDEN_INJECT_STATE` atomically (write + rename); a vnode watch on its directory fires, the new state is applied
// and `<file>.ack` is written with `{"seq":n,"pid":p,"proxy":bool}` (`proxy`: launched with WARDEN_NET_PROXY). No sockets, no polling, nothing running while idle.
//
// Covered: NSURLSession (default/ephemeral/background configurations and sessionWithConfiguration:*), network path
// APIs (nw_path_get_status, nw_path_uses_interface_type, NWPathMonitor update handlers re-fired on change),
// SCNetworkReachability (flags, callbacks re-fired on change), wall clocks (clock_gettime(CLOCK_REALTIME),
// gettimeofday, time, CFAbsoluteTimeGetCurrent), shifted by an offset or held at a fixed instant (`clockFrozenMs`). NSURLSession.sharedSession is replaced by a session on the routed
// default configuration (sharing the shared session's cache, cookie and credential stores). Not covered: raw sockets / NWConnection / CFStream (they bypass the proxy), monotonic clocks (left real on purpose).
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <objc/runtime.h>
#import <stdatomic.h>
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

#pragma mark - control channel

static void write_ack(long long seq) {
  NSString *ack = [g_state_path stringByAppendingString:@".ack"];
  NSString *body = [NSString stringWithFormat:@"{\"seq\":%lld,\"pid\":%d,\"proxy\":%s}", seq, getpid(), g_proxy_dict ? "true" : "false"];
  [body writeToFile:ack atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

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
    NSString *state = env[@"WARDEN_INJECT_STATE"];
    if (state.length) {
      g_state_path = [state copy];
      watch_state();
    }
    DLOG("loaded in pid %d", getpid());
  }
}
