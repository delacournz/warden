import ExpoModulesCore
import LocalAuthentication
import Security

/// The Keychain service every item of the demo lives under.
private let service = "nz.co.delacour.warden.example.keychain-acl"

/// Access control the demo writes: the flag sets an app picks for a secret behind Face ID or the passcode.
private func flags(for acl: String) -> SecAccessControlCreateFlags? {
  switch acl {
  case "currentSetOrPasscode": return [.biometryCurrentSet, .or, .devicePasscode]
  case "currentSet": return [.biometryCurrentSet]
  case "any": return [.biometryAny]
  case "passcode": return [.devicePasscode]
  case "userPresence": return [.userPresence]
  default: return nil
  }
}

/// The query that names one demo item.
private func itemQuery(_ account: String) -> [String: Any] {
  [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
}

/// Writes `secret` under `account` with the access control `acl` (replacing any item there); answers the OSStatus.
private func save(account: String, secret: String, acl: String) -> Int {
  guard let wanted = flags(for: acl) else { return Int(errSecParam) }
  var error: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, wanted, &error)
  else { return Int(errSecParam) }
  SecItemDelete(itemQuery(account) as CFDictionary)
  var attributes = itemQuery(account)
  attributes[kSecValueData as String] = Data(secret.utf8)
  attributes[kSecAttrAccessControl as String] = access
  return Int(SecItemAdd(attributes as CFDictionary, nil))
}

/// A plain `SecItemCopyMatching` of the item's data: no `evaluatePolicy` of the app's own, the Keychain decides.
/// `noUI` passes a context that may not show UI, as an app reading in the background would.
private func read(account: String, noUI: Bool) -> [String: Any] {
  var query = itemQuery(account)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  query[kSecUseOperationPrompt as String] = "Read the demo secret"
  if noUI {
    let context = LAContext()
    context.interactionNotAllowed = true
    query[kSecUseAuthenticationContext as String] = context
  }
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, let data = result as? Data else { return ["status": Int(status)] }
  return ["status": Int(status), "value": String(decoding: data, as: UTF8.self)]
}

/// Keychain items behind `SecAccessControl` for the example app's Keychain screen (iOS only).
public class KeychainAclModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeychainAcl")

    AsyncFunction("save") { (account: String, secret: String, acl: String) -> Int in
      save(account: account, secret: secret, acl: acl)
    }

    AsyncFunction("read") { (account: String, noUI: Bool) -> [String: Any] in
      read(account: account, noUI: noUI)
    }

    // the same read on the main thread: the Keychain call blocks it while the system sheet is up
    AsyncFunction("readOnMain") { (account: String) -> [String: Any] in
      read(account: account, noUI: false)
    }.runOnQueue(.main)

    AsyncFunction("remove") { (account: String) -> Int in
      Int(SecItemDelete(itemQuery(account) as CFDictionary))
    }
  }
}
