import { describe, it, expect } from 'vitest';
import { openCfb, MAX_CFB_ENTRIES } from '../cfb';
import { buildCfb, toArrayBuffer } from '../../../../../test/fixtures/cfb-builder';

const fill = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as { code?: string }).code); }
  return 'no-throw';
};
const poke32 = (bytes: Uint8Array, off: number, v: number) => new DataView(bytes.buffer, bytes.byteOffset).setUint32(off, v >>> 0, true);

describe('openCfb — 정상 경로', () => {
  it('일반 섹터 스트림 · 미니 스트림 · 중첩 저장소 경로를 그대로 읽는다', () => {
    const big = fill(5000, 1);
    const small = fill(100, 2);
    const nested = fill(70, 3);
    const idx = openCfb(toArrayBuffer(buildCfb({ FileHeader: small, 'BodyText/Section0': big, 'BinData/BIN0001.jpg': nested }).bytes));
    expect(idx.names().sort()).toEqual(['BinData/BIN0001.jpg', 'BodyText/Section0', 'FileHeader']);
    expect(idx.bytes('BodyText/Section0')).toEqual(big);
    expect(idx.bytes('FileHeader')).toEqual(small);
    expect(idx.bytes('BinData/BIN0001.jpg')).toEqual(nested);
    expect(idx.has('BodyText')).toBe(false); // 저장소는 스트림이 아니다
    expect(idx.bytes('없음')).toBeNull();
  });

  it('크기 0 스트림은 빈 바이트다', () => {
    expect(openCfb(toArrayBuffer(buildCfb({ empty: new Uint8Array(0) }).bytes)).bytes('empty')).toEqual(new Uint8Array(0));
  });

  it('미니 스트림 경계 — 4095 바이트(미니)와 4096 바이트(일반)를 둘 다 읽는다', () => {
    const a = fill(4095, 4);
    const b = fill(4096, 5);
    const idx = openCfb(toArrayBuffer(buildCfb({ a, b }).bytes));
    expect(idx.bytes('a')).toEqual(a);
    expect(idx.bytes('b')).toEqual(b);
  });

  it('FAT 섹터가 109개를 넘으면 DIFAT 체인을 따라간다 (~7MB)', () => {
    const big = fill(7_400_000, 9);
    const layout = buildCfb({ big });
    expect(layout.difatSectorCount).toBeGreaterThan(0);
    const out = openCfb(toArrayBuffer(layout.bytes)).bytes('big')!;
    expect(out.length).toBe(big.length);
    expect(out.subarray(0, 1000)).toEqual(big.subarray(0, 1000));
    expect(out.subarray(-1000)).toEqual(big.subarray(-1000));
  });

  it(`디렉터리 항목이 정확히 ${MAX_CFB_ENTRIES}개면 연다 (경계)`, () => {
    const streams: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_CFB_ENTRIES - 1; i++) streams[`s${i}`] = new Uint8Array(0); // + 루트 = MAX
    expect(openCfb(toArrayBuffer(buildCfb(streams).bytes)).names()).toHaveLength(MAX_CFB_ENTRIES - 1);
  });
});

describe('openCfb — 손상 · 공격 입력', () => {
  it('CFB 매직이 아니거나 헤더보다 짧으면 DOC_CORRUPT', () => {
    expect(codeOf(() => openCfb(new ArrayBuffer(600)))).toBe('DOC_CORRUPT');
    const short = buildCfb({ a: fill(10, 1) }).bytes.slice(0, 100);
    expect(codeOf(() => openCfb(toArrayBuffer(short)))).toBe('DOC_CORRUPT');
  });

  it('섹터 크기 필드가 9·12 가 아니면 DOC_CORRUPT', () => {
    const b = buildCfb({ a: fill(10, 1) }).bytes;
    new DataView(b.buffer).setUint16(30, 20, true);
    expect(codeOf(() => openCfb(toArrayBuffer(b)))).toBe('DOC_CORRUPT');
  });

  it('FAT 순환(뒤 섹터가 앞 섹터를 가리킴)은 무한 루프가 아니라 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    const s = layout.startSector('big');
    poke32(layout.bytes, layout.fatEntryOffset(s + 1), s);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it('미니 FAT 순환도 DOC_CORRUPT', () => {
    const layout = buildCfb({ small: fill(200, 1) }); // 미니 섹터 4개
    const s = layout.startSector('small');
    poke32(layout.bytes, layout.miniFatEntryOffset(s + 1), s);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('small'))).toBe('DOC_CORRUPT');
  });

  it('디렉터리 섹터 체인 순환(크기 없이 끝까지 따라가는 체인)도 DOC_CORRUPT', () => {
    // 스트림(takeChain)이 아니라 디렉터리·미니 FAT 를 읽는 walkChain 쪽 — 위 두 순환 테스트는 이 길을 지나지 않는다.
    const layout = buildCfb({ a: fill(10, 1) });
    const dirStart = new DataView(layout.bytes.buffer, layout.bytes.byteOffset).getUint32(48, true);
    poke32(layout.bytes, layout.fatEntryOffset(dirStart), dirStart);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)))).toBe('DOC_CORRUPT');
  });

  it('디렉터리 형제 링크 순환은 DOC_CORRUPT', () => {
    const layout = buildCfb({ a: fill(10, 1), b: fill(10, 2) });
    poke32(layout.bytes, layout.entryOffset('b') + 72, layout.entryIndex('b'));
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)))).toBe('DOC_CORRUPT');
  });

  it('저장소 중첩이 32단을 넘으면 DOC_CORRUPT (32단은 연다)', () => {
    const deep = (n: number) => `${Array.from({ length: n }, () => 'd').join('/')}/s`;
    expect(openCfb(toArrayBuffer(buildCfb({ [deep(32)]: fill(10, 1) }).bytes)).has(deep(32))).toBe(true);
    expect(codeOf(() => openCfb(toArrayBuffer(buildCfb({ [deep(33)]: fill(10, 1) }).bytes)))).toBe('DOC_CORRUPT');
  });

  it('범위 밖 시작 섹터는 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    poke32(layout.bytes, layout.entryOffset('big') + 116, 0x00ffffff);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it('스트림 크기가 체인보다 길면 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    poke32(layout.bytes, layout.entryOffset('big') + 120, 9000);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it('스트림 크기가 파일보다 크면 버퍼를 잡기 전에 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    poke32(layout.bytes, layout.entryOffset('big') + 120, 0x7fffffff);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it(`디렉터리 항목이 ${MAX_CFB_ENTRIES}개를 넘으면 DOC_TOO_LARGE`, () => {
    const streams: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_CFB_ENTRIES; i++) streams[`s${i}`] = new Uint8Array(0); // + 루트 = MAX + 1
    expect(codeOf(() => openCfb(toArrayBuffer(buildCfb(streams).bytes)))).toBe('DOC_TOO_LARGE');
  });
});
