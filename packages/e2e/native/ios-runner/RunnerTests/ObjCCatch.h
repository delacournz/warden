#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns the Objective-C exception it raised, or nil. XCUITest reports some failures (typing with no
/// keyboard focus, a lost app) by raising, and an exception that escapes to the test method ends `testServe` and the
/// listener with it. Swift cannot catch NSException, so the executor runs every op through this.
NSException *_Nullable WardenCatch(NS_NOESCAPE void (^block)(void));

NS_ASSUME_NONNULL_END
