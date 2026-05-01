import './style.css';

const MEMORY_SIZE = 64;
const BLOCK_SIZE = 4;
const CACHE_LINES = 4;

const SAMPLE_PROGRAM = `; R = (A + B) * C
0: LDA 48
1: ADD 49
2: MUL 51
3: STA 50
4: HLT

48: DATA 7
49: DATA 5
50: DATA 0
51: DATA 3`;

const INSTRUCTIONS = {
  NOP: { opcode: 0x0, needsOperand: false, label: '空操作' },
  LDA: { opcode: 0x1, needsOperand: true, label: '读内存到 ACC' },
  STA: { opcode: 0x2, needsOperand: true, label: 'ACC 写回内存' },
  ADD: { opcode: 0x3, needsOperand: true, label: 'ACC + M[addr]' },
  SUB: { opcode: 0x4, needsOperand: true, label: 'ACC - M[addr]' },
  MUL: { opcode: 0x5, needsOperand: true, label: 'ACC * M[addr]' },
  DIV: { opcode: 0x6, needsOperand: true, label: 'ACC / M[addr]' },
  JMP: { opcode: 0x7, needsOperand: true, label: '无条件转移' },
  JZ:  { opcode: 0x8, needsOperand: true, label: '零标志转移' },
  JN:  { opcode: 0x9, needsOperand: true, label: '负标志转移' },
  HLT: { opcode: 0xf, needsOperand: false, label: '停机' },
};

const OPCODE_NAMES = Object.fromEntries(
  Object.entries(INSTRUCTIONS).map(([name, spec]) => [spec.opcode, name]),
);

const PHASE_LABELS = {
  fetch: '取指准备',
  'fetch-read': '取指读存储器',
  decode: '译码',
  'operand-address': '送操作数地址',
  'operand-read': '读操作数',
  execute: '执行',
  writeback: '写回',
  'store-address': '送写入地址',
  'store-write': '写存储器',
  branch: '转移判定',
  halted: '停机',
  fault: '故障',
};

const state = {
  memory: makeEmptyMemory(),
  cache: makeCache(),
  regs: makeRegisters(),
  psw: makeFlags(),
  phase: 'fetch',
  status: 'ready',
  programSource: SAMPLE_PROGRAM,
  currentInstr: null,
  pending: null,
  bus: emptyBus(),
  alu: emptyAlu(),
  lastMemoryEvent: null,
  activityLog: [],
  instructionCount: 0,
  running: false,
  runTimer: null,
  clockMs: 600,
  selectedAddr: 50,
  manualAddr: '50',
  manualData: '0',
  error: '',
};

loadProgram({ silent: true });
render();

function makeRegisters() {
  return { PC: 0, IR: 0, MAR: 0, MDR: 0, ACC: 0, X: 0 };
}

function makeFlags() {
  return { Z: 0, N: 0, C: 0, O: 0, S: 0 };
}

function emptyBus() {
  return { op: 'IDLE', from: '-', to: '-', address: null, data: null, detail: '总线空闲' };
}

function emptyAlu() {
  return { active: false, op: '-', a: 0, b: 0, result: 0, flags: makeFlags(), detail: '等待运算指令' };
}

function makeEmptyMemory() {
  return Array.from({ length: MEMORY_SIZE }, () => makeDataCell(0));
}

function makeDataCell(value) {
  return { kind: 'data', value: value | 0 };
}

function makeInstructionCell(mnemonic, operand, source) {
  const spec = INSTRUCTIONS[mnemonic];
  return {
    kind: 'instruction',
    mnemonic,
    operand: operand ?? 0,
    opcode: spec.opcode,
    source,
  };
}

function makeCache() {
  return {
    lines: Array.from({ length: CACHE_LINES }, () => ({
      valid: 0,
      tag: 0,
      block: null,
      data: Array.from({ length: BLOCK_SIZE }, () => makeDataCell(0)),
    })),
    stats: { total: 0, hits: 0, misses: 0 },
  };
}

function resetCache() {
  state.cache = makeCache();
  state.lastMemoryEvent = null;
}

function cloneCell(cell) {
  return cell.kind === 'instruction'
    ? makeInstructionCell(cell.mnemonic, cell.operand, cell.source)
    : makeDataCell(cell.value);
}

function encodeCell(cell) {
  if (!cell) return 0;
  if (cell.kind === 'data') return cell.value | 0;
  return ((cell.opcode & 0xf) << 8) | (cell.operand & 0xff);
}

function parseNumber(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('缺少数值');

  let sign = 1;
  if (text.startsWith('-')) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  let value;
  if (/^0x[0-9a-f]+$/i.test(text)) value = parseInt(text.slice(2), 16);
  else if (/^0b[01]+$/i.test(text)) value = parseInt(text.slice(2), 2);
  else if (/^\d+$/.test(text)) value = parseInt(text, 10);
  else throw new Error(`无法解析数值: ${raw}`);

  return (sign * value) | 0;
}

function parseAddress(raw) {
  const addr = parseNumber(raw);
  if (addr < 0 || addr >= MEMORY_SIZE) {
    throw new Error(`地址 ${addr} 超出范围 0-${MEMORY_SIZE - 1}`);
  }
  return addr;
}

function assemble(source) {
  const memory = makeEmptyMemory();
  const used = new Set();
  const lines = source.split(/\r?\n/);
  let cursor = 0;

  lines.forEach((line, idx) => {
    const clean = line.replace(/;.*/, '').trim();
    if (!clean) return;

    let body = clean;
    const addressMatch = body.match(/^([^:\s]+)\s*:\s*(.*)$/);
    if (addressMatch) {
      cursor = parseAddress(addressMatch[1]);
      body = addressMatch[2].trim();
      if (!body) return;
    }

    const parts = body.split(/\s+/);
    const keyword = parts[0].toUpperCase();

    if (keyword === 'ORG') {
      if (parts.length < 2) throw new Error(`第 ${idx + 1} 行 ORG 缺少地址`);
      cursor = parseAddress(parts[1]);
      return;
    }

    if (cursor < 0 || cursor >= MEMORY_SIZE) {
      throw new Error(`第 ${idx + 1} 行地址 ${cursor} 超出范围`);
    }
    if (used.has(cursor)) throw new Error(`第 ${idx + 1} 行重复写入地址 ${cursor}`);

    if (keyword === 'DATA') {
      if (parts.length < 2) throw new Error(`第 ${idx + 1} 行 DATA 缺少数值`);
      memory[cursor] = makeDataCell(parseNumber(parts[1]));
    } else {
      const spec = INSTRUCTIONS[keyword];
      if (!spec) throw new Error(`第 ${idx + 1} 行未知指令: ${parts[0]}`);
      const operand = spec.needsOperand ? parseAddress(parts[1]) : 0;
      if (spec.needsOperand && parts.length < 2) {
        throw new Error(`第 ${idx + 1} 行 ${keyword} 缺少操作数地址`);
      }
      memory[cursor] = makeInstructionCell(keyword, operand, body);
    }

    used.add(cursor);
    cursor += 1;
  });

  return memory;
}

function loadProgram({ silent = false } = {}) {
  stopRun();
  try {
    state.memory = assemble(state.programSource);
    resetCpuOnly();
    resetCache();
    state.status = 'ready';
    state.error = '';
    pushLog('程序已装入主存，PC 复位到 0', 'ok');
  } catch (error) {
    state.error = error.message;
    state.status = 'fault';
    state.phase = 'fault';
    pushLog(error.message, 'error');
  }
  if (!silent) render();
}

function resetCpuOnly() {
  state.regs = makeRegisters();
  state.psw = makeFlags();
  state.phase = 'fetch';
  state.currentInstr = null;
  state.pending = null;
  state.bus = emptyBus();
  state.alu = emptyAlu();
  state.lastMemoryEvent = null;
  state.instructionCount = 0;
  state.status = 'ready';
  state.error = '';
}

function resetAll() {
  stopRun();
  loadProgram({ silent: true });
  render();
}

function cacheAccess(addr, op, writeCell = null) {
  const block = Math.floor(addr / BLOCK_SIZE);
  const offset = addr % BLOCK_SIZE;
  const lineIndex = block % CACHE_LINES;
  const tag = Math.floor(block / CACHE_LINES);
  const line = state.cache.lines[lineIndex];
  const hit = line.valid === 1 && line.tag === tag;

  state.cache.stats.total += 1;
  if (hit) {
    state.cache.stats.hits += 1;
  } else {
    state.cache.stats.misses += 1;
    line.valid = 1;
    line.tag = tag;
    line.block = block;
    const base = block * BLOCK_SIZE;
    line.data = Array.from({ length: BLOCK_SIZE }, (_, i) => cloneCell(state.memory[base + i]));
  }

  if (op === 'write') {
    const nextCell = cloneCell(writeCell);
    state.memory[addr] = nextCell;
    line.data[offset] = cloneCell(nextCell);
  }

  const event = {
    addr,
    op,
    hit,
    lineIndex,
    tag,
    block,
    offset,
    cell: cloneCell(op === 'write' ? writeCell : line.data[offset]),
  };
  state.lastMemoryEvent = event;
  return event;
}

function stepMicro({ skipRender = false } = {}) {
  if (state.phase === 'halted' || state.phase === 'fault') {
    stopRun();
    if (!skipRender) render();
    return;
  }

  try {
    switch (state.phase) {
      case 'fetch':
        microFetchAddress();
        break;
      case 'fetch-read':
        microFetchRead();
        break;
      case 'decode':
        microDecode();
        break;
      case 'operand-address':
        microOperandAddress();
        break;
      case 'operand-read':
        microOperandRead();
        break;
      case 'execute':
        microExecute();
        break;
      case 'writeback':
        microWriteback();
        break;
      case 'store-address':
        microStoreAddress();
        break;
      case 'store-write':
        microStoreWrite();
        break;
      case 'branch':
        microBranch();
        break;
      default:
        throw new Error(`未知微状态: ${state.phase}`);
    }
  } catch (error) {
    enterFault(error.message);
  }

  if (!skipRender) render();
}

function microFetchAddress() {
  state.regs.MAR = state.regs.PC;
  state.bus = {
    op: 'ADDR',
    from: 'PC',
    to: 'MAR / Memory',
    address: state.regs.MAR,
    data: null,
    detail: `PC=${state.regs.PC} 送入 MAR，准备访问主存`,
  };
  state.phase = 'fetch-read';
  pushLog(`取指: PC -> MAR (${formatAddr(state.regs.MAR)})`, 'info');
}

function microFetchRead() {
  const event = cacheAccess(state.regs.MAR, 'read');
  const cell = event.cell;
  state.regs.MDR = encodeCell(cell);
  state.regs.IR = cell.kind === 'instruction' ? encodeCell(cell) : 0;
  state.currentInstr = cell.kind === 'instruction' ? cell : null;
  state.regs.PC = (state.regs.PC + 1) % MEMORY_SIZE;
  state.bus = {
    op: 'READ',
    from: event.hit ? `Cache L${event.lineIndex}` : 'Memory',
    to: 'MDR / IR',
    address: event.addr,
    data: formatCell(cell),
    detail: `${event.hit ? 'Cache hit' : 'Cache miss'}，取到 ${formatCell(cell)}`,
  };

  if (cell.kind !== 'instruction') {
    enterFault(`PC 指向 ${formatAddr(event.addr)}，该单元是数据而不是指令`);
    return;
  }

  state.phase = 'decode';
  pushLog(`取指读: ${formatAddr(event.addr)} -> IR (${formatCell(cell)})`, event.hit ? 'hit' : 'miss');
}

function microDecode() {
  const instr = requireInstruction();
  state.bus = {
    op: 'DECODE',
    from: 'IR',
    to: 'Control Unit',
    address: null,
    data: formatInstruction(instr),
    detail: `${instr.mnemonic} 被译码为 ${INSTRUCTIONS[instr.mnemonic].label}`,
  };
  pushLog(`译码: ${formatInstruction(instr)}`, 'info');

  if (instr.mnemonic === 'HLT') {
    state.phase = 'halted';
    state.status = 'halted';
    state.instructionCount += 1;
    stopRun();
    pushLog('HLT: 机器停机', 'ok');
  } else if (instr.mnemonic === 'NOP') {
    finishInstruction('NOP 完成');
  } else if (['JMP', 'JZ', 'JN'].includes(instr.mnemonic)) {
    state.phase = 'branch';
  } else if (instr.mnemonic === 'STA') {
    state.phase = 'store-address';
  } else {
    state.phase = 'operand-address';
  }
}

function microOperandAddress() {
  const instr = requireInstruction();
  state.regs.MAR = instr.operand;
  state.bus = {
    op: 'ADDR',
    from: 'IR.operand',
    to: 'MAR / Memory',
    address: instr.operand,
    data: null,
    detail: `操作数地址 ${formatAddr(instr.operand)} 送入 MAR`,
  };
  state.phase = 'operand-read';
  pushLog(`${instr.mnemonic}: 操作数地址 -> MAR (${formatAddr(instr.operand)})`, 'info');
}

function microOperandRead() {
  const instr = requireInstruction();
  const event = cacheAccess(state.regs.MAR, 'read');
  const value = encodeCell(event.cell) | 0;
  state.regs.MDR = value;
  state.regs.X = value;
  state.bus = {
    op: 'READ',
    from: event.hit ? `Cache L${event.lineIndex}` : 'Memory',
    to: 'MDR / X',
    address: event.addr,
    data: value,
    detail: `${event.hit ? 'Cache hit' : 'Cache miss'}，M[${event.addr}] -> X = ${value}`,
  };
  state.phase = 'execute';
  pushLog(`${instr.mnemonic}: 读操作数 ${formatAddr(event.addr)} = ${value}`, event.hit ? 'hit' : 'miss');
}

function microExecute() {
  const instr = requireInstruction();
  const a = state.regs.ACC | 0;
  const b = state.regs.X | 0;

  if (instr.mnemonic === 'LDA') {
    const flags = flagsFromResult(state.regs.MDR, { C: 0, O: 0 });
    state.pending = { result: state.regs.MDR | 0, flags };
    state.alu = {
      active: true,
      op: 'PASS',
      a: state.regs.MDR | 0,
      b: 0,
      result: state.regs.MDR | 0,
      flags,
      detail: 'MDR 直通到 ACC',
    };
    state.bus = {
      op: 'PASS',
      from: 'MDR',
      to: 'ACC',
      address: null,
      data: state.regs.MDR | 0,
      detail: `LDA 准备写回 ACC=${state.regs.MDR | 0}`,
    };
  } else {
    const result = runAlu(instr.mnemonic, a, b);
    state.pending = { result: result.result, flags: result.flags };
    state.alu = result;
    state.bus = {
      op: 'ALU',
      from: 'ACC / X',
      to: 'ALU',
      address: null,
      data: result.result,
      detail: result.detail,
    };
  }

  state.phase = 'writeback';
  pushLog(`${instr.mnemonic}: ${state.alu.detail}`, 'alu');
}

function microWriteback() {
  const instr = requireInstruction();
  if (!state.pending) throw new Error('写回阶段缺少 ALU 结果');
  state.regs.ACC = state.pending.result | 0;
  state.psw = { ...state.pending.flags };
  state.bus = {
    op: 'WRITEBACK',
    from: 'ALU',
    to: 'ACC / PSW',
    address: null,
    data: state.regs.ACC,
    detail: `ACC=${state.regs.ACC}，PSW=${formatFlags(state.psw)}`,
  };
  state.pending = null;
  finishInstruction(`${instr.mnemonic} 完成，结果写回 ACC=${state.regs.ACC}`);
}

function microStoreAddress() {
  const instr = requireInstruction();
  state.regs.MAR = instr.operand;
  state.regs.MDR = state.regs.ACC;
  state.bus = {
    op: 'ADDR',
    from: 'IR.operand / ACC',
    to: 'MAR / MDR',
    address: instr.operand,
    data: state.regs.ACC,
    detail: `准备把 ACC=${state.regs.ACC} 写入 ${formatAddr(instr.operand)}`,
  };
  state.phase = 'store-write';
  pushLog(`STA: MAR=${formatAddr(instr.operand)}, MDR=${state.regs.MDR}`, 'info');
}

function microStoreWrite() {
  const instr = requireInstruction();
  const cell = makeDataCell(state.regs.MDR);
  const event = cacheAccess(state.regs.MAR, 'write', cell);
  state.bus = {
    op: 'WRITE',
    from: 'MDR',
    to: event.hit ? `Cache L${event.lineIndex} / Memory` : 'Memory',
    address: event.addr,
    data: state.regs.MDR,
    detail: `write-through: ${formatAddr(event.addr)} <= ${state.regs.MDR}`,
  };
  pushLog(`STA: ${formatAddr(event.addr)} <= ${state.regs.MDR}`, event.hit ? 'hit' : 'miss');
  finishInstruction(`${instr.mnemonic} 完成，内存已写入`);
}

function microBranch() {
  const instr = requireInstruction();
  const before = state.regs.PC;
  const take =
    instr.mnemonic === 'JMP'
    || (instr.mnemonic === 'JZ' && state.psw.Z === 1)
    || (instr.mnemonic === 'JN' && state.psw.N === 1);

  if (take) state.regs.PC = instr.operand;

  state.bus = {
    op: 'BRANCH',
    from: 'Control Unit',
    to: 'PC',
    address: take ? instr.operand : before,
    data: take ? 'TAKEN' : 'SKIP',
    detail: `${instr.mnemonic} ${take ? '成立' : '不成立'}，PC ${before} -> ${state.regs.PC}`,
  };
  finishInstruction(`${instr.mnemonic}: ${take ? '跳转' : '顺序执行'}`);
}

function requireInstruction() {
  if (!state.currentInstr || state.currentInstr.kind !== 'instruction') {
    throw new Error('当前 IR 中没有有效指令');
  }
  return state.currentInstr;
}

function finishInstruction(message) {
  state.phase = 'fetch';
  state.status = 'running';
  state.currentInstr = null;
  state.pending = null;
  state.instructionCount += 1;
  pushLog(message, 'ok');
}

function enterFault(message) {
  state.phase = 'fault';
  state.status = 'fault';
  state.error = message;
  stopRun();
  pushLog(message, 'error');
}

function stepInstruction() {
  const startCount = state.instructionCount;
  let guard = 24;

  do {
    stepMicro({ skipRender: true });
    guard -= 1;
  } while (
    guard > 0
    && state.phase !== 'halted'
    && state.phase !== 'fault'
    && state.instructionCount === startCount
  );

  render();
}

function toggleRun() {
  if (state.running) {
    stopRun();
    render();
    return;
  }

  if (state.phase === 'halted' || state.phase === 'fault') return;
  state.running = true;
  state.status = 'running';
  state.runTimer = setInterval(() => {
    stepMicro({ skipRender: true });
    if (state.phase === 'halted' || state.phase === 'fault') stopRun();
    render();
  }, state.clockMs);
  render();
}

function stopRun() {
  if (state.runTimer) clearInterval(state.runTimer);
  state.runTimer = null;
  state.running = false;
}

function runAlu(op, a, b) {
  let result;
  let C = 0;
  let O = 0;
  let detail = '';

  if (op === 'ADD') {
    result = (a + b) | 0;
    C = ((a >>> 0) + (b >>> 0)) > 0xffffffff ? 1 : 0;
    O = sameSign(a, b) && !sameSign(a, result) ? 1 : 0;
    detail = `${a} + ${b} = ${result}`;
  } else if (op === 'SUB') {
    result = (a - b) | 0;
    C = (a >>> 0) >= (b >>> 0) ? 1 : 0;
    O = !sameSign(a, b) && !sameSign(a, result) ? 1 : 0;
    detail = `${a} - ${b} = ${result}`;
  } else if (op === 'MUL') {
    const product = BigInt(a | 0) * BigInt(b | 0);
    result = Number(BigInt.asIntN(32, product));
    O = product < -2147483648n || product > 2147483647n ? 1 : 0;
    detail = `${a} * ${b} = ${result}${O ? ' (32 位溢出)' : ''}`;
  } else if (op === 'DIV') {
    if (b === 0) throw new Error('除数为 0，DIV 无法执行');
    O = a === -2147483648 && b === -1 ? 1 : 0;
    result = Math.trunc(a / b) | 0;
    detail = `${a} / ${b} = ${result}${O ? ' (32 位溢出)' : ''}`;
  } else {
    throw new Error(`ALU 不支持操作 ${op}`);
  }

  const flags = flagsFromResult(result, { C, O });
  return { active: true, op, a, b, result, flags, detail };
}

function sameSign(a, b) {
  return ((a ^ b) & 0x80000000) === 0;
}

function flagsFromResult(result, extra = {}) {
  const N = (result >>> 31) & 1;
  const O = extra.O ? 1 : 0;
  return {
    Z: result === 0 ? 1 : 0,
    N,
    C: extra.C ? 1 : 0,
    O,
    S: N ^ O,
  };
}

function manualRead() {
  try {
    const addr = parseAddress(state.manualAddr);
    const event = cacheAccess(addr, 'read');
    state.selectedAddr = addr;
    state.manualData = String(encodeCell(event.cell) | 0);
    pushLog(`手动读: ${formatAddr(addr)} = ${formatCell(event.cell)}`, event.hit ? 'hit' : 'miss');
  } catch (error) {
    state.error = error.message;
  }
  render();
}

function manualWrite() {
  try {
    const addr = parseAddress(state.manualAddr);
    const value = parseNumber(state.manualData);
    const event = cacheAccess(addr, 'write', makeDataCell(value));
    state.selectedAddr = addr;
    pushLog(`手动写: ${formatAddr(addr)} <= ${value}`, event.hit ? 'hit' : 'miss');
  } catch (error) {
    state.error = error.message;
  }
  render();
}

function pushLog(message, type = 'info') {
  state.activityLog.unshift({
    id: Date.now() + Math.random(),
    type,
    message,
    phase: PHASE_LABELS[state.phase] ?? state.phase,
  });
  state.activityLog = state.activityLog.slice(0, 50);
}

function formatAddr(addr) {
  return `0x${(addr >>> 0).toString(16).toUpperCase().padStart(2, '0')}`;
}

function formatHex32(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function formatCell(cell) {
  if (!cell) return '-';
  return cell.kind === 'instruction' ? formatInstruction(cell) : String(cell.value | 0);
}

function formatInstruction(cell) {
  if (!cell || cell.kind !== 'instruction') return '-';
  const spec = INSTRUCTIONS[cell.mnemonic];
  return spec.needsOperand ? `${cell.mnemonic} ${cell.operand}` : cell.mnemonic;
}

function formatFlags(flags) {
  return `Z=${flags.Z} N=${flags.N} C=${flags.C} O=${flags.O} S=${flags.S}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function bitGroups(value) {
  const bits = (value >>> 0).toString(2).padStart(32, '0');
  return bits
    .match(/.{1,8}/g)
    .map((group) => `<span>${group.replaceAll('0', '<i>0</i>').replaceAll('1', '<b>1</b>')}</span>`)
    .join('');
}

function statusText() {
  if (state.phase === 'halted') return '已停机';
  if (state.phase === 'fault') return '故障';
  if (state.running) return '自动运行';
  if (state.status === 'ready') return '就绪';
  return '单步运行';
}

function render() {
  document.querySelector('#app').innerHTML = `
    <header class="app-header">
      <div>
        <p class="eyebrow">WEB COMPUTER SIMULATOR</p>
        <h1>整机数据通路</h1>
      </div>
      <div class="status-strip">
        <span class="status-pill status-${state.phase}">${statusText()}</span>
        <span>周期 ${state.instructionCount}</span>
        <span>${PHASE_LABELS[state.phase] ?? state.phase}</span>
      </div>
    </header>

    <main class="workspace">
      ${renderProgramPanel()}
      ${renderCpuPanel()}
      ${renderDatapathPanel()}
      ${renderAluPanel()}
      ${renderMemoryPanel()}
      ${renderCachePanel()}
      ${renderLogPanel()}
    </main>
  `;

  bindEvents();
}

function renderProgramPanel() {
  return `
    <section class="panel program-panel">
      <div class="panel-title">程序装入器</div>
      <textarea id="programSource" spellcheck="false">${escapeHtml(state.programSource)}</textarea>
      ${state.error ? `<div class="error-line">${escapeHtml(state.error)}</div>` : ''}
      <div class="button-row">
        <button id="loadProgramBtn">装入程序</button>
        <button id="resetBtn">复位</button>
      </div>
      <div class="button-row">
        <button id="stepMicroBtn">单步微操作</button>
        <button id="stepInstrBtn">单条指令</button>
        <button id="runBtn">${state.running ? '暂停' : '运行'}</button>
      </div>
      <label class="range-row">
        <span>时钟</span>
        <input id="clockRange" type="range" min="120" max="1200" step="40" value="${state.clockMs}">
        <strong>${state.clockMs}ms</strong>
      </label>
    </section>`;
}

function renderCpuPanel() {
  const regs = [
    ['PC', state.regs.PC, '下一条指令地址'],
    ['IR', state.regs.IR, '当前指令编码'],
    ['MAR', state.regs.MAR, '存储器地址寄存器'],
    ['MDR', state.regs.MDR, '存储器数据寄存器'],
    ['ACC', state.regs.ACC, '累加器'],
    ['X', state.regs.X, '操作数寄存器'],
  ];

  return `
    <section class="panel cpu-panel">
      <div class="panel-title">CPU 寄存器</div>
      <div class="reg-table">
        ${regs.map(([name, value, title]) => `
          <div class="reg-row" title="${title}">
            <span>${name}</span>
            <strong>${value | 0}</strong>
            <em>${formatHex32(value)}</em>
          </div>
        `).join('')}
      </div>
      <div class="flag-row">
        ${Object.entries(state.psw).map(([key, value]) => `
          <span class="${value ? 'flag-on' : ''}">${key}=${value}</span>
        `).join('')}
      </div>
      <div class="decode-box">
        <span>IR 解码</span>
        <strong>${state.currentInstr ? formatInstruction(state.currentInstr) : '-'}</strong>
        <em>${state.currentInstr ? INSTRUCTIONS[state.currentInstr.mnemonic].label : '等待取指'}</em>
      </div>
    </section>`;
}

function renderDatapathPanel() {
  const busData = state.bus.data === null ? '-' : escapeHtml(state.bus.data);
  return `
    <section class="panel datapath-panel">
      <div class="panel-title">控制器 / 总线</div>
      <div class="datapath">
        <div class="unit ${state.bus.from.includes('PC') || state.bus.from.includes('IR') ? 'active' : ''}">
          <span>Control Unit</span>
          <strong>${PHASE_LABELS[state.phase] ?? state.phase}</strong>
        </div>
        <div class="bus-line">
          <span>${escapeHtml(state.bus.op)}</span>
          <strong>${escapeHtml(state.bus.from)} → ${escapeHtml(state.bus.to)}</strong>
          <em>ADDR ${state.bus.address === null ? '-' : formatAddr(state.bus.address)} · DATA ${busData}</em>
        </div>
        <div class="unit ${state.bus.to.includes('ALU') || state.bus.op === 'ALU' ? 'active' : ''}">
          <span>ALU</span>
          <strong>${escapeHtml(state.alu.op)}</strong>
        </div>
        <div class="unit ${state.bus.to.includes('Memory') || state.bus.from.includes('Memory') || state.bus.from.includes('Cache') ? 'active' : ''}">
          <span>Memory</span>
          <strong>${state.lastMemoryEvent ? (state.lastMemoryEvent.hit ? 'HIT' : 'MISS') : '-'}</strong>
        </div>
      </div>
      <div class="bus-detail">${escapeHtml(state.bus.detail)}</div>
    </section>`;
}

function renderAluPanel() {
  return `
    <section class="panel alu-panel">
      <div class="panel-title">ALU 连接状态</div>
      <div class="alu-grid">
        <div><span>A / ACC</span><strong>${state.alu.a | 0}</strong></div>
        <div><span>B / X</span><strong>${state.alu.b | 0}</strong></div>
        <div><span>OP</span><strong>${escapeHtml(state.alu.op)}</strong></div>
        <div><span>RESULT</span><strong>${state.alu.result | 0}</strong></div>
      </div>
      <div class="alu-detail">${escapeHtml(state.alu.detail)}</div>
      <div class="bit-panel">
        <label>ACC</label>
        <div>${bitGroups(state.regs.ACC)}</div>
      </div>
      <div class="bit-panel">
        <label>X</label>
        <div>${bitGroups(state.regs.X)}</div>
      </div>
    </section>`;
}

function renderMemoryPanel() {
  return `
    <section class="panel memory-panel">
      <div class="panel-title">统一主存</div>
      <div class="memory-tools">
        <label>地址 <input id="manualAddr" value="${escapeHtml(state.manualAddr)}"></label>
        <label>数据 <input id="manualData" value="${escapeHtml(state.manualData)}"></label>
        <button id="manualReadBtn">读</button>
        <button id="manualWriteBtn">写</button>
      </div>
      <div class="memory-grid">
        ${state.memory.map((cell, addr) => renderMemoryCell(cell, addr)).join('')}
      </div>
    </section>`;
}

function renderMemoryCell(cell, addr) {
  const classes = ['memory-cell'];
  if (addr === state.regs.PC) classes.push('is-pc');
  if (addr === state.regs.MAR) classes.push('is-mar');
  if (addr === state.selectedAddr) classes.push('is-selected');
  if (state.lastMemoryEvent?.addr === addr) classes.push('is-accessed');
  if (cell.kind === 'instruction') classes.push('is-instruction');

  return `
    <button class="${classes.join(' ')}" data-addr="${addr}">
      <span>${addr.toString().padStart(2, '0')}</span>
      <strong>${escapeHtml(cell.kind === 'instruction' ? cell.mnemonic : cell.value)}</strong>
      <em>${escapeHtml(cell.kind === 'instruction' && INSTRUCTIONS[cell.mnemonic].needsOperand ? cell.operand : cell.kind)}</em>
    </button>`;
}

function renderCachePanel() {
  const stats = state.cache.stats;
  const hitRate = stats.total ? Math.round((stats.hits / stats.total) * 100) : 0;
  return `
    <section class="panel cache-panel">
      <div class="panel-title">Cache 直接映射</div>
      <div class="cache-stats">
        <span>访问 ${stats.total}</span>
        <span>命中 ${stats.hits}</span>
        <span>缺失 ${stats.misses}</span>
        <strong>${hitRate}%</strong>
      </div>
      <table>
        <thead>
          <tr><th>Line</th><th>V</th><th>Tag</th><th>Block</th><th>Words</th></tr>
        </thead>
        <tbody>
          ${state.cache.lines.map((line, index) => `
            <tr class="${state.lastMemoryEvent?.lineIndex === index ? 'active-row' : ''}">
              <td>L${index}</td>
              <td>${line.valid}</td>
              <td>${line.valid ? line.tag : '-'}</td>
              <td>${line.valid ? line.block : '-'}</td>
              <td>${line.valid ? line.data.map(formatCell).join(' | ') : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>`;
}

function renderLogPanel() {
  return `
    <section class="panel log-panel">
      <div class="panel-title">微操作日志</div>
      <div class="log-list">
        ${state.activityLog.length ? state.activityLog.map((item) => `
          <div class="log-item log-${item.type}">
            <span>${escapeHtml(item.phase)}</span>
            <strong>${escapeHtml(item.message)}</strong>
          </div>
        `).join('') : '<div class="empty-log">尚无微操作</div>'}
      </div>
    </section>`;
}

function bindEvents() {
  document.getElementById('programSource')?.addEventListener('input', (event) => {
    state.programSource = event.target.value;
  });
  document.getElementById('loadProgramBtn')?.addEventListener('click', () => loadProgram());
  document.getElementById('resetBtn')?.addEventListener('click', resetAll);
  document.getElementById('stepMicroBtn')?.addEventListener('click', () => stepMicro());
  document.getElementById('stepInstrBtn')?.addEventListener('click', stepInstruction);
  document.getElementById('runBtn')?.addEventListener('click', toggleRun);
  document.getElementById('clockRange')?.addEventListener('input', (event) => {
    state.clockMs = Number(event.target.value);
    if (state.running) {
      stopRun();
      toggleRun();
    } else {
      render();
    }
  });
  document.getElementById('manualAddr')?.addEventListener('input', (event) => {
    state.manualAddr = event.target.value;
  });
  document.getElementById('manualData')?.addEventListener('input', (event) => {
    state.manualData = event.target.value;
  });
  document.getElementById('manualReadBtn')?.addEventListener('click', manualRead);
  document.getElementById('manualWriteBtn')?.addEventListener('click', manualWrite);
  document.querySelectorAll('.memory-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const addr = Number(cell.dataset.addr);
      state.selectedAddr = addr;
      state.manualAddr = String(addr);
      state.manualData = String(encodeCell(state.memory[addr]) | 0);
      render();
    });
  });
}
