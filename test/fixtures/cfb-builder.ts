/**
 * 테스트용 CFB(v3, 512바이트 섹터) 작성기 — cfb.ts 리더의 독립 오라클이 되도록 MS-CFB 규약을 여기서
 * 따로 구현한다(리더 상수를 import 하지 않는다). 4096 미만 스트림은 미니 스트림에 넣고, FAT 섹터가
 * 109개를 넘으면 DIFAT 섹터를 만든다. 공격 입력은 반환된 layout 의 오프셋으로 바이트를 고쳐 만든다.
 */
const SEC = 512;
const MINI = 64;
const CUTOFF = 4096;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface Node {
  name: string;
  type: 1 | 2 | 5;
  data: Uint8Array;
  children: Node[];
  index: number;
  start: number;
  size: number;
  right: number;
  child: number;
}

export interface CfbLayout {
  bytes: Uint8Array;
  /** 디렉터리 항목 번호('' = 루트) */
  entryIndex(path: string): number;
  /** 디렉터리 항목(128B)의 파일 내 오프셋 */
  entryOffset(path: string): number;
  /** 일반 FAT 항목 n 의 파일 내 오프셋 */
  fatEntryOffset(n: number): number;
  /** 미니 FAT 항목 n 의 파일 내 오프셋 */
  miniFatEntryOffset(n: number): number;
  /** 스트림의 시작 섹터(미니 스트림이면 미니 섹터 번호) */
  startSector(path: string): number;
  difatSectorCount: number;
}

function u32s(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function buildCfb(streams: Record<string, Uint8Array>): CfbLayout {
  const mk = (name: string, type: 1 | 2 | 5, data: Uint8Array = new Uint8Array(0)): Node =>
    ({ name, type, data, children: [], index: -1, start: END, size: type === 2 ? data.length : 0, right: NOSTREAM, child: NOSTREAM });
  const root = mk('Root Entry', 5);
  const byPath = new Map<string, Node>([['', root]]);
  for (const [path, data] of Object.entries(streams)) {
    const parts = path.split('/');
    let parent = root;
    parts.forEach((part, i) => {
      const sub = parts.slice(0, i + 1).join('/');
      let node = byPath.get(sub);
      if (!node) {
        node = i === parts.length - 1 ? mk(part, 2, data) : mk(part, 1);
        parent.children.push(node);
        byPath.set(sub, node);
      }
      parent = node;
    });
  }
  // 항목 번호는 너비 우선. 형제는 오른쪽 링크 한 줄로 잇는다(리더는 균형을 요구하지 않는다).
  const order: Node[] = [];
  const queue: Node[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    n.index = order.length;
    order.push(n);
    queue.push(...n.children);
  }
  for (const n of order) {
    n.child = n.children[0]?.index ?? NOSTREAM;
    n.children.forEach((c, i) => { c.right = n.children[i + 1]?.index ?? NOSTREAM; });
  }

  // 미니 스트림
  const miniChunks: Uint8Array[] = [];
  const miniFat: number[] = [];
  for (const n of order) {
    if (n.type !== 2 || n.size === 0 || n.size >= CUTOFF) continue;
    const count = Math.ceil(n.size / MINI);
    n.start = miniFat.length;
    for (let k = 0; k < count; k++) {
      miniFat.push(k < count - 1 ? n.start + k + 1 : END);
      const c = new Uint8Array(MINI);
      c.set(n.data.subarray(k * MINI, (k + 1) * MINI));
      miniChunks.push(c);
    }
  }
  const miniStream = concat(miniChunks);
  root.size = miniStream.length;

  // 일반 섹터
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const alloc = (data: Uint8Array): number => {
    if (data.length === 0) return END;
    const count = Math.ceil(data.length / SEC);
    const start = fat.length;
    for (let k = 0; k < count; k++) {
      fat.push(k < count - 1 ? start + k + 1 : END);
      const s = new Uint8Array(SEC);
      s.set(data.subarray(k * SEC, (k + 1) * SEC));
      sectors.push(s);
    }
    return start;
  };
  for (const n of order) if (n.type === 2 && n.size >= CUTOFF) n.start = alloc(n.data);
  root.start = alloc(miniStream);
  const miniFatStart = alloc(u32s(miniFat));
  const miniFatSectors = Math.ceil((miniFat.length * 4) / SEC);

  const dir = new Uint8Array(Math.ceil(order.length / 4) * 4 * 128);
  const ddv = new DataView(dir.buffer);
  for (const n of order) {
    const o = n.index * 128;
    const name = n.name.slice(0, 31);
    for (let i = 0; i < name.length; i++) ddv.setUint16(o + i * 2, name.charCodeAt(i), true);
    ddv.setUint16(o + 64, (name.length + 1) * 2, true);
    dir[o + 66] = n.type;
    dir[o + 67] = 1; // black
    ddv.setUint32(o + 68, NOSTREAM, true);
    ddv.setUint32(o + 72, n.right, true);
    ddv.setUint32(o + 76, n.child, true);
    ddv.setUint32(o + 116, n.start, true);
    ddv.setUint32(o + 120, n.size, true);
  }
  const dirStart = alloc(dir);

  // FAT · DIFAT 섹터 수는 자기 자신도 섹터라 수렴할 때까지 반복한다.
  const data = fat.length;
  let nFat = 1;
  let nDifat = 0;
  for (;;) {
    const needFat = Math.ceil((data + nFat + nDifat) / 128);
    const needDifat = needFat > 109 ? Math.ceil((needFat - 109) / 127) : 0;
    if (needFat === nFat && needDifat === nDifat) break;
    nFat = needFat;
    nDifat = needDifat;
  }
  const fatIds = Array.from({ length: nFat }, (_, i) => data + i);
  const difatIds = Array.from({ length: nDifat }, (_, i) => data + nFat + i);
  for (let i = 0; i < nFat; i++) fat.push(FATSECT);
  for (let i = 0; i < nDifat; i++) fat.push(DIFSECT);
  while (fat.length < nFat * 128) fat.push(FREE);
  const fatBytes = u32s(fat);
  for (let i = 0; i < nFat; i++) sectors.push(fatBytes.slice(i * SEC, (i + 1) * SEC));
  const rest = fatIds.slice(109);
  for (let i = 0; i < nDifat; i++) {
    const chunk = rest.slice(i * 127, (i + 1) * 127);
    while (chunk.length < 127) chunk.push(FREE);
    chunk.push(i < nDifat - 1 ? difatIds[i + 1]! : END);
    sectors.push(u32s(chunk));
  }

  const header = new Uint8Array(SEC);
  const hv = new DataView(header.buffer);
  header.set(MAGIC, 0);
  hv.setUint16(24, 0x3e, true);
  hv.setUint16(26, 3, true);
  hv.setUint16(28, 0xfffe, true);
  hv.setUint16(30, 9, true);
  hv.setUint16(32, 6, true);
  hv.setUint32(44, nFat, true);
  hv.setUint32(48, dirStart, true);
  hv.setUint32(56, CUTOFF, true);
  hv.setUint32(60, miniFatStart, true);
  hv.setUint32(64, miniFatSectors, true);
  hv.setUint32(68, nDifat > 0 ? difatIds[0]! : END, true);
  hv.setUint32(72, nDifat, true);
  for (let i = 0; i < 109; i++) hv.setUint32(76 + i * 4, i < nFat ? fatIds[i]! : FREE, true);

  const bytes = concat([header, ...sectors]);
  const node = (path: string): Node => {
    const n = byPath.get(path);
    if (!n) throw new Error(`no entry ${path}`);
    return n;
  };
  return {
    bytes,
    entryIndex: (path) => node(path).index,
    entryOffset: (path) => (dirStart + 1) * SEC + node(path).index * 128,
    fatEntryOffset: (n) => (fatIds[Math.floor(n / 128)]! + 1) * SEC + (n % 128) * 4,
    miniFatEntryOffset: (n) => (miniFatStart + 1) * SEC + n * 4,
    startSector: (path) => node(path).start,
    difatSectorCount: nDifat,
  };
}

export const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
