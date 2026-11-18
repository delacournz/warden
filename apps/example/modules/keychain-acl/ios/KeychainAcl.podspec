Pod::Spec.new do |s|
  s.name           = 'KeychainAcl'
  s.version        = '1.0.0'
  s.summary        = 'Keychain items with SecAccessControl, for the warden example app'
  s.description    = 'Writes and reads Keychain items behind Face ID / passcode access control (example app only).'
  s.license        = 'MIT'
  s.author         = 'warden'
  s.homepage       = 'https://warden.co.nz'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
