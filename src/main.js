import './style.css';
import { IntegerALU, toBin32, toHex32 } from './alu-int.js';
import { FloatALU, parseFloat32, toBin23 } from './alu-float.js';
import { addSteps, subSteps, mulSteps, divSteps, floatSteps, ldaSteps, staSteps } from './steps.js';
import { renderMemoryPage, bindMemoryEvents, memState } from './memory-page.js';

const intALU   = new IntegerALU();
const floatALU = new FloatALU();

// ─── App State ────────────────────────────────────────────────────────────────
const state = {
  page:   'alu',
  mode:   'int',
  op:     '+',
  inputA: '25',
  inputB: '7',
  memOpAddr: '0x10',  // 内存操作地址 (LDA/STA)
  // step engine
  stepList:     [],
  stepIdx:      -1,   // -1 = not started; 0..n = current step
  autoTimer:    null,
  autoSpeeds:   [1500, 900, 500, 250, 100],  // ms per level (1=slow,5=fast)
  autoSpeedLvl: 2,    // default medium
  // live register/signal state (set by step engine)
  regs:  { PC:0, MAR:0, MDR:0, IR:0, ACC:0, MQ:0, X:0 },
  psw:   { Z:0, N:0, C:0, O:0, S:0 },
  sigs:  { ALU_OP:0, CIN:0, COUT:0, OVF:0, ZERO:0, NEG:0,
           ENA_ALU:0, WR_ACC:0, WR_MQ:0, WR_X:0, RD_MEM:0, DATA_BUS:0, WR_PSW:0 },
  prevRegs: null,
  prevSigs: null,
  error: '',
  // final result (for binary panel)
  lastResult: null,
};

const ALU_OP_NAMES = { 0:'---',1:'ADD',2:'SUB',3:'MUL',4:'DIV',
                       0b000:'ADD',0b001:'SUB',0b010:'MUL',0b011:'DIV',
                       0b100:'FADD',0b101:'FSUB' };

// ─── Input Parsing ─────────────────────────────────────────────────────────────
function parseIntInput(s) {
  s = s.trim();
  if (/^-?0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) | 0;
  if (/^-?0b[01]+$/i.test(s))     return parseInt(s.replace(/^-?0b/,''), 2) * (s.startsWith('-') ? -1 : 1) | 0;
  const n = parseInt(s, 10);
  if (isNaN(n)) throw new Error(`无效整数: "${s}"`);
  return n | 0;
}
function parseFloatInput(s) {
  const n = parseFloat(s);
  if (isNaN(n)) throw new Error(`无效浮点数: "${s}"`);
  return Math.fround(n);
}

// ─── Step Engine ───────────────────────────────────────────────────────────────
function generateSteps() {
  state.error = '';
  stopAuto();
  try {
    if (state.mode === 'int') {
      const a = parseIntInput(state.inputA);
      const b = parseIntInput(state.inputB);
      switch (state.op) {
        case '+': state.stepList = addSteps(a, b); break;
        case '-': state.stepList = subSteps(a, b); break;
        case '*': state.stepList = mulSteps(a, b); break;
        case '/': state.stepList = divSteps(a, b); break;
      }
      // Compute final result for binary panel
      let res;
      switch (state.op) {
        case '+': res = intALU.add(a,b); break;
        case '-': res = intALU.sub(a,b); break;
        case '*': res = intALU.mul(a,b); break;
        case '/': res = intALU.div(a,b); break;
      }
      if (res && !res.error) state.lastResult = {mode:'int', a, b, res};
      else if (res?.error) throw new Error(res.error);
    } else {
      const a = parseFloatInput(state.inputA);
      const b = parseFloatInput(state.inputB);
      state.stepList = floatSteps(a, b, state.op);
      let res;
      if (state.op === '+') res = floatALU.add(a, b);
      else                   res = floatALU.sub(a, b);
      state.lastResult = {mode:'float', a, b, res};
    }
    state.stepIdx = 0;
    applyStep(0);
  } catch(e) {
    state.error = e.message;
    state.stepList = [];
    state.stepIdx = -1;
  }
  render();
}

// ─── LDA / STA: ALU ⇄ Memory ─────────────────────────────────────────────────
function loadFromMemory(destReg) {
  state.error = '';
  stopAuto();
  try {
    const sim = memState.sim;
    const addr = parseIntInput(state.memOpAddr) & ((1 << sim.addressBits) - 1);
    const event = sim.access(addr, 'read');
    memState.lastEvent = event;
    state.stepList = ldaSteps(addr, destReg, sim, event);
    state.lastResult = null;
    state.stepIdx = 0;
    state.prevRegs = null;
    state.prevSigs = null;
    applyStep(0);
  } catch (e) {
    state.error = '地址解析失败: ' + e.message;
  }
  render();
}

function storeToMemory() {
  state.error = '';
  stopAuto();
  try {
    const sim = memState.sim;
    const addr = parseIntInput(state.memOpAddr) & ((1 << sim.addressBits) - 1);
    const accVal = state.regs.ACC & 0xFF;
    const event = sim.access(addr, 'write', accVal);
    memState.lastEvent = event;
    state.stepList = staSteps(addr, state.regs.ACC, sim, event);
    state.lastResult = null;
    state.stepIdx = 0;
    state.prevRegs = null;
    state.prevSigs = null;
    applyStep(0);
  } catch (e) {
    state.error = '地址解析失败: ' + e.message;
  }
  render();
}

function applyStep(idx) {
  if (idx < 0 || idx >= state.stepList.length) return;
  const step = state.stepList[idx];
  state.prevRegs = {...state.regs};
  state.prevSigs = {...state.sigs};
  state.regs = {...step.regs};
  state.psw  = {...step.psw};
  state.sigs = {...step.sigs};
  state.stepIdx = idx;
}

function nextStep() {
  if (state.stepIdx < state.stepList.length - 1) {
    applyStep(state.stepIdx + 1);
    render();
  } else {
    stopAuto();
    render();
  }
}

function prevStep() {
  if (state.stepIdx > 0) {
    // Re-apply from scratch to get correct prevRegs
    state.prevRegs = null; state.prevSigs = null;
    if (state.stepIdx >= 2) {
      const s = state.stepList[state.stepIdx - 2];
      state.prevRegs = {...s.regs}; state.prevSigs = {...s.sigs};
    }
    const step = state.stepList[state.stepIdx - 1];
    state.regs = {...step.regs}; state.psw = {...step.psw}; state.sigs = {...step.sigs};
    state.stepIdx--;
    render();
  }
}

function resetSteps() {
  stopAuto();
  if (state.stepList.length > 0) {
    state.prevRegs = null; state.prevSigs = null;
    applyStep(0);
    render();
  }
}

function startAuto() {
  if (state.autoTimer) return;
  const speed = state.autoSpeeds[state.autoSpeedLvl] ?? 500;
  state.autoTimer = setInterval(() => {
    if (state.stepIdx >= state.stepList.length - 1) { stopAuto(); render(); return; }
    applyStep(state.stepIdx + 1);
    render();
  }, speed);
  render();
}

function stopAuto() {
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
}

// ─── Binary Panel Builder ──────────────────────────────────────────────────────
function bitsToFloat32(bits) {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = bits >>> 0;
  return new Float32Array(buf)[0];
}

// Labels for ACC at each step phase / operation
function accSubLabel(phase, label, op) {
  if (phase === 'fetch' || phase === 'decode') return '初始状态';
  if (label.includes('取A') || label.includes('A → ACC') || label.includes('A → acc')) return '← A 装入';
  if (phase === 'writeback') {
    if (op === '/') return '商 Q (结果)';
    if (op === '*') return '积低32位 (结果)';
    return '运算结果';
  }
  if (phase === 'flags') return '最终结果';
  if (op === '/' && phase === 'exec') return '余数 P';
  if (op === '*' && phase === 'exec') return '部分积(高位)';
  if (op === '+') return 'A / 结果';
  if (op === '-') return 'A (被减数)';
  return 'ACC';
}

function xSubLabel(phase, label, op) {
  if (op === '-') {
    if (label.includes('~B') && !label.includes('[-B]') && !label.includes('补码')) return '~B  按位取反';
    if (label.includes('[-B]') || label.includes('补码') || label.includes('~B+1')) return '[-B] = ~B+1  补码';
    if (phase === 'load') return 'B  原码';
    return '[-B]  (操作数B的补码)';
  }
  if (op === '/') return '除数 D  (全程不变)';
  if (op === '*') return '被乘数 X_val';
  return '操作数 B';
}

function mqSubLabel(phase, label, op) {
  if (op === '*') {
    if (phase === 'load') return '乘数 Y';
    if (phase === 'writeback') return '积高32位';
    return '移位中（乘数→积低位）';
  }
  if (op === '/') {
    if (phase === 'load') return '被除数 N';
    if (phase === 'writeback') return '余数 R';
    return '商位 q 累积中';
  }
  return 'MQ';
}

// Build a single reg row with optional transition highlighting
function buildRegRow(label, sublabel, val, prevVal, accent) {
  const changed = prevVal !== undefined && prevVal !== null && prevVal !== val;
  const binStr = toBin32(val);
  const dec = val | 0;
  const accentColor = accent || (changed ? 'var(--green)' : '');
  return `
    <div class="bin-row${changed ? ' bin-changed' : ''}">
      <div class="bin-label-col">
        <span class="bin-label" style="${accentColor?`color:${accentColor}`:''}">
          ${label}</span>
        <span class="bin-sublabel">${sublabel || ''}</span>
      </div>
      ${colorBin32(binStr)}
      <div class="bin-dec-col">
        <span class="bin-dec${changed ? ' is-changed' : ''}">${dec}</span>
        ${changed && prevVal !== null
          ? `<span class="bin-prev-val">${prevVal | 0}</span>`
          : ''}
      </div>
    </div>`;
}

// Build a "before → after" transition row (2 sub-rows)
function buildTransitionRow(label, sublabel, before, after) {
  return `
    <div class="bin-transition">
      <div class="bin-trans-header">
        <span class="bin-trans-label">${label}</span>
        <span class="bin-trans-sub">${sublabel}</span>
      </div>
      <div class="bin-trans-before">
        <span class="bin-trans-arrow">  </span>
        ${colorBin32(toBin32(before))}
        <span class="bin-trans-dec">${before | 0}</span>
      </div>
      <div class="bin-trans-after">
        <span class="bin-trans-arrow" style="color:var(--green)">→</span>
        ${colorBin32(toBin32(after))}
        <span class="bin-trans-dec new">${after | 0}</span>
      </div>
    </div>`;
}

// Build carry row
function buildCarryRow(carries) {
  const str = carries.slice(0, 32).map(c => c ? '1' : '0').join('');
  return `
    <div class="bin-row">
      <div class="bin-label-col">
        <span class="bin-label" style="color:var(--cyan)">C↑</span>
        <span class="bin-sublabel">进位链</span>
      </div>
      <div class="carry-row">${str}</div>
      <div class="bin-dec-col">
        <span class="bin-dec" style="color:var(--cyan)">C₃₂=${carries[32]}</span>
      </div>
    </div>`;
}

// Float row: sign|exp|mantissa layout with detail line
function buildFloatRegRow(label, sublabel, bits, accent) {
  const f = parseFloat32(bitsToFloat32(bits));
  const val = bitsToFloat32(bits);
  return `
    <div class="bin-row" style="${accent?`border-top:1px solid ${accent}`:''}">
      <div class="bin-label-col">
        <span class="bin-label" style="${accent?`color:${accent}`:''}">
          ${label}</span>
        <span class="bin-sublabel">${sublabel}</span>
      </div>
      ${floatBitsHTML(toBin32(bits))}
      <div class="bin-dec-col">
        <span class="bin-dec" style="${accent?`color:${accent}`:''}">
          ${isNaN(val) ? 'NaN' : isFinite(val) ? Math.fround(val) : (val > 0 ? '+Inf' : '-Inf')}
        </span>
      </div>
    </div>
    <div style="padding:2px 0 4px 36px;font-size:9px;color:var(--muted);font-family:monospace;border-bottom:1px solid var(--border)">
      ${f.sign?'-':'+'}  E=${f.expBiased}(2^${f.expActual})
      ${f.isSubnormal?'0':'1'}.${toBin23(f.mantissa).slice(0,14)}…
    </div>`;
}

// ─── Main binary HTML builder ──────────────────────────────────────────────────
function buildBinaryHTML() {
  const { mode, op, stepList, stepIdx, lastResult } = state;
  const hasSteps = stepList.length > 0;
  const currentStep = hasSteps && stepIdx >= 0 ? stepList[stepIdx] : null;
  const regs   = state.regs;
  const prev   = state.prevRegs;

  // ── Float mode ──────────────────────────────────────────────────────────────
  if (mode === 'float') {
    const legend = `<div style="font-size:10px;color:var(--muted);margin-top:8px;display:flex;gap:12px;font-family:monospace">
      <span style="color:var(--red)">■ 符号(1)</span>
      <span style="color:var(--yellow)">■ 阶码(8)</span>
      <span style="color:var(--green)">■ 尾数(23)</span>
    </div>`;

    if (!currentStep) {
      // Static final result
      if (!lastResult) return { header:'', rows:'<div style="color:var(--muted);padding:10px;font-size:12px">点击"执行运算"开始</div>', legend };
      const {a,b,res} = lastResult;
      const fa=parseFloat32(a), fb=parseFloat32(b), fr=res.fr;
      return {
        header: '',
        rows: buildFloatRegRow('A','操作数',fa.bits,'') +
              buildFloatRegRow('B','操作数',fb.bits,'') +
              buildFloatRegRow('R','结果',fr.bits,'var(--green)'),
        legend,
      };
    }

    // Step-aware float display
    const phase = currentStep.phase;
    let rows = '';
    const accBits = regs.ACC >>> 0;
    const xBits   = regs.X  >>> 0;

    if (phase === 'fetch' || phase === 'decode') {
      rows = `<div style="color:var(--muted);font-size:11px;padding:8px 0;font-family:monospace">
        等待装载操作数…</div>`;
    } else if (phase === 'load' && currentStep.label.includes('A')) {
      rows = buildFloatRegRow('ACC','← A 装入',accBits,'');
    } else {
      // Show ACC and X as floats
      rows = buildFloatRegRow('ACC', accSubLabel(phase, currentStep.label, op), accBits,
               phase==='writeback'||phase==='flags' ? 'var(--green)' : '');
      if (xBits !== 0 || phase !== 'load')
        rows += buildFloatRegRow('X','操作数 B',xBits,'');
    }
    return { header:'', rows, legend };
  }

  // ── Integer mode ─────────────────────────────────────────────────────────────
  const binHeader = `<div style="font-size:10px;color:var(--muted);margin-bottom:6px;font-family:monospace;display:flex;gap:5px">
    <span style="width:36px"></span>
    <span style="width:69px;text-align:center">[31:24]</span>
    <span style="width:69px;text-align:center">[23:16]</span>
    <span style="width:69px;text-align:center">[15:8]</span>
    <span style="width:69px;text-align:center">[7:0]</span>
  </div>`;

  if (!currentStep) {
    // Static final result
    if (!lastResult) return { header: binHeader,
      rows: '<div style="color:var(--muted);padding:10px;font-size:12px">点击"执行运算"开始</div>',
      legend: '' };
    const {a,b,res} = lastResult;
    const showCarry = (op==='+' || op==='-') && res.carries;
    return {
      header: binHeader,
      rows: buildRegRow('A','操作数',a,null,'') +
            (showCarry ? buildCarryRow(res.carries) : '') +
            buildRegRow('B','操作数',b,null,'') +
            buildRegRow('R','结果',res.result,null,'var(--green)') +
            (res.mq !== undefined ? buildRegRow('MQ',op==='/'?'余数':'积高32位',res.mq,null,'') : ''),
      legend: '',
    };
  }

  // ── Step-aware integer display ──────────────────────────────────────────────
  const phase = currentStep.phase;
  const label = currentStep.label;

  // Detect if ACC changed significantly (not just by a few bits)
  const accPrev   = prev?.ACC ?? null;
  const xPrev     = prev?.X   ?? null;
  const mqPrev    = prev?.MQ  ?? null;

  let rows = '';

  // ── ACC ──
  const accSub = accSubLabel(phase, label, op);
  // For writeback: show transition from old to new value
  if (phase === 'writeback' && accPrev !== null && accPrev !== regs.ACC) {
    rows += buildTransitionRow('ACC', accSub, accPrev, regs.ACC);
  } else {
    rows += buildRegRow('ACC', accSub, regs.ACC, accPrev,
              phase === 'writeback' || phase === 'flags' ? 'var(--green)' : '');
  }

  // ── Carry chain (ADD/SUB carry propagation step) ──
  if ((op === '+' || op === '-') && phase === 'exec' && label.includes('进位')
      && lastResult?.res?.carries) {
    rows += buildCarryRow(lastResult.res.carries);
  }

  // ── X ──
  const xSub = xSubLabel(phase, label, op);
  // For SUB negate steps: show the transformation
  if (op === '-' && phase === 'exec' && xPrev !== null && xPrev !== regs.X) {
    rows += buildTransitionRow('X', xSub, xPrev, regs.X);
  } else {
    rows += buildRegRow('X', xSub, regs.X, xPrev, '');
  }

  // ── MQ (for MUL / DIV) ──
  if (op === '*' || op === '/') {
    const mqSub = mqSubLabel(phase, label, op);
    if (phase === 'writeback' && mqPrev !== null && mqPrev !== regs.MQ) {
      rows += buildTransitionRow('MQ', mqSub, mqPrev, regs.MQ);
    } else {
      rows += buildRegRow('MQ', mqSub, regs.MQ, mqPrev,
                phase === 'writeback' ? 'var(--orange)' : '');
    }
  }

  // ── Extra: show IR to indicate instruction ──
  if (phase === 'fetch' || phase === 'decode') {
    rows += `<div style="padding:6px 0;font-size:10px;color:var(--muted);font-family:monospace;border-top:1px solid var(--border)">
      IR ← 0x${(regs.IR>>>0).toString(16).toUpperCase().padStart(2,'0')}
      　操作码已装入，等待执行
    </div>`;
  }

  return { header: binHeader, rows, legend: '' };
}

// ─── Rendering Helpers ─────────────────────────────────────────────────────────
function colorBin32(bin32) {
  const bytes = [];
  for (let b = 0; b < 4; b++) {
    const slice = bin32.slice(b*8, b*8+8);
    bytes.push('<span class="byte-grp">' +
      [...slice].map(c=>`<span class="${c==='1'?'b1c':'b0c'}">${c}</span>`).join('') +
      '</span>');
  }
  return `<div class="int-bits">${bytes.join('')}</div>`;
}

function colorBin32Reg(bin32) {
  return [...bin32].map(c=>`<span class="${c==='1'?'b1':'b0'}">${c}</span>`).join('');
}

function floatBitsHTML(bin32) {
  return `<div class="float-bits">
    <span class="fsign">${bin32[0]}</span><span class="fsep">|</span>
    <span class="fexp">${bin32.slice(1,9)}</span><span class="fsep">|</span>
    <span class="fmant">${bin32.slice(9)}</span>
  </div>`;
}

function changedClass(key, isReg) {
  if (!state.prevRegs && !state.prevSigs) return '';
  const prev = isReg ? (state.prevRegs?.[key]) : (state.prevSigs?.[key]);
  const curr = isReg ? state.regs[key] : state.sigs[key];
  return prev !== undefined && prev !== curr ? ' changed' : '';
}

const PHASE_LABELS = {
  fetch:'取指', decode:'译码', load:'取数', exec:'执行', writeback:'写回', flags:'标志', error:'错误',
};

// ─── Unified Page Header ───────────────────────────────────────────────────────
function buildPageHeader() {
  return `
    <header class="header">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="header-title">COMPUTER SIMULATOR</span>
        <span class="header-sub">基于《计算机组成原理》唐朔飞</span>
      </div>
      <div class="header-anchors">
        <a href="#alu-section" class="anchor-tab">▣ 运算器 ALU</a>
        <a href="#mem-section" class="anchor-tab">▤ 存储系统 Memory & Cache</a>
      </div>
    </header>`;
}

function bindPageTabs() {
  document.querySelectorAll('.anchor-tab').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// ─── Render ────────────────────────────────────────────────────────────────────
function render() {
  const { mode, op, error, stepList, stepIdx, lastResult,
          regs, psw, sigs, autoTimer, autoSpeedLvl } = state;
  const hasSteps = stepList.length > 0;
  const atEnd    = stepIdx === stepList.length - 1;
  const autoOn   = !!autoTimer;

  // ── Register Bank ──
  const regDefs = [
    {name:'PC', desc:'程序计数器'},
    {name:'MAR',desc:'存储器地址寄存器'},
    {name:'MDR',desc:'存储器数据寄存器'},
    {name:'IR', desc:'指令寄存器'},
    {name:'ACC',desc:'累加器'},
    {name:'MQ', desc:'乘商寄存器'},
    {name:'X',  desc:'操作数寄存器'},
  ];
  const regHTML = regDefs.map(r => `
    <div class="reg-row${changedClass(r.name,true)}" title="${r.desc}">
      <span class="reg-name">${r.name}</span>
      <span class="reg-bin">${colorBin32Reg(toBin32(regs[r.name]))}</span>
      <span class="reg-hex">${toHex32(regs[r.name])}</span>
    </div>`).join('');

  const pswHTML = `
    <div class="reg-row psw-row">
      <span class="reg-name">PSW</span>
      <div class="psw-grid" style="grid-column:2/4">
        ${['Z','N','C','O','S'].map(f => {
          const labels={Z:'零',N:'负',C:'进位',O:'溢出',S:'符号'};
          return `<span class="flag ${psw[f]?'on':'off'}" title="${labels[f]}标志">${f}=${psw[f]}</span>`;
        }).join('')}
      </div>
    </div>`;

  // ── Operation Buttons ──
  const ops = mode==='int' ? ['+','-','×','÷'] : ['+','-'];
  const opMap = {'+':'+', '-':'-', '×':'*', '÷':'/'};
  const opBtns = ops.map(sym => {
    const val = opMap[sym]??sym;
    return `<button class="op-btn ${op===val?'active':''}" data-op="${val}">${sym}</button>`;
  }).join('');

  // ── Step Controls ──
  const stepControls = `
    <div class="step-controls">
      <button class="step-btn" id="resetBtn" ${!hasSteps||stepIdx<=0?'disabled':''}>⏮</button>
      <button class="step-btn" id="prevBtn"  ${!hasSteps||stepIdx<=0?'disabled':''}>◀</button>
      <div class="step-progress" title="进度">
        <div class="step-progress-fill" style="width:${hasSteps?(stepIdx+1)/stepList.length*100:0}%"></div>
      </div>
      <span class="step-counter">${hasSteps?`${stepIdx+1}/${stepList.length}`:'0/0'}</span>
      <button class="step-btn" id="nextBtn"  ${!hasSteps||atEnd?'disabled':''}>▶</button>
      <button class="step-btn ${autoOn?'auto-on':''}" id="autoBtn" ${!hasSteps?'disabled':''}>
        ${autoOn?'⏸ 暂停':'⏩ 自动'}
      </button>
      <span class="speed-label">速度</span>
      <input type="range" class="speed-slider" id="speedSlider" min="0" max="4" value="${autoSpeedLvl}">
    </div>`;

  // ── Current Step Description Box ──
  const currentStep = hasSteps && stepIdx >= 0 ? stepList[stepIdx] : null;
  const descBox = currentStep ? `
    <div class="step-desc-box visible">
      <div class="step-desc-phase">
        <span class="phase-badge phase-${currentStep.phase}">${PHASE_LABELS[currentStep.phase]??currentStep.phase}</span>
        　${currentStep.label}
      </div>
      ${currentStep.desc}
    </div>` : `<div class="step-desc-box"></div>`;

  // ── Binary Display (step-aware) ──
  const { header: binHeader, rows: binRows, legend: floatLegend } = buildBinaryHTML();

  // ── Signal Lines ──
  const aluOpName = ALU_OP_NAMES[sigs.ALU_OP] ?? '---';
  const sigDefs = [
    {name:'ENA_ALU', val:sigs.ENA_ALU, color:'on',         label:'ALU使能'},
    {name:'ALU_OP',  val:sigs.ALU_OP.toString(2).padStart(3,'0'), led:sigs.ENA_ALU, color:'on-cyan', label:aluOpName},
    null,
    {name:'CIN',  val:sigs.CIN,  color:'on',        label:'进位输入'},
    {name:'COUT', val:sigs.COUT, color:'on',        label:'进位输出'},
    {name:'OVF',  val:sigs.OVF,  color:'on-red',    label:'溢出'},
    null,
    {name:'ZERO', val:sigs.ZERO, color:'on-yellow', label:'零标志'},
    {name:'NEG',  val:sigs.NEG,  color:'on-red',    label:'负标志'},
    null,
    {name:'RD_MEM',   val:sigs.RD_MEM,   color:'on-cyan', label:'读内存'},
    {name:'DATA_BUS', val:sigs.DATA_BUS, color:'on-cyan', label:'数据总线'},
    {name:'WR_ACC',   val:sigs.WR_ACC,   color:'on',      label:'写ACC'},
    {name:'WR_MQ',    val:sigs.WR_MQ,    color:'on',      label:'写MQ'},
    {name:'WR_X',     val:sigs.WR_X,     color:'on',      label:'写X'},
    {name:'WR_PSW',   val:sigs.WR_PSW,   color:'on-red',  label:'写PSW'},
  ];

  const sigHTML = sigDefs.map(s => {
    if (s === null) return `<div class="signal-sep"></div>`;
    const active  = typeof s.led !== 'undefined' ? s.led : (s.val ? 1 : 0);
    const ledCls  = active ? s.color : 'off';
    const sigChg  = changedClass(s.name, false);
    return `<div class="signal-row${sigChg}">
      <div class="led ${ledCls}"></div>
      <span class="sig-name">${s.name}</span>
      <span class="sig-val">${s.val} ${s.label}</span>
    </div>`;
  }).join('');

  // ── Trace Panel ──
  let traceHTML = '';
  if (!hasSteps) {
    traceHTML = `<div class="trace-empty">点击"执行运算"生成逐步运算序列…</div>`;
  } else {
    traceHTML = stepList.map((step, i) => {
      const isCurrent = i === stepIdx;
      const isSep = !step.desc && !step.label;
      return `<div class="trace-step${isCurrent?' current-step':''}${isSep?' sep-step':''}"
                   data-step="${i}" style="cursor:pointer">
        <span class="tl">${step.label}</span>
        <span class="tv">${step.desc}</span>
        <span class="phase-badge phase-${step.phase}">${PHASE_LABELS[step.phase]??step.phase}</span>
      </div>`;
    }).join('');
  }

  // ── Full DOM ──
  document.querySelector('#app').innerHTML = `
    ${buildPageHeader()}

    <div class="section-header" id="alu-section">
      <span class="section-num">①</span>
      <span class="section-title">运算器 ALU</span>
      <span class="section-desc">32位整数 / IEEE 754 浮点 · 单步执行 · 寄存器与信号线可视化</span>
    </div>

    <div class="simulator">
      <!-- Register Bank -->
      <div class="panel register-bank">
        <div class="panel-title">寄存器组 Register Bank</div>
        ${regHTML}${pswHTML}
      </div>

      <!-- Input Panel -->
      <div class="panel input-panel">
        <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>运算输入</span>
          <div class="mode-tabs" style="margin:0">
            <button class="mode-tab ${mode==='int'?'active':''}" data-mode="int">整数 32-bit</button>
            <button class="mode-tab ${mode==='float'?'active':''}" data-mode="float">浮点 IEEE 754</button>
          </div>
        </div>
        <div class="input-row">
          <div class="operand-grp">
            <label class="operand-label">操作数 A → ACC</label>
            <input class="operand-input" id="inputA" type="text" value="${state.inputA}"
              placeholder="${mode==='int'?'十进制 / 0xFF / 0b1010':'如 3.14'}" />
          </div>
          <div class="op-col">${opBtns}</div>
          <div class="operand-grp">
            <label class="operand-label">操作数 B → X</label>
            <input class="operand-input" id="inputB" type="text" value="${state.inputB}"
              placeholder="${mode==='int'?'十进制 / 0xFF / 0b1010':'如 1.0'}" />
          </div>
        </div>
        ${error?`<div class="error-msg">⚠ ${error}</div>`:''}
        <button class="compute-btn" id="computeBtn">▶ 执行运算（生成步骤）</button>

        <div class="mem-ops-section">
          <div class="mem-ops-title">⇄ 内存交互（通过 MAR/MDR 走 Cache）</div>
          <div class="mem-ops-row">
            <div class="operand-grp" style="flex:1">
              <label class="operand-label">内存地址 (0~${(1 << memState.sim.addressBits) - 1})</label>
              <input class="operand-input" id="memOpAddrInput" type="text" value="${state.memOpAddr}"
                placeholder="0x10 / 16"/>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <button class="op-btn mem-op" id="ldaAccBtn" title="LDA: 从该地址装载到 ACC">📥 LDA→ACC</button>
              <button class="op-btn mem-op" id="ldaXBtn" title="LDA: 从该地址装载到 X">📥 LDA→X</button>
              <button class="op-btn mem-op" id="staBtn" title="STA: 将 ACC 存入该地址">📤 STA←ACC</button>
            </div>
          </div>
        </div>

        ${stepControls}
        ${descBox}
      </div>

      <!-- Binary Display -->
      <div class="panel binary-panel">
        <div class="panel-title">
          ${mode==='int'?'32位补码 Two\'s Complement':'IEEE 754 单精度位布局'}
        </div>
        ${binHeader}${binRows}${floatLegend}
      </div>

      <!-- Signal Panel -->
      <div class="panel signal-panel">
        <div class="panel-title">信号线状态</div>
        ${sigHTML}
      </div>

      <!-- Trace Panel -->
      <div class="panel trace-panel">
        <div class="panel-title">
          运算步骤序列
          ${hasSteps?`<span style="color:var(--muted);font-weight:400;font-size:10px;margin-left:8px">
            共 ${stepList.length} 步，点击任意行跳转
          </span>`:''}
        </div>
        ${traceHTML}
      </div>
    </div>

    <div class="section-header" id="mem-section">
      <span class="section-num">②</span>
      <span class="section-title">存储系统 Memory & Cache</span>
      <span class="section-desc">主存读写 · Cache 三种映射机制（直接 / 全相联 / 组相联）· LRU 替换</span>
    </div>

    ${renderMemoryPage()}
  `;

  // ── Event Binding ──
  bindPageTabs();
  document.getElementById('computeBtn').addEventListener('click', generateSteps);

  document.getElementById('inputA').addEventListener('input', e => { state.inputA = e.target.value; });
  document.getElementById('inputB').addEventListener('input', e => { state.inputB = e.target.value; });
  document.getElementById('inputA').addEventListener('keydown', e => { if(e.key==='Enter') generateSteps(); });
  document.getElementById('inputB').addEventListener('keydown', e => { if(e.key==='Enter') generateSteps(); });

  document.querySelectorAll('.op-btn').forEach(btn => {
    btn.addEventListener('click', () => { state.op = btn.dataset.op; render(); });
  });
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.mode = tab.dataset.mode;
      state.op = '+';
      state.stepList = []; state.stepIdx = -1;
      state.lastResult = null; state.error = '';
      stopAuto();
      render();
    });
  });

  // ── Memory Op Bindings (LDA / STA) ──
  document.getElementById('memOpAddrInput')?.addEventListener('input', e => {
    state.memOpAddr = e.target.value;
  });
  document.getElementById('ldaAccBtn')?.addEventListener('click', () => loadFromMemory('ACC'));
  document.getElementById('ldaXBtn')?.addEventListener('click',   () => loadFromMemory('X'));
  document.getElementById('staBtn')?.addEventListener('click',    () => storeToMemory());

  // Step controls
  document.getElementById('resetBtn')?.addEventListener('click', resetSteps);
  document.getElementById('prevBtn')?.addEventListener('click',  prevStep);
  document.getElementById('nextBtn')?.addEventListener('click',  nextStep);
  document.getElementById('autoBtn')?.addEventListener('click',  () => {
    if (autoTimer) stopAuto(); else startAuto();
    render();
  });
  document.getElementById('speedSlider')?.addEventListener('input', e => {
    state.autoSpeedLvl = +e.target.value;
    if (autoTimer) { stopAuto(); startAuto(); }
  });

  // Click trace row to jump to step
  document.querySelectorAll('.trace-step[data-step]').forEach(row => {
    row.addEventListener('click', () => {
      const idx = +row.dataset.step;
      stopAuto();
      // Re-apply from scratch up to idx
      state.prevRegs = idx > 0 ? {...state.stepList[idx-1].regs} : null;
      state.prevSigs = idx > 0 ? {...state.stepList[idx-1].sigs} : null;
      const step = state.stepList[idx];
      state.regs = {...step.regs}; state.psw = {...step.psw}; state.sigs = {...step.sigs};
      state.stepIdx = idx;
      render();
      // Scroll clicked row into view
      document.querySelectorAll('.trace-step.current-step')[0]?.scrollIntoView({block:'nearest'});
    });
  });

  // Scroll current step into view in trace
  if (hasSteps) {
    const cur = document.querySelectorAll('.trace-step.current-step')[0];
    cur?.scrollIntoView({block:'nearest', behavior:'smooth'});
  }

  // ── Memory & Cache section bindings (unified view) ──
  bindMemoryEvents(render);
}

// ── Initial render ──
render();
