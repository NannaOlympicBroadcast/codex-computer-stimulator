/**
 * Step sequence generators for each ALU operation.
 * Each step is a full machine-state snapshot:
 *   { phase, label, desc, regs, psw, sigs }
 */

import { toBin32 } from './alu-int.js';
import { parseFloat32, toBin23 } from './alu-float.js';

// ─── Defaults ──────────────────────────────────────────────────────────────────
const R0 = { PC:0, MAR:0, MDR:0, IR:0, ACC:0, MQ:0, X:0 };
const P0 = { Z:0, N:0, C:0, O:0, S:0 };
const S0 = { ALU_OP:0, CIN:0, COUT:0, OVF:0, ZERO:0, NEG:0,
              ENA_ALU:0, WR_ACC:0, WR_MQ:0, WR_X:0, RD_MEM:0, DATA_BUS:0, WR_PSW:0 };

function mk(phase, label, desc, regs={}, psw={}, sigs={}) {
  return { phase, label, desc,
    regs: {...R0,...regs}, psw: {...P0,...psw}, sigs: {...S0,...sigs} };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function addFlags(a32, b32) {
  const result = (a32 + b32) | 0;
  let carry = 0;
  const carries = [0];
  for (let i = 0; i < 32; i++) {
    const s = ((a32>>>i)&1) + ((b32>>>i)&1) + carry;
    carry = s >> 1;
    carries.push(carry);
  }
  const sA=(a32>>>31)&1, sB=(b32>>>31)&1, sR=(result>>>31)&1;
  const O=(sA===sB&&sA!==sR)?1:0;
  return { result, carries, C:carries[32], O, psw:{Z:result===0?1:0,N:sR,C:carries[32],O,S:sR^O} };
}

// ─── Integer ADD ───────────────────────────────────────────────────────────────
export function addSteps(a, b) {
  const ai=a|0, bi=b|0, ir=0x01;
  const {result,carries,C,O,psw} = addFlags(ai, bi);
  const sR=(result>>>31)&1;

  return [
    mk('fetch',   '① 取指 FETCH',
      `PC=0→MAR，读取ADD指令，IR←0x01`,
      {PC:0,MAR:0,MDR:ir,IR:ir}, {}, {RD_MEM:1,DATA_BUS:1}),
    mk('decode',  '② 译码 DECODE',
      `IR[5:0]=0x01 → ADD，ALU_OP←000`,
      {IR:ir}, {}, {ALU_OP:0b000}),
    mk('load',    '③ 取操作数A → ACC',
      `MAR←&A，MDR←${ai}，ACC←${ai}`,
      {IR:ir,ACC:ai}, {}, {RD_MEM:1,WR_ACC:1,DATA_BUS:1,ALU_OP:0b000}),
    mk('load',    '④ 取操作数B → X',
      `MAR←&B，MDR←${bi}，X←${bi}`,
      {IR:ir,ACC:ai,X:bi}, {}, {RD_MEM:1,WR_X:1,DATA_BUS:1,ALU_OP:0b000}),
    mk('exec',    '⑤ 进位输入 C₀=0，使能ALU',
      `ALU全加器就绪，C₀=0送入最低位全加器`,
      {IR:ir,ACC:ai,X:bi}, {}, {ENA_ALU:1,CIN:0,ALU_OP:0b000}),
    mk('exec',    '⑥ 32位并行全加计算',
      `各位全加器同时计算 Sᵢ=Aᵢ⊕Bᵢ⊕Cᵢ，进位链并行传播`,
      {IR:ir,ACC:ai,X:bi}, {}, {ENA_ALU:1,CIN:0,ALU_OP:0b000,DATA_BUS:1}),
    mk('exec',    '⑦ 进位链传播完成',
      `C₃₂=${C}（进位输出），溢出检测 OF=${O}，结果=${result}`,
      {IR:ir,ACC:ai,X:bi}, {}, {ENA_ALU:1,CIN:0,COUT:C,OVF:O,ALU_OP:0b000,DATA_BUS:1}),
    mk('writeback','⑧ 结果写回 ACC',
      `WR_ACC=1，ACC←${result} (${toBin32(result)})`,
      {IR:ir,ACC:result,X:bi}, {}, {WR_ACC:1,COUT:C,OVF:O,ALU_OP:0b000,DATA_BUS:1}),
    mk('flags',   '⑨ 更新 PSW 标志',
      `Z=${psw.Z} N=${psw.N} C=${psw.C} O=${psw.O} S=${psw.S}`,
      {IR:ir,ACC:result,X:bi}, psw, {WR_PSW:1,ZERO:psw.Z,NEG:psw.N,COUT:C,OVF:O,ALU_OP:0b000}),
  ];
}

// ─── Integer SUB ───────────────────────────────────────────────────────────────
export function subSteps(a, b) {
  const ai=a|0, bi=b|0, ir=0x02;
  const invB = ~bi;
  const negB = (invB+1)|0;
  const {result,carries,C,O,psw} = addFlags(ai, negB);

  return [
    mk('fetch',   '① 取指 FETCH',
      `PC=0→MAR，读取SUB指令，IR←0x02`,
      {IR:ir}, {}, {RD_MEM:1,DATA_BUS:1}),
    mk('decode',  '② 译码 DECODE',
      `IR=SUB，ALU_OP←001`,
      {IR:ir}, {}, {ALU_OP:0b001}),
    mk('load',    '③ 取A → ACC',
      `ACC←${ai}`,
      {IR:ir,ACC:ai}, {}, {RD_MEM:1,WR_ACC:1,DATA_BUS:1,ALU_OP:0b001}),
    mk('load',    '④ 取B → X',
      `X←${bi}`,
      {IR:ir,ACC:ai,X:bi}, {}, {RD_MEM:1,WR_X:1,DATA_BUS:1,ALU_OP:0b001}),
    mk('exec',    '⑤ 求[~B] — 按位取反',
      `X各位取反: ~${bi} = ${invB}  (${toBin32(invB)})`,
      {IR:ir,ACC:ai,X:invB}, {}, {ENA_ALU:1,ALU_OP:0b001}),
    mk('exec',    '⑥ 求[-B]补码 — ~B+1',
      `[-B] = ~B+1 = ${negB}  (${toBin32(negB)})`,
      {IR:ir,ACC:ai,X:negB}, {}, {ENA_ALU:1,CIN:1,ALU_OP:0b001,DATA_BUS:1}),
    mk('exec',    '⑦ A+[-B] 并行全加',
      `等价 A-B，CIN=1（已含+1），并行全加器执行`,
      {IR:ir,ACC:ai,X:negB}, {}, {ENA_ALU:1,CIN:1,ALU_OP:0b001,DATA_BUS:1}),
    mk('exec',    '⑧ 进位链传播完成',
      `C₃₂=${C}，OF=${O}，结果=${result}`,
      {IR:ir,ACC:ai,X:negB}, {}, {ENA_ALU:1,CIN:1,COUT:C,OVF:O,ALU_OP:0b001,DATA_BUS:1}),
    mk('writeback','⑨ 结果写回 ACC',
      `ACC←${result}`,
      {IR:ir,ACC:result,X:bi}, {}, {WR_ACC:1,COUT:C,OVF:O,ALU_OP:0b001,DATA_BUS:1}),
    mk('flags',   '⑩ 更新 PSW',
      `Z=${psw.Z} N=${psw.N} C=${psw.C} O=${psw.O} S=${psw.S}`,
      {IR:ir,ACC:result,X:bi}, psw, {WR_PSW:1,ZERO:psw.Z,NEG:psw.N,COUT:C,OVF:O,ALU_OP:0b001}),
  ];
}

// ─── Integer MUL — Booth 1-bit ─────────────────────────────────────────────────
export function mulSteps(a, b) {
  const ai=a|0, bi=b|0, ir=0x03;
  const X_val = BigInt(ai);   // multiplicand → X register
  const Y_val = BigInt(bi);   // multiplier   → MQ initially

  const steps = [];

  // Init
  steps.push(mk('load', '① 取指/译码，装载操作数',
    `X(被乘数)←${ai}，MQ(乘数)←${bi}，ACC←0，Booth算法就绪`,
    {IR:ir,ACC:0,MQ:bi,X:ai}, {}, {ALU_OP:0b010,WR_MQ:1,WR_X:1,WR_ACC:1,DATA_BUS:1}));

  // Booth 1-bit iteration
  // Use 33-bit ACC (BigInt) for sign, 32-bit MQ (BigInt)
  let ACC = 0n;
  let MQ  = Y_val;
  let q_prev = 0n;
  const MASK32 = 0xFFFFFFFFn;
  const X_big  = X_val;

  for (let i = 0; i < 32; i++) {
    const q0 = MQ & 1n;
    let op = 'nop';

    if (q0 === 1n && q_prev === 0n) {
      ACC -= X_big;
      op = 'sub';
    } else if (q0 === 0n && q_prev === 1n) {
      ACC += X_big;
      op = 'add';
    }

    q_prev = q0;

    // Arithmetic right shift [ACC, MQ] by 1
    const lsb_acc = ACC & 1n;
    MQ = ((MQ >> 1n) & 0x7FFFFFFFn) | (lsb_acc << 31n);
    ACC = ACC >> 1n;   // BigInt arithmetic right shift (sign-extends)

    const opStr = op==='add' ? `ACC+X=${Number(BigInt.asIntN(33,ACC<<1n)>>1n)+Number(X_big)}` :
                  op==='sub' ? `ACC-X` : '无操作';
    const qBit = op==='nop' ? '-' : (op==='add' ? '' : '');

    steps.push(mk('exec', `第${String(i+1).padStart(2,' ')}步 Booth迭代`,
      `q₀=${q0} q₋₁=${q_prev===q0?q_prev:1n-q_prev} → ${op==='add'?'加X':op==='sub'?'减X':'无操作'}；算术右移[ACC,MQ]`,
      {IR:ir,
       ACC: Number(BigInt.asIntN(32,ACC)),
       MQ:  Number(BigInt.asUintN(32,MQ)),
       X:   ai},
      {},
      {ENA_ALU:1,ALU_OP:0b010,
       CIN: op==='sub'?1:0,
       DATA_BUS:1,
       WR_ACC: op!=='nop'?1:0,
      }));
  }

  // Final: low 32 in MQ, high 32 in ACC
  const low32  = Number(BigInt.asIntN(32, MQ));
  const high32 = Number(BigInt.asIntN(32, ACC));
  const overflow = (ACC < -1n || ACC > 0n) ? 1 : 0;
  const sR = (low32 >>> 31) & 1;

  steps.push(mk('writeback', '⑯⁺ 积写回寄存器',
    `低32位→ACC=${low32}，高32位→MQ=${high32}${overflow?'，溢出!':''}`,
    {IR:ir,ACC:low32,MQ:high32,X:ai},
    {Z:low32===0?1:0,N:sR,C:0,O:overflow,S:sR^overflow},
    {WR_ACC:1,WR_MQ:1,DATA_BUS:1,ALU_OP:0b010,OVF:overflow,ZERO:low32===0?1:0,NEG:sR,WR_PSW:1}));

  return steps;
}

// ─── Integer DIV — 不恢复余数法（加减交替法）─────────────────────────────────
export function divSteps(a, b) {
  const ai=a|0, bi=b|0, ir=0x04;
  if (bi === 0) return [mk('error','❌ 除数为零','除数不能为零', {IR:ir}, {O:1}, {OVF:1})];

  const signN = ai < 0 ? -1 : 1;
  const signD = bi < 0 ? -1 : 1;
  const signQ = signN * signD;

  const absN = BigInt(Math.abs(ai));
  const absD = BigInt(Math.abs(bi));

  const steps = [];

  steps.push(mk('load', '① 初始化寄存器',
    `ACC=0(余数)，MQ=|被除数|=${Math.abs(ai)}，X=|除数|=${Math.abs(bi)}，符号(商)=${signQ<0?'-':'+'}`,
    {IR:ir,ACC:0,MQ:Math.abs(ai),X:Math.abs(bi)},
    {}, {ALU_OP:0b011,WR_MQ:1,WR_X:1,WR_ACC:1,DATA_BUS:1}));

  let P = 0n;          // partial remainder (ACC)
  let A = absN;        // will accumulate quotient bits (MQ)
  const V = absD;

  for (let i = 0; i < 32; i++) {
    // Left shift [P, A] by 1 (64-bit left shift)
    const msb_A = (A >> 31n) & 1n;
    P = (P << 1n) | msb_A;
    A = (A << 1n) & 0xFFFFFFFFn;

    const P_before = P;
    let op, cin;
    if (P >= 0n) {
      P = P - V;
      op = 'sub'; cin = 0;
    } else {
      P = P + V;
      op = 'add'; cin = 1;
    }

    const qBit = P >= 0n ? 1n : 0n;
    A = (A & 0xFFFFFFFEn) | qBit;

    steps.push(mk('exec',
      `第${String(i+1).padStart(2,' ')}步 左移→${op==='sub'?'P≥0减V':'P<0加V'}→q=${qBit}`,
      `[ACC,MQ]左移后 P_before=${P_before}，执行${op==='sub'?'P-V':'P+V'}=${P}；商位q${i}=${qBit}`,
      {IR:ir,
       ACC: Number(BigInt.asIntN(32,P)),
       MQ:  Number(BigInt.asUintN(32,A)),
       X:   Math.abs(bi)},
      {},
      {ENA_ALU:1,ALU_OP:0b011,CIN:cin,DATA_BUS:1,
       WR_ACC:1,WR_MQ:1,
       COUT: op==='sub' && P>=0n ? 1 : 0}));
  }

  // Post-correction
  let corrected = false;
  if (P < 0n) {
    P = P + V;
    corrected = true;
    steps.push(mk('exec', '余数修正 P+V',
      `最终余数P<0，需加回除数V：P=${P}（恢复正确余数）`,
      {IR:ir, ACC:Number(BigInt.asIntN(32,P)), MQ:Number(BigInt.asUintN(32,A)), X:Math.abs(bi)},
      {},
      {ENA_ALU:1,ALU_OP:0b011,CIN:1,DATA_BUS:1,WR_ACC:1}));
  }

  // Apply signs
  let quotient  = Number(A);
  let remainder = Number(P);
  if (signQ < 0)  quotient  = -quotient;
  if (signN < 0)  remainder = -remainder;
  const quot32 = quotient  | 0;
  const rem32  = remainder | 0;
  const sR = (quot32 >>> 31) & 1;
  const psw = {Z:quot32===0?1:0,N:sR,C:0,O:0,S:sR};

  steps.push(mk('writeback', `${corrected?'⑱':'⑰'} 符号修正，写回结果`,
    `商=${quot32}→ACC，余数=${rem32}→MQ；验证：${ai}=${bi}×${quot32}+${rem32}`,
    {IR:ir,ACC:quot32,MQ:rem32,X:bi},
    psw,
    {WR_ACC:1,WR_MQ:1,DATA_BUS:1,ALU_OP:0b011,ZERO:psw.Z,NEG:sR,WR_PSW:1}));

  return steps;
}

// ─── LDA — Load Accumulator (走 Cache 访存) ────────────────────────────────────
export function ldaSteps(addr, destReg, sim, event) {
  const ir = destReg === 'ACC' ? 0x10 : 0x11;
  const { offset, index, tag, blockBase } = event.parts;
  const value = event.value;
  const addrHex = `0x${addr.toString(16).toUpperCase().padStart(2,'0')}`;
  const valHex  = `0x${value.toString(16).toUpperCase().padStart(2,'0')}`;
  const tagBin  = tag.toString(2).padStart(Math.max(sim.tagBits,1),'0');
  const idxLabel = sim.mode==='set'?'Set':sim.mode==='full'?'(无)':'Idx';
  const out = [];

  out.push(mk('fetch', '① 取指 LDA',
    `读取 LDA 指令字节（IR ← 0x${ir.toString(16).toUpperCase()}），目标寄存器 = ${destReg}`,
    {IR:ir}, {}, {RD_MEM:1, DATA_BUS:1}));

  out.push(mk('decode', '② 译码 LDA',
    `LDA：从内存装载至 ${destReg}，ALU 不参与运算`,
    {IR:ir}, {}, {ALU_OP:0}));

  out.push(mk('load', '③ 操作数地址 → MAR',
    `MAR ← ${addrHex}（${sim.addressBits}位地址）`,
    {IR:ir, MAR:addr}, {}, {DATA_BUS:1}));

  out.push(mk('exec', '④ 地址分解 → 查 Cache',
    `Tag=${tagBin}(${tag})  ${idxLabel}=${index}  Offset=${offset}`,
    {IR:ir, MAR:addr}, {}, {DATA_BUS:1, RD_MEM:1}));

  if (event.hit) {
    out.push(mk('exec', `⑤ Cache 命中 ⚡  Line ${event.lineIdx}`,
      `命中无需访问主存，直接从 Cache 取数`,
      {IR:ir, MAR:addr}, {}, {DATA_BUS:1, RD_MEM:0}));
  } else {
    out.push(mk('exec', '⑤ Cache 缺失 ✕',
      `Tag=${tagBin} 在 ${idxLabel}=${index} 中未找到，发起主存访问`,
      {IR:ir, MAR:addr}, {}, {RD_MEM:1, DATA_BUS:1}));

    if (event.evicted) {
      out.push(mk('exec', `⑤' LRU 替换 Line ${event.evicted.line}`,
        `LRU 选中受害者：原 B${event.evicted.blockNum}（Tag=${event.evicted.tag}）被替换`,
        {IR:ir, MAR:addr}, {}, {RD_MEM:1, DATA_BUS:1}));
    }

    out.push(mk('exec', '⑥ 主存 → Cache 调块',
      `从主存 0x${blockBase.toString(16).toUpperCase()} 起读 ${sim.blockSize} 字节，载入 Line ${event.lineIdx}`,
      {IR:ir, MAR:addr}, {}, {RD_MEM:1, DATA_BUS:1}));
  }

  out.push(mk('exec', `⑦ MDR ← Cache[${event.lineIdx}][${offset}]`,
    `从 Cache 行偏移取出字节：MDR ← ${valHex}（十进制 ${value}）`,
    {IR:ir, MAR:addr, MDR:value}, {}, {DATA_BUS:1}));

  const sR = (value & 0x80) ? 1 : 0;
  const psw = {Z:value===0?1:0, N:sR, C:0, O:0, S:sR};
  const writeSig = destReg==='ACC' ? {WR_ACC:1} : {WR_X:1};
  const regUpdate = destReg==='ACC' ? {ACC:value} : {X:value};

  out.push(mk('writeback', `⑧ ${destReg} ← MDR`,
    `${destReg} ← ${value}（数据从总线送入 ${destReg}）`,
    {IR:ir, MAR:addr, MDR:value, ...regUpdate},
    {}, {DATA_BUS:1, ...writeSig}));

  out.push(mk('flags', '⑨ 更新 PSW',
    `根据装入字节设标志：Z=${psw.Z}, N=${psw.N}`,
    {IR:ir, MAR:addr, MDR:value, ...regUpdate},
    psw, {WR_PSW:1, ZERO:psw.Z, NEG:sR}));

  return out;
}

// ─── STA — Store Accumulator (走 Cache 写主存) ────────────────────────────────
export function staSteps(addr, accValue, sim, event) {
  const ir = 0x12;
  const value = accValue & 0xFF;
  const { offset, index, tag, blockBase } = event.parts;
  const addrHex = `0x${addr.toString(16).toUpperCase().padStart(2,'0')}`;
  const valHex  = `0x${value.toString(16).toUpperCase().padStart(2,'0')}`;
  const tagBin  = tag.toString(2).padStart(Math.max(sim.tagBits,1),'0');
  const idxLabel = sim.mode==='set'?'Set':sim.mode==='full'?'(无)':'Idx';
  const out = [];

  out.push(mk('fetch', '① 取指 STA',
    `读取 STA 指令字节（IR ← 0x${ir.toString(16).toUpperCase()}）`,
    {IR:ir, ACC:accValue}, {}, {RD_MEM:1, DATA_BUS:1}));

  out.push(mk('decode', '② 译码 STA',
    `STA：将 ACC 低8位写入指定内存地址`,
    {IR:ir, ACC:accValue}, {}, {ALU_OP:0}));

  out.push(mk('load', '③ 操作数地址 → MAR',
    `MAR ← ${addrHex}`,
    {IR:ir, ACC:accValue, MAR:addr}, {}, {DATA_BUS:1}));

  out.push(mk('exec', '④ ACC[7:0] → MDR',
    `MDR ← ${valHex}（待写入字节）`,
    {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {DATA_BUS:1}));

  out.push(mk('exec', '⑤ 地址分解 → 查 Cache',
    `Tag=${tagBin}(${tag})  ${idxLabel}=${index}  Offset=${offset}`,
    {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {DATA_BUS:1}));

  if (event.hit) {
    out.push(mk('exec', `⑥ Cache 命中 ⚡  Line ${event.lineIdx}`,
      `直接更新 Cache 内的字节`,
      {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {DATA_BUS:1}));
  } else {
    out.push(mk('exec', '⑥ Cache 缺失 ✕（写分配）',
      `先调块到 Cache，再写入 — write-allocate 策略`,
      {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {RD_MEM:1, DATA_BUS:1}));

    if (event.evicted) {
      out.push(mk('exec', `⑥' LRU 替换 Line ${event.evicted.line}`,
        `LRU 选中受害者：B${event.evicted.blockNum} 被替换`,
        {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {RD_MEM:1, DATA_BUS:1}));
    }

    out.push(mk('exec', '⑦ 主存 → Cache 调块',
      `从主存 0x${blockBase.toString(16).toUpperCase()} 起读 ${sim.blockSize} 字节到 Line ${event.lineIdx}`,
      {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {RD_MEM:1, DATA_BUS:1}));
  }

  out.push(mk('writeback', `⑧ Cache[${event.lineIdx}][${offset}] ← MDR`,
    `Cache 字节更新：${valHex}`,
    {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {DATA_BUS:1}));

  out.push(mk('exec', '⑨ Memory[MAR] ← MDR (write-through)',
    `主存对应字节同步更新（write-through 写穿透）`,
    {IR:ir, ACC:accValue, MAR:addr, MDR:value}, {}, {DATA_BUS:1, RD_MEM:0}));

  return out;
}

// ─── Float ADD / SUB — IEEE 754 ────────────────────────────────────────────────
export function floatSteps(a, b, op) {
  const subtract = op === '-';
  const ir = subtract ? 0x06 : 0x05;
  const aluOp = subtract ? 0b101 : 0b100;
  const fa = parseFloat32(a), fb = parseFloat32(b);
  const result = subtract ? a-b : a+b;
  const fr = parseFloat32(Math.fround(result));

  function fDesc(f) {
    return `符号=${f.sign} 阶码=${f.expBiased}(2^${f.expActual}) 尾数=1.${toBin23(f.mantissa).slice(0,10)}…`;
  }

  // Prepare aligned mantissas
  let mA = fa.isSubnormal ? fa.mantissa : (fa.mantissa | 0x800000);
  let mB = fb.isSubnormal ? fb.mantissa : (fb.mantissa | 0x800000);
  const expDiff = fa.expBiased - fb.expBiased;
  let alignedExp = fa.expBiased;
  let mB_aligned = mB, mA_aligned = mA;
  if (expDiff > 0) {
    mB_aligned = mB >>> Math.min(expDiff, 24);
  } else if (expDiff < 0) {
    mA_aligned = mA >>> Math.min(-expDiff, 24);
    alignedExp = fb.expBiased;
  }

  const effSignB = subtract ? (fb.sign^1) : fb.sign;
  const smA = fa.sign===0 ? mA_aligned : -mA_aligned;
  const smB = effSignB===0 ? mB_aligned : -mB_aligned;
  const rawMant = smA + smB;

  // Build intermediate float bits (before normalize)
  const buf4 = new ArrayBuffer(4);
  const f32v = new Float32Array(buf4); const u32v = new Uint32Array(buf4);
  f32v[0] = Math.fround(result); const resBits = u32v[0];

  return [
    mk('fetch', '① 取指 FETCH',
      `PC→MAR，读取F${subtract?'SUB':'ADD'}指令`,
      {IR:ir}, {}, {RD_MEM:1,DATA_BUS:1}),
    mk('decode','② 译码 DECODE',
      `ALU_OP←${aluOp.toString(2).padStart(3,'0')} (F${subtract?'SUB':'ADD'})`,
      {IR:ir}, {}, {ALU_OP:aluOp}),
    mk('load',  '③ 解析浮点 A',
      fDesc(fa),
      {IR:ir, ACC: fa.bits|0}, {}, {RD_MEM:1,WR_ACC:1,DATA_BUS:1,ALU_OP:aluOp}),
    mk('load',  '④ 解析浮点 B',
      fDesc(fb),
      {IR:ir, ACC:fa.bits|0, X:fb.bits|0}, {}, {RD_MEM:1,WR_X:1,DATA_BUS:1,ALU_OP:aluOp}),
    mk('exec',  '⑤ 比较阶码',
      `E_A=${fa.expBiased}(2^${fa.expActual})，E_B=${fb.expBiased}(2^${fb.expActual})，差=${expDiff}`,
      {IR:ir,ACC:fa.bits|0,X:fb.bits|0}, {}, {ENA_ALU:1,ALU_OP:aluOp}),
    mk('exec',  '⑥ 对阶（小阶向大阶对齐）',
      expDiff===0 ? '阶码相等，无需移位' :
      expDiff>0 ? `B尾数右移${Math.min(expDiff,24)}位对齐至2^${fa.expActual}` :
                  `A尾数右移${Math.min(-expDiff,24)}位对齐至2^${fb.expActual}`,
      {IR:ir,ACC:fa.bits|0,X:fb.bits|0}, {}, {ENA_ALU:1,ALU_OP:aluOp,DATA_BUS:1}),
    mk('exec',  '⑦ 尾数加减运算',
      `(${fa.sign?'-':'+'}1.m_A)+(${effSignB?'-':'+'}1.m_B) = ${rawMant>=0?'+':''}${rawMant}`,
      {IR:ir,ACC:fa.bits|0,X:fb.bits|0}, {}, {ENA_ALU:1,ALU_OP:aluOp,DATA_BUS:1,CIN:effSignB}),
    mk('exec',  '⑧ 规格化 & 舍入(GRS)',
      `IEEE 754 就近舍入，调整阶码 → 2^${fr.expActual}`,
      {IR:ir,ACC:resBits|0,X:fb.bits|0}, {}, {ENA_ALU:1,ALU_OP:aluOp,DATA_BUS:1}),
    mk('writeback','⑨ 结果写回 ACC',
      fDesc(fr),
      {IR:ir,ACC:resBits|0,X:fb.bits|0}, {}, {WR_ACC:1,DATA_BUS:1,ALU_OP:aluOp}),
    mk('flags', '⑩ 更新 PSW',
      `Z=${fr.val===0?1:0} N=${fr.sign} O=${fr.isInf?1:0}`,
      {IR:ir,ACC:resBits|0,X:fb.bits|0},
      {Z:fr.val===0?1:0,N:fr.sign,O:fr.isInf?1:0,S:fr.sign},
      {WR_PSW:1,ZERO:fr.val===0?1:0,NEG:fr.sign,OVF:fr.isInf?1:0,ALU_OP:aluOp}),
  ];
}
