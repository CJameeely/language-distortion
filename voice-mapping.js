/**
 * voice-mapping.js —— 《语言失真》语音语调 → 气囊花姿态 → 气路控制目标
 *
 * 只做数据转换：不含 UI、串口、音频采集。
 *
 *   import { updateFeatures, updateEmotion, getState, toCommand, config } from './voice-mapping.js';
 *
 *   // 每帧（Web Audio 分析循环里，现有页面约 20 帧/秒）
 *   updateFeatures({ rms, pitchHz, zcr }, performance.now());
 *   // 约每 3 秒（wav2vec2 情绪模型出结果时）
 *   updateEmotion({ angry, happy, neutral, sad }, performance.now());
 *   // 需要发送时
 *   serialWrite(toCommand(getState()) + '\n');   // "P,target,rate"，两个值都是 0–1000
 *
 * 背景：
 *   - 气囊花是可充放气的软体气囊。气路：两个气泵，一个充气、一个抽气（L298N 驱动）
 *   - 开环系统，没有气压传感器：充气程度只能由 Arduino 按充放气时间估计
 *   - 气泵有物理反应时间，开关太快没有效果还会损耗元件 → 第四步有最小变化量和最小间隔
 *   - 气囊花读的是人控制不了的那部分声音：语调里的颤抖、音量的起伏、说话的节奏。
 *     它是迟缓的镜子，不是音量表
 *
 * 管线：
 *   1. 声音特征：speaking、intensity 强度、pitchVar 音高起伏、tremor 颤抖、rhythm 节奏
 *   2. 情绪：模型四类概率 → valence 效价 / arousal 唤醒度（缓慢过渡，不确定时更多依赖声音特征）
 *   3. 姿态：fill 充盈度 + breath 呼吸（周期 20~40 秒 / 深度）+ shiver 颤动，全部指数缓动（tau）
 *   4. 气路：target 目标充盈度、rate 急缓程度 → toPneumatic() → 0–1000 整数
 */

// =====================================================================
// 可调参数（运行时可直接改 config.xxx，或用 setConfig({...})）
// =====================================================================
export const config = {
  // ---- 第一步：声音特征 ----
  noiseFloorInit: 0.005,      // 噪声底初值（rms）
  noiseFloorMin: 0.0005,      // 噪声底下限，避免安静房间里噪声底趋近 0 后一点声音就算说话
  noiseRiseTau: 10,           // 噪声底上升的时间常数（秒）：环境变吵时慢慢跟上
  noiseLockMs: 20000,         // 有声时噪声底不上升（说话不会把它抬高）；但连续 20 秒没有一帧安静，
                              // 多半是环境噪声变大了（风扇、人群），这时才允许上升
  noiseFallTau: 0.8,          // 噪声底下降的时间常数（秒）：较快，安静下来立刻跟上
  speakRatio: 2.5,            // rms 超过 噪声底 × 2.5 才算有声
  speakMinRms: 0.006,         // 同时必须超过这个绝对值
  speakHoldMs: 600,           // 有声后保持“在说话”这么久，词与词之间的停顿不算沉默
  intensityDbRange: 30,       // 高出噪声底 30dB → intensity = 1

  pitchMinHz: 60,             // 有效基频范围，范围外视为 YIN 误判
  pitchMaxHz: 600,
  pitchWindowMs: 2000,        // pitchVar 统计最近 2 秒的有效基频
  pitchVarLow: 0.8,           // 基频标准差（半音）≤ 0.8 → pitchVar = 0（平板的语调）
  pitchVarHigh: 5,            // ≥ 5 半音 → pitchVar = 1（大起大落）

  // tremor 用基频的二阶差分：滑音、语调起伏这种“平滑的变化”二阶差分很小，相邻帧的抖动才大。
  // 按约 20 帧/秒（现有页面的分析频率）标定；帧率差很多时需要重调 tremorLow / tremorHigh
  tremorWindowMs: 600,        // 统计最近 0.6 秒
  tremorMaxGapMs: 150,        // 相邻有效基频帧间隔超过这个值就断开（中间有无声帧）
  tremorJumpMax: 2,           // 相邻帧基频跳变超过 2 半音视为 YIN 误判 / 音节切换，不计入
  tremorLow: 0.15,            // 平均二阶差分（半音）≤ 0.15 → tremor = 0
  tremorHigh: 1.2,            // ≥ 1.2 → tremor = 1

  rhythmWindowMs: 2500,       // 语速统计窗口
  syllableRateLow: 1.5,       // rms 包络起伏 ≤ 1.5 次/秒 → 慢
  syllableRateHigh: 5.5,      // ≥ 5.5 次/秒 → 快
  zcrLow: 0.03,               // 过零率（每个采样点的过零次数）
  zcrHigh: 0.12,
  rhythmZcrMix: 0.3,          // rhythm = 0.7 × 包络起伏频率 + 0.3 × 过零率

  featureSmoothTau: 0.25,     // 声音特征只做轻度平滑（秒），去掉帧间噪声

  // ---- 第二步：情绪坐标 ----
  valenceHappy: 1.0,          // valence = 1.0 × happy − 0.8 × (angry + sad)
  valenceNegative: 0.8,
  arousalWeights: { angry: 0.9, happy: 0.7, neutral: 0.3, sad: 0.15 },
  moodTau: 2.0,               // 模型结果约 3 秒更新一次，valence / arousal 用这个时间常数过渡
  confidenceMin: 0.4,         // 最大概率 ≥ 0.4 → 完全采信模型
  confidenceFloor: 0.25,      // 最大概率 ≤ 0.25（四类平均）→ 完全不采信，之间线性
  modelStaleMs: 10000,        // 超过这么久没有新的模型结果（模型没加载等），逐渐不再采信
  arousalModelMix: 0.6,       // arousal = 0.6 × 模型 + 0.4 × 声音
  arousalIntensityMix: 0.6,   // 声音部分 = 0.6 × intensity + 0.4 × pitchVar
  // 模型不确定时 valence 改用声音粗估：语调生动略偏正，颤抖偏负（幅度有限）
  acousticValencePitch: 0.8,
  acousticValenceTremor: 0.6,
  acousticValenceMax: 0.5,

  // ---- 第三步：气囊花姿态 ----
  tau: 2.0,                   // 延迟表达的时间常数（秒）：越大越迟缓
  fillLow: 0.25,              // arousal = 0 时的充盈度
  fillHigh: 0.85,             // arousal = 1 时的充盈度
  sadFill: 0.12,              // sad 占主导时塌下去的目标充盈度
  sadTauScale: 2.5,           // sad 泄气时缓动更慢（tau × 2.5）
  // 呼吸周期范围（秒）：rhythm 高 → 短。按现在的气泵定的（全功率充满约 52 秒、放空约 95 秒），
  // 2~8 秒的呼吸在实物上几乎看不出来；换更快的气路时可以调短
  breathPeriodMin: 20,
  breathPeriodMax: 40,
  breathDepthNeutral: 0.07,   // 呼吸幅度（充盈度 ±），valence = 0
  breathDepthPositive: 0.15,  // valence = +1：大而圆润
  breathDepthNegative: 0.03,  // valence = −1：小
  shiverMax: 0.15,            // 颤动幅度上限：最多占 0–1 总行程的 15%
  shiverTremorGain: 1.0,      // 颤动强度 = clamp(1.0 × tremor + 1.0 × 愤怒度)
  shiverAngerGain: 1.0,       // 愤怒度 = 负效价 × 高唤醒（arousal 0.5→1）
  shiverTau: 0.6,             // 颤动强度的缓动（秒），比 tau 快，颤抖要及时
  silenceMs: 4000,            // 连续沉默超过 4 秒 → 回到休息状态
  restTau: 4.0,               // 回休息状态的时间常数（秒），比 tau 更慢
  rest: { fill: 0.3, breathPeriod: 40, breathDepth: 0.04, rate: 0.2 },

  // ---- 第四步：气路控制目标 ----
  rateMin: 0.15,              // rate = 0.15 + 0.85 × arousal
  minChange: 0.03,            // target / rate 与上次输出相差小于 0.03 就不更新
  shiverMinIntervalMs: 300,   // 颤动造成的目标变化，间隔不短于 300ms（颤动越弱间隔越长，最长 2 倍）

  // ---- 其他 ----
  maxDt: 0.5,                 // 单帧最大时间步（秒）：标签页切走等长时间停顿后不会跳变
};

/** 合并修改参数（rest、arousalWeights 支持只改其中一项） */
export function setConfig(partial) {
  const { rest, arousalWeights, ...others } = partial;
  Object.assign(config, others);
  if (rest) Object.assign(config.rest, rest);
  if (arousalWeights) Object.assign(config.arousalWeights, arousalWeights);
}

// =====================================================================
// 第四步：气路（气路改变时只改这个函数）
// =====================================================================
/**
 * 姿态 → 发给 Arduino 的控制目标（0–1000 整数）
 * 现在的气路：两个气泵（一个充、一个抽）。Arduino 负责把 target 换算成充气 / 放气时长，
 * 用 rate 决定充放的急缓，并设置最长连续充气时间作为安全上限。
 * 换成“气泵 + 电磁阀”等气路时，在这里做非线性映射、死区或限幅即可。
 */
export function toPneumatic(target, rate) {
  return {
    target: Math.round(clamp(target) * 1000),
    rate: Math.round(clamp(rate) * 1000),
  };
}

// =====================================================================
// 工具
// =====================================================================
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpFactor = (dt, tau) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
const ease = (cur, target, dt, tau) => cur + (target - cur) * lerpFactor(dt, tau);
const ramp = (v, from, to) => clamp((v - from) / (to - from));   // from→0, to→1
const num = (v) => (Number.isFinite(v) ? v : 0);
const semitones = (hz) => 12 * Math.log2(hz / 55);

function std(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

// =====================================================================
// 映射器
// =====================================================================
export function createVoiceMapper(cfg = config) {
  let lastTs;

  // 第一步
  let noiseFloor, lastLoudTs, lastQuietTs, speechStartTs, wasSpeaking;
  let pitchBuf, tremorBuf, prevSt, prevSt2;   // prevSt / prevSt2：最近两个有效基频 {t, st}
  let envFast, envSlow, envAbove, onsets;
  const voice = { speaking: false, intensity: 0, pitchVar: 0, tremor: 0, rhythm: 0 };

  // 第二步
  let emoTarget, lastEmotionTs;
  const moodModel = { valence: 0, arousal: 0, trust: 0, sadness: 0 };
  const mood = { valence: 0, arousal: 0, confidence: 0 };

  // 第三步
  const flower = { fill: 0, breathPeriod: 0, breathDepth: 0, shiver: 0 };
  let rate, breathPhase, shiverOffset, shiverSign, lastShiverTs;
  let present;

  // 第四步
  let outTarget, outRate;
  let pneumatic;

  // ---------- 第一步：声音特征 ----------
  function updateVoice(rms, pitchHz, zcr, ts, dt) {
    const threshold = Math.max(noiseFloor * cfg.speakRatio, cfg.speakMinRms);
    const loud = rms > threshold;

    // 自适应噪声底：比它安静就较快跟下来；没有声音时慢慢跟上去；有声时不动，除非太久没安静过
    if (!loud) lastQuietTs = ts;
    if (rms < noiseFloor) noiseFloor = ease(noiseFloor, rms, dt, cfg.noiseFallTau);
    else if (!loud || ts - lastQuietTs > cfg.noiseLockMs) noiseFloor = ease(noiseFloor, rms, dt, cfg.noiseRiseTau);
    noiseFloor = Math.max(noiseFloor, cfg.noiseFloorMin);

    if (loud) lastLoudTs = ts;
    const speaking = lastLoudTs != null && ts - lastLoudTs <= cfg.speakHoldMs;
    if (speaking && !wasSpeaking) speechStartTs = ts;
    wasSpeaking = speaking;
    voice.speaking = speaking;

    // intensity：说话时相对噪声底的分贝数
    const intensityRaw = speaking && rms > noiseFloor
      ? ramp(20 * Math.log10(rms / noiseFloor), 0, cfg.intensityDbRange) : 0;

    // 基频：只统计说话中、范围内的有效值
    const voiced = speaking && pitchHz >= cfg.pitchMinHz && pitchHz <= cfg.pitchMaxHz;
    let pitchVarRaw = null, tremorRaw = null;
    if (voiced) {
      const st = semitones(pitchHz);
      pitchBuf.push({ t: ts, st });

      // tremor：连续三帧有效基频的二阶差分（去掉了语调的平滑起伏，只留相邻帧的细小抖动）
      const linked = (a, b) => a && b.t - a.t <= cfg.tremorMaxGapMs && Math.abs(b.st - a.st) <= cfg.tremorJumpMax;
      const cur = { t: ts, st };
      if (linked(prevSt, cur) && linked(prevSt2, prevSt)) {
        tremorBuf.push({ t: ts, d2: Math.abs(st - 2 * prevSt.st + prevSt2.st) });
      }
      if (prevSt && !linked(prevSt, cur)) prevSt = null;   // 断开：重新开始一段
      prevSt2 = prevSt;
      prevSt = cur;
    } else {
      prevSt = prevSt2 = null;
    }
    while (pitchBuf.length && ts - pitchBuf[0].t > cfg.pitchWindowMs) pitchBuf.shift();
    while (tremorBuf.length && ts - tremorBuf[0].t > cfg.tremorWindowMs) tremorBuf.shift();
    if (voiced && pitchBuf.length >= 5) {
      pitchVarRaw = ramp(std(pitchBuf.map((p) => p.st)), cfg.pitchVarLow, cfg.pitchVarHigh);
    }
    if (voiced && tremorBuf.length >= 3) {
      const mean = tremorBuf.reduce((a, b) => a + b.d2, 0) / tremorBuf.length;
      tremorRaw = ramp(mean, cfg.tremorLow, cfg.tremorHigh);
    }

    // rhythm：rms 包络每秒起伏几次（≈ 音节速率），再混入过零率
    envFast = ease(envFast, rms, dt, 0.04);
    envSlow = ease(envSlow, rms, dt, 0.6);
    let rhythmRaw = null;
    if (speaking) {
      if (!envAbove && loud && envFast > envSlow * 1.2) { envAbove = true; onsets.push(ts); }
      else if (envAbove && envFast < envSlow * 0.9) envAbove = false;
    } else {
      envAbove = false;
    }
    while (onsets.length && ts - onsets[0] > cfg.rhythmWindowMs) onsets.shift();
    if (speaking) {
      // 刚开口时窗口还没填满：按实际说话时长算（至少 1 秒），避免语速被低估
      const windowS = Math.max(1, Math.min(cfg.rhythmWindowMs, ts - speechStartTs) / 1000);
      const syllable = ramp(onsets.length / windowS, cfg.syllableRateLow, cfg.syllableRateHigh);
      const zcrN = ramp(zcr, cfg.zcrLow, cfg.zcrHigh);
      rhythmRaw = (1 - cfg.rhythmZcrMix) * syllable + cfg.rhythmZcrMix * zcrN;
    }

    // 轻度平滑；没说话时 intensity 回零，其余保持最后的值（沉默超过 silenceMs 后由休息状态接管）
    const k = cfg.featureSmoothTau;
    voice.intensity = ease(voice.intensity, intensityRaw, dt, k);
    if (pitchVarRaw != null) voice.pitchVar = ease(voice.pitchVar, pitchVarRaw, dt, k);
    if (tremorRaw != null) voice.tremor = ease(voice.tremor, tremorRaw, dt, k);
    else if (!voiced) voice.tremor = ease(voice.tremor, 0, dt, k * 4);   // 不发声时颤抖慢慢消退
    if (rhythmRaw != null) voice.rhythm = ease(voice.rhythm, rhythmRaw, dt, k);

    present = lastLoudTs != null && ts - lastLoudTs <= cfg.silenceMs;
  }

  // ---------- 第二步：情绪坐标 ----------
  function updateMood(ts, dt) {
    const t = emoTarget;
    const stale = lastEmotionTs == null || ts - lastEmotionTs > cfg.modelStaleMs;
    const trustTarget = t && !stale ? t.trust : 0;

    // 模型结果约 3 秒一跳：用 moodTau 缓慢过渡
    if (t) {
      moodModel.valence = ease(moodModel.valence, t.valence, dt, cfg.moodTau);
      moodModel.arousal = ease(moodModel.arousal, t.arousal, dt, cfg.moodTau);
      moodModel.sadness = ease(moodModel.sadness, t.sadness, dt, cfg.moodTau);
      mood.confidence = ease(mood.confidence, stale ? 0 : t.confidence, dt, cfg.moodTau);
    }
    moodModel.trust = ease(moodModel.trust, trustTarget, dt, cfg.moodTau);
    const trust = moodModel.trust;

    // valence：模型不确定时改用声音粗估
    const acousticValence = !present ? 0 : clamp(
      cfg.acousticValencePitch * (voice.pitchVar - 0.4) - cfg.acousticValenceTremor * voice.tremor,
      -cfg.acousticValenceMax, cfg.acousticValenceMax);
    mood.valence = clamp(lerp(acousticValence, moodModel.valence, trust), -1, 1);

    // arousal = 0.6 × 模型 + 0.4 × 声音；模型不确定时模型所占比例按 trust 下降
    const acousticArousal = cfg.arousalIntensityMix * voice.intensity + (1 - cfg.arousalIntensityMix) * voice.pitchVar;
    const modelShare = cfg.arousalModelMix * trust;
    mood.arousal = clamp(modelShare * moodModel.arousal + (1 - modelShare) * acousticArousal);
  }

  // ---------- 第三步：情绪坐标 → 姿态 ----------
  function updateFlower(ts, dt) {
    let fillT, periodT, depthT, shiverT, rateT, tau;
    if (present) {
      const { valence, arousal } = mood;
      const sadness = moodModel.sadness * moodModel.trust;
      fillT = lerp(lerp(cfg.fillLow, cfg.fillHigh, arousal), cfg.sadFill, sadness);
      periodT = lerp(cfg.breathPeriodMax, cfg.breathPeriodMin, voice.rhythm);
      depthT = valence >= 0
        ? lerp(cfg.breathDepthNeutral, cfg.breathDepthPositive, valence)
        : lerp(cfg.breathDepthNeutral, cfg.breathDepthNegative, -valence);
      const anger = Math.max(0, -valence) * ramp(arousal, 0.5, 1);
      shiverT = cfg.shiverMax * clamp(cfg.shiverTremorGain * voice.tremor + cfg.shiverAngerGain * anger);
      rateT = lerp(cfg.rateMin, 1, arousal);
      tau = fillT < flower.fill && sadness > 0.3 ? cfg.tau * cfg.sadTauScale : cfg.tau;   // 悲伤：慢慢泄气
    } else {
      ({ fill: fillT, breathPeriod: periodT, breathDepth: depthT, rate: rateT } = cfg.rest);
      shiverT = 0;
      tau = cfg.restTau;
    }

    flower.fill = ease(flower.fill, fillT, dt, tau);
    flower.breathPeriod = ease(flower.breathPeriod, periodT, dt, present ? cfg.tau : cfg.restTau);
    flower.breathDepth = ease(flower.breathDepth, depthT, dt, present ? cfg.tau : cfg.restTau);
    flower.shiver = ease(flower.shiver, shiverT, dt, cfg.shiverTau);
    rate = ease(rate, rateT, dt, present ? cfg.tau : cfg.restTau);

    // 呼吸：相位连续累加，周期变化时不会跳
    breathPhase = (breathPhase + dt / Math.max(flower.breathPeriod, 0.1)) % 1;
    const breath = flower.breathDepth * Math.sin(2 * Math.PI * breathPhase);

    // 颤动：短促的小幅充放（正负交替），两次变化至少间隔 shiverMinIntervalMs；越弱间隔越长
    const level = cfg.shiverMax > 0 ? flower.shiver / cfg.shiverMax : 0;
    const interval = cfg.shiverMinIntervalMs * (2 - clamp(level));
    if (lastShiverTs == null || ts - lastShiverTs >= interval) {
      const next = flower.shiver < 0.005 ? 0 : (shiverSign = -shiverSign) * flower.shiver;
      if (next !== shiverOffset) { shiverOffset = next; lastShiverTs = ts; }
    }

    return { target: clamp(flower.fill + breath + shiverOffset), rate: clamp(rate) };
  }

  // ---------- 第四步：姿态 → 气路控制目标 ----------
  function updateOutput(raw) {
    // 变化太小不更新，避免气泵频繁启停
    if (outTarget == null || Math.abs(raw.target - outTarget) >= cfg.minChange) outTarget = raw.target;
    if (outRate == null || Math.abs(raw.rate - outRate) >= cfg.minChange) outRate = raw.rate;
    pneumatic = toPneumatic(outTarget, outRate);
  }

  // ---------- 每帧 ----------
  function updateFeatures(features, timestampMs) {
    const dt = lastTs == null ? 0 : clamp((timestampMs - lastTs) / 1000, 0, cfg.maxDt);
    lastTs = timestampMs;
    const rms = Math.max(0, num(features?.rms));
    const pitchHz = Math.max(0, num(features?.pitchHz));
    const zcr = Math.max(0, num(features?.zcr));

    updateVoice(rms, pitchHz, zcr, timestampMs, dt);
    updateMood(timestampMs, dt);
    updateOutput(updateFlower(timestampMs, dt));
    return getState();
  }

  // ---------- 约每 3 秒：情绪模型 ----------
  function updateEmotion(probs, timestampMs) {
    const p = {};
    let total = 0;
    for (const k of ['angry', 'happy', 'neutral', 'sad']) { p[k] = Math.max(0, num(probs?.[k])); total += p[k]; }
    if (total <= 0) return getState();                       // 无效结果：忽略
    for (const k in p) p[k] /= total;

    const w = cfg.arousalWeights;
    const confidence = Math.max(p.angry, p.happy, p.neutral, p.sad);
    emoTarget = {
      valence: clamp(cfg.valenceHappy * p.happy - cfg.valenceNegative * (p.angry + p.sad), -1, 1),
      arousal: clamp(w.angry * p.angry + w.happy * p.happy + w.neutral * p.neutral + w.sad * p.sad),
      confidence,
      trust: ramp(confidence, cfg.confidenceFloor, cfg.confidenceMin),   // < 0.4 视为不确定，降低权重
      sadness: p.sad === confidence ? p.sad : 0,                        // sad 占主导时才算
    };
    lastEmotionTs = timestampMs;
    return getState();
  }

  function getState() {
    return {
      voice: { ...voice },
      mood: { ...mood },
      flower: { ...flower },
      pneumatic: { ...pneumatic },
      present,
    };
  }

  /** 回到初始状态（休息、无人说话） */
  function reset() {
    lastTs = null;
    noiseFloor = cfg.noiseFloorInit;
    lastLoudTs = null; lastQuietTs = null; speechStartTs = null; wasSpeaking = false;
    pitchBuf = []; tremorBuf = []; prevSt = prevSt2 = null;
    envFast = envSlow = 0; envAbove = false; onsets = [];
    Object.assign(voice, { speaking: false, intensity: 0, pitchVar: 0, tremor: 0, rhythm: 0 });
    emoTarget = null; lastEmotionTs = null;
    Object.assign(moodModel, { valence: 0, arousal: 0, trust: 0, sadness: 0 });
    Object.assign(mood, { valence: 0, arousal: 0, confidence: 0 });
    Object.assign(flower, { fill: cfg.rest.fill, breathPeriod: cfg.rest.breathPeriod, breathDepth: cfg.rest.breathDepth, shiver: 0 });
    rate = cfg.rest.rate;
    breathPhase = 0; shiverOffset = 0; shiverSign = 1; lastShiverTs = null;
    present = false;
    outTarget = null; outRate = null;
    updateOutput({ target: flower.fill, rate });
  }

  reset();
  return { updateFeatures, updateEmotion, getState, reset };
}

/** 拼成发给 Arduino 的命令（不含换行）："P,target,rate" */
export function toCommand(state) {
  const { target, rate } = state.pneumatic;
  return `P,${target},${rate}`;
}

// 默认实例：直接 import { updateFeatures, updateEmotion, getState } 即可
const defaultMapper = createVoiceMapper(config);
export const updateFeatures = defaultMapper.updateFeatures;
export const updateEmotion = defaultMapper.updateEmotion;
export const getState = defaultMapper.getState;
export const reset = defaultMapper.reset;

/*
 * =====================================================================
 * 自检清单（默认参数）
 * =====================================================================
 * 先每秒打印一次 getState()，再做以下测试。每种情况持续 8 秒以上：
 * 姿态有 tau = 2 秒的延迟（约 5 秒到 90%），模型每 3 秒才出一次结果、mood 再用 2 秒过渡。
 *
 * 1. 用自己的声音测试
 *   平静地说话（正常音量、正常语速）
 *     voice   speaking = true；intensity 中等（约 0.3~0.6）；tremor 接近 0
 *     mood    模型多半判 neutral：valence 在 0 附近（略负），arousal 约 0.3~0.5
 *     flower  fill 约 0.45~0.55；breathPeriod 约 30~35 秒；breathDepth 约 0.06~0.07；shiver ≈ 0
 *     pneumatic target 在 fill 上下约 ±70 缓慢起伏（约半分钟一个来回）；rate 约 400~550
 *   大声、激动地说（快、音高起伏大）
 *     voice   intensity → 0.8 以上；pitchVar、rhythm 明显升高
 *     mood    happy → valence 正、arousal > 0.6；angry → valence 负、arousal 高
 *     flower  fill 升到 0.7 以上；breathPeriod 缩短到 20~25 秒
 *             开心：breathDepth 变大（→ 0.15）；愤怒：breathDepth 变小（→ 0.03），shiver 升高
 *     pneumatic target 整体升高；rate → 700 以上；愤怒时 target 有每 0.3~0.6 秒一次的小跳动
 *   低声、慢慢地说
 *     voice   intensity 低（约 0.1~0.3）；rhythm 低
 *     mood    arousal 低；模型判 sad 时 valence 明显为负
 *     flower  fill 下降；sad 占主导时继续缓慢塌到 0.15 附近（比别的变化慢）；breathPeriod 拉长到 35~40 秒
 *     pneumatic target 低，起伏小；rate 低（200~350）
 *   刻意让声音发抖（拉长一个元音，让音高快速小幅抖动）
 *     voice   tremor 升高（0.4 以上），pitchVar 变化不大
 *     flower  shiver 升高（最多 0.15）
 *     pneumatic target 出现短促的小幅充放，相邻两次变化至少间隔 300ms
 *
 * 2. 停止说话后
 *   - 0 ~ 0.6 秒：仍算在说话（speakHoldMs），词间停顿不会被判成沉默
 *   - 0.6 ~ 4 秒：speaking = false、present 仍为 true；intensity 回零，fill 随 arousal 稍降，
 *     其余（节奏、颤抖逐渐消退）保持最后的样子
 *   - 4 秒后：present = false，开始回休息状态（restTau = 4 秒，约 9 秒到 90%）：
 *     fill → 0.3、breathPeriod → 40 秒、breathDepth → 0.04、shiver → 0、rate → 200
 *   - 再开口时立即 present = true，姿态从当前值以 tau 缓动过去
 *
 * 3. 假数据测试：见 voice-mapping.test.mjs（node voice-mapping.test.mjs）
 *   覆盖沉默、平静中性、开心兴奋、愤怒、悲伤低语五种情况，以及模型结果不跳变、
 *   最小变化量、颤动最小间隔、停止说话后回到休息状态。
 */
