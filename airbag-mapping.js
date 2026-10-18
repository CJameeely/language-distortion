/**
 * airbag-mapping.js —— 《语言失真》语调 → 气囊花动作参数
 *
 * 只做"识别结果 → 动作"的映射，不含识别、UI、串口。
 * 输入来自 voice-mapping.js 的 getState()（语音特征 + 情绪），再加上表情的效价（判断"不一致"）：
 *
 *   import { createAirbagMapper } from './airbag-mapping.js';
 *   const airbag = createAirbagMapper();
 *   airbag.update({ valence, arousal, ambiguity, present, tremor, rhythm, faceValence, facePresent }, now);
 *   const lines = airbag.frames(now, sender);
 *
 * 气囊是一个完整的气囊、两个泵（充 / 抽），而且很慢（充满约 52 秒、放空约 95 秒），做不到"快"。
 * 所以状态之间主要靠：充盈程度、呼吸周期、吸呼比例、停顿、规律的微颤脉冲、犹豫 来区分（见参数表）。
 *
 * 局部（表情和语音不一致时）：单个气囊没有"多片花瓣"，改成三种"不协调"：
 *   - 随机抽动：短促地开一下泵，不一致越大越频繁。
 *     抽动的方向有含义：脸比声音积极（强颜欢笑）→ 只抽气，像在泄气；声音比脸积极 → 只充气，像暗涌。
 *   - 吸呼比例偏向急吸（像倒吸一口气）；
 *   - 呼吸节奏变得不规则（周期长短随机变化）。
 *
 * Arduino 会把呼吸幅度按泵的能力自动收窄（保证吸进去和呼出来的量一样，两个方向都看得见），
 * 所以表里的 dep 是"想要的"幅度，周期短的状态实际幅度会小一些。
 */
import { blendAnchors, createTransitionTracker, clamp, lerp, ramp } from './mapping-core.js';

// =====================================================================
// 参数表（直接改这里调手感；运行时也可以改 config.xxx）
// =====================================================================
export const config = {
  //   S：pos 充盈度 0~1 | dur 底层走完全程秒（受泵速限制）| curve 0 匀速 1 缓入缓出 2 快起慢收 3 慢起急停 |
  //      back 往上（重新鼓起）的用时倍数 | per 呼吸周期秒 | dep 呼吸幅度 0~1 | hold 吸到顶停顿秒 |
  //      trA 微颤每次的气量（满行程比例；0.006 ≈ 充气泵开 0.3 秒）| trF 微颤频率 Hz | still 呼到底静止秒 | hes 犹豫 0~1
  //   L：inhale 吸气占呼吸周期的比例（0.5 = 一样长，越小越"急吸"）| jitter 呼吸不规则度 0~1
  anchors: {
    calm: {
      label: '平静', at: { valence: 0, arousal: 0.35 },
      S: { pos: 0.45, dur: 60, curve: 1, back: 1, per: 40, dep: 0.12, hold: 2,   trA: 0,     trF: 0,    still: 2,   hes: 0 },
      L: { inhale: 0.5, jitter: 0 },
    },
    excited: {   // 正效价、高唤醒：饱满、短周期
      label: '兴奋', at: { valence: 0.7, arousal: 0.8 },
      S: { pos: 0.80, dur: 40, curve: 2, back: 1, per: 20, dep: 0.20, hold: 0.5, trA: 0,     trF: 0,    still: 0.5, hes: 0 },
      L: { inhale: 0.5, jitter: 0 },
    },
    tense: {     // 负效价、高唤醒：急吸慢呼、规律的短促脉冲（每 0.6 秒一次）
      label: '紧张', at: { valence: -0.7, arousal: 0.8 },
      S: { pos: 0.60, dur: 30, curve: 3, back: 1, per: 20, dep: 0.08, hold: 0,   trA: 0.006, trF: 1.67, still: 0,   hes: 0.2 },
      L: { inhale: 0.33, jitter: 0.1 },
    },
    low: {       // 负效价、低唤醒：瘪、长呼气后在底部停住 10 秒、重新鼓起很慢
      label: '低落', at: { valence: -0.7, arousal: 0.1 },
      S: { pos: 0.20, dur: 60, curve: 1, back: 3, per: 60, dep: 0.06, hold: 1,   trA: 0,     trF: 0,    still: 10,  hes: 0.2 },
      L: { inhale: 0.4, jitter: 0 },
    },
  },
  // 犹豫（语音情绪模型不确定时叠加）：只覆盖写出的字段
  ambiguous: {
    label: '犹豫',
    S: { per: 30, dep: 0.10, hold: 3, still: 3, hes: 0.8 },
    L: { jitter: 0.3 },
  },
  ambiguityStart: 0.35,
  ambiguityFull: 0.85,
  sharpness: 2,
  valenceScale: 0.5,
  // 情绪模型的最大概率 → 含糊度：概率 ≥ 0.6 → 0，≤ 0.25（四类平均）→ 1
  confidenceSure: 0.6,
  confidenceUnsure: 0.25,

  // 声音本身的修饰
  rhythmPerScale: [1.15, 0.85],   // 说话节奏慢 → 呼吸周期 ×1.15，快 → ×0.85
  tremorVolume: 0.006,            // 声音发抖（tremor = 1）时的微颤气量（同 trA）
  tremorHz: 1.5,                  // 声音发抖时的微颤频率
  tremorMinVolume: 0.0015,        // 混合后微颤气量小于这个就当没有（否则会偶尔冒出一次莫名的抽动）

  // 表情 / 语音不一致 → 局部的"不协调"
  mismatchStart: 0.1,             // 效价差（0~1，|表情效价 − 语音效价| / 2）从这里开始算不一致
  mismatchFull: 0.6,              // 到这里算完全不一致
  twitchEverySlow: 8,             // 刚开始不一致时，平均 8 秒抽动一次
  twitchEveryFast: 1.5,           // 完全不一致时，平均 1.5 秒一次
  twitchLen: [0.2, 0.4],          // 每次抽动开泵多久（秒）
  mismatchInhale: 0.12,           // 吸气比例最多减少这么多（更像倒吸一口气）
  mismatchJitter: 0.5,            // 呼吸不规则度最多加到这么多

  // 主导状态切换时的一次性动作：[动作, 幅度]
  transitionGestures: {
    excited: ['inhale', 0.9],     // 深吸
    tense: ['hold', 0.6],         // 屏息
    low: ['exhale', 0.9],         // 长呼
    calm: null,
    ambiguous: ['twitch', 0.6],   // 抽动一下
  },
  stateConfirmMs: 1500,           // 语音情绪 3 秒才更新一次，确认时间比机械花长
  gestureMinGapMs: 8000,          // 气囊动作慢，两次切换动作至少隔 8 秒
};

const DISCRETE = new Set(['curve']);

/** 混合锚点 + 声音修饰 + 不一致 → { weights, dominant, mismatch, S, L }（人能读的单位） */
export function blend(input, cfg = config) {
  const { valence = 0, arousal = 0.35, ambiguity = 0, tremor = 0, rhythm = 0.5,
          faceValence = 0, facePresent = false, present = true } = input;
  const st = blendAnchors(valence, arousal, ambiguity, { ...cfg, discrete: DISCRETE });
  const S = { ...st.S }, L = { inhale: st.L.inhale, jitter: st.L.jitter, twitchEvery: 0, twitchLen: cfg.twitchLen[0], twitchMode: 0 };

  // 声音本身：节奏快 → 呼吸快；声音发抖 → 微颤
  S.per *= lerp(cfg.rhythmPerScale[0], cfg.rhythmPerScale[1], clamp(rhythm));
  const tr = clamp(tremor);
  if (tr * cfg.tremorVolume > S.trA) { S.trA = tr * cfg.tremorVolume; S.trF = Math.max(S.trF, cfg.tremorHz); }
  if (S.trA < cfg.tremorMinVolume) { S.trA = 0; S.trF = 0; }

  // 表情 / 语音不一致
  const mismatch = facePresent && present ? ramp(Math.abs(faceValence - valence) / 2, cfg.mismatchStart, cfg.mismatchFull) : 0;
  if (mismatch > 0.02) {
    L.twitchEvery = lerp(cfg.twitchEverySlow, cfg.twitchEveryFast, mismatch);
    L.twitchLen = lerp(cfg.twitchLen[0], cfg.twitchLen[1], mismatch);
    L.twitchMode = faceValence > valence ? 2 : 1;          // 脸比声音积极 → 泄气；声音比脸积极 → 暗涌
    L.inhale = Math.max(0.25, L.inhale - cfg.mismatchInhale * mismatch);
    L.jitter = Math.max(L.jitter, cfg.mismatchJitter * mismatch);
  }
  return { ...st, mismatch, S, L };
}

/** 情绪模型的置信度（最大概率）→ 含糊度 0~1 */
export function ambiguityFromConfidence(confidence, cfg = config) {
  return 1 - ramp(confidence, cfg.confidenceUnsure, cfg.confidenceSure);
}

/** 协议用的单位（气囊的 S 已经是 0~1 / 秒 / Hz，不需要换算） */
export function toProtocol({ S, L }) {
  return { S: { ...S }, L: { ...L } };
}

// =====================================================================
// 映射器
// =====================================================================
export function createAirbagMapper(cfg = config, protocol) {
  let state = null, present = false;
  const tracker = createTransitionTracker(cfg);
  let pendingGesture = null;

  function update(input, now) {
    present = !!input.present;
    state = present
      ? blend(input, cfg)
      : blend({ valence: cfg.anchors.calm.at.valence, arousal: cfg.anchors.calm.at.arousal }, cfg);
    const g = tracker.update(state.dominant, now, present);
    if (g) pendingGesture = g;
    return getState();
  }

  function frames(now, sender) {
    if (!state || !sender) return [];
    const out = sender.update(toProtocol(state), now, false);
    if (pendingGesture && protocol) {
      const line = sender.gesture(protocol.GESTURES.P[pendingGesture[0]], pendingGesture[1], now);
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
 * 打开调试面板（检测页按 C），把气囊花切到"手动"：
 *   平静   充到四成多，40 秒一次的慢呼吸，吸呼一样长
 *   兴奋   切换时先深吸一口；之后鼓到八成，20 秒一次的呼吸
 *   紧张   切换时屏息几秒；之后急吸慢呼，每 0.6 秒一次短促的充 / 抽脉冲（看得到、听得到抽动）
 *   低落   切换时长呼一口；之后瘪到两成，长呼气后在底部停 10 秒，重新鼓起很慢
 *   犹豫   （含糊度拉高）呼吸长短不规律，充到一半常常停住或退回
 *   不一致 （把"表情效价"拉到和"语音效价"差很远）随机的短促抽动越来越频繁；
 *          表情比语音积极 → 抽动是往外泄气，反过来 → 往里暗涌
 * 假数据测试：node airbag-mapping.test.mjs
 */
