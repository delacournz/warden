/**
 * Page-side expression that reads which screen the app is on, through the React DevTools global hook: the route names
 * of the focused screens from the outermost navigator to the deepest, e.g. `["(tabs)", "todos"]`. Expo Router names a
 * screen after its file below the router root (relative to the enclosing layout), so the joined names are the route key
 * (`(tabs)/todos`) that `routerRoot` files resolve from.
 *
 * Synchronous, so a plain `Runtime.evaluate` answers it: a JSON string `{"route":[…]}` or `{"error":"no-hook"|"no-roots"}`.
 * Plain ES2015 like `tree.script.ts` (Hermes, no backticks or interpolation). Unfocused screens and frozen or hidden
 * subtrees (`activityState === 0`, `freeze`, `isPageFocused === false`) are skipped, as the tree script does, and a
 * screen that wraps its own screen (the same `route.key` on nested fibers) counts once.
 */
export const ROUTE_SCRIPT = `function (g) {
  var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.renderers || typeof hook.getFiberRoots !== "function") return JSON.stringify({ error: "no-hook" });
  var best = [];
  var seen = 0;
  var BUDGET = 300000;

  function isObj(v) {
    return v !== null && typeof v === "object";
  }

  function hidden(props) {
    return props.activityState === 0 || props.isPageFocused === false || props.freeze === true;
  }

  function walk(f, chain, lastKey) {
    var stack = [{ f: f, chain: chain, lastKey: lastKey }];
    while (stack.length > 0) {
      var item = stack.pop();
      var node = item.f;
      while (node) {
        seen++;
        if (seen > BUDGET) return;
        var props = isObj(node.memoizedProps) ? node.memoizedProps : null;
        var cur = item.chain;
        var key = item.lastKey;
        var skip = false;
        if (props) {
          if (hidden(props)) skip = true;
          var route = props.route;
          var nav = props.navigation;
          if (!skip && isObj(route) && typeof route.name === "string" && isObj(nav)) {
            var focused = true;
            if (typeof nav.isFocused === "function") {
              try {
                focused = nav.isFocused() === true;
              } catch (e) {
                focused = true;
              }
            }
            if (!focused) skip = true;
            else if (route.key === undefined || route.key !== key) {
              cur = cur.concat([route.name]);
              key = route.key;
              if (cur.length > best.length) best = cur;
            }
          }
        }
        if (!skip && node.child) stack.push({ f: node.child, chain: cur, lastKey: key });
        node = node.sibling;
      }
    }
  }

  var ids = [];
  hook.renderers.forEach(function (_r, id) { ids.push(id); });
  var roots = 0;
  for (var i = 0; i < ids.length; i++) {
    var set = hook.getFiberRoots(ids[i]);
    if (!set || typeof set.forEach !== "function") continue;
    set.forEach(function (root) {
      roots++;
      if (root && root.current) walk(root.current, [], undefined);
    });
  }
  if (roots === 0) return JSON.stringify({ error: "no-roots" });
  return JSON.stringify({ route: best });
}`;

/** Expression that runs `ROUTE_SCRIPT` against the page's global object. */
export const ROUTE_EXPRESSION = `(${ROUTE_SCRIPT})(typeof globalThis !== "undefined" ? globalThis : (typeof global !== "undefined" ? global : this))`;
