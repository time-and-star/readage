# Android selection callback host checks

Run `node scripts/test-android-selection-menu.mjs`. The runner compiles the actual
`ReadageSelectionActionModeCallback.java` against the minimal Android callback
stubs in this directory and executes eight independent contract cases. It uses
`JAVA_HOME` or the project's portable JDK and requires no downloaded dependencies.

Covered behavior: create/prepare delegation and return values, removal of commands
added or re-added by WebView, preservation when the suppression policy is false,
dynamic policy changes, click/destroy delegation, Callback2 content rect delegation,
the Callback1 default rect, and retention of the action mode without `finish()`.

These host checks do not reproduce Chromium selection handles, vendor translation
cards, Android lifecycle, or actual editable-field/reader DOM detection. Device UI
acceptance remains separate. Output is kept in the isolated
`tmp/android-tools/selection-menu-host-tests/` directory; user libraries are untouched.
