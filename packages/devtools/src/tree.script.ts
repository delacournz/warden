/**
 * Page-side script that reads the app's React component tree through the React DevTools global hook and reports
 * the components a test can address (testID, accessibility label, text, screens) together with their window rects.
 *
 * Runs inside Hermes untranspiled, so it is plain ES2015: no arrow functions, optional chaining, nullish
 * coalescing or async functions, and no backticks or interpolation (it lives in a template literal here).
 * Used as `(TREE_SCRIPT)(config, globalObject)`; it answers "started" at once and delivers the result later:
 * through the CDP binding `config.binding` when the page has one, else as a JSON string in
 * `globalObject.__warden_tree_results[requestId]` for the host to poll and delete.
 *
 * Inactive-screen heuristic (a subtree is skipped unless `all`, then it is kept and flagged `inactive`):
 * - props `activityState === 0` (react-native-screens), `isPageFocused === false` (pager views), `freeze === true`
 *   (react-freeze, Suspense-style freezing), `aria-hidden === true`, `accessibilityElementsHidden === true`,
 *   `importantForAccessibility === "no-hide-descendants"`, or a style whose last `display` is `"none"`;
 * - a fiber with both `route` and `navigation` props (a react-navigation / expo-router screen) whose
 *   `navigation.isFocused()` is false. `isFocused` accounts for parent navigators, so a focused tab inside an
 *   unfocused stack screen is unfocused too. When it throws the screen is treated as unknown, not as unfocused.
 * The reported `screen` is `route.name` of the deepest focused screen. `activityState === 1` (transitioning)
 * is kept. With `config.screen` pruning is off and only the subtree of the screen with that route name is reported.
 */
export const TREE_SCRIPT = `function (cfg, g) {
  var rid = cfg.requestId;
  var MAX = typeof cfg.max === "number" && cfg.max > 0 ? Math.min(Math.floor(cfg.max), 5000) : 5000;
  var GUARD = typeof cfg.guardMs === "number" && cfg.guardMs > 0 ? cfg.guardMs : 1200;
  var ALL = cfg.all === true;
  var ONLY = typeof cfg.screen === "string" && cfg.screen !== "" ? cfg.screen : null;
  var BUDGET = 300000;
  var MAX_DEPTH = 1500;
  var MEASURE_CAP = 8000;
  var TEXT_CAP = 200;
  var HOST_NAMES = {
    RCTView: "View",
    RCTText: "Text",
    RCTVirtualText: "Text",
    RCTScrollView: "ScrollView",
    RCTImageView: "Image",
    RCTSinglelineTextInputView: "TextInput",
    RCTMultilineTextInputView: "TextInput",
    AndroidTextInput: "TextInput"
  };
  var EMPTY = {};
  var visits = 0;
  var budgetHit = false;
  var delivered = false;
  var finished = false;
  var timer = null;
  var bestScreen = null;
  var bestDepth = -1;
  var onlyFound = false;
  var hostMap = new Map();
  var hostList = [];
  var rects = [];
  var forest = [];
  var pending = 0;

  function isObj(v) {
    return v !== null && typeof v === "object";
  }

  function str(v) {
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  function message(e) {
    return String(e && e.message ? e.message : e);
  }

  function deliver(result) {
    if (delivered) return;
    delivered = true;
    var cb = g[cfg.binding];
    if (typeof cb === "function") {
      cb(JSON.stringify({ requestId: rid, result: result }));
      return;
    }
    var store = g.__warden_tree_results;
    if (!isObj(store)) {
      store = {};
      g.__warden_tree_results = store;
    }
    store[rid] = JSON.stringify(result);
  }

  function lastDisplay(style, depth) {
    if (!style || depth > 6) return undefined;
    if (Array.isArray(style)) {
      var found;
      for (var i = 0; i < style.length; i++) {
        var d = lastDisplay(style[i], depth + 1);
        if (d !== undefined) found = d;
      }
      return found;
    }
    return typeof style === "object" ? style.display : undefined;
  }

  function isHidden(props) {
    return props.activityState === 0 ||
      props.isPageFocused === false ||
      props.freeze === true ||
      props["aria-hidden"] === true ||
      props.accessibilityElementsHidden === true ||
      props.importantForAccessibility === "no-hide-descendants" ||
      lastDisplay(props.style, 0) === "none";
  }

  function typeName(t, depth) {
    if (typeof t === "function") return t.displayName || t.name || "";
    if (typeof t === "string") return t;
    if (isObj(t) && depth < 4) {
      return t.displayName || typeName(t.render, depth + 1) || typeName(t.type, depth + 1) || "";
    }
    return "";
  }

  function nameOf(f) {
    var t = f.type;
    if (f.tag === 5 && typeof t === "string") {
      return Object.prototype.hasOwnProperty.call(HOST_NAMES, t) ? HOST_NAMES[t] : t;
    }
    return typeName(t, 0) || "Component";
  }

  function rectHostOf(f) {
    if (f.tag === 5) return f;
    var cur = f.child;
    var n = 0;
    while (cur && n < 30) {
      if (cur.sibling) return null;
      if (cur.tag === 5) return cur;
      if (cur.tag === 6) return null;
      cur = cur.child;
      n++;
    }
    return null;
  }

  function registerHost(h) {
    if (!h) return -1;
    var i = hostMap.get(h);
    if (i === undefined) {
      if (hostList.length >= MEASURE_CAP) return -1;
      i = hostList.length;
      hostList.push(h);
      hostMap.set(h, i);
    }
    return i;
  }

  function clip(t) {
    return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t;
  }

  function buildChildren(f, ctx, depth) {
    var nodes = [];
    var strings = [];
    if (depth >= MAX_DEPTH) {
      budgetHit = true;
      return { nodes: nodes, strings: strings };
    }
    var c = f.child;
    while (c) {
      var r = buildFiber(c, ctx, depth + 1);
      for (var i = 0; i < r.nodes.length; i++) nodes.push(r.nodes[i]);
      for (var j = 0; j < r.strings.length; j++) strings.push(r.strings[j]);
      c = c.sibling;
    }
    return { nodes: nodes, strings: strings };
  }

  function buildFiber(f, ctx, depth) {
    visits++;
    if (visits > BUDGET) {
      budgetHit = true;
      return { nodes: [], strings: [] };
    }
    if (f.tag === 6) {
      var s = f.memoizedProps;
      if (typeof s === "string" || typeof s === "number") return { nodes: [], strings: [String(s)] };
      return { nodes: [], strings: [] };
    }
    var props = isObj(f.memoizedProps) ? f.memoizedProps : EMPTY;
    var route = props.route;
    var nav = props.navigation;
    var screenRoot = isObj(route) && typeof route.name === "string" && isObj(nav);
    var focused;
    if (screenRoot && typeof nav.isFocused === "function") {
      try {
        focused = nav.isFocused() === true;
      } catch (e) {
        focused = undefined;
      }
    }
    var hidden = isHidden(props) || focused === false;
    if (ONLY === null && hidden && !ALL) return { nodes: [], strings: [] };
    var inactive = ctx.inactive || (ONLY === null && hidden);
    var inScreen = ctx.inScreen;
    if (ONLY !== null && screenRoot && route.name === ONLY) {
      inScreen = true;
      onlyFound = true;
    }
    if (ONLY === null && screenRoot && focused === true && !inactive && depth > bestDepth) {
      bestDepth = depth;
      bestScreen = route.name;
    }
    var childCtx = ctx;
    if (inactive !== ctx.inactive || inScreen !== ctx.inScreen) childCtx = { inactive: inactive, inScreen: inScreen };
    var kids = buildChildren(f, childCtx, depth);

    var type = f.type;
    var isHost = f.tag === 5 && typeof type === "string";
    var isText = isHost && (type === "RCTText" || type === "Text");
    var isVirtual = isHost && type === "RCTVirtualText";
    var testID = str(props.testID);
    var label = str(props.accessibilityLabel) || str(props["aria-label"]);
    var strings = kids.strings;
    var text;
    var outStrings = strings;
    if (isText) {
      var joined = clip(strings.join(""));
      text = joined === "" ? undefined : joined;
      outStrings = [];
    }
    var emit = (ONLY === null || inScreen) &&
      (testID !== undefined || label !== undefined || screenRoot || (isText && text !== undefined));
    if (!emit) return { nodes: kids.nodes, strings: outStrings };
    if (!isText && strings.length > 0) {
      text = clip(strings.join(isVirtual ? "" : " "));
      if (!isVirtual) outStrings = [];
    }
    var node = {
      name: nameOf(f),
      testID: testID,
      label: label,
      text: text,
      hostIdx: registerHost(rectHostOf(f)),
      kids: kids.nodes,
      inactive: inactive,
      screenRoot: screenRoot,
      rect: undefined
    };
    return { nodes: [node], strings: outStrings };
  }

  function r1(v) {
    return Math.round(v * 10) / 10;
  }

  function accept(i, x, y, w, h) {
    if (finished) return;
    if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return;
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return;
    rects[i] = { x: r1(x), y: r1(y), w: r1(w), h: r1(h) };
  }

  function done() {
    pending--;
    if (pending === 0) finish();
  }

  function measure(i) {
    var sn = hostList[i].stateNode;
    var settled = false;
    function viaWindow(x, y, w, h) {
      if (settled) return;
      settled = true;
      accept(i, x, y, w, h);
      done();
    }
    function viaShadow(x, y, w, h, px, py) {
      if (settled) return;
      settled = true;
      accept(i, px, py, w, h);
      done();
    }
    try {
      if (isObj(sn)) {
        var pub = isObj(sn.canonical) ? sn.canonical.publicInstance : null;
        if (isObj(pub) && typeof pub.measureInWindow === "function") {
          pub.measureInWindow(viaWindow);
          return;
        }
        if (typeof sn.measureInWindow === "function") {
          sn.measureInWindow(viaWindow);
          return;
        }
        var fab = g.nativeFabricUIManager;
        if (sn.node && isObj(fab) && typeof fab.measure === "function") {
          fab.measure(sn.node, viaShadow);
          return;
        }
        var tag = typeof sn._nativeTag === "number"
          ? sn._nativeTag
          : (isObj(sn.canonical) && typeof sn.canonical.nativeTag === "number" ? sn.canonical.nativeTag : undefined);
        var proxy = g.nativeModuleProxy;
        var ui = isObj(proxy) ? proxy.UIManager : null;
        if (tag !== undefined && isObj(ui) && typeof ui.measureInWindow === "function") {
          ui.measureInWindow(tag, viaWindow);
          return;
        }
      }
    } catch (e) {
    }
    if (!settled) {
      settled = true;
      done();
    }
  }

  function sameRect(a, b) {
    if (a === undefined || b === undefined) return a === b;
    return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
  }

  function canAbsorb(p, c) {
    return !p.screenRoot &&
      !!p.inactive === !!c.inactive &&
      sameRect(p.rect, c.rect) &&
      (c.testID === undefined || c.testID === p.testID) &&
      (c.label === undefined || c.label === p.label);
  }

  function finalize(nodes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.rect = n.hostIdx >= 0 ? rects[n.hostIdx] : undefined;
      n.kids = finalize(n.kids);
      if (n.rect === undefined && n.testID === undefined) {
        for (var k = 0; k < n.kids.length; k++) out.push(n.kids[k]);
        continue;
      }
      while (n.kids.length === 1 && canAbsorb(n, n.kids[0])) {
        var c = n.kids[0];
        if (n.testID === undefined) n.testID = c.testID;
        if (n.label === undefined) n.label = c.label;
        if (n.text === undefined) n.text = c.text;
        n.screenRoot = n.screenRoot || c.screenRoot;
        n.kids = c.kids;
      }
      out.push(n);
    }
    return out;
  }

  var comps = [];
  var more = false;

  function flatten(nodes, parentId) {
    for (var i = 0; i < nodes.length; i++) {
      if (comps.length >= MAX) {
        more = true;
        return;
      }
      var n = nodes[i];
      var id = comps.length;
      var c = { id: id, name: n.name, parent: parentId };
      if (n.testID !== undefined) c.testID = n.testID;
      if (n.label !== undefined) c.label = n.label;
      if (n.text !== undefined) c.text = n.text;
      if (n.rect !== undefined) c.rect = n.rect;
      if (n.inactive) c.inactive = true;
      comps.push(c);
      flatten(n.kids, id);
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (timer !== null && typeof g.clearTimeout === "function") g.clearTimeout(timer);
    try {
      flatten(finalize(forest), null);
      var result = { components: comps, truncated: more || budgetHit };
      var screen = ONLY !== null ? (onlyFound ? ONLY : null) : bestScreen;
      if (screen !== null) result.screen = screen;
      deliver(result);
    } catch (e) {
      deliver({ error: message(e) });
    }
  }

  function countFibers(start) {
    var n = 0;
    var cur = start;
    while (cur && n < 20000) {
      n++;
      if (cur.child) {
        cur = cur.child;
        continue;
      }
      while (cur && cur !== start && !cur.sibling) cur = cur.return;
      if (!cur || cur === start) break;
      cur = cur.sibling;
    }
    return n;
  }

  try {
    var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!isObj(hook)) {
      deliver({ error: "no-hook" });
      return "started";
    }
    var best = null;
    var bestCount = -1;
    var consider = function (set) {
      if (!set || typeof set.forEach !== "function") return;
      set.forEach(function (root) {
        var cur = root && root.current;
        if (!cur) return;
        var n = countFibers(cur);
        if (n > bestCount) {
          bestCount = n;
          best = cur;
        }
      });
    };
    if (typeof hook.getFiberRoots === "function") {
      if (isObj(hook.renderers) && typeof hook.renderers.forEach === "function") {
        hook.renderers.forEach(function (renderer, id) {
          consider(hook.getFiberRoots(id));
        });
      }
      if (best === null) consider(hook.getFiberRoots(1));
    }
    if (best === null) {
      deliver({ error: "no-roots" });
      return "started";
    }
    forest = buildChildren(best, { inactive: false, inScreen: false }, 0).nodes;
    if (hostList.length === 0) {
      finish();
      return "started";
    }
    pending = hostList.length + 1;
    for (var i = 0; i < hostList.length; i++) measure(i);
    done();
    if (!finished) {
      if (typeof g.setTimeout === "function") timer = g.setTimeout(finish, GUARD);
      else finish();
    }
  } catch (e) {
    deliver({ error: message(e) });
  }
  return "started";
}`;

export type TreeScriptConfig = {
	requestId: string;
	/** name of the CDP binding to report through (when the page has it) */
	binding: string;
	max?: number;
	screen?: string;
	all?: boolean;
	/** how long to wait for native measurements before reporting what arrived (default 1200 ms) */
	guardMs?: number;
};

/** Expression that runs `TREE_SCRIPT` against the page's global object; evaluates to "started". */
export function treeInstallExpression(config: TreeScriptConfig): string {
	const globalObject =
		'typeof globalThis !== "undefined" ? globalThis : (typeof global !== "undefined" ? global : this)';
	return `(${TREE_SCRIPT})(${JSON.stringify(config)}, ${globalObject})`;
}
