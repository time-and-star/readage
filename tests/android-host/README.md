# SQLite host compatibility tests

Run `node scripts/test-android-database.mjs` with JDK 21. The script also discovers the project's temporary portable JDK. Its Maven Central dependencies have pinned versions and SHA-256 checksums, and are cached under ignored `tmp/android-tools/host-tests`.

This compiles the production `LocalDatabaseStore.java` and reuses `LocalDatabaseStoreTest.java`. SQL executes on real SQLite through a small JDBC boundary; the JSON implementation follows Android's `org.json`. The substitutes in this directory belong exclusively to this host test and are never included in the Android app.

Passing these tests confirms transaction, schema, conflict, snapshot, date, and operation receipt behavior on the host. It does not verify Android's CursorWindow, Capacitor bridge, process termination, TTS, or device behavior. Build the test APK and use `connectedDebugAndroidTest` on an Android 12 or newer device for those platform database checks.
