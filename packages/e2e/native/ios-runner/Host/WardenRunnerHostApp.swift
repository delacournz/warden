import SwiftUI

/// The app the UI-test bundle is "testing". It does nothing: `warden-runner` drives whatever app is asked for by bundle
/// id, and the XCUITest target needs a host application to be built, signed and installed with.
@main
struct WardenRunnerHostApp: App {
  var body: some Scene {
    WindowGroup {
      Text("warden-runner")
    }
  }
}
