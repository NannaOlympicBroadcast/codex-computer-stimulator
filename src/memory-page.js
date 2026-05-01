import { MemoryCacheSim } from './cache.js';

export const memState = {
  sim: new MemoryCacheSim({ mode: 'direct' }),
  inputAddr: '0x0A',
  inputData: '0xFF',
  lastEvent: null,
};

// ─── helpers ────────────────────────────────────────────────────────────────────
const hex = (v, w=2) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
const bin = (v, w)   => (v >>> 0).toString(2).padStart(w, '0');

function parseAddr(s) {
  s = s.trim();
  let n;
  if (/^0x[0-9a-f]+$/i.test(s))  n = parseInt(s, 16);
  else if (/^0b[01]+$/i.test(s)) n = parseInt(s.slice(2), 2);
  else                           n = parseInt(s, 10);
  if (isNaN(n)) throw new Error(`无效地址: "${s}"`);
  return n;
}

function parseByte(s) {
  s = s.trim();
  let n;
  if (/^0x[0-9a-f]+$/i.test(s))  n = parseInt(s, 16);
  else if (/^0b[01]+$/i.test(s)) n = parseInt(s.slice(2), 2);
  else                           n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n > 255) throw new Error(`无效字节: "${s}"`);
  return n & 0xFF;
}

// ─── Address Breakdown HTML ────────────────────────────────────────────────────
function addrBreakdownHTML(sim, addr, parts) {
  const bits = bin(addr, sim.addressBits);
  const segs = [];

  if (sim.mode === 'full') {
    if (sim.tagBits > 0) segs.push({ label:'TAG', cls:'tag-color', count: sim.tagBits, val: parts.tag, bin: bits.slice(0, sim.tagBits) });
    if (sim.offsetBits>0) segs.push({ label:'OFFSET', cls:'off-color', count: sim.offsetBits, val: parts.offset, bin: bits.slice(sim.tagBits) });
  } else {
    const idxLabel = sim.mode==='set' ? 'SET' : 'INDEX';
    if (sim.tagBits > 0)   segs.push({ label:'TAG', cls:'tag-color', count: sim.tagBits, val: parts.tag, bin: bits.slice(0, sim.tagBits) });
    if (sim.indexBits > 0) segs.push({ label: idxLabel, cls:'idx-color', count: sim.indexBits, val: parts.index, bin: bits.slice(sim.tagBits, sim.tagBits + sim.indexBits) });
    if (sim.offsetBits > 0)segs.push({ label:'OFFSET', cls:'off-color', count: sim.offsetBits, val: parts.offset, bin: bits.slice(sim.tagBits + sim.indexBits) });
  }

  return `
    <div class="addr-breakdown">
      <div class="addr-bits-row">
        ${segs.map(s => `<div class="addr-seg ${s.cls}" style="flex:${s.count}">
          <div class="addr-seg-bin">${s.bin}</div>
          <div class="addr-seg-label">${s.label} (${s.count}bit)</div>
          <div class="addr-seg-val">= ${s.val}</div>
        </div>`).join('')}
      </div>
    </div>`;
}

// ─── Cache Table HTML ──────────────────────────────────────────────────────────
function cacheTableHTML(sim, lastEvent) {
  const rows = [];
  for (let i = 0; i < sim.cacheLines; i++) {
    const ln = sim.cache[i];
    let setLabel = '';
    if (sim.mode === 'direct') setLabel = `${i}`;
    else if (sim.mode === 'set') setLabel = `S${Math.floor(i / sim.ways)}.W${i % sim.ways}`;
    else setLabel = `${i}`;

    const isHit = lastEvent && lastEvent.lineIdx === i && lastEvent.hit;
    const isMissTarget = lastEvent && lastEvent.lineIdx === i && !lastEvent.hit;
    const wasEvicted = lastEvent?.evicted?.line === i;

    const dataHex = Array.from(ln.data).map(b => hex(b)).join(' ');
    const tagBin = ln.valid ? bin(ln.tag, Math.max(sim.tagBits, 1)) : '-';
    const blockNum = ln.valid ? sim.reconstructBlock(ln.tag, sim.mode==='set'? Math.floor(i/sim.ways) : i) : '-';

    rows.push(`
      <tr class="${isHit?'hit-row':''}${isMissTarget?'miss-row':''}${wasEvicted?'evict-row':''}">
        <td class="cache-idx">${setLabel}</td>
        <td><span class="valid-bit ${ln.valid?'on':'off'}">${ln.valid}</span></td>
        <td class="cache-tag">${tagBin}</td>
        <td class="cache-data">${ln.valid ? dataHex : '— — — —'}</td>
        <td class="cache-block">${ln.valid ? `B${blockNum}` : '-'}</td>
        <td class="cache-lru">${ln.valid ? ln.lru : '-'}</td>
      </tr>`);
  }

  return `
    <table class="cache-table">
      <thead>
        <tr>
          <th>${sim.mode==='set'?'组.路':'行号'}</th>
          <th>V</th>
          <th>Tag (bin)</th>
          <th>数据 (4字节)</th>
          <th>所属块</th>
          <th>LRU</th>
        </tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

// ─── Memory Grid HTML ──────────────────────────────────────────────────────────
function memoryGridHTML(sim, lastEvent) {
  const rows = [];
  for (let b = 0; b < sim.numBlocks; b++) {
    const base = b * sim.blockSize;
    const bytes = [];
    for (let i = 0; i < sim.blockSize; i++) {
      const isAccessed = lastEvent && lastEvent.parts.blockBase === base && (base + i) === lastEvent.addr;
      bytes.push(`<span class="mem-byte${isAccessed?' accessed':''}">${hex(sim.memory[base + i])}</span>`);
    }
    const isCurrentBlock = lastEvent?.parts?.blockNum === b;
    const inCache = sim.cache.some(ln => ln.valid && sim.reconstructBlock(ln.tag, 0) === b ||
      (ln.valid && sim.cache.indexOf(ln)>=0 && sim.reconstructBlock(ln.tag,
        sim.mode==='set'?Math.floor(sim.cache.indexOf(ln)/sim.ways):sim.cache.indexOf(ln)) === b));
    rows.push(`
      <div class="mem-block-row${isCurrentBlock?' current-block':''}${inCache?' cached':''}">
        <span class="mem-block-label">B${b}</span>
        <span class="mem-block-addr">${hex(base)}</span>
        <div class="mem-block-bytes">${bytes.join('')}</div>
        ${inCache?'<span class="cache-marker">⚡</span>':''}
      </div>`);
  }
  return `<div class="mem-grid">${rows.join('')}</div>`;
}

// ─── Stats & Log ───────────────────────────────────────────────────────────────
function statsHTML(sim) {
  const hitRate = sim.stats.total ? (sim.stats.hits / sim.stats.total * 100).toFixed(1) : '0.0';
  return `
    <div class="stats-grid">
      <div class="stat-cell"><span class="stat-num">${sim.stats.total}</span><span class="stat-lbl">总访问</span></div>
      <div class="stat-cell hit"><span class="stat-num">${sim.stats.hits}</span><span class="stat-lbl">命中 Hit</span></div>
      <div class="stat-cell miss"><span class="stat-num">${sim.stats.misses}</span><span class="stat-lbl">缺失 Miss</span></div>
      <div class="stat-cell rate"><span class="stat-num">${hitRate}%</span><span class="stat-lbl">命中率</span></div>
    </div>`;
}

function logHTML(sim) {
  if (!sim.log.length) return `<div class="log-empty">尚无访问记录…</div>`;
  return sim.log.map(ev => {
    const opName = ev.op === 'read' ? 'RD' : 'WR';
    const result = ev.hit ? `<span class="log-hit">HIT</span>` : `<span class="log-miss">MISS</span>`;
    const evi = ev.evicted ? ` 替换Line${ev.evicted.line}(B${ev.evicted.blockNum})` : '';
    return `
      <div class="log-row">
        <span class="log-time">#${ev.time}</span>
        <span class="log-op ${ev.op}">${opName}</span>
        <span class="log-addr">${hex(ev.addr)}</span>
        ${result}
        <span class="log-detail">Line${ev.lineIdx}, Tag=${bin(ev.parts.tag, Math.max(sim.tagBits,1))}, Off=${ev.parts.offset}, Val=${hex(ev.value)}${evi}</span>
      </div>`;
  }).join('');
}

// ─── Page Render ───────────────────────────────────────────────────────────────
export function renderMemoryPage() {
  const { sim, inputAddr, inputData, lastEvent } = memState;

  let parts = null;
  let breakdownHTML = '';
  let parseError = '';
  try {
    const addr = parseAddr(inputAddr) & ((1 << sim.addressBits) - 1);
    parts = sim.decode(addr);
    breakdownHTML = addrBreakdownHTML(sim, addr, parts);
  } catch (e) { parseError = e.message; }

  const modeLabel = { direct: '直接映射', full: '全相联', set: '组相联' }[sim.mode];
  const modeDesc  = sim.mode === 'direct'
    ? `每个内存块映射到唯一Cache行：行号 = blockNum mod ${sim.cacheLines}`
    : sim.mode === 'full'
      ? `任意内存块可放入任意Cache行（共${sim.cacheLines}行）`
      : `${sim.numSets}组 × ${sim.ways}路：组号 = blockNum mod ${sim.numSets}`;

  const resultBadge = lastEvent
    ? (lastEvent.hit
        ? `<span class="result-badge hit">⚡ HIT</span>`
        : `<span class="result-badge miss">✕ MISS</span>`)
    : '';

  return `
    <div class="memory-sim">

      <!-- ── Top: Config & Stats ── -->
      <div class="panel mem-config-panel">
        <div class="panel-title">映射方式 & 配置</div>
        <div class="config-row">
          <div class="map-mode-tabs">
            <button class="map-tab ${sim.mode==='direct'?'active':''}" data-mode="direct">直接映射</button>
            <button class="map-tab ${sim.mode==='full'?'active':''}"   data-mode="full">全相联</button>
            <button class="map-tab ${sim.mode==='set'?'active':''}"    data-mode="set">组相联</button>
          </div>
          <div class="config-info">
            <span><b>${modeLabel}</b> · ${modeDesc}</span>
          </div>
          <button class="step-btn" id="cacheResetBtn">⟲ 清空Cache</button>
        </div>
        <div class="config-detail">
          <span>主存：${sim.totalBytes}B (${sim.numBlocks}块)</span>
          <span>Cache：${sim.cacheLines * sim.blockSize}B (${sim.cacheLines}行)</span>
          <span>块大小：${sim.blockSize}B</span>
          <span>地址：${sim.addressBits}bit</span>
          ${sim.mode==='set'?`<span>关联度：${sim.ways}-way (${sim.numSets}组)</span>`:''}
          <span>位段划分：TAG=${sim.tagBits} ${sim.indexBits>0?`<span class="${sim.mode==='set'?'idx-color':'idx-color'}">${sim.mode==='set'?'SET':'IDX'}=${sim.indexBits}</span>`:''} OFF=${sim.offsetBits}</span>
        </div>
      </div>

      <!-- ── Stats ── -->
      <div class="panel mem-stats-panel">
        <div class="panel-title">访问统计</div>
        ${statsHTML(sim)}
      </div>

      <!-- ── Address Input & Breakdown ── -->
      <div class="panel mem-addr-panel">
        <div class="panel-title">地址访问</div>
        <div class="addr-input-row">
          <div class="operand-grp" style="flex:1">
            <label class="operand-label">地址 (0~${sim.totalBytes-1})</label>
            <input class="operand-input" id="memAddrInput" type="text" value="${inputAddr}"
              placeholder="0x1A / 0b011010 / 26"/>
          </div>
          <div class="operand-grp" style="flex:1">
            <label class="operand-label">写入数据 (0~255)</label>
            <input class="operand-input" id="memDataInput" type="text" value="${inputData}"
              placeholder="0xFF / 255"/>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <button class="op-btn" id="readBtn">读 RD</button>
            <button class="op-btn" id="writeBtn">写 WR</button>
          </div>
        </div>
        ${parseError ? `<div class="error-msg">⚠ ${parseError}</div>` : ''}
        ${breakdownHTML}
        ${lastEvent ? `
          <div class="access-result">
            ${resultBadge}
            <span style="font-family:monospace;font-size:11px">
              地址 ${hex(lastEvent.addr)} → ${lastEvent.op==='read'?'读':'写'}
              ${lastEvent.hit ? `命中 Line ${lastEvent.lineIdx}` : `从主存调块到 Line ${lastEvent.lineIdx}`}
              ${lastEvent.evicted ? `（替换原Line${lastEvent.evicted.line}/B${lastEvent.evicted.blockNum}）` : ''}
              ，值 = ${hex(lastEvent.value)}
            </span>
          </div>` : ''}
      </div>

      <!-- ── Cache State ── -->
      <div class="panel mem-cache-panel">
        <div class="panel-title">Cache 状态</div>
        ${cacheTableHTML(sim, lastEvent)}
      </div>

      <!-- ── Memory ── -->
      <div class="panel mem-memory-panel">
        <div class="panel-title">主存 (${sim.totalBytes}B)</div>
        ${memoryGridHTML(sim, lastEvent)}
      </div>

      <!-- ── Log ── -->
      <div class="panel mem-log-panel">
        <div class="panel-title">访问日志</div>
        <div class="log-list">${logHTML(sim)}</div>
      </div>

    </div>`;
}

// ─── Event Bindings ────────────────────────────────────────────────────────────
export function bindMemoryEvents(rerender) {
  const { sim } = memState;

  const doAccess = (op) => {
    try {
      const addr = parseAddr(memState.inputAddr) & ((1 << sim.addressBits) - 1);
      let data = 0;
      if (op === 'write') data = parseByte(memState.inputData);
      memState.lastEvent = sim.access(addr, op, data);
    } catch (e) {
      // error shown in render
    }
    rerender();
  };

  // Input changes: only update state + live breakdown, no full rerender
  // (avoids losing focus while typing)
  const updateBreakdownLive = () => {
    try {
      const addr = parseAddr(memState.inputAddr) & ((1 << sim.addressBits) - 1);
      const parts = sim.decode(addr);
      const html = addrBreakdownHTML(sim, addr, parts);
      const container = document.querySelector('.addr-breakdown');
      if (container) container.outerHTML = html;
    } catch (e) { /* ignore parse errors while typing */ }
  };
  document.getElementById('memAddrInput')?.addEventListener('input', e => {
    memState.inputAddr = e.target.value;
    updateBreakdownLive();
  });
  document.getElementById('memDataInput')?.addEventListener('input', e => {
    memState.inputData = e.target.value;
  });
  document.getElementById('memAddrInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doAccess('read');
  });

  document.getElementById('readBtn')?.addEventListener('click',  () => doAccess('read'));
  document.getElementById('writeBtn')?.addEventListener('click', () => doAccess('write'));
  document.getElementById('cacheResetBtn')?.addEventListener('click', () => {
    sim.reset();
    memState.lastEvent = null;
    rerender();
  });

  document.querySelectorAll('.map-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      sim.configure({
        mode,
        addressBits: 6, blockSize: 4, cacheLines: 4, ways: 2,
      });
      memState.lastEvent = null;
      rerender();
    });
  });
}
