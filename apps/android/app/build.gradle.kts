plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.dagger.hilt.android")
    id("com.google.devtools.ksp")
}

// Worker base URL baked into BuildConfig. Override with -PapiBaseUrl=https://.../
// The default is production so a plain `./gradlew assembleDebug` yields a working
// APK instead of one pointing at a placeholder host.
val apiBaseUrl: String = (project.findProperty("apiBaseUrl") as String?)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: "https://estatemate.estatemate.workers.dev/"

// Version identity. CI derives these from the `bridge-*` tag using
// major*10000 + minor*100 + patch; locally they fall back to the committed
// defaults. The fallback uses the same formula (0.1.0 -> 10) so a dev build can
// never collide with a real bridge-0.0.1 release.
val appVersionName: String = (project.findProperty("appVersionName") as String?)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: "0.1.0"
val appVersionCode: Int = (project.findProperty("appVersionCode") as String?)
    ?.trim()
    ?.toIntOrNull()
    ?.takeIf { it > 0 }
    ?: 10

// Optional release signing, activated only when every ANDROID_KEYSTORE_* variable
// is present. Without them `assembleRelease` still builds, but stays unsigned, so
// a missing secret can never silently produce a mis-signed artifact.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
val keystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
val keystoreAlias: String? = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val keystoreKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
val hasReleaseSigning = listOf(
    keystorePath,
    keystorePassword,
    keystoreAlias,
    keystoreKeyPassword,
).all { it != null } && keystorePath?.let { file(it).exists() } == true

if (listOf(keystorePath, keystorePassword, keystoreAlias, keystoreKeyPassword).any { it != null } && !hasReleaseSigning) {
    logger.warn(
        "ANDROID_KEYSTORE_* partially set (keystore file present: ${keystorePath?.let { file(it).exists() }}). " +
            "Release build will be UNSIGNED. Set ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, " +
            "ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD together.",
    )
}

android {
    namespace = "com.estatemate.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.estatemate.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keystoreAlias
                keyPassword = keystoreKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

    implementation("com.google.dagger:hilt-android:2.52")
    ksp("com.google.dagger:hilt-compiler:2.52")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("io.coil-kt:coil-compose:2.7.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
