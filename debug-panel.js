/**
 * debug-panel.js —— 展前现场调试面板（检测页按 C 打开 / 关闭）
 *
 * 每株植物一栏：
 *   - "手动"开关：打开后这株植物不再用识别结果，改用下面滑块的值（识别仍在跑，只是不驱动它）
 *   - 滑块：直接设定 效价 / 唤醒度 / 含糊度 等输入
 *   - 状态按钮：一键把滑块放到某个状态的位置（同时打开手动）
 *   - 动作按钮：立即触发一次局部 / 一次性动作（手动、自动下都可以用）
 *   - 实时读数：当前主导状态和关键参数，方便对照参数表调手感
 *
 *   const panel = createDebugPanel(document.body);
 *   panel.addPlant({ key, title, sliders, states, actions, readout });
 *   panel.manual(key) → 是否手动；panel.values(key) → { 滑块名: 值 }
 */
export function createDebugPanel(parent = document.body) {
  const css = document.createElement('style');
  css.textContent = `
.dbgp{position:fixed;right:24px;top:70px;z-index:8;width:340px;max-height:calc(100vh - 100px);overflow:auto;
  padding:14px 16px;border-radius:16px;font:12px/1.5 ui-monospace,'SF Mono',monospace;color:#4b4638;
  background:rgba(246,243,236,.92);border:1px solid rgba(255,255,255,.7);box-shadow:0 8px 30px rgba(0,0,0,.12)}
.dbgp[hidden]{display:none}
.dbgp h3{margin:0 0 6px;font:600 14px/1.4 inherit;display:flex;justify-content:space-between;align-items:center}
.dbgp section{padding:10px 0;border-top:1px solid rgba(110,100,78,.18)}
.dbgp section:first-of-type{border-top:0;padding-top:0}
.dbgp label.row{display:grid;grid-template-columns:62px 1fr 42px;gap:8px;align-items:center;margin:3px 0}
.dbgp input[type=range]{width:100%}
.dbgp .btns{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}
.dbgp button{font:inherit;padding:3px 9px;border-radius:999px;border:1px solid rgba(110,100,78,.3);background:#fff;cursor:pointer}
.dbgp button:hover{background:#eef0e6}
.dbgp .manual{font-weight:400;font-size:12px;display:flex;gap:4px;align-items:center;cursor:pointer}
.dbgp pre{margin:6px 0 0;white-space:pre-wrap;color:#7d7561;font:11px/1.45 inherit}
.dbgp .hint{color:#7d7561;margin:0 0 8px}`;
  document.head.appendChild(css);

  const root = document.createElement('div');
  root.className = 'dbgp';
  root.hidden = true;
  root.innerHTML = '<p class="hint">调试面板（按 C 关闭）。打开某株的"手动"后，它只听滑块，不听识别。</p>';
  parent.appendChild(root);
  addEventListener('keydown', (e) => {
    if ((e.key === 'c' || e.key === 'C') && !e.repeat && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) root.hidden = !root.hidden;
  });

  const plants = {};

  function addPlant({ key, title, sliders = [], states = [], actions = [], readout }) {
    const sec = document.createElement('section');
    const p = plants[key] = { manual: false, values: {}, inputs: {} };
    sec.innerHTML = `<h3>${title}<label class="manual"><input type="checkbox"> 手动</label></h3>`;
    const manualBox = sec.querySelector('input');
    manualBox.onchange = () => { p.manual = manualBox.checked; };

    for (const s of sliders) {
      const row = document.createElement('label');
      row.className = 'row';
      row.innerHTML = `<span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step ?? 0.01}" value="${s.value}"><span></span>`;
      const input = row.querySelector('input'), out = row.lastElementChild;
      const show = () => { p.values[s.name] = Number(input.value); out.textContent = Number(input.value).toFixed(2); };
      input.oninput = show;
      show();
      p.inputs[s.name] = { input, show };
      sec.appendChild(row);
    }
    const addButtons = (list, onClick) => {
      if (!list.length) return;
      const box = document.createElement('div');
      box.className = 'btns';
      for (const item of list) {
        const b = document.createElement('button');
        b.textContent = item.label;
        b.onclick = () => onClick(item);
        box.appendChild(b);
      }
      sec.appendChild(box);
    };
    addButtons(states, (st) => {                       // 状态按钮：设滑块 + 打开手动
      for (const [k, v] of Object.entries(st.values)) { if (p.inputs[k]) { p.inputs[k].input.value = v; p.inputs[k].show(); } }
      manualBox.checked = p.manual = true;
    });
    addButtons(actions, (a) => a.run());              // 动作按钮：立即执行
    const pre = document.createElement('pre');
    sec.appendChild(pre);
    if (readout) setInterval(() => { if (!root.hidden) pre.textContent = readout() || ''; }, 250);
    root.appendChild(sec);
  }

  return {
    addPlant,
    manual: (key) => !!plants[key]?.manual,
    values: (key) => ({ ...(plants[key]?.values || {}) }),
    get open() { return !root.hidden; },
  };
}
