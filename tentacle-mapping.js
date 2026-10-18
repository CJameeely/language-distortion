/**
 * tentacle-mapping.js —— 《语言失真》身体姿态（LMA）→ 触手动作参数
 *
 * 只做"识别结果 → 动作"的映射，不含识别、UI、串口。
 * 输入来自 posture-mapping.js 的 getState().lma（O 开放度、W 沉重感、A 左右不对称 -1~1、F 流动性）：
 *
 *   import { createTentacleMapper } from './tentacle-mapping.js';
 *   const tentacle = createTentacleMapper();
 *   tentacle.update({ O, W, A, F, present }, now);
 *   const lines = tentacle.frames(now, sender);
 *
 * 两层：
 *   控制层：每根触手有自己的目标（卷曲量 curl、偏向 lean）——不对称的身体让三根触手本来应该各不相同。
 *   硬件层：toHardware() 把三根触手的目标合成两个电机能做到的东西。
 *     !!! 硬件限制：两个电机（A 拉三根触手的外侧线，B 拉内侧线）同时拉三根触手，三根没法各动各的。
 *         三根之间的差别只能取平均，表现为"整体卷曲 + 外 / 内偏向"。两个电机之间还能做的"局部"：
 *         两侧呼吸相位差（触手摇摆、扭动）、两侧呼吸幅度不同、微颤只加在一侧。
 *         以后加电机（比如每根触手一个），只需要改 toHardware() 和固件的电机数量。
 *
 * 状态（效价 × 唤醒度）从 LMA 推出来：
 *   效价 ≈ 开放度 − 沉重感（张开、抬头 → 正；收拢、低头含胸 → 负）
 *   唤醒度 ≈ 流动性为主、开放度为辅（动得多、动得快 → 高）
 *   含糊度 = 最近 3 秒身体左右摇摆、开合"来回"变的程度（拿不定主意的身体）。
 *            只算来回：走过的总路程减去最终的净移动。一次干脆的大动作不算犹豫。
 */
import { blendAnchors, createTransitionTracker, clamp, lerp, ramp } from './mapping-core.js';

// =====================================================================
// 参数表（直接改这里调手感；运行时也可以改 config.xxx）
// =====================================================================
export const config = {
  //   S：pos 整体卷曲 0~1（0 = 线全放出、舒展；1 = 收到最大）| dur 全程秒 | curve 0 匀速 1 缓入缓出 2 快起慢收 3 慢起急停 |
  //      back 放松回去的用时倍数（"下沉后迟迟不回"）| per 呼吸周期秒 | dep 呼吸幅度 0~1 | hold 收到顶停顿秒 |
  //      trA 微颤幅度（MAX_STEPS 的比例；固件 1600 步时 0.0125 ≈ ±20 步）| trF 微颤 Hz | still 放到底静止秒 | hes 犹豫 0~1
  //   固件全速收线约 1200 步/秒（1600 步 ≈ 1.3 秒走完全程）；放线不快过触手回弹（600 步/秒）
  //   所以微颤做不到又大又快：放线那一半最快 600 步/秒，±25 步时最多约 5Hz
  anchors: {
    calm: {
      label: '平静', at: { valence: 0, arousal: 0.35 },
      S: { pos: 0.20, dur: 3.3, curve: 1, back: 1, per: 10, dep: 0.05, hold: 1,   trA: 0,      trF: 0, still: 3,   hes: 0 },
    },
    excited: {   // 舒展、快、呼吸短而深、细小的微颤
      label: '兴奋', at: { valence: 0.7, arousal: 0.8 },
      S: { pos: 0.05, dur: 1.4, curve: 2, back: 1, per: 4,  dep: 0.12, hold: 0.3, trA: 0.0125, trF: 4, still: 0.5, hes: 0 },
    },
    tense: {     // 急收（慢起急停）、绷住不放、强微颤（±25 步 @5Hz：触手回弹速度限制了抖动，表里原定的 ±40 @8Hz 做不出来）
      label: '紧张', at: { valence: -0.7, arousal: 0.8 },
      S: { pos: 0.60, dur: 1.0, curve: 3, back: 1, per: 3,  dep: 0.04, hold: 2,   trA: 0.016,  trF: 5, still: 0.5, hes: 0.1 },
    },
    low: {       // 缓慢下沉蜷缩、很久才放松（回程 ×4）、不呼吸
      label: '低落', at: { valence: -0.7, arousal: 0.1 },
      S: { pos: 0.80, dur: 6.0, curve: 1, back: 4, per: 12, dep: 0,    hold: 8,   trA: 0,      trF: 0, still: 8,   hes: 0.2 },
    },
  },
  // 犹豫（身体摇摆不定时叠加）：收到一半放回去、重试
  ambiguous: {
    label: '犹豫',
    S: { dur: 2.5, curve: 1, per: 6, dep: 0.05, hold: 1.5, trA: 0.006, trF: 2, still: 1.5, hes: 0.8 },
  },
  ambiguityStart: 0.35,
  ambiguityFull: 0.85,
  sharpness: 2,
  valenceScale: 0.5,

  // LMA → 情绪坐标
  arousalFlow: 0.75,             // 唤醒度 = 0.75 × 流动性 + 0.25 × 开放度
  inputTau: 0.8,                 // LMA 先平滑一下（秒），去掉逐帧抖动
  wobbleWindowMs: 3000,          // 含糊度：统计最近 3 秒
  wobbleAsym: [0.1, 0.6],        // 左右（A）每秒"来回"的量从 0.1 到 0.6 → 含糊度 0~1
  wobbleOpen: [0.05, 0.3],       // 开合（O）每秒"来回"的量从 0.05 到 0.3 → 含糊度 0~1

  // 不对称 → 局部
  kAsym: 1.0,                    // 偏向 = A × kAsym（想让方向相反就设为负数）
  tentacleSpread: [-0.3, 0, 0.3],// 控制层：三根触手对不对称的反应强弱不同（倾向一侧时靠那边的弯得更多）
  phaseMax: 0.5,                 // 不对称时两侧呼吸最多错开半个呼吸周期 → 摇摆、扭动
  ampSkew: 0.6,                  // 不对称时两侧呼吸幅度的差别（偏向那侧 ×1.6，另一侧 ×0.4）
  trSideFrom: 0.3,               // |A| 超过这个值时，微颤只加在偏向的那一侧

  // 主导状态切换时的一次性动作：[动作, 幅度]
  transitionGestures: {
    excited: ['unfurl', 0.9],    // 舒展
    tense: ['curl', 0.7],        // 蜷缩
    low: ['curl', 0.5],
    calm: null,
    ambiguous: ['wave', 0.7],    // 摆动：A、B 先后各拉一下
  },
  stateConfirmMs: 1000,
  gestureMinGapMs: 3000,
};

const DISCRETE = new Set(['curve']);

/** 控制层：每根触手的目标（三根各不相同） */
export function tentacleTargets(curl, A, cfg = config) {
  return cfg.tentacleSpread.map((s) => ({
    curl: clamp(curl * (1 + s * Math.abs(A))),
    lean: clamp((A * cfg.kAsym) * (1 + s), -1, 1),
  }));
}

/**
 * 硬件层：三根触手的目标 → 两个电机能做到的（整体卷曲 + 外 / 内偏向）。
 * 现在两个电机同时拉三根触手，只能取平均，三根之间的差别做不出来（见文件开头）。
 */
export function toHardware(tentacles) {
  const n = tentacles.length;
  return {
    curl: tentacles.reduce((s, t) => s + t.curl, 0) / n,
    lean: tentacles.reduce((s, t) => s + t.lean, 0) / n,
  };
}

/** LMA → { valence, arousal } */
export function moodFromLMA({ O = 0, W = 0, F = 0 }, cfg = config) {
  return { valence: clamp(O - W, -1, 1), arousal: clamp(cfg.arousalFlow * F + (1 - cfg.arousalFlow) * O) };
}

/** 每秒"来回"的量：走过的总路程减去净移动，再除以时间（一次干脆的移动 ≈ 0，来回摆 → 大） */
function backAndForth(xs, seconds) {
  if (xs.length < 3 || seconds <= 0) return 0;
  let path = 0;
  for (let i = 1; i < xs.length; i++) path += Math.abs(xs[i] - xs[i - 1]);
  return Math.max(0, path - Math.abs(xs[xs.length - 1] - xs[0])) / seconds;
}

// =====================================================================
// 映射器
// =====================================================================
export function createTentacleMapper(cfg = config, protocol) {
  let state = null, present = false, lastTs = null;
  const sm = { O: 0, W: 0, A: 0, F: 0 };
  let history = [];               // 含糊度用：{t, A, O}
  const tracker = createTransitionTracker(cfg);
  let pendingGesture = null;

  /** input: { O, W, A, F, present }，可选 ambiguity（调试面板直接指定） */
  function update(input, now) {
    present = !!input.present;
    const dt = lastTs == null ? 0 : Math.min(0.5, (now - lastTs) / 1000);
    lastTs = now;
    const k = dt === 0 ? 1 : 1 - Math.exp(-dt / cfg.inputTau);
    if (present) for (const key of ['O', 'W', 'A', 'F']) sm[key] += ((input[key] ?? 0) - sm[key]) * (state ? k : 1);

    // 含糊度：最近 3 秒身体左右摇摆、开合来回变的程度
    if (present) history.push({ t: now, A: input.A ?? 0, O: input.O ?? 0 });
    history = history.filter((h) => now - h.t <= cfg.wobbleWindowMs);
    const span = history.length > 1 ? (history[history.length - 1].t - history[0].t) / 1000 : 0;
    const wobble = Math.max(ramp(backAndForth(history.map((h) => h.A), span), ...cfg.wobbleAsym),
                            ramp(backAndForth(history.map((h) => h.O), span), ...cfg.wobbleOpen));
    const ambiguity = input.ambiguity ?? wobble;

    const calm = cfg.anchors.calm.at;
    const mood = present ? moodFromLMA(sm, cfg) : calm;
    const st = blendAnchors(mood.valence, mood.arousal, present ? ambiguity : 0, { ...cfg, discrete: DISCRETE });

    // 不对称 → 每根触手的目标（控制层）→ 两个电机（硬件层）
    const A = present ? clamp(sm.A, -1, 1) : 0;
    const tentacles = tentacleTargets(st.S.pos, A, cfg);
    const hw = toHardware(tentacles);
    const a = Math.abs(A);
    const L = {
      lean: hw.lean,
      phaseAB: Math.sign(A) * a * cfg.phaseMax * st.S.per,
      ampA: clamp(1 + cfg.ampSkew * A, 0, 2),
      ampB: clamp(1 - cfg.ampSkew * A, 0, 2),
      trSide: a > cfg.trSideFrom ? (A > 0 ? 1 : 2) : 0,
    };
    state = { ...st, S: { ...st.S, pos: hw.curl }, L, tentacles, lma: { ...sm }, mood, ambiguity };

    const g = tracker.update(state.dominant, now, present);
    if (g) pendingGesture = g;
    return getState();
  }

  function frames(now, sender) {
    if (!state || !sender) return [];
    const out = sender.update({ S: state.S, L: state.L }, now, false);
    if (pendingGesture && protocol) {
      const line = sender.gesture(protocol.GESTURES.T[pendingGesture[0]], pendingGesture[1], now);
      if (line) { out.push(line); pendingGesture = null; }
    }
    return out;
  }

  function getState() { return state && { ...state, shown: tracker.shown, present }; }
  function trigger(name, amp = 0.8) { pendingGesture = [name, amp]; }

  return { update, frames, getState, trigger };
}

/*
 * =====================================================================
 * 自检（默认参数）
 * =====================================================================
 * 打开调试面板（检测页按 C），把触手切到"手动"：
 *   平静   微微收着（两成），10 秒一次的慢呼吸
 *   兴奋   切换时先舒展一下；之后几乎全放开、4 秒一次的深呼吸、细小的微颤
 *   紧张   切换时蜷一下；之后急收到六成（慢起急停）、在顶上绷 2 秒、明显的 8Hz 抖动
 *   低落   缓慢下沉蜷到八成，很久才放松（×4），不呼吸
 *   犹豫   收到一半常常停住或放回去；每次进入时 A、B 先后各拉一下（摆动）
 *   不对称 （A 滑块拉向一侧）偏向那侧的线收得更多、那侧呼吸更深，两侧呼吸错开 → 触手摇摆；
 *          |A| > 0.3 时微颤只在偏向那一侧
 * 假数据测试：node tentacle-mapping.test.mjs
 */
