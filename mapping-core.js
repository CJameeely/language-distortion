/**
 * mapping-core.js —— 三株植物映射模块共用的两件事
 *
 * 1. blendAnchors：按 效价 × 唤醒度 平面上的距离混合几个锚点状态的参数，含糊度高时再叠加"犹豫"。
 *    离谁近就更像谁（锐化过，主导状态清楚，过渡仍然连续）；离散字段（曲线、LED 模式…）取主导状态的值。
 * 2. createTransitionTracker：主导状态持续一会儿才算切换；切换时排一个一次性动作，
 *    让观众看得出"它读到了新东西"，而不只是在动。
 */
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ramp = (v, from, to) => clamp((v - from) / (to - from));

/**
 * @param cfg  { anchors: {名: {at:{valence,arousal}, S:{…}, L:{…}}}, ambiguous: {S:{…}, L:{…}},
 *               discrete: Set(字段名), sharpness, valenceScale, ambiguityStart, ambiguityFull }
 * @returns    { weights, dominant（含糊度过半时为 'ambiguous'）, ambiguityWeight, S, L }
 */
export function blendAnchors(valence, arousal, ambiguity, cfg) {
  const names = Object.keys(cfg.anchors);
  const raw = names.map((n) => {
    const a = cfg.anchors[n].at;
    const d2 = ((valence - a.valence) * cfg.valenceScale) ** 2 + (arousal - a.arousal) ** 2;
    return 1 / Math.pow(d2 + 0.01, cfg.sharpness);
  });
  const sum = raw.reduce((x, y) => x + y, 0);
  const weights = Object.fromEntries(names.map((n, i) => [n, raw[i] / sum]));
  const dominant = names.reduce((a, b) => (weights[a] >= weights[b] ? a : b));

  // 某一组（比如触手没有 L）锚点里没写，就是空的
  const mix = (part) => Object.fromEntries(Object.keys(cfg.anchors[dominant][part] || {}).map((k) => [k, cfg.discrete.has(k)
    ? cfg.anchors[dominant][part][k]
    : names.reduce((acc, n) => acc + weights[n] * cfg.anchors[n][part][k], 0)]));
  const S = mix('S'), L = mix('L');

  const amb = ramp(ambiguity, cfg.ambiguityStart, cfg.ambiguityFull);
  for (const [part, obj] of [['S', S], ['L', L]]) {
    for (const [k, v] of Object.entries(cfg.ambiguous[part] || {})) {
      obj[k] = cfg.discrete.has(k) ? (amb > 0.5 ? v : obj[k]) : lerp(obj[k], v, amb);
    }
  }
  return { weights, dominant: amb > 0.5 ? 'ambiguous' : dominant, ambiguityWeight: amb, S, L };
}

/**
 * 主导状态切换 → 一次性动作。
 *   const tr = createTransitionTracker({ transitionGestures, stateConfirmMs, gestureMinGapMs });
 *   tr.update(dominant, now, allowGesture) → 该执行的动作 [名字, 幅度] 或 null
 * 离上一个动作太近时不丢掉：先排着，等间隔够了、而且还在这个状态，再补上。
 */
export function createTransitionTracker(cfg) {
  let shown = 'calm', candidate = 'calm', candidateSince = 0, lastGestureAt = -Infinity;
  let queued = null;                 // 等间隔的动作
  return {
    update(dominant, now, allowGesture = true) {
      if (dominant !== candidate) { candidate = dominant; candidateSince = now; }
      if (candidate !== shown && now - candidateSince >= cfg.stateConfirmMs) {
        shown = candidate;
        queued = cfg.transitionGestures[shown] || null;    // 新状态的动作（覆盖还没执行的旧动作）
      }
      if (!queued || !allowGesture || now - lastGestureAt < cfg.gestureMinGapMs) return null;
      const g = queued;
      queued = null;
      lastGestureAt = now;
      return g;
    },
    get shown() { return shown; },
  };
}

export { clamp, lerp, ramp };
