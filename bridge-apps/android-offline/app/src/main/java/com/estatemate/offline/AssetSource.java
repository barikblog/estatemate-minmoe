/*
 * Where the portal's static files come from.
 *
 * The interface keeps the serving logic (StaticFiles) testable on a desktop
 * JVM against a plain directory, while the APK implementation reads from
 * Android assets — apps/web/dist is bundled into the APK at build time.
 */
package com.estatemate.offline;

public interface AssetSource {
    /** True when the relative path (no leading slash) is a readable file. */
    boolean exists(String relativePath);

    /** The file's bytes, or null when it does not exist. */
    byte[] read(String relativePath);
}
