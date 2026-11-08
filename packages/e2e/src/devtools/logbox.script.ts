/**
 * Page-side expression that turns React Native's LogBox off for good in this JS context: no warning/error toasts and
 * no full-screen inspector, even for a fatal error. Every log still reaches the console (and so `console.jsonl` and
 * Metro's terminal); only the overlay that covers the app and steals taps is gone.
 *
 * LogBox is not on a global: the script finds `react-native/Libraries/LogBox/Data/LogBoxData.js` in Metro's dev
 * module registry (`__r.getModules()`, a `Map` of id → module with a `verboseName` path) and, once it is initialized,
 * adds an ignore pattern that matches every message (`appendNewLog` drops ignored logs before they are stored, which
 * is what keeps a fatal's inspector shut too, and the logs already shown are filtered out), disables notifications
 * (`LogBox.ignoreAllLogs()`) and closes an open inspector. Re-running it is harmless (the pattern is de-duplicated).
 *
 * Synchronous: `"off"`, `"no-require"` (no dev Metro require yet: the bundle has not run, or a release build) or
 * `"not-ready"` (LogBoxData not loaded yet). Plain ES5 (Hermes), no backticks or interpolation.
 */
export const LOGBOX_SCRIPT = `function (g) {
  var req = g.__r;
  if (typeof req !== "function" || typeof req.getModules !== "function") return "no-require";
  var modules = req.getModules();
  if (!modules || typeof modules.forEach !== "function") return "no-require";
  var data = null;
  modules.forEach(function (mod) {
    if (data || !mod || typeof mod.verboseName !== "string" || !mod.isInitialized) return;
    var name = mod.verboseName.replace(/\\\\/g, "/");
    if (!/(^|\\/)react-native\\/Libraries\\/LogBox\\/Data\\/LogBoxData\\.js$/.test(name)) return;
    var exports = mod.publicModule && mod.publicModule.exports;
    if (exports && typeof exports.addIgnorePatterns === "function") data = exports;
  });
  if (!data) return "not-ready";
  data.addIgnorePatterns([/[\\s\\S]*/]);
  if (typeof data.setDisabled === "function") data.setDisabled(true);
  if (typeof data.setSelectedLog === "function") data.setSelectedLog(-1);
  return "off";
}`;

/** Expression that runs `LOGBOX_SCRIPT` against the page's global object. */
export const LOGBOX_EXPRESSION = `(${LOGBOX_SCRIPT})(typeof globalThis !== "undefined" ? globalThis : (typeof global !== "undefined" ? global : this))`;
