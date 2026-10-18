/**
 * plant-protocol.js —— 《语言失真》网页 → Arduino 的新串口协议（三株植物共用）
 *
 *   $<株><类型>,<序号>,<字段1>,…,<字段n>*<校验>\n
 *     株：F 机械花  P 气囊花  T 触手
 *     类型：S 动作参数（11 个字段，三株一样）  L 局部（每株不同）  G 一次性动作（2 个字段）
 *     序号：0~255 循环（每株一个计数器），Arduino 发现不连续会打印 "F SEQ 丢帧 n"
 *     校验：'$' 和 '*' 之间所有字符的异或，两位十六进制大写（同 NMEA）
 *   字段全是整数，单位见 FIELDS；Arduino 端字段数不对、校验不对就整行丢弃（见 总体代码.ino 开头）。
 *
 * 发送策略（createSender）：
 *   - 每帧都可以调用，但只有参数"明显变化"时才真的发（变化阈值见 FIELDS 的 kind）；
 *   - 同一株两次发送至少间隔 minIntervalMs（250ms）；
 *   - 没变化时每 keepaliveMs（1 秒）重发一次 S，当作心跳（Arduino 3 秒没收到就回到平静）；
 *   - 一次性动作 G 立即发，但两次至少间隔 minGestureMs。
 */

/* 字段表：名字、编码方式、变化判定。
   kind：lin = 线性（差值超过 span × 阈值才算变化）  log = 时间类（比值超过 1 + 阈值才算变化）  exact = 离散值
   thr：这个字段单独的变化阈值（不写就用发送器的默认 8%） */
export const FIELDS = {
  S: [
    { name: 'pos',   scale: 1000, kind: 'lin', span: 1000 },   // 目标位置 0~1
    { name: 'dur',   scale: 1000, kind: 'log' },               // 全程用时（秒 → ms）
    { name: 'curve', scale: 1,    kind: 'exact' },             // 0 匀速 1 缓入缓出 2 快起慢收 3 慢起急停
    { name: 'back',  scale: 10,   kind: 'log' },               // 回程倍数（×10）
    { name: 'per',   scale: 1000, kind: 'log', thr: 0.15 },    // 呼吸周期（秒 → ms）；说话节奏一直在小幅波动，门槛放宽到 15%
    { name: 'dep',   scale: 1000, kind: 'lin', span: 200 },    // 呼吸幅度 0~1
    { name: 'hold',  scale: 1000, kind: 'log' },               // 吸到顶停顿（秒 → ms）
    { name: 'trA',   scale: 1000, kind: 'lin', span: 40 },     // 微颤幅度 0~1
    { name: 'trF',   scale: 10,   kind: 'log' },               // 微颤频率（Hz → 0.1Hz）
    { name: 'still', scale: 1000, kind: 'log' },               // 呼到底静止（秒 → ms）
    { name: 'hes',   scale: 1000, kind: 'lin', span: 1000 },   // 犹豫度 0~1
  ],
  FL: [
    { name: 'ledLevel',   scale: 1,    kind: 'lin', span: 60 },     // LED 亮度 0~255
    { name: 'ledPer',     scale: 1000, kind: 'log' },               // LED 周期（秒 → ms）
    { name: 'ledMode',    scale: 1,    kind: 'exact' },             // 0 常亮 1 脉动 2 闪烁 3 断续
    { name: 'ledPhase',   scale: 1000, kind: 'lin', span: 4000 },   // LED 相位差（秒 → ms，正 = 滞后）
    { name: 'probeAmp',   scale: 1000, kind: 'lin', span: 100 },    // 试探幅度 0~1
    { name: 'probeEvery', scale: 1000, kind: 'log' },               // 试探间隔（秒 → ms，0 = 不试探）
  ],
  PL: [
    { name: 'inhale',      scale: 1000, kind: 'lin', span: 200 },   // 吸气占呼吸周期的比例（0.5 = 吸呼一样长）
    { name: 'jitter',      scale: 1000, kind: 'lin', span: 400 },   // 呼吸不规则度 0~1
    { name: 'twitchEvery', scale: 1000, kind: 'log' },              // 随机抽动平均间隔（秒 → ms，0 = 不抽动）
    { name: 'twitchLen',   scale: 1000, kind: 'log' },              // 每次抽动开泵多久（秒 → ms）
    { name: 'twitchMode',  scale: 1,    kind: 'exact' },            // 0 充放交替 1 只充 2 只抽
  ],
  TL: [
    { name: 'lean',    scale: 1000, kind: 'lin', span: 1000 },      // 偏向 -1~1（正 = 外侧线 A 收得多）
    { name: 'phaseAB', scale: 1000, kind: 'lin', span: 3000 },      // B 的呼吸比 A 晚多少（秒 → ms）
    { name: 'ampA',    scale: 1000, kind: 'lin', span: 1000 },      // A 的呼吸幅度倍数 0~2
    { name: 'ampB',    scale: 1000, kind: 'lin', span: 1000 },      // B 的呼吸幅度倍数 0~2
    { name: 'trSide',  scale: 1,    kind: 'exact' },                // 微颤加在哪：0 两侧 1 只 A 2 只 B
  ],
};

/* 一次性动作编号（$?G 的第一个字段），每株各自一套 */
export const GESTURES = {
  F: { probe: 1, open: 2, close: 3, flinch: 4 },      // 机械花：试探 大开 大合 惊缩
  P: { twitch: 1, inhale: 2, exhale: 3, hold: 4 },    // 气囊：抽动 深吸 长呼 屏息
  T: { twitch: 1, curl: 2, unfurl: 3, wave: 4 },      // 触手：抽动 蜷缩 舒展 摆动（A、B 先后各拉一下）
};

/** 校验：'$' 之后、'*' 之前所有字符的异或 */
export function checksum(body) {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i) & 0xff;
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

/** 拼一帧（不含换行）：encodeFrame('F', 'S', 7, [500, 3000, …]) → "$FS,7,500,3000,…*4B" */
export function encodeFrame(plant, type, seq, ints) {
  const body = `${plant}${type},${seq & 0xff},${ints.map((v) => Math.round(v)).join(',')}`;
  return `$${body}*${checksum(body)}`;
}

/** 解析一帧（测试和调试用，和 Arduino 端 parseFrame 规则相同）；不合法返回 null */
export function parseFrame(line) {
  const m = /^\$([A-Z])([A-Z]),(\d{1,3}),(-?\d+(?:,-?\d+)*)\*([0-9A-Fa-f]{2})$/.exec(line.trim());
  if (!m) return null;
  const body = line.trim().slice(1, line.trim().lastIndexOf('*'));
  if (checksum(body) !== m[5].toUpperCase()) return null;
  return { plant: m[1], type: m[2], seq: +m[3], fields: m[4].split(',').map(Number) };
}

/** 参数对象（人能读的单位）→ 协议整数 */
export function toInts(fieldSpecs, params) {
  return fieldSpecs.map((f) => Math.round((Number(params[f.name]) || 0) * f.scale));
}

function changed(fieldSpecs, a, b, threshold) {
  if (!a) return true;
  return fieldSpecs.some((f, i) => {
    const x = a[i], y = b[i], threshold_ = f.thr ?? threshold;
    if (f.kind === 'exact') return x !== y;
    if (f.kind === 'log') {
      if (x <= 0 || y <= 0) return (x <= 0) !== (y <= 0);
      return Math.max(x / y, y / x) > 1 + threshold_;
    }
    return Math.abs(x - y) > f.span * threshold_;
  });
}

/**
 * 一株植物的发送器。
 *   const sender = createSender('F', { L: FIELDS.FL });
 *   sender.update({ S: params, L: local }, now, force)  → 这一刻该发的帧（字符串数组，可能为空）
 *   sender.gesture(GESTURES.F.open, 0.9, now)           → 一次性动作帧（或 null：离上次太近）
 */
export function createSender(plant, specs, opts = {}) {
  const o = { minIntervalMs: 250, keepaliveMs: 1000, minGestureMs: 600, threshold: 0.08, ...opts };
  const types = { S: FIELDS.S, ...specs };
  let seq = 0, lastSendAt = -Infinity, lastGestureAt = -Infinity, lastKeepalive = -Infinity;
  const lastSent = {};
  return {
    update(params, now, force = false) {
      if (now - lastSendAt < o.minIntervalMs) return [];
      const out = [];
      for (const [type, spec] of Object.entries(types)) {
        if (!params[type]) continue;
        const ints = toInts(spec, params[type]);
        const keepalive = type === 'S' && now - lastKeepalive >= o.keepaliveMs;
        if (force || keepalive || changed(spec, lastSent[type], ints, o.threshold)) {
          out.push(encodeFrame(plant, type, seq++, ints));
          lastSent[type] = ints;
          if (type === 'S') lastKeepalive = now;
        }
      }
      if (out.length) lastSendAt = now;
      return out;
    },
    gesture(code, amp, now) {
      if (now - lastGestureAt < o.minGestureMs) return null;
      lastGestureAt = now;
      return encodeFrame(plant, 'G', seq++, [code, Math.round(Math.max(0, Math.min(1, amp)) * 1000)]);
    },
    reset() { for (const k in lastSent) delete lastSent[k]; lastSendAt = lastKeepalive = lastGestureAt = -Infinity; },
  };
}
