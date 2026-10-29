// Test harness for libwarden-inject (macOS build): a line on stdin -> one JSON line describing what the injected
// process sees. Commands: `print`, `monitor` (start an NWPathMonitor and report each update), `quit`.
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <sys/time.h>

static void emit(NSDictionary *d) {
  NSData *j = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  printf("%s\n", [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding].UTF8String);
  fflush(stdout);
}

static nw_path_monitor_t g_monitor;

int main(void) {
  @autoreleasepool {
    char buf[256];
    while (fgets(buf, sizeof buf, stdin)) {
      NSString *cmd = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if ([cmd isEqualToString:@"quit"]) break;
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
