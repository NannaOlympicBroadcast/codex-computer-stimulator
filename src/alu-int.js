/** 32-bit signed integer ALU — simulates bit-level operations */

export function toBin32(n) {
  return (n >>> 0).toString(2).padStart(32, '0');
}

export function toHex32(n) {
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export class IntegerALU {
  add(a, b) {
    const ai = a | 0, bi = b | 0;
    const carries = new Array(33).fill(0);
    const bits = new Array(32).fill(0);
    let carry = 0;

    for (let i = 0; i < 32; i++) {
      const ab = (ai >>> i) & 1;
      const bb = (bi >>> i) & 1;
      const s = ab + bb + carry;
      bits[i] = s & 1;
      carry = s >> 1;
      carries[i + 1] = carry;
    }

    const result = (bits.reduce((acc, b, i) => acc | (b << i), 0)) | 0;
    const sA = (ai >>> 31) & 1, sB = (bi >>> 31) & 1, sR = (result >>> 31) & 1;
    const overflow = (sA === sB && sA !== sR) ? 1 : 0;

    return {
      result,
      flags: {
        zero: result === 0 ? 1 : 0,
        carry: carries[32],
        overflow,
        negative: sR,
        sign: sR ^ overflow,
      },
      carries,
      steps: [
        { label: 'A [补码]', value: toBin32(ai) },
        { label: 'B [补码]', value: toBin32(bi) },
        { label: '进位链 C₀-C₃₂', value: carries.map(c => c ? '1' : '0').join('') },
        { label: '结果 S', value: toBin32(result) },
        { label: '溢出检测', value: `sA=${sA} sB=${sB} sR=${sR} → OF=${overflow}` },
      ],
    };
  }

  sub(a, b) {
    const ai = a | 0, bi = b | 0;
    const negB = (~bi + 1) | 0;
    const res = this.add(ai, negB);
    res.steps = [
      { label: 'A [补码]', value: toBin32(ai) },
      { label: 'B [补码]', value: toBin32(bi) },
      { label: '[~B]', value: toBin32(~bi) },
      { label: '[-B] (取补)', value: toBin32(negB) },
      { label: '━━ 执行 A+[-B] ━━', value: '' },
      ...res.steps,
    ];
    return res;
  }

  mul(a, b) {
    const ai = a | 0, bi = b | 0;
    const bigA = BigInt(ai), bigB = BigInt(bi);
    const bigResult = bigA * bigB;
    const result = Number(BigInt.asIntN(32, bigResult));
    const highWord = Number(BigInt.asIntN(32, bigResult >> 32n));
    const overflow =
      bigResult < BigInt(-2147483648) || bigResult > BigInt(2147483647) ? 1 : 0;
    const sR = (result >>> 31) & 1;

    const boothSteps = this._boothSteps(ai, bi);

    return {
      result,
      mq: highWord,
      flags: { zero: result === 0 ? 1 : 0, carry: 0, overflow, negative: sR, sign: sR ^ overflow },
      steps: [
        { label: 'X [被乘数补码]', value: toBin32(ai) },
        { label: 'Y [乘数补码]', value: toBin32(bi) },
        { label: '算法', value: 'Booth 有符号乘法' },
        ...boothSteps,
        { label: '积低32位 → ACC', value: toBin32(result) },
        { label: '积高32位 → MQ', value: toBin32(highWord) },
        overflow ? { label: '溢出', value: '64位积超出32位表示范围' } : null,
      ].filter(Boolean),
    };
  }

  div(a, b) {
    const ai = a | 0, bi = b | 0;
    if (bi === 0) return { error: '除数为零', flags: { zero: 0, carry: 0, overflow: 1, negative: 0, sign: 0 } };

    // 不恢复余数法（加减交替法）
    const signN = ai < 0 ? -1 : 1, signD = bi < 0 ? -1 : 1;
    const signQ = signN * signD;
    const absN = BigInt(Math.abs(ai)), absD = BigInt(Math.abs(bi));

    let P = 0n, A = absN;
    const V = absD;
    const traceSteps = [
      { label: '算法', value: '不恢复余数法（加减交替法）' },
      { label: '|被除数| MQ', value: toBin32(Number(absN)) },
      { label: '|除数| X',   value: toBin32(Number(absD)) },
    ];

    for (let i = 0; i < 32; i++) {
      const msb = (A >> 31n) & 1n;
      P = (P << 1n) | msb;
      A = (A << 1n) & 0xFFFFFFFFn;
      if (P >= 0n) { P -= V; } else { P += V; }
      const qBit = P >= 0n ? 1n : 0n;
      A = (A & 0xFFFFFFFEn) | qBit;
      if (i < 4) traceSteps.push({
        label: `第${i+1}步 q${i}=${qBit}`,
        value: `ACC(P)=${Number(BigInt.asIntN(32,P))} MQ=${Number(BigInt.asUintN(32,A))}`,
      });
    }
    if (P < 0n) { P += V; traceSteps.push({ label: '余数修正 P+V', value: `余数=${P}` }); }

    let quotient  = Number(A),  remainder = Number(P);
    if (signQ < 0)  quotient  = -quotient;
    if (signN < 0)  remainder = -remainder;
    const quot32 = quotient | 0, rem32 = remainder | 0;
    const sR = (quot32 >>> 31) & 1;

    traceSteps.push({ label: '商 → ACC', value: toBin32(quot32) });
    traceSteps.push({ label: '余数 → MQ', value: toBin32(rem32) });
    traceSteps.push({ label: '验证', value: `${ai} = ${bi}×(${quot32}) + ${rem32}` });

    return {
      result: quot32, mq: rem32,
      flags: { zero: quot32===0?1:0, carry: 0, overflow: 0, negative: sR, sign: sR },
      steps: traceSteps,
    };
  }

  _boothSteps(a, b) {
    // Show first few Booth 2-bit recoding steps (simplified display)
    const steps = [];
    // Extend to 33 bits for sign
    const bBig = BigInt(b);
    const aBig = BigInt(a);
    // Booth recoding of multiplier: group bits 2 by 2 with overlap
    const bits = [];
    for (let i = 0; i < 32; i++) bits.push(Number((bBig >> BigInt(i)) & 1n));
    bits.push(Number((bBig >> 31n) & 1n)); // sign extension

    const table = { '0,0,0': 0, '0,0,1': 1, '0,1,0': 1, '0,1,1': 2, '1,0,0': -2, '1,0,1': -1, '1,1,0': -1, '1,1,1': 0 };
    let prev = 0;
    const partials = [];
    for (let i = 0; i < 32; i += 2) {
      const key = [bits[i + 1] ?? 0, bits[i], prev].join(',');
      const d = table[key] ?? 0;
      partials.push({ i, d });
      prev = bits[i + 1] ?? 0;
    }
    // Show first 4 partial products for brevity
    partials.slice(0, 4).forEach(({ i, d }) => {
      if (d !== 0) {
        const label = d === 2 ? '2×X' : d === -2 ? '-2×X' : d === 1 ? '+X' : '-X';
        steps.push({ label: `P${i / 2} (位${i + 1}:${i})`, value: `系数=${d} (${label}) 左移${i}位` });
      }
    });
    if (partials.length > 4) steps.push({ label: '…(共16组部分积)…', value: '' });
    return steps;
  }
}
