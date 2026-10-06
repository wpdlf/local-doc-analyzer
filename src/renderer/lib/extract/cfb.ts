/**
 * OLE CFB(Compound File Binary) 읽기 전용 리더 — `.hwp`(HWP 5.x) 컨테이너.
 *
 * 새 의존성 없이 직접 구현한다(설계 H2). 신뢰할 수 없는 바이너리라 **모든 섹터 번호·길이를 믿지 않는다**:
 * 체인은 방문 집합으로 순환을 끊고 길이를 파일 섹터 수(또는 스트림 크기)로 묶으며, 디렉터리 트리는 방문
 * 집합과 깊이 상한으로 순회한다. 구조가 어긋나면 DOC_CORRUPT, 항목 수 상한은 DOC_TOO_LARGE.
 * 스트림은 bytes() 를 부를 때 읽고, 압축은 풀지 않는다 — 추출기가 문서 전체 예산으로 푼다.
 */
import { hasCfbMagic } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { MAX_ZIP_ENTRIES } from './zip';
import type { ContainerIndex } from './types';

const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;
const MAX_REGSECT = 0xfffffffa;
const HEADER_SIZE = 512;
const HEADER_DIFAT = 109;
const DIR_ENTRY = 128;
const MINI_CUTOFF = 4096;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
/** 디렉터리 항목 수 상한 — zip 엔트리 상한과 같은 값(목록 순회 비용을 묶는다). */
export const MAX_CFB_ENTRIES = MAX_ZIP_ENTRIES;
/** 저장소 중첩 깊이 상한. HWP 는 두 단(`BodyText/Section0`)이면 충분하다. */
const MAX_STORAGE_DEPTH = 32;

interface DirEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

function corrupt(why: string): never {
  return extractFail('DOC_CORRUPT', `cfb: ${why}`);
}

export function openCfb(data: ArrayBuffer): ContainerIndex {
  const buf = new Uint8Array(data);
  if (buf.length < HEADER_SIZE || !hasCfbMagic(buf)) corrupt('not a compound file');
  const dv = new DataView(data);
  const sectorShift = dv.getUint16(30, true);
  const miniShift = dv.getUint16(32, true);
  if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) corrupt('sector size');
  const secSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  // 헤더가 섹터 -1 자리를 차지한다(v4 는 4096 바이트 헤더). 잘린 마지막 섹터도 세고, 읽을 때 길이로 거른다.
  const sectorCount = Math.max(0, Math.ceil((buf.length - secSize) / secSize));
  const numFat = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true);
  const difatStart = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);
  if (miniCutoff !== MINI_CUTOFF) corrupt('mini stream cutoff');
  // FAT 섹터도 파일 안의 섹터다 — 개수는 파일 섹터 수를 넘을 수 없다(FAT 배열 크기 ≤ 파일 크기).
  if (numFat === 0 || numFat > sectorCount) corrupt('fat sector count');

  /** 메타데이터(FAT·DIFAT·디렉터리) 섹터는 온전한 한 섹터여야 한다. */
  const fullSector = (n: number): number => {
    const off = (n + 1) * secSize;
    if (n >= sectorCount || off + secSize > buf.length) corrupt('sector out of range');
    return off;
  };

  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT && fatSectors.length < numFat; i++) fatSectors.push(dv.getUint32(76 + i * 4, true));
  const perDifat = secSize / 4 - 1;
  const seenDifat = new Set<number>();
  for (let d = difatStart; fatSectors.length < numFat;) {
    if (d > MAX_REGSECT || seenDifat.has(d) || seenDifat.size >= numDifat) corrupt('difat chain');
    seenDifat.add(d);
    const off = fullSector(d);
    for (let i = 0; i < perDifat && fatSectors.length < numFat; i++) fatSectors.push(dv.getUint32(off + i * 4, true));
    d = dv.getUint32(off + perDifat * 4, true);
  }
  const perSector = secSize / 4;
  const fat = new Uint32Array(numFat * perSector);
  for (const [k, s] of fatSectors.entries()) {
    const off = fullSector(s);
    for (let i = 0; i < perSector; i++) fat[k * perSector + i] = dv.getUint32(off + i * 4, true);
  }

  /** start 부터 ENDOFCHAIN 까지(크기를 모르는 디렉터리·미니 FAT). 순환·범위 밖·과대 길이는 손상이다. */
  const walkChain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== ENDOFCHAIN; s = table[s]!) {
      if (s > MAX_REGSECT || s >= table.length || seen.has(s) || out.length >= limit) corrupt('sector chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  /** 정확히 count 개(스트림 크기에서 도출). 체인이 먼저 끝나면 손상 — 뒤 꼬리는 따라가지 않는다. */
  const takeChain = (start: number, table: Uint32Array, count: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; out.length < count; s = table[s]!) {
      if (s > MAX_REGSECT || s >= table.length || seen.has(s)) corrupt('sector chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readAll = (start: number): Uint8Array => {
    const secs = walkChain(start, fat, sectorCount);
    const out = new Uint8Array(secs.length * secSize);
    secs.forEach((s, i) => { const off = fullSector(s); out.set(buf.subarray(off, off + secSize), i * secSize); });
    return out;
  };
  const readRegular = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    for (const [i, s] of takeChain(start, fat, Math.ceil(size / secSize)).entries()) {
      if (s >= sectorCount) corrupt('sector out of range');
      const from = (s + 1) * secSize;
      const len = Math.min(secSize, size - i * secSize);
      if (from + len > buf.length) corrupt('stream past end of file');
      out.set(buf.subarray(from, from + len), i * secSize);
    }
    return out;
  };

  const dirBytes = readAll(dirStart);
  const entryCount = dirBytes.length / DIR_ENTRY;
  if (entryCount > MAX_CFB_ENTRIES) {
    // 빈 항목(type 0)은 섹터 채움이다 — 실제로 쓰인 항목만 센다.
    let used = 0;
    for (let i = 0; i < entryCount; i++) if (dirBytes[i * DIR_ENTRY + 66] !== 0) used += 1;
    if (used > MAX_CFB_ENTRIES) extractFail('DOC_TOO_LARGE', 'cfb directory entry count exceeded');
  }
  const ddv = new DataView(dirBytes.buffer);
  const entries: (DirEntry | null)[] = [];
  for (let i = 0; i < entryCount; i++) {
    const o = i * DIR_ENTRY;
    const type = dirBytes[o + 66]!;
    if (type === 0) { entries.push(null); continue; }
    const nameLen = Math.min(64, ddv.getUint16(o + 64, true));
    let name = '';
    for (let k = 0; k < nameLen / 2 - 1; k++) name += String.fromCharCode(ddv.getUint16(o + k * 2, true));
    // v4(4096 섹터)만 크기 상위 32비트를 쓴다. 100MB 파일에 4GB 넘는 스트림은 있을 수 없다.
    if (secSize === 4096 && ddv.getUint32(o + 124, true) !== 0) corrupt('stream size');
    entries.push({
      name, type,
      left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true),
      start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true),
    });
  }
  const root = entries[0];
  if (!root || root.type !== TYPE_ROOT) corrupt('root entry');
  if (root.size > buf.length) corrupt('mini stream size');

  const streams = new Map<string, DirEntry>();
  const visited = new Set<number>();
  const stack: { idx: number; prefix: string; depth: number }[] = [{ idx: root.child, prefix: '', depth: 0 }];
  while (stack.length > 0) {
    const { idx, prefix, depth } = stack.pop()!;
    if (idx === NOSTREAM) continue;
    if (idx >= entries.length || visited.has(idx)) corrupt('directory tree');
    visited.add(idx);
    const e = entries[idx];
    if (!e) corrupt('directory tree');
    stack.push({ idx: e.left, prefix, depth }, { idx: e.right, prefix, depth });
    const path = prefix + e.name;
    if (e.type === TYPE_STORAGE) {
      if (depth + 1 > MAX_STORAGE_DEPTH) corrupt('storage depth');
      stack.push({ idx: e.child, prefix: `${path}/`, depth: depth + 1 });
    } else if (e.type === TYPE_STREAM) {
      streams.set(path, e);
    }
  }

  let mini: { stream: Uint8Array; fat: Uint32Array } | null = null;
  const loadMini = () => {
    if (!mini) {
      const stream = root.size > 0 ? readRegular(root.start, root.size) : new Uint8Array(0);
      const mf = miniFatStart > MAX_REGSECT ? new Uint8Array(0) : readAll(miniFatStart);
      const mdv = new DataView(mf.buffer);
      const table = new Uint32Array(mf.length / 4);
      for (let i = 0; i < table.length; i++) table[i] = mdv.getUint32(i * 4, true);
      mini = { stream, fat: table };
    }
    return mini;
  };
  const readMini = (start: number, size: number): Uint8Array => {
    const { stream, fat: mfat } = loadMini();
    const out = new Uint8Array(size);
    for (const [i, s] of takeChain(start, mfat, Math.ceil(size / miniSize)).entries()) {
      const from = s * miniSize;
      const len = Math.min(miniSize, size - i * miniSize);
      if (from + len > stream.length) corrupt('mini sector out of range');
      out.set(stream.subarray(from, from + len), i * miniSize);
    }
    return out;
  };

  const read = (name: string): Uint8Array | null => {
    const e = streams.get(name);
    if (!e) return null;
    if (e.size === 0) return new Uint8Array(0);
    // 크기 필드를 믿고 버퍼부터 잡으면 4GB 할당이 먼저 터진다 — 파일보다 큰 스트림은 손상이다.
    if (e.size > buf.length) corrupt('stream larger than file');
    return e.size < miniCutoff ? readMini(e.start, e.size) : readRegular(e.start, e.size);
  };
  const decoder = new TextDecoder('utf-8');
  return {
    names: () => [...streams.keys()],
    has: (name) => streams.has(name),
    bytes: read,
    text: (name) => {
      const b = read(name);
      return b ? decoder.decode(b) : null;
    },
  };
}
