import { BOOTSTRAP_SCRIPT } from "./bootstrap.script";

/** Bump when the injected state or its wrappers change: an older install is replaced, not reused. */
export const PROFILER_VERSION = 1;

/** The global the injected profiler keeps its state on. */
export const PROFILER_GLOBAL = "__WARDEN_REACT_PROFILER__";

/**
 * Page-side script, used as `(PROFILER_SCRIPT)(config, globalObject)`; returns a JSON string.
 * `config.action` is `status`, `start` or `stop`, `config.owner` names the agent that holds the profile.
 *
 * Runs inside Hermes untranspiled: plain ES5 plus `Map`/`Set`, no backticks, no interpolation, no backslashes.
 * Idempotent: state lives on `globalObject.__WARDEN_REACT_PROFILER__` (versioned), so `start` and `stop` can be
 * separate connections. Profiling state is in the JS runtime, not the socket.
 *
 * - Every `hook.rendererInterfaces` entry has `startProfiling` / `stopProfiling` wrapped (once) so the state knows
 *   when profiling began even if a DevTools frontend started it.
 * - `hook.onCommitFiberRoot` is patched (original called first) to cache fiber id to display name, and each fiber's
 *   nearest component parent, so components that unmount before `stop` stay named.
 * - Owner marker `{ owner, startedAt, heartbeat }`: a second owner is refused with `session_active` unless
 *   `config.force`, or the marker went stale (no start, stop or commit for five minutes).
 *
 * Replies: `{ ok: false, code, message, hint?, owner? }`, or for `status` the state, for `start`
 * `{ ok: true, startedWall, startedPerf, dev, rn, bootstrapped }`, for `stop` the flattened profiling data:
 * `{ ok: true, v, anchor, dev, roots: [{ rootID, name, commits: [...] }], names, parents, memo, compiled, sources }`
 * with per commit `{ t, dur, eff, pas, prio, upd: [names], a: [[id, ms]], s: [[id, ms]], c: [[id, change]] }` and
 * per change `{ p: props, st: state, h: hooks, x: context, f: first mount }`.
 */
export const PROFILER_SCRIPT = `function (cfg, g) {
  var V = ${PROFILER_VERSION};
  var KEY = "${PROFILER_GLOBAL}";
  var STALE_MS = 300000;
  var WALK_BUDGET = 20000;
  var SOURCE_BUDGET = 60000;
  var PERFORMED_WORK = 1;
  var bootstrap = ${BOOTSTRAP_SCRIPT};

  function reply(o) { return JSON.stringify(o); }
  function fail(code, message, hint, owner) {
    var o = { ok: false, code: code, message: message };
    if (hint) o.hint = hint;
    if (owner) o.owner = owner;
    return reply(o);
  }
  function wallNow() { return Date.now(); }
  function perfNow() {
    return typeof g.performance === "object" && g.performance && typeof g.performance.now === "function"
      ? g.performance.now()
      : Date.now();
  }
  function entriesOf(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    if (typeof x.entries === "function") return Array.from(x.entries());
    return [];
  }
  function rendererList(hook) {
    var out = [];
    var ris = hook.rendererInterfaces;
    if (ris && typeof ris.forEach === "function") ris.forEach(function (ri, id) { out.push({ id: id, ri: ri }); });
    return out;
  }

  var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (g.__DEV__ === false) {
    return fail("release_build", "__DEV__ is false: React render profiling needs a dev build", "run a dev client (warden dev <platform>)");
  }
  if (!hook) {
    return fail("release_build", "no React DevTools hook in this runtime: a release build, or the hook was stripped", "run a dev client (warden dev <platform>)");
  }

  var S = g[KEY];
  if (!S || S.v !== V) {
    S = { v: V, owner: null, profiling: false, startedWall: 0, startedPerf: 0, names: {}, parents: {}, memo: {}, wrapped: false };
    g[KEY] = S;
  }

  function nameOfType(type) {
    if (!type) return null;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (type.displayName) return type.displayName;
    if (type.render) return nameOfType(type.render);
    if (type.type) return nameOfType(type.type);
    return null;
  }
  function isComponent(tag) { return tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15; }

  function walkCommit(ri, rootFiber) {
    var idOf = ri.getFiberIDUnsafe || ri.getFiberIDForFiber;
    if (typeof idOf !== "function") return;
    var stack = [rootFiber, undefined];
    var visits = 0;
    while (stack.length > 0 && visits < WALK_BUDGET) {
      var parentId = stack.pop();
      var fiber = stack.pop();
      visits++;
      var pid = parentId;
      if (isComponent(fiber.tag)) {
        var worked = (fiber.flags & PERFORMED_WORK) !== 0 || fiber.alternate === null;
        var id = null;
        try { id = idOf.call(ri, fiber); } catch (e) { id = null; }
        if (typeof id === "number") {
          if (worked || S.names[id] === undefined) {
            var n = nameOfType(fiber.type);
            if (n) S.names[id] = n;
          }
          if (parentId !== undefined) S.parents[id] = parentId;
          if (fiber.tag === 14 || fiber.tag === 15) S.memo[id] = 1;
          pid = id;
        }
      }
      if (typeof fiber.subtreeFlags === "number" && (fiber.subtreeFlags & PERFORMED_WORK) === 0 && (fiber.flags & PERFORMED_WORK) === 0 && fiber.alternate !== null) continue;
      var child = fiber.child;
      while (child) {
        stack.push(child);
        stack.push(pid);
        child = child.sibling;
      }
    }
  }

  function install() {
    var ris = rendererList(hook);
    for (var i = 0; i < ris.length; i++) {
      var ri = ris[i].ri;
      if (ri.__wardenWrapped === V) continue;
      ri.__wardenWrapped = V;
      (function (target) {
        var start = target.startProfiling;
        var stop = target.stopProfiling;
        if (typeof start === "function") {
          target.startProfiling = function () {
            S.profiling = true;
            if (!S.startedWall) { S.startedWall = wallNow(); S.startedPerf = perfNow(); }
            return start.apply(target, arguments);
          };
        }
        if (typeof stop === "function") {
          target.stopProfiling = function () {
            S.profiling = false;
            return stop.apply(target, arguments);
          };
        }
      })(ri);
    }
    if (hook.__wardenCommitPatched !== V) {
      var current = hook.onCommitFiberRoot;
      var original = current && current.__wardenOriginal ? current.__wardenOriginal : current;
      var patched = function (rendererId, root) {
        var result = original ? original.apply(this, arguments) : undefined;
        var state = g[KEY];
        if (state && state.profiling) {
          try {
            if (state.owner) state.owner.heartbeat = wallNow();
            var ri = hook.rendererInterfaces.get(rendererId);
            if (ri && root && root.current) walkCommit(ri, root.current);
          } catch (e) {}
        }
        return result;
      };
      patched.__wardenOriginal = original;
      hook.onCommitFiberRoot = patched;
      hook.__wardenCommitPatched = V;
    }
  }

  function ownerRefusal() {
    var o = S.owner;
    if (!o || o.owner === cfg.owner || cfg.force === true) return null;
    var last = Math.max(o.startedAt || 0, o.heartbeat || 0);
    if (wallNow() - last >= STALE_MS) return null;
    return fail("session_active", "React profiling is already held by " + o.owner, "wait for it to stop, or pass --force to take over", o.owner);
  }

  function anyProfiling() {
    var ris = rendererList(hook);
    for (var i = 0; i < ris.length; i++) {
      if (ris[i].ri.isProfiling === true) return true;
    }
    return S.profiling;
  }

  if (cfg.action === "status") {
    return reply({ ok: true, v: V, profiling: anyProfiling(), owner: S.owner, renderers: rendererList(hook).length });
  }

  if (cfg.action === "start") {
    var refused = ownerRefusal();
    if (refused) return refused;
    var boot = bootstrap(g, hook);
    if (!boot.ok) return reply(boot);
    install();
    var ris = rendererList(hook);
    S.names = {};
    S.parents = {};
    S.memo = {};
    S.startedWall = wallNow();
    S.startedPerf = perfNow();
    S.profiling = true;
    S.owner = { owner: cfg.owner, startedAt: S.startedWall, heartbeat: S.startedWall };
    try {
      for (var i = 0; i < ris.length; i++) {
        if (typeof ris[i].ri.stopProfiling === "function" && ris[i].ri.isProfiling === true) ris[i].ri.stopProfiling();
        ris[i].ri.startProfiling(true);
      }
    } catch (e) {
      S.profiling = false;
      S.owner = null;
      return fail("cdp_failed", "startProfiling threw: " + (e && e.message ? e.message : String(e)));
    }
    return reply({ ok: true, startedWall: S.startedWall, startedPerf: S.startedPerf, dev: g.__DEV__ === true, rn: boot.rn, bootstrapped: boot.bootstrapped });
  }

  if (cfg.action === "stop") {
    if (!S.owner && !S.profiling) return fail("not_profiling", "no React profile is running", "start one with warden perf react start");
    var refusedStop = ownerRefusal();
    if (refusedStop) return refusedStop;
    install();
    var stoppedWall = wallNow();
    var stoppedPerf = perfNow();
    var rendererIfaces = rendererList(hook);
    var roots = [];
    var names = {};
    var compiled = {};
    var nameById = function (ri, id, snapshotNames) {
      if (snapshotNames[id] !== undefined) return snapshotNames[id];
      if (S.names[id] !== undefined) return S.names[id];
      var get = ri.getDisplayNameForElementID || ri.getDisplayNameForFiberByID;
      if (typeof get === "function") {
        try { var n = get.call(ri, id); if (n) return n; } catch (e) {}
      }
      return null;
    };
    for (var r = 0; r < rendererIfaces.length; r++) {
      var ri = rendererIfaces[r].ri;
      var data = null;
      try {
        if (typeof ri.stopProfiling === "function") ri.stopProfiling();
        data = ri.getProfilingData();
      } catch (e) { data = null; }
      var forRoots = data && data.dataForRoots ? data.dataForRoots : [];
      for (var k = 0; k < forRoots.length; k++) {
        var rd = forRoots[k];
        var snapshotNames = {};
        var snaps = entriesOf(rd.snapshots);
        for (var s = 0; s < snaps.length; s++) {
          var node = snaps[s][1];
          if (node && node.displayName) snapshotNames[snaps[s][0]] = node.displayName;
          if (node && node.compiledWithForget) compiled[snaps[s][0]] = 1;
        }
        var commits = [];
        var cds = rd.commitData || [];
        for (var c = 0; c < cds.length; c++) {
          var cd = cds[c];
          var upd = [];
          var updaters = cd.updaters || [];
          for (var u = 0; u < updaters.length; u++) {
            if (updaters[u] && updaters[u].displayName) upd.push(updaters[u].displayName);
            if (updaters[u] && updaters[u].compiledWithForget) compiled[updaters[u].id] = 1;
          }
          var actual = entriesOf(cd.fiberActualDurations);
          var self = entriesOf(cd.fiberSelfDurations);
          var changes = entriesOf(cd.changeDescriptions);
          var outChanges = [];
          for (var ch = 0; ch < changes.length; ch++) {
            var d = changes[ch][1] || {};
            outChanges.push([changes[ch][0], { p: d.props || null, st: d.state || null, h: d.hooks || null, x: d.context || null, f: d.isFirstMount ? 1 : 0 }]);
          }
          for (var a = 0; a < actual.length; a++) {
            var fid = actual[a][0];
            if (names[fid] === undefined) {
              var nm = nameById(ri, fid, snapshotNames);
              if (nm) names[fid] = nm;
            }
          }
          commits.push({ t: cd.timestamp, dur: cd.duration, eff: cd.effectDuration || 0, pas: cd.passiveEffectDuration || 0, prio: cd.priorityLevel || null, upd: upd, a: actual, s: self, c: outChanges });
        }
        roots.push({ rootID: rd.rootID, name: rd.displayName || "root", commits: commits });
      }
    }

    var sources = {};
    try {
      for (var q = 0; q < rendererIfaces.length; q++) {
        var rid = rendererIfaces[q].id;
        var fiberRoots = typeof hook.getFiberRoots === "function" ? hook.getFiberRoots(rid) : null;
        if (!fiberRoots) continue;
        fiberRoots.forEach(function (fr) {
          var pending = [fr.current];
          var seen = 0;
          while (pending.length > 0 && seen < SOURCE_BUDGET) {
            var f = pending.pop();
            seen++;
            if (isComponent(f.tag)) {
              var nameHere = nameOfType(f.type);
              if (nameHere && sources[nameHere] === undefined) {
                var src = f._debugSource;
                if (src && src.fileName) sources[nameHere] = { file: src.fileName, line: src.lineNumber || 0 };
                else if (f._debugStack && typeof f._debugStack.stack === "string") sources[nameHere] = { stack: f._debugStack.stack.split(String.fromCharCode(10)).slice(0, 4).join(String.fromCharCode(10)) };
              }
            }
            if (f.sibling) pending.push(f.sibling);
            if (f.child) pending.push(f.child);
          }
        });
      }
    } catch (e) {}

    var startedWall = S.startedWall;
    var startedPerf = S.startedPerf;
    S.profiling = false;
    S.owner = null;
    return reply({
      ok: true,
      v: V,
      anchor: { startedWall: startedWall, startedPerf: startedPerf, stoppedWall: stoppedWall, stoppedPerf: stoppedPerf },
      dev: g.__DEV__ === true,
      roots: roots,
      names: names,
      parents: S.parents,
      memo: S.memo,
      compiled: compiled,
      sources: sources
    });
  }

  return fail("cdp_failed", "unknown action " + cfg.action);
}`;
