/**
 * posture-mapping.js —— 《语言失真》身体姿态 → 触手姿态 → 电机目标
 *
 * 只做数据转换：不含 UI、串口、姿态检测。
 *
 *   import { update, getState, toCommand, config } from './posture-mapping.js';
 *
 *   // 每帧（MediaPipe Pose 回调里）
 *   update(results.poseLandmarks ?? null, performance.now());
 *   const s = getState();
 *   serialWrite(toCommand(s) + '\n');      // "T,a,b,s"，三个值都是 0–1000
 *
 * 管线：
 *   1. 身体 → LMA 特征：O 开放度、W 沉重感、A 不对称度、F 流动性（全部用肩宽归一化，轻度平滑）
 *   2. LMA → 触手姿态：curl 卷曲度、lean 偏向、speed 速度（指数缓动，时间常数 tau，形成“迟缓的镜子”）
 *   3. 触手姿态 → 两根线：mixLines(curl, lean)，再对 a + b 加软上限
 *
 * 坐标约定：MediaPipe 归一化坐标 x 向右、y 向下。x 按画面宽度归一化，y 按画面高度归一化，
 * 所以先乘 config.aspectRatio（宽/高）换算成同一尺度，水平和竖直距离才能和肩宽比较。
 */

// =====================================================================
// 可调参数（运行时可直接改 config.xxx，或用 setConfig({...})）
// =====================================================================
export const config = {
  // ---- 输入 ----
  aspectRatio: 16 / 9,        // 摄像头画面 宽/高，按实际设置：video.videoWidth / video.videoHeight
  visibilityMin: 0.5,         // 关键点 visibility 低于此值视为不可见

  // ---- 第一步：LMA 特征 ----
  landmarkSmoothTau: 0.08,    // 关键点轻度平滑（秒），去抖动
  featureSmoothTau: 0.15,     // O/W/A/F 轻度平滑（秒）
  openRatioMin: 0.5,          // 双腕距离/肩宽 ≤ 此值 → O = 0（双手收拢在胸前）
  openRatioMax: 3.0,          // 双腕距离/肩宽 ≥ 此值 → O = 1（双臂平举张开）
  headUpRatio: 0.7,           // 鼻子高出肩中点 ≥ 0.7 肩宽 → 头部不下垂（W_head = 0）
  headDownRatio: 0.1,         // 鼻子高出肩中点 ≤ 0.1 肩宽 → 完全低头（W_head = 1）
  torsoUpRatio: 1.6,          // 肩中点到髋中点 ≥ 1.6 肩宽 → 躯干挺直（W_torso = 0）
  torsoDownRatio: 0.9,        // ≤ 0.9 肩宽 → 躯干完全压缩（弯腰/蜷缩，W_torso = 1）
  torsoMix: 0.4,              // 双髋可见时，躯干压缩在 W 中所占比例
  asymRange: 0.3,             // 两肩高度差达到 0.3 肩宽 → |A| = 1
  flowFloor: 0.1,             // 低于 0.1 肩宽/秒的移动视为静止（吸收残余抖动）
  flowMax: 2.0,               // 达到 2 肩宽/秒 → F = 1

  // ---- 第二步：触手姿态 ----
  kOpen: 0.6,
  kWeight: 0.7,
  curlOffset: 0.25,           // curl = clamp(kOpen·(1−O) + kWeight·W − curlOffset)
  kAsym: 1.0,                 // lean = clamp(A·kAsym)；想让镜像方向相反就设为负数
  speedMin: 0.15,             // speed = speedMin + (1 − speedMin)·F
  tau: 1.4,                   // 延迟表达的时间常数（秒）：越大越迟缓

  // ---- 无人 ----
  absentDelayMs: 1500,        // 连续这么久没人，才开始回休息姿态（期间保持最后的姿态）
  restTau: 3.0,               // 回休息姿态的时间常数（秒），比 tau 更慢
  rest: { curl: 0.12, lean: 0, speed: 0.1 },

  // ---- 第三步：电机 ----
  sumMax: 1.4,                // a + b 的上限（两根线都收满会压坏网管）
  sumSoftness: 0.2,           // 软上限的过渡宽度：a + b 超过 sumMax − sumSoftness 后逐渐压缩

  // ---- 其他 ----
  maxDt: 0.5,                 // 单帧最大时间步（秒）。标签页切走等长时间停顿后不会跳变
};

/** 合并修改参数（rest 支持只改其中一项） */
export function setConfig(partial) {
  const { rest, ...others } = partial;
  Object.assign(config, others);
  if (rest) Object.assign(config.rest, rest);
}

// =====================================================================
// 第三步：走线方式（改走线时只改这个函数）
// =====================================================================
/**
 * 触手姿态 → 两根线的收线量（0–1）
 * 默认走线：两根线分别沿网管两侧。lean > 0 时更多收 a 线、放 b 线，触手弯向 a 侧。
 */
export function mixLines(curl, lean) {
  return {
    a: curl * Math.min(1, 1 + lean),
    b: curl * Math.min(1, 1 - lean),
  };
}

/** a + b 软上限：低于膝点不变，超过后用 tanh 平滑压到 sumMax 以内，并保持 a:b 比例 */
export function limitSum(a, b, sumMax, softness) {
  const s = a + b;
  if (s <= 0) return { a, b };
  let sNew;
  if (softness <= 0) {
    sNew = Math.min(s, sumMax);
  } else {
    const knee = sumMax - softness;
    if (s <= knee) return { a, b };
    sNew = knee + softness * Math.tanh((s - knee) / softness);
  }
  const k = sNew / s;
  return { a: a * k, b: b * k };
}

// =====================================================================
// 工具
// =====================================================================
const NOSE = 0, L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16, L_HIP = 23, R_HIP = 24;
const USED_POINTS = [NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP];
const FLOW_POINTS = [NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR];

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerpFactor = (dt, tau) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
const ease = (cur, target, dt, tau) => cur + (target - cur) * lerpFactor(dt, tau);
const ramp = (v, from, to) => clamp((v - from) / (to - from));   // from→0, to→1，可反向

// =====================================================================
// 映射器
// =====================================================================
export function createPostureMapper(cfg = config) {
  let lastTs = null;          // 上一帧时间戳（ms）
  let lastSeenTs = null;      // 最后一次看到人的时间戳（ms）
  let present = false;
  let fresh = true;           // 下一次看到人时直接初始化（不从旧值平滑过来）

  const pts = new Map();      // 平滑后的关键点 idx → {x, y}（已乘宽高比）
  let prevFlowPts = null;     // 上一帧用于计算流动性的点

  const lma = { O: 0, W: 0, A: 0, F: 0 };
  const posture = { ...cfg.rest };
  let target = { ...cfg.rest };
  const motors = { a: 0, b: 0, speed: 0 };

  const visible = (p) =>
    p != null && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 1) >= cfg.visibilityMin;

  // ---------- 第一步：身体 → LMA ----------
  function smoothLandmarks(lm, dt) {
    const k = fresh ? 1 : lerpFactor(dt, cfg.landmarkSmoothTau);
    for (const idx of USED_POINTS) {
      const p = lm[idx];
      if (!visible(p)) { pts.delete(idx); continue; }
      const x = p.x * cfg.aspectRatio, y = p.y;
      const s = pts.get(idx);
      if (!s) pts.set(idx, { x, y });
      else { s.x += (x - s.x) * k; s.y += (y - s.y) * k; }
    }
  }

  function computeRawLMA(dt, sw) {
    const g = (i) => pts.get(i);
    const lSh = g(L_SH), rSh = g(R_SH);
    const midShY = (lSh.y + rSh.y) / 2;
    const raw = { O: null, W: null, A: null, F: null };

    // Openness：双腕水平距离 / 肩宽
    if (g(L_WR) && g(R_WR)) {
      raw.O = ramp(Math.abs(g(L_WR).x - g(R_WR).x) / sw, cfg.openRatioMin, cfg.openRatioMax);
    }

    // Weight：头部下垂（+ 躯干压缩）
    let wHead = null, wTorso = null;
    if (g(NOSE)) {
      const headH = (midShY - g(NOSE).y) / sw;                     // 鼻子高出肩中点多少个肩宽
      wHead = ramp(headH, cfg.headUpRatio, cfg.headDownRatio);
    }
    if (g(L_HIP) && g(R_HIP)) {
      const torso = ((g(L_HIP).y + g(R_HIP).y) / 2 - midShY) / sw;  // 躯干长度（肩宽）
      wTorso = ramp(torso, cfg.torsoUpRatio, cfg.torsoDownRatio);
    }
    if (wHead != null && wTorso != null) raw.W = (1 - cfg.torsoMix) * wHead + cfg.torsoMix * wTorso;
    else raw.W = wHead ?? wTorso;

    // Asymmetry：两肩高度差。正 = 本人左肩（11）更低
    raw.A = clamp((lSh.y - rSh.y) / sw / cfg.asymRange, -1, 1);

    // Flow：各点平均速度（肩宽/秒）
    if (prevFlowPts && dt > 0) {
      let sum = 0, n = 0;
      for (const idx of FLOW_POINTS) {
        const a = prevFlowPts.get(idx), b = pts.get(idx);
        if (a && b) { sum += Math.hypot(b.x - a.x, b.y - a.y); n++; }
      }
      if (n > 0) raw.F = ramp(sum / n / dt / sw, cfg.flowFloor, cfg.flowMax);
    }
    prevFlowPts = new Map(FLOW_POINTS.filter((i) => pts.has(i)).map((i) => [i, { ...pts.get(i) }]));

    return raw;
  }

  function updateLMA(raw, dt) {
    for (const key of ['O', 'W', 'A', 'F']) {
      if (raw[key] == null) continue;                               // 看不到的部位保持上一值
      lma[key] = fresh ? raw[key] : ease(lma[key], raw[key], dt, cfg.featureSmoothTau);
    }
  }

  // ---------- 第二步：LMA → 触手姿态目标 ----------
  function postureFromLMA({ O, W, A, F }) {
    return {
      curl: clamp(cfg.kOpen * (1 - O) + cfg.kWeight * W - cfg.curlOffset),
      lean: clamp(A * cfg.kAsym, -1, 1),
      speed: clamp(cfg.speedMin + (1 - cfg.speedMin) * F),
    };
  }

  // ---------- 第三步：触手姿态 → 电机 ----------
  function computeMotors() {
    const m = mixLines(posture.curl, posture.lean);
    const lim = limitSum(clamp(m.a), clamp(m.b), cfg.sumMax, cfg.sumSoftness);
    motors.a = Math.round(clamp(lim.a) * 1000);
    motors.b = Math.round(clamp(lim.b) * 1000);
    motors.speed = Math.round(clamp(posture.speed) * 1000);
  }

  function loseTracking() {
    pts.clear();
    prevFlowPts = null;
    fresh = true;
  }

  // ---------- 每帧 ----------
  function update(landmarks, timestampMs) {
    const dt = lastTs == null ? 0 : clamp((timestampMs - lastTs) / 1000, 0, cfg.maxDt);
    lastTs = timestampMs;

    let sw = 0;
    const seen = Array.isArray(landmarks) && visible(landmarks[L_SH]) && visible(landmarks[R_SH]);
    if (seen) {
      smoothLandmarks(landmarks, dt);
      const l = pts.get(L_SH), r = pts.get(R_SH);
      sw = Math.hypot(l.x - r.x, l.y - r.y);
    }

    if (seen && sw > 1e-3) {
      const raw = computeRawLMA(dt, sw);
      updateLMA(raw, dt);
      fresh = false;
      lastSeenTs = timestampMs;
      present = true;
      target = postureFromLMA(lma);
    } else {
      loseTracking();
      lma.F = ease(lma.F, 0, dt, cfg.featureSmoothTau);
      if (lastSeenTs == null || timestampMs - lastSeenTs >= cfg.absentDelayMs) {
        present = false;
        target = { ...cfg.rest };
      }
      // 否则（短暂丢失 < absentDelayMs）保持最后的目标姿态
    }

    const tau = present ? cfg.tau : cfg.restTau;
    posture.curl = ease(posture.curl, target.curl, dt, tau);
    posture.lean = ease(posture.lean, target.lean, dt, tau);
    posture.speed = ease(posture.speed, target.speed, dt, tau);

    computeMotors();
    return getState();
  }

  function getState() {
    return {
      lma: { ...lma },
      posture: { ...posture },
      motors: { ...motors },
      present,
    };
  }

  /** 回到初始状态（休息姿态、无人） */
  function reset() {
    lastTs = null;
    lastSeenTs = null;
    present = false;
    loseTracking();
    Object.assign(lma, { O: 0, W: 0, A: 0, F: 0 });
    Object.assign(posture, cfg.rest);
    target = { ...cfg.rest };
    computeMotors();
  }

  reset();
  return { update, getState, reset };
}

/** 拼成发给 Arduino 的命令（不含换行）："T,a,b,s" */
export function toCommand(state) {
  const { a, b, speed } = state.motors;
  return `T,${a},${b},${speed}`;
}

// 默认实例：直接 import { update, getState } 即可
const defaultMapper = createPostureMapper(config);
export const update = defaultMapper.update;
export const getState = defaultMapper.getState;
export const reset = defaultMapper.reset;

/*
 * =====================================================================
 * 自检清单（默认参数）
 * =====================================================================
 * 先用 getState() 实时打印 lma / posture / motors 再做以下动作。每个动作保持 5 秒以上，
 * 因为 posture 有 tau = 1.4 秒的延迟（约 3 秒到 90%，5 秒后基本到位）。
 *
 * 1. 各 LMA 值的测试动作
 *   O 开放度
 *     - 双臂向两侧平举（双腕距离 ≥ 3 肩宽）→ O ≈ 1
 *     - 双手在胸前合拢（双腕距离 ≤ 0.5 肩宽）→ O ≈ 0
 *     - 头抬起、站直时：张开 → curl 0，a = b = 0；合拢 → curl ≈ 0.35，a = b ≈ 350
 *   W 沉重感
 *     - 站直抬头：鼻子高出肩中点约 0.7 肩宽以上 → W ≈ 0
 *     - 低头到下巴贴胸、含胸弯腰 → W → 1
 *     - 双臂张开时低头：curl = 0.7·W − 0.25（W = 1 时 ≈ 0.45）
 *     - 双臂合拢再低头含胸：curl → 1，a、b 都想收满，但被 a + b 软上限压到约 700 / 700
 *   A 不对称度
 *     - 左肩（本人左侧）下沉 / 向左侧弯 → A → +1 → lean → +1 → 只有 a 收线，b → 0
 *     - 右肩下沉 → A → −1 → 只有 b 收线
 *     - 双肩水平 → A ≈ 0 → a = b
 *     - 若装置里触手弯的方向和观众感觉相反，把 kAsym 设为 −1
 *   F 流动性
 *     - 静止站立 → F ≈ 0 → speed → 150
 *     - 快速挥舞双臂 → F → 1 → speed → 1000
 *     - F 只影响 speed，不影响 a、b
 *
 * 2. 人离开画面
 *   - 0 ~ 1.5 秒：present 仍为 true，posture 和 motors 继续向最后的目标缓动（短暂丢失不会抽动），
 *     F 很快降到 0
 *   - 1.5 秒后：present = false，curl → 0.12、lean → 0、speed → 0.1（restTau = 3 秒，约 7 秒到 90%）
 *   - 最终 motors ≈ { a: 120, b: 120, speed: 100 }
 *   - 人回来后立即 present = true，LMA 直接按新画面初始化，posture 从当前值以 tau 缓动过去
 *
 * 3. 假数据测试：见 posture-mapping.test.mjs（node posture-mapping.test.mjs）
 */
