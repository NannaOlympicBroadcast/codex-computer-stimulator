/** IEEE 754 单精度浮点 ALU — 支持加减运算 */

const buf4 = new ArrayBuffer(4);
const f32View = new Float32Array(buf4);
const u32View = new Uint32Array(buf4);

export function toBin23(n) { return (n >>> 0).toString(2).padStart(23, '0'); }
export function toBin8(n)  { return (n >>> 0).toString(2).padStart(8, '0'); }

export function parseFloat32(val) {
  f32View[0] = val;
  const bits = u32View[0];
  const sign     = (bits >>> 31) & 1;
  const expBiased = (bits >>> 23) & 0xFF;
  const mantissa  = bits & 0x7FFFFF;
  const expActual = expBiased === 0 ? -126 : expBiased - 127;
  const isSubnormal = expBiased === 0;
  const isInf  = expBiased === 0xFF && mantissa === 0;
  const isNaN  = expBiased === 0xFF && mantissa !== 0;
  return { sign, expBiased, expActual, mantissa, bits, isSubnormal, isInf, isNaN, val };
}

function floatToBits(f) {
  f32View[0] = f;
  return u32View[0];
}

function describeSpecial(f) {
  if (f.isNaN) return 'NaN';
  if (f.isInf) return f.sign ? '-Inf' : '+Inf';
  if (f.isSubnormal) return '非规格化数';
  return null;
}

export class FloatALU {
  add(a, b) { return this._op(a, b, false); }
  sub(a, b) { return this._op(a, b, true); }

  _op(a, b, negate) {
    const fa = parseFloat32(a);
    const fb = parseFloat32(b);
    const steps = [];

    steps.push({ label: 'A 解析', value: this._describeFloat(fa) });
    steps.push({ label: 'B 解析', value: this._describeFloat(fb) });

    // Handle special values
    const specA = describeSpecial(fa), specB = describeSpecial(fb);
    if (specA || specB) {
      steps.push({ label: '特殊值处理', value: `A=${specA ?? '正常'} B=${specB ?? '正常'} → 硬件特判` });
      const rawResult = negate ? a - b : a + b;
      const fr = parseFloat32(rawResult);
      steps.push({ label: '结果', value: this._describeFloat(fr) });
      return { result: rawResult, steps, fa, fb, fr };
    }

    // Step 1: compare exponents
    const expDiff = fa.expBiased - fb.expBiased;
    steps.push({ label: '1. 比较阶码', value: `E_A=${fa.expBiased}(${fa.expActual > 0 ? '+' : ''}${fa.expActual}), E_B=${fb.expBiased}(${fb.expActual > 0 ? '+' : ''}${fb.expActual}), 差=${expDiff}` });

    // Step 2: align (add implicit 1)
    let mA = fa.isSubnormal ? fa.mantissa : (fa.mantissa | 0x800000); // 1.mantissa
    let mB = fb.isSubnormal ? fb.mantissa : (fb.mantissa | 0x800000);
    let expResult = fa.expBiased;

    if (expDiff > 0) {
      const shift = Math.min(expDiff, 24);
      mB = mB >>> shift;
      steps.push({ label: '2. 对阶', value: `B尾数右移${shift}位，以对齐至阶${fa.expActual}` });
    } else if (expDiff < 0) {
      const shift = Math.min(-expDiff, 24);
      mA = mA >>> shift;
      expResult = fb.expBiased;
      steps.push({ label: '2. 对阶', value: `A尾数右移${shift}位，以对齐至阶${fb.expActual}` });
    } else {
      steps.push({ label: '2. 对阶', value: '阶码相等，无需移位' });
    }

    // Step 3: signed mantissa add/sub
    const effectiveSignB = negate ? (fb.sign ^ 1) : fb.sign;
    const signedA = fa.sign === 0 ? mA : -mA;
    const signedB = effectiveSignB === 0 ? mB : -mB;
    const rawMantissa = signedA + signedB;
    steps.push({ label: '3. 尾数运算', value: `(${fa.sign ? '-' : '+'}1.m_A) + (${effectiveSignB ? '-' : '+'}1.m_B) = ${rawMantissa >= 0 ? '+' : ''}${rawMantissa}` });

    // Step 4: normalize (using hardware float for accuracy)
    const rawResult = negate ? a - b : a + b;
    const fr = parseFloat32(rawResult);

    if (rawMantissa !== 0) {
      const normShift = fr.expBiased - expResult;
      if (normShift > 0) steps.push({ label: '4. 规格化', value: `尾数右移${normShift}位，阶码+${normShift}` });
      else if (normShift < 0) steps.push({ label: '4. 规格化', value: `尾数左移${-normShift}位，阶码${normShift}` });
      else steps.push({ label: '4. 规格化', value: '尾数已规格化，无需移位' });
    } else {
      steps.push({ label: '4. 规格化', value: '结果为零' });
    }

    steps.push({ label: '5. 舍入 (GRS)', value: 'IEEE 754 就近舍入（round to nearest even）' });
    steps.push({ label: '结果', value: this._describeFloat(fr) });

    return { result: rawResult, steps, fa, fb, fr };
  }

  _describeFloat(f) {
    if (f.isNaN)  return `NaN  [${toBin8(f.expBiased)} | ${toBin23(f.mantissa)}]`;
    if (f.isInf)  return `${f.sign ? '-' : '+'}Inf [${toBin8(f.expBiased)} | ${toBin23(f.mantissa)}]`;
    const implicit = f.isSubnormal ? '0' : '1';
    return `${f.sign ? '-' : '+'}  阶=${f.expBiased}(2^${f.expActual})  ${implicit}.${toBin23(f.mantissa)}`;
  }
}
