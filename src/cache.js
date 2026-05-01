/**
 * Cache + 主存模拟器
 * 支持三种映射方式：直接映射 / 全相联 / 组相联
 * 写策略：写穿透（write-through, write-allocate）
 * 替换策略：LRU
 */

export class MemoryCacheSim {
  constructor(cfg = {}) {
    this.configure({
      mode: 'direct',          // 'direct' | 'full' | 'set'
      addressBits: 6,          // 64 字节主存
      blockSize: 4,            // 4 字节/块
      cacheLines: 4,           // 4 行
      ways: 2,                 // 组相联：每组2路
      ...cfg,
    });
  }

  configure(cfg) {
    Object.assign(this, cfg);
    this.totalBytes = 1 << this.addressBits;
    this.numBlocks  = this.totalBytes / this.blockSize;
    this.offsetBits = Math.log2(this.blockSize);

    if (this.mode === 'direct') {
      this.indexBits = Math.log2(this.cacheLines);
      this.tagBits   = this.addressBits - this.indexBits - this.offsetBits;
      this.numSets   = this.cacheLines;
      this.waysActual= 1;
    } else if (this.mode === 'full') {
      this.indexBits = 0;
      this.tagBits   = this.addressBits - this.offsetBits;
      this.numSets   = 1;
      this.waysActual= this.cacheLines;
    } else { // set
      this.numSets   = this.cacheLines / this.ways;
      this.indexBits = Math.log2(this.numSets);
      this.tagBits   = this.addressBits - this.indexBits - this.offsetBits;
      this.waysActual= this.ways;
    }

    this.memory = new Uint8Array(this.totalBytes);
    for (let i = 0; i < this.totalBytes; i++) this.memory[i] = i & 0xFF; // 初始填充

    this.cache = [];
    for (let i = 0; i < this.cacheLines; i++) {
      this.cache.push({
        valid: 0, tag: 0, lru: 0,
        data: new Uint8Array(this.blockSize),
      });
    }
    this.lruTick = 0;
    this.stats = { hits: 0, misses: 0, total: 0 };
    this.log   = [];
  }

  decode(addr) {
    const offMask = (1 << this.offsetBits) - 1;
    const offset  = addr & offMask;
    let index = 0, tag = 0;
    if (this.mode === 'direct' || this.mode === 'set') {
      index = (addr >> this.offsetBits) & ((1 << this.indexBits) - 1);
      tag   = addr >> (this.offsetBits + this.indexBits);
    } else {
      tag = addr >> this.offsetBits;
    }
    const blockNum = addr >> this.offsetBits;
    const blockBase = addr & ~offMask;
    return { offset, index, tag, blockNum, blockBase };
  }

  /** 反推：从 (tag, setIndex) 还原内存块号 */
  reconstructBlock(tag, setIndex) {
    if (this.mode === 'full') return tag;            // 全相联：tag = blockNum
    return (tag << this.indexBits) | setIndex;       // 直接/组相联
  }

  setLineRange(setIndex) {
    if (this.mode === 'direct') return [setIndex, setIndex + 1];
    if (this.mode === 'full')   return [0, this.cacheLines];
    return [setIndex * this.ways, setIndex * this.ways + this.ways]; // set
  }

  access(addr, op = 'read', writeData = 0) {
    addr = addr & ((1 << this.addressBits) - 1);
    this.stats.total++;
    this.lruTick++;

    const parts = this.decode(addr);
    const { offset, index, tag, blockBase } = parts;
    const [lo, hi] = this.setLineRange(index);

    // 查找命中
    let hitLine = -1;
    for (let i = lo; i < hi; i++) {
      if (this.cache[i].valid && this.cache[i].tag === tag) { hitLine = i; break; }
    }

    let lineIdx, hit, evicted = null;
    if (hitLine >= 0) {
      hit = true;
      lineIdx = hitLine;
      this.stats.hits++;
    } else {
      hit = false;
      this.stats.misses++;
      // 选受害者：先选无效行，否则LRU
      let invIdx = -1;
      for (let i = lo; i < hi; i++) if (!this.cache[i].valid) { invIdx = i; break; }
      if (invIdx >= 0) {
        lineIdx = invIdx;
      } else {
        let minLru = Infinity, victim = lo;
        for (let i = lo; i < hi; i++) {
          if (this.cache[i].lru < minLru) { minLru = this.cache[i].lru; victim = i; }
        }
        lineIdx = victim;
        evicted = {
          line: lineIdx,
          tag: this.cache[lineIdx].tag,
          blockNum: this.reconstructBlock(this.cache[lineIdx].tag, index),
        };
      }
      // 从主存读入整块
      this.cache[lineIdx].valid = 1;
      this.cache[lineIdx].tag   = tag;
      for (let i = 0; i < this.blockSize; i++) {
        this.cache[lineIdx].data[i] = this.memory[blockBase + i];
      }
    }

    this.cache[lineIdx].lru = this.lruTick;

    // 实际读/写
    let value;
    if (op === 'read') {
      value = this.cache[lineIdx].data[offset];
    } else {
      this.cache[lineIdx].data[offset] = writeData & 0xFF;
      this.memory[addr] = writeData & 0xFF;       // write-through
      value = writeData & 0xFF;
    }

    const event = { addr, op, hit, lineIdx, parts, value, evicted, time: this.stats.total };
    this.log.unshift(event);
    if (this.log.length > 12) this.log.pop();
    return event;
  }

  reset() {
    for (const ln of this.cache) {
      ln.valid = 0; ln.tag = 0; ln.lru = 0; ln.data.fill(0);
    }
    this.stats = { hits: 0, misses: 0, total: 0 };
    this.log = [];
    this.lruTick = 0;
  }

  resetMemory() {
    for (let i = 0; i < this.totalBytes; i++) this.memory[i] = i & 0xFF;
  }
}
