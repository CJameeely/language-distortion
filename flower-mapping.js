/**
 * flower-mapping.js —— 《语言失真》面部表情 → 机械花动作参数
 *
 * 只做"识别结果 → 动作"的映射，不含识别、UI、串口。
 *
 *   import { createFlowerMapper } from './flower-mapping.js';
 *   const flower = createFlowerMapper();
 *   // 每帧（或表情更新时）
 *   flower.update({ valence, arousal, ambiguity, present }, performance.now());
 *   const lines = flower.frames(performance.now());   // 这一刻该发给 Arduino 的帧（可能为空）
 *
 * 思路（解决"不同情绪的输出区别太小"）：
 *   - 不再只靠开合幅度区分状态。每个状态是一整套动作参数：目标位置、速度、加减速曲线、
 *     呼吸节奏、停顿、微颤、静止时长、犹豫度，再加上 LED 和"小幅试探"的节奏。
 *   - 4 个锚点状态（平静 / 兴奋 / 紧张 / 低落）按 效价 × 唤醒度 平面上的距离混合，
 *     离谁近就更像谁（锐化过，所以主导状态清楚，过渡仍然连续）；含糊度高时再叠加"犹豫"。
 *   - 主导状态切换的那一刻，机械花做一个一次性动作（大开 / 惊缩 / 大合 / 试探），
 *     让观众看得出"它读到了新东西"，而不只是在动。
 *
 * 只有一个舵机，局部感靠：舵机两层动作（小幅试探 vs 大幅开合）+ LED 节奏和舵机错开 + 投影（投影.html）。
 */

// =====================================================================
// 参数表（直接改这里调手感；运行时也可以改 config.xxx）
// =====================================================================
export const config = {
  // 舵机实际行程（度），要和 总体代码.ino 里 ANGLE_MAX − ANGLE_MIN 一致：微颤、试探按"度"写在下面，靠它换算
  servoTravelDeg: 180,

  // 锚点状态：at = 在 效价（−1~1）× 唤醒度（0~1）平面上的位置
  //   S：pos 开合 0~1 | dur 全程秒 | curve 0 匀速 1 缓入缓出 2 快起慢收 3 慢起急停 | back 回程倍数 |
  //      per 呼吸周期秒 | dep 呼吸幅度 0~1 | hold 吸到顶停顿秒 | trDeg 微颤幅度（度）| trF 微颤 Hz |
  //      still 呼到底静止秒 | hes 犹豫 0~1
  //   L：ledLevel 0~255（Arduino 再夹到 60）| ledPer LED 周期秒 | ledMode 0 常亮 1 脉动 2 闪烁 3 断续 |
  //      ledPhase LED 比舵机呼吸晚多少秒（负 = 领先）| probeDeg 试探幅度（度）| probeEvery 试探间隔秒（0 = 不试探）
  anchors: {
    calm: {
      label: '平静', at: { valence: 0, arousal: 0.35 },
      S: { pos: 0.50, dur: 3.0, curve: 1, back: 1, per: 8,  dep: 0.05, hold: 1.0, trDeg: 0,   trF: 0, still: 4,   hes: 0 },
      L: { ledLevel: 25, ledPer: 8,    ledMode: 1, ledPhase: 0,    probeDeg: 4, probeEvery: 6 },
    },
    excited: {   // 正效价、高唤醒：快、短周期、带微颤
      label: '兴奋', at: { valence: 0.7, arousal: 0.8 },
      S: { pos: 0.90, dur: 1.2, curve: 2, back: 1, per: 3,  dep: 0.10, hold: 0.3, trDeg: 1.5, trF: 6, still: 0.5, hes: 0 },
      L: { ledLevel: 55, ledPer: 1.5,  ledMode: 1, ledPhase: -0.2, probeDeg: 0, probeEvery: 0 },
    },
    tense: {     // 负效价、高唤醒：急、慢起急停、强微颤，LED 与舵机反相
      label: '紧张', at: { valence: -0.7, arousal: 0.8 },
      S: { pos: 0.30, dur: 0.6, curve: 3, back: 1, per: 2,  dep: 0.03, hold: 0.2, trDeg: 3,   trF: 9, still: 0.3, hes: 0.1 },
      L: { ledLevel: 45, ledPer: 0.14, ledMode: 2, ledPhase: 1.0,  probeDeg: 0, probeEvery: 0 },
    },
    low: {       // 负效价、低唤醒：慢、合上后迟迟不回（回程 ×4）、长时间停在底部，LED 滞后 2 秒
      label: '低落', at: { valence: -0.7, arousal: 0.1 },
      S: { pos: 0.15, dur: 2.5, curve: 1, back: 4, per: 12, dep: 0.02, hold: 0.5, trDeg: 0,   trF: 0, still: 8,   hes: 0.2 },
      L: { ledLevel: 10, ledPer: 12,   ledMode: 1, ledPhase: 2.0,  probeDeg: 2, probeEvery: 15 },
    },
  },
  // 犹豫（含糊度高时叠加）：只覆盖这里写出的字段，开合目标保持上面混合出来的值
  ambiguous: {
    label: '犹豫',
    S: { dur: 2.0, curve: 1, per: 6, dep: 0.04, hold: 1.5, trDeg: 0.8, trF: 3, still: 3, hes: 0.8 },
    L: { ledLevel: 20, ledPer: 3, ledMode: 3, ledPhase: 0.7, probeDeg: 8, probeEvery: 2.5 },
  },
  ambiguityStart: 0.35,    // 含糊度从这里开始叠加犹豫
  ambiguityFull: 0.85,     // 到这里完全是"犹豫"
  sharpness: 2,            // 锚点混合的锐度：越大越"非此即彼"，越小越平均
  valenceScale: 0.5,       // 算距离时效价乘这个数（效价范围 2，唤醒度范围 1）

  // 主导状态切换时的一次性动作（让观众看出"读到了新东西"）：[动作, 幅度 0~1]
  transitionGestures: {
    excited: ['open', 0.95],   // 大开
    tense: ['flinch', 0.3],    // 惊缩：快速合上一下
    low: ['close', 0.85],      // 大合
    calm: null,
    ambiguous: ['probe', 0.6], // 试探
  },
  stateConfirmMs: 800,       // 新的主导状态要持续这么久才算切换（避免表情抖动时来回触发）
  gestureMinGapMs: 2500,     // 两次切换动作至少间隔（太短会让快速变化的表情不停地触发大动作）

  absentMs: 5000,            // 看不到脸这么久 → 回到平静
};

import { blendAnchors, createTransitionTracker, clamp } from './mapping-core.js';

const DISCRETE = new Set(['curve', 'ledMode', 'ledPhase']);   // 不能平均的：取主导状态的值

/** 混合锚点：返回 { weights, dominant, S, L }（S/L 为人能读的单位，含 trDeg/probeDeg） */
export function blend(valence, arousal, ambiguity, cfg = config) {
  return blendAnchors(valence, arousal, ambiguity, { ...cfg, discrete: DISCRETE });
}

/** 人能读的单位 → 协议用的 0~1（度换算成满行程的比例） */
export function toProtocol({ S, L }, cfg = config) {
  const deg = (d) => clamp(d / cfg.servoTravelDeg);
  return {
    S: { pos: S.pos, dur: S.dur, curve: S.curve, back: S.back, per: S.per, dep: S.dep, hold: S.hold,
         trA: deg(S.trDeg), trF: S.trF, still: S.still, hes: S.hes },
    L: { ledLevel: L.ledLevel, ledPer: L.ledPer, ledMode: L.ledMode, ledPhase: L.ledPhase,
         probeAmp: L.probeEvery > 0 ? deg(L.probeDeg) : 0, probeEvery: L.probeEvery },
  };
}

// =====================================================================
// 映射器：输入表情，输出该发的帧
// =====================================================================
export function createFlowerMapper(cfg = config, protocol) {
  let state = null;              // 最近一次 blend 的结果
  const tracker = createTransitionTracker(cfg);
  let lastSeenAt = -Infinity, present = false;
  let pendingGesture = null;     // [动作, 幅度]

  function update({ valence = 0, arousal = 0.35, ambiguity = 0, present: seen = true }, now) {
    if (seen) lastSeenAt = now;
    present = now - lastSeenAt <= cfg.absentMs;
    state = present
      ? blend(valence, arousal, ambiguity, cfg)
      : blend(cfg.anchors.calm.at.valence, cfg.anchors.calm.at.arousal, 0, cfg);

    // 主导状态持续 stateConfirmMs 才算切换；切换时排一个一次性动作
    const g = tracker.update(state.dominant, now, present);
    if (g) pendingGesture = g;
    return getState();
  }

  /** 交给 plant-protocol.js 的发送器：只在参数明显变化 / 心跳 / 有一次性动作时返回帧 */
  function frames(now, sender) {
    if (!state || !sender) return [];
    const out = sender.update(toProtocol(state, cfg), now, false);
    if (pendingGesture && protocol) {
      const line = sender.gesture(protocol.GESTURES.F[pendingGesture[0]], pendingGesture[1], now);
      if (line) { out.push(line); pendingGesture = null; }
    }
    return out;
  }

  function getState() {
    return state && { ...state, shown: tracker.shown, present };
  }

  /** 调试面板：立即触发一个一次性动作（不经过识别） */
  function trigger(name, amp = 0.8) { pendingGesture = [name, amp]; }

  return { update, frames, getState, trigger };
}

/*
 * =====================================================================
 * 自检（默认参数）
 * =====================================================================
 * 打开调试面板（检测页按 C），把机械花切到"手动"，拖滑块或点状态按钮：
 *   平静   缓慢呼吸（8 秒一次），每 6 秒左右一次 4° 的小幅试探；LED 跟着呼吸慢慢脉动
 *   兴奋   切换时先大幅张开一次；之后张得很开、3 秒一次快呼吸、细小快速的微颤；LED 快脉动、略领先
 *   紧张   切换时快速缩一下；之后半合、2 秒急促呼吸、明显的 9Hz 抖动；LED 不规则闪烁、和舵机反相
 *   低落   切换时大幅合上；之后合得很紧、要很久才张开一点（回程 ×4），在底部停 8 秒；LED 很暗、晚 2 秒
 *   犹豫   （含糊度拉高）每 2~3 秒试探一次 8°；开合动作走到一半常常停住或退回；LED 断断续续
 * 任意两个状态之间来回切，应该一眼能分出节奏、停顿、抖不抖，而不只是开得大还是小。
 * 假数据测试：node flower-mapping.test.mjs
 */
