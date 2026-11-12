/** Redirect share links into the extension options page for import. */
(() => {
  if (!location.hash.startsWith("#wuge=")) return;
  // Web page can import itself; only bridge when the extension content script runs.
  const target = chrome.runtime.getURL("options.html") + location.hash;
  location.replace(target);
})();
