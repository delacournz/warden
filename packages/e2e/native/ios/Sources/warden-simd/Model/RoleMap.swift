import Foundation

// Element type name -> `Role`. Shared by `warden-simd` (AX `type`, `AX` prefix stripped) and `warden-runner` (the
// XCUIElement.ElementType name), which compile this file by path: keep it free of simulator and XCTest imports.

enum RoleMap {
  /// XCUI / AX element type (the `AX` prefix already stripped, as idb reports it) to `Role`. `Other` upgrades to
  /// `button` when AX gives it the button trait; anything unknown is `other`. A `textfield` with the
  /// `secure-text-field` trait is `securefield`: the host `ax` reader names a secure text input `TextField` and keeps
  /// its secure state only in that trait (empty or filled), where the bridge says `SecureTextField`.
  static func role(forType type: String, traits: [String]) -> Role {
    let known = table[type] ?? .other
    if known == .other, traits.contains("button") { return .button }
    if known == .textfield, traits.contains("secure-text-field") { return .securefield }
    return known
  }

  static let table: [String: Role] = [
    "Button": .button, "ToolbarButton": .button, "MenuButton": .button, "PopUpButton": .button,
    "DisclosureTriangle": .button, "Key": .button, "MenuItem": .button, "RadioButton": .button,
    "StaticText": .text,
    "TextField": .textfield, "TextView": .textfield, "ComboBox": .textfield,
    "SecureTextField": .securefield,
    "SearchField": .searchfield,
    "Image": .image, "Icon": .image,
    "Switch": .switch, "Toggle": .switch,
    "CheckBox": .checkbox,
    "Slider": .slider,
    "Link": .link,
    "Cell": .cell, "TableRow": .cell,
    "Table": .list, "CollectionView": .list, "Outline": .list, "Browser": .list,
    "ScrollView": .scrollview,
    "Tab": .tab,
    "TabBar": .tabbar,
    "Alert": .alert,
    "Sheet": .sheet, "Dialog": .sheet, "Popover": .sheet, "Drawer": .sheet,
    "Keyboard": .keyboard,
    "NavigationBar": .navbar,
    "Toolbar": .toolbar,
    "Window": .window,
    "Application": .application,
  ]
}
