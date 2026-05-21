plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
}

fun readRepoVersion(): String {
    val manifest = rootProject.file("../manifest.json")
    if (!manifest.isFile) return "0.0.1"
    return Regex(""""version"\s*:\s*"([^"]+)"""")
        .find(manifest.readText())
        ?.groupValues
        ?.get(1)
        ?: "0.0.1"
}

fun versionCodeFrom(version: String): Int {
    val parts = version.split(".").map { it.toIntOrNull() ?: 0 }
    val major = parts.getOrElse(0) { 0 }
    val minor = parts.getOrElse(1) { 0 }
    val patch = parts.getOrElse(2) { 0 }
    val build = parts.getOrElse(3) { 0 }
    return major * 1_000_000 + minor * 10_000 + patch * 100 + build
}

val repoVersion = readRepoVersion()
val mihonVersionCode = versionCodeFrom(repoVersion).coerceAtLeast(1)

android {
    namespace = "eu.kanade.tachiyomi.extension.en.comix"
    compileSdk = libs.versions.android.sdk.compile.get().toInt()

    defaultConfig {
        applicationId = "eu.kanade.tachiyomi.extension.en.comix"
        minSdk = libs.versions.android.sdk.min.get().toInt()
        targetSdk = libs.versions.android.sdk.target.get().toInt()
        versionCode = mihonVersionCode
        versionName = "1.4.$mihonVersionCode"

        manifestPlaceholders += mapOf(
            "appName" to "Mihon: Comix",
            "extClass" to ".Comix",
            "nsfw" to "1",
        )

        base {
            archivesName.set("comix-mihon-v$repoVersion")
        }
    }

    sourceSets {
        named("main") {
            manifest.srcFile("AndroidManifest.xml")
            java.directories.clear()
            java.directories.add("src")
            kotlin.directories.clear()
            kotlin.directories.add("src")
            res.directories.clear()
            res.directories.add("res")
            assets.directories.clear()
            assets.directories.add("assets")
        }
    }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file("signingkey.jks")
            storePassword = providers.environmentVariable("KEY_STORE_PASSWORD").orNull
            keyAlias = providers.environmentVariable("ALIAS").orNull
            keyPassword = providers.environmentVariable("KEY_PASSWORD").orNull
        }
    }

    buildTypes {
        named("release") {
            signingConfig = if (rootProject.file("signingkey.jks").exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = false
        }
    }

    dependenciesInfo {
        includeInApk = false
    }

    buildFeatures {
        buildConfig = false
    }

    packaging {
        resources.excludes.add("kotlin-tooling-metadata.json")
    }
}

kotlin {
    compilerOptions {
        freeCompilerArgs.add("-opt-in=kotlinx.serialization.ExperimentalSerializationApi")
    }
}

dependencies {
    compileOnly(libs.bundles.extension.compile)
}
