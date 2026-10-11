# Retrofit/Gson DTOs are intentionally kept for release serialization.
-keepattributes Signature
-keepattributes *Annotation*
# The DTOs live in com.estatemate.app.data.remote (the old rule named a
# `...remote.dto` package this app never had, so it kept nothing). R8 is off in
# this project's release build type; this rule is here so enabling minification
# later cannot silently break Gson's field-name mapping.
-keep class com.estatemate.app.data.remote.** { *; }
-keepclassmembers class com.estatemate.app.data.remote.** { <fields>; }
