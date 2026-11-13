/** Redirect GitHub share links into the extension options page for import. */
(() => {
  if (!location.hash.startsWith("#wuge=")) return;
  const target = chrome.runtime.getURL("options.html") + location.hash;
  location.replace(target);
})();
