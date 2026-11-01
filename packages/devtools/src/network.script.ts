/**
 * The page side of network capture: a `fetch` wrapper that records finished requests into an in-page ring,
 * drained by `__warden_net_drain()`.
 *
 * This is source text evaluated inside Hermes by `Runtime.evaluate`, which does not transpile it, so it stays
 * plain ES2015 on purpose: `function`, `var`, promises, no `async`/`await`, arrows, `?.` or `??`.
 * `XMLHttpRequest` is not patched: RN's `fetch` is built on it, so patching both would count every request twice.
 *
 * Use as `(NETWORK_SCRIPT)(config, globalObject)`; see {@link networkInstallExpression}.
 */
export const NETWORK_SCRIPT = `function (cfg, g) {
  if (g.__warden_net_patched) return "already";
  if (typeof g.fetch !== "function") return "no fetch";
  g.__warden_net_patched = true;
  var original = g.fetch;
  var log = [];
  var maxBody = cfg.maxBody || 65536;
  var textual = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i;

  function skipped(url) {
    for (var i = 0; i < cfg.skipPrefixes.length; i++) {
      var prefix = cfg.skipPrefixes[i];
      if (url.indexOf(prefix) === 0 && "/?#".indexOf(url.charAt(prefix.length) || "/") !== -1) return true;
    }
    return false;
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (Array.isArray(h)) {
      for (var i = 0; i < h.length; i++) out[String(h[i][0]).toLowerCase()] = String(h[i][1]);
    } else if (typeof h.forEach === "function") {
      h.forEach(function (value, key) { out[String(key).toLowerCase()] = String(value); });
    } else {
      for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[k.toLowerCase()] = String(h[k]);
    }
    return out;
  }

  function requestBodyText(body) {
    if (typeof body === "string") return body.length > maxBody ? body.slice(0, maxBody) : body;
    if (body && typeof body.toString === "function" && body.constructor && body.constructor.name === "URLSearchParams") {
      return body.toString();
    }
    return undefined;
  }

  function push(entry) {
    log.push(entry);
    if (log.length > cfg.ring) log.shift();
  }

  g.__warden_net_drain = function () {
    var out = log;
    log = [];
    return JSON.stringify(out);
  };

  g.fetch = function (input, init) {
    var self = this;
    var args = arguments;
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (skipped(url)) return original.apply(self, args);

    var started = Date.now();
    var entry = {
      ts: started,
      method: String((init && init.method) || (input && input.method) || "GET").toUpperCase(),
      url: url,
      status: 0,
      durationMs: 0,
      requestHeaders: headersToObject((init && init.headers) || (input && input.headers)),
      responseHeaders: {}
    };
    if (cfg.includeBodies && init && init.body !== undefined && init.body !== null) {
      var sent = requestBodyText(init.body);
      if (sent !== undefined) entry.requestBody = sent;
    }

    return original.apply(self, args).then(function (res) {
      entry.status = res.status;
      entry.durationMs = Date.now() - started;
      entry.responseHeaders = headersToObject(res.headers);
      var type = entry.responseHeaders["content-type"] || "";
      if (!cfg.includeBodies || !textual.test(type)) {
        push(entry);
        return res;
      }
      try {
        res.clone().text().then(function (text) {
          if (text.length > maxBody) {
            entry.responseBody = text.slice(0, maxBody);
            entry.responseBodyTruncated = true;
          } else {
            entry.responseBody = text;
          }
          push(entry);
        }, function () { push(entry); });
      } catch (e) {
        push(entry);
      }
      return res;
    }, function (error) {
      entry.durationMs = Date.now() - started;
      entry.error = error && error.message ? error.message : String(error);
      push(entry);
      throw error;
    });
  };
  return "patched";
}`;

export type NetworkScriptConfig = {
	/** page-side ring size */
	ring: number;
	includeBodies: boolean;
	/** URLs starting with any of these are not recorded (Metro) */
	skipPrefixes: string[];
	/** body text cap in characters (default 64 KB) */
	maxBody?: number;
};

/** The expression to `Runtime.evaluate`: installs the wrapper once and answers `patched` / `already` / `no fetch`. */
export function networkInstallExpression(config: NetworkScriptConfig): string {
	const global = `(typeof globalThis !== "undefined" ? globalThis : (0, eval)("this"))`;
	return `(${NETWORK_SCRIPT})(${JSON.stringify(config)}, ${global})`;
}

/** Reads the page's ring and empties it; `null` when the wrapper is not installed (fresh JS context). */
export const NETWORK_DRAIN_EXPRESSION = `typeof __warden_net_drain === "function" ? __warden_net_drain() : null`;
