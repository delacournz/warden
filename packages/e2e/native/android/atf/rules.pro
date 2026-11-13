# R8 rules for warden-atf: keep the one entry point, the framework's checks (looked up by class) and what they read.
-keep class nz.co.delacour.warden.atf.AtfAudit { public static java.lang.String run(...); }
-keep class com.google.android.apps.common.testing.accessibility.framework.** extends com.google.android.apps.common.testing.accessibility.framework.AccessibilityHierarchyCheck { *; }
-keep class com.google.android.apps.common.testing.accessibility.framework.strings.** { *; }
-keepattributes Signature,InnerClasses,EnclosingMethod,*Annotation*
# protobuf-javalite reflects on generated message fields
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite { <fields>; }
-dontwarn androidx.**
-dontwarn javax.annotation.**
-dontwarn org.checkerframework.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.j2objc.annotations.**
-dontwarn org.jspecify.**
-dontwarn sun.misc.Unsafe
-dontwarn java.lang.ClassValue
-dontwarn com.google.protobuf.**
-dontobfuscate
# the framework's View-based integrations (material, espresso, junit) are not used: the audit reads node infos
-dontwarn com.google.android.material.**
-dontwarn androidx.test.**
-dontwarn org.junit.**
-dontwarn junit.**
-dontwarn org.hamcrest.**
# enums are read with reflection (values / valueOf), protobuf enums included
-keepclassmembers enum * { public static **[] values(); public static ** valueOf(java.lang.String); }
