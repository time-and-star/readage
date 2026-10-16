/* Android-only policy. DOM ranges and all shared reading gestures stay intact. */
(function () {
  if (window.__readageSelectionMenuInstalled || !window.ReadageSelectionMenu) return;
  window.__readageSelectionMenuInstalled = true;
  var editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  var excluded = editable + ', button, a, [data-reading-interaction="true"], [data-selection-translation="true"]';
  var controls = '[data-reading-touch-handle], .reading-selection-actions:not(.word-card-selection-actions)';
  var textBlocks = '[data-reading-paragraph], [data-reading-context="title"]';
  var pressInReader = false;
  var pressTimeout;

  function element(node) { return node && (node.nodeType === 1 ? node : node.parentElement); }
  function isReaderText(node, allowLink) {
    var target = element(node);
    if (!target || target.closest(allowLink ? excluded.replace(', a,', ',') : excluded)) return false;
    var block = target.closest(textBlocks);
    return !!(block && block.closest('.reading-content, .dictionary-trial__text'));
  }
  function readerRange() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    var range = selection.getRangeAt(0);
    return isReaderText(range.startContainer, true) && isReaderText(range.endContainer, true);
  }
  function publish() {
    var active = element(document.activeElement);
    window.ReadageSelectionMenu.setSuppressed(!!(!(active && active.closest(editable))
      && (pressInReader || readerRange())));
  }
  function onPress(event) {
    clearTimeout(pressTimeout);
    var target = element(event.target);
    // Preserve the policy while an app handle or toolbar is touched.
    pressInReader = !!(target && !target.closest(editable)
      && (isReaderText(target) || (target.closest(controls) && readerRange())));
    publish();
    // Android can cancel a touch stream to start native selection. Keep the
    // scope through that transition, without retaining a stale gesture forever.
    pressTimeout = setTimeout(function () { pressInReader = false; publish(); }, 1500);
  }
  function onRelease() { pressInReader = false; clearTimeout(pressTimeout); publish(); }
  document.addEventListener('pointerdown', onPress, true);
  document.addEventListener('touchstart', onPress, { capture: true, passive: true });
  document.addEventListener('pointerup', onRelease, true);
  document.addEventListener('touchend', onRelease, true);
  document.addEventListener('selectionchange', publish, true);
  document.addEventListener('focusin', publish, true);
  document.addEventListener('focusout', function () { setTimeout(publish, 0); }, true);
  publish();
})();
