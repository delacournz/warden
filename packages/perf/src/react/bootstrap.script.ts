/**
 * Page-side script, used as `(BOOTSTRAP_SCRIPT)(globalObject, hook)`, that makes sure the React DevTools backend is
 * attached so `hook.rendererInterfaces` is populated even with no DevTools frontend connected.
 *
 * Runs inside Hermes untranspiled: plain ES5 plus `Map`, no backticks, no interpolation, no backslashes (it lives in
 * a template literal). Returns an object: `{ ok: true, bootstrapped, rn }` or `{ ok: false, code, message, hint? }`
 * with `code` one of `rn_too_old` (React Native below 0.74), `devtools_backend_missing`.
 *
 * It reads the app's Metro module registry (`__r.getModules()`, present in dev bundles), finds `react-devtools-core`
 * and calls its `connectWithCustomMessagingProtocol` with no-op handlers: that initialises the backend and attaches
 * every renderer already registered with the hook, without opening a socket.
 */
export const BOOTSTRAP_SCRIPT = `function (g, hook) {
  var MIN_MINOR = 74;
  function eachModule(fn) {
    var req = g.__r;
    var mods = req && typeof req.getModules === "function" ? req.getModules() : null;
    if (!mods) return false;
    if (typeof mods.forEach === "function") {
      mods.forEach(function (m, id) { fn(m, id); });
      return true;
    }
    var keys = Object.keys(mods);
    for (var i = 0; i < keys.length; i++) fn(mods[keys[i]], keys[i]);
    return true;
  }
  function requireId(id) {
    var n = Number(id);
    return g.__r(String(n) === String(id) ? n : id);
  }
  function findModules(needle) {
    var found = [];
    eachModule(function (m, id) {
      var name = m && (m.verboseName || m.path || "");
      if (typeof name === "string" && name.indexOf(needle) !== -1) found.push(id);
    });
    return found;
  }
  function rnVersion() {
    try {
      var ids = findModules("Libraries/Utilities/Platform");
      for (var i = 0; i < ids.length; i++) {
        var p = requireId(ids[i]);
        p = p && p.default ? p.default : p;
        var v = p && p.constants && p.constants.reactNativeVersion;
        if (v && typeof v.minor === "number") return v;
      }
    } catch (e) {}
    return null;
  }
  function count() {
    var ri = hook.rendererInterfaces;
    return ri && typeof ri.size === "number" ? ri.size : 0;
  }

  var version = rnVersion();
  var rn = version ? version.major + "." + version.minor + "." + version.patch : null;
  if (version && version.major === 0 && version.minor < MIN_MINOR) {
    return {
      ok: false,
      code: "rn_too_old",
      message: "React Native " + rn + " is below 0.74: its DevTools backend cannot record change descriptions reliably",
      hint: "upgrade to React Native 0.74 or newer to profile React renders"
    };
  }
  if (count() > 0) return { ok: true, bootstrapped: false, rn: rn };

  var attached = false;
  var reason = "react-devtools-core is not in the app's module registry";
  try {
    var ids = findModules("react-devtools-core");
    for (var i = 0; i < ids.length && !attached; i++) {
      var mod = null;
      try { mod = requireId(ids[i]); } catch (e) { continue; }
      var connect = mod && mod.connectWithCustomMessagingProtocol;
      if (typeof connect !== "function") continue;
      var noop = function () {};
      connect({
        onSubscribe: function () { return noop; },
        onUnsubscribe: noop,
        onMessage: noop,
        isProfiling: false
      });
      attached = count() > 0;
      if (!attached) reason = "react-devtools-core connected but no renderer attached";
    }
  } catch (e) {
    reason = "react-devtools-core failed: " + (e && e.message ? e.message : String(e));
  }
  if (!attached) {
    return {
      ok: false,
      code: "devtools_backend_missing",
      message: "no React DevTools backend is attached (" + reason + ")",
      hint: "run a dev build whose bundle includes react-devtools-core, or open React DevTools once"
    };
  }
  return { ok: true, bootstrapped: true, rn: rn };
}`;
