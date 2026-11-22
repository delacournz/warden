# R8 rules for the passkey provider / caller spike. Entry points come from aapt2's --proguard output (manifest components).
-keepattributes Signature,InnerClasses,EnclosingMethod,*Annotation*
-dontobfuscate
-dontwarn androidx.**
-dontwarn kotlin.**
-dontwarn kotlinx.**
-dontwarn org.jetbrains.annotations.**
-dontwarn org.jspecify.**
