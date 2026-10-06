/**
 * 테스트용 HWP 5.x 작성기 — 레코드 트리를 직렬화하고 CFB 로 묶는다. 유닛 테스트와 E2E 픽스처가 같이 쓴다.
 * 프로덕션 hwp-records.ts 의 상수를 import 하지 않는다(독립 오라클). 바이트 배치는 실물로 확정한 값이다
 * (docs/02-design/features/hwp-binary.design.md §0 "실물로 확정한 바이트 배치").
 */
import { deflateSync } from 'fflate';
import { buildCfb, toArrayBuffer, type CfbLayout } from './cfb-builder';

export { toArrayBuffer };

export const T = {
  DOCUMENT_PROPERTIES: 0x10, ID_MAPPINGS: 0x11, BIN_DATA: 0x12, PARA_SHAPE: 0x19,
  PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, CTRL_HEADER: 0x47, LIST_HEADER: 0x48,
  SHAPE_COMPONENT: 0x4c, TABLE: 0x4d, PICTURE: 0x55, EQEDIT: 0x58,
} as const;

export interface Rec { tag: number; data: Uint8Array; children?: Rec[] }

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const le16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const le32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const zeros = (n: number) => new Uint8Array(n);
const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c & 0xff; b[i * 2 + 1] = c >>> 8; }
  return b;
};
/** 컨트롤 id 4글자 → 저장 바이트(역순). 실물: `tbl ` ↔ 20 6c 62 74 */
export const idBytes = (id: string) => new Uint8Array([id.charCodeAt(3), id.charCodeAt(2), id.charCodeAt(1), id.charCodeAt(0)]);
const idOf = (rec: Rec) => String.fromCharCode(rec.data[3]!, rec.data[2]!, rec.data[1]!, rec.data[0]!);

export function serialize(nodes: Rec[], level = 0): Uint8Array {
  const out: Uint8Array[] = [];
  for (const n of nodes) {
    const size = n.data.length;
    const ext = size >= 0xfff;
    out.push(le32(((n.tag & 0x3ff) | ((level & 0x3ff) << 10) | ((ext ? 0xfff : size) << 20)) >>> 0));
    if (ext) out.push(le32(size));
    out.push(n.data);
    if (n.children?.length) out.push(serialize(n.children, level + 1));
  }
  return cat(...out);
}

/** 확장 컨트롤 문자 코드 — 구역/단 정의 2 · 필드 3 · 숨은 설명 15 · 머리말/꼬리말 16 · 각주/미주 17 · 자동 번호 18 · 개체 11 */
const CTRL_CHAR: Record<string, number> = { secd: 2, cold: 2, tcmt: 15, head: 16, foot: 16, 'fn  ': 17, 'en  ': 17, atno: 18 };
const ctrlChar = (id: string) => CTRL_CHAR[id] ?? (id.startsWith('%') ? 3 : 11);

export type Inline = string | Rec;
export interface ParaOptions { shape?: number; breakType?: number }

/** 문단 — 문자열은 본문, Rec(ctrl() 로 만든 CTRL_HEADER)은 그 자리에 확장 컨트롤 문자 8 wchar 를 넣는다. */
export function para(content: Inline | Inline[], o: ParaOptions = {}): Rec {
  const items = Array.isArray(content) ? content : [content];
  const units: number[] = [];
  const ctrls: Rec[] = [];
  for (const it of items) {
    if (typeof it === 'string') {
      for (let i = 0; i < it.length; i++) {
        const c = it.charCodeAt(i);
        if (c === 0x09) units.push(9, 0, 0, 0, 0, 0, 0, 9); // 탭은 인라인 컨트롤(8 wchar)
        else units.push(c); // '\n'(10)은 1 wchar 줄바꿈
      }
      continue;
    }
    const id = idOf(it);
    const code = ctrlChar(id);
    const b = idBytes(id);
    units.push(code, b[0]! | (b[1]! << 8), b[2]! | (b[3]! << 8), 0, 0, 0, 0, code);
    ctrls.push(it);
  }
  units.push(13);
  const text = new Uint8Array(units.length * 2);
  units.forEach((u, i) => { text[i * 2] = u & 0xff; text[i * 2 + 1] = u >>> 8; });
  // 24바이트: 글자 수 · 컨트롤 마스크 · 문단 모양 id @8 · 스타일 @10 · 나눔 종류 @11 · 글자 모양 수 @12(=1) · …
  const header = cat(le32(units.length), le32(0), le16(o.shape ?? 0), new Uint8Array([0, o.breakType ?? 0]), le16(1), zeros(10));
  return { tag: T.PARA_HEADER, data: header, children: [{ tag: T.PARA_TEXT, data: text }, { tag: T.PARA_CHAR_SHAPE, data: zeros(8) }, ...ctrls] };
}

export function ctrl(id: string, children: Rec[] = []): Rec {
  return { tag: T.CTRL_HEADER, data: cat(idBytes(id), zeros(40)), children };
}

export interface CellSpec { row: number; col: number; rowSpan?: number; colSpan?: number; paras: Rec[] }
export const cell = (row: number, col: number, text: string, span: { rowSpan?: number; colSpan?: number } = {}): CellSpec =>
  ({ row, col, ...span, paras: [para(text)] });

/** 표 셀 LIST_HEADER(47바이트, 실물과 같은 길이): 8바이트 머리 뒤 열 @8 · 행 @10 · 열 병합 @12 · 행 병합 @14 */
const cellHeader = (c: CellSpec) =>
  cat(le16(c.paras.length), le16(0), le32(0x20), le16(c.col), le16(c.row), le16(c.colSpan ?? 1), le16(c.rowSpan ?? 1), zeros(31));

export function table(rows: number, cols: number, cells: CellSpec[]): Rec {
  const tableRec: Rec = { tag: T.TABLE, data: cat(le32(0), le16(rows), le16(cols), zeros(10 + rows * 2)) };
  return ctrl('tbl ', [tableRec, ...cells.flatMap((c) => [{ tag: T.LIST_HEADER, data: cellHeader(c) }, ...c.paras])]);
}

const pictureRec = (binId: number): Rec => {
  const d = zeros(91);
  d[71] = binId & 0xff;
  d[72] = binId >>> 8;
  return { tag: T.PICTURE, data: d };
};
const shape = (id: string, children: Rec[]): Rec => ({ tag: T.SHAPE_COMPONENT, data: cat(idBytes(id), zeros(240)), children });

/** 실물과 같은 모양: gso → $pic → PICTURE */
export const picture = (binId: number): Rec => ctrl('gso ', [shape('$pic', [pictureRec(binId)])]);
/** 묶음 개체($con)로 depth 겹 감싼 그림 */
export function groupedPicture(depth: number, binId: number): Rec {
  let s = shape('$pic', [pictureRec(binId)]);
  for (let i = 0; i < depth; i++) s = shape('$con', [s]);
  return ctrl('gso ', [s]);
}
/** 글상자: gso → $rec → LIST_HEADER + 문단들 */
export const textBox = (paras: Rec[]): Rec =>
  ctrl('gso ', [shape('$rec', [{ tag: T.LIST_HEADER, data: cat(le16(paras.length), zeros(32)) }, ...paras])]);
export const equation = (script: string): Rec =>
  ctrl('eqed', [{ tag: T.EQEDIT, data: cat(le32(0), le16(script.length), utf16(script), zeros(16)) }]);

export interface BinSpec { id: number; ext: string; bytes: Uint8Array; type?: number; compress?: 0 | 1 | 2 }
export interface HwpSpec {
  /** 구역마다 최상위 문단 */
  sections: Rec[][];
  paraShapes?: { head: number; level: number }[];
  bins?: BinSpec[];
  /** 기본 0x01(압축) */
  flags?: number;
  /** 기본 5.1.1.0 */
  version?: number;
  prvText?: string;
  bodyDir?: 'BodyText' | 'ViewText';
  omit?: string[];
  /** 압축·직렬화를 건너뛰고 그대로 넣을 스트림(손상 입력용) */
  override?: Record<string, Uint8Array>;
}

export function docInfoBytes(spec: HwpSpec): Uint8Array {
  const shapes = spec.paraShapes ?? [{ head: 0, level: 0 }];
  return serialize([
    { tag: T.DOCUMENT_PROPERTIES, data: cat(le16(spec.sections.length), zeros(24)) },
    { tag: T.ID_MAPPINGS, data: cat(le32(spec.bins?.length ?? 0), zeros(68)) },
    ...(spec.bins ?? []).map((b) => ({ tag: T.BIN_DATA, data: cat(le16((b.type ?? 1) | ((b.compress ?? 0) << 4)), le16(b.id), le16(b.ext.length), utf16(b.ext)) })),
    ...shapes.map((s) => ({ tag: T.PARA_SHAPE, data: cat(le32(((s.head & 3) << 23) | ((s.level & 7) << 25)), zeros(50)) })),
  ]);
}

export function buildHwp(spec: HwpSpec): CfbLayout {
  const flags = spec.flags ?? 0x01;
  const compressed = (flags & 0x01) !== 0;
  const pack = (b: Uint8Array) => (compressed ? deflateSync(b) : b);
  const fileHeader = zeros(256);
  fileHeader.set(new TextEncoder().encode('HWP Document File'), 0);
  const fv = new DataView(fileHeader.buffer);
  fv.setUint32(32, spec.version ?? 0x05010100, true);
  fv.setUint32(36, flags, true);
  const streams: Record<string, Uint8Array> = { FileHeader: fileHeader, DocInfo: pack(docInfoBytes(spec)) };
  spec.sections.forEach((s, i) => { streams[`${spec.bodyDir ?? 'BodyText'}/Section${i}`] = pack(serialize(s)); });
  for (const b of spec.bins ?? []) {
    const name = `BinData/BIN${b.id.toString(16).toUpperCase().padStart(4, '0')}.${b.ext}`;
    const c = b.compress ?? 0;
    streams[name] = c === 2 || (c === 0 && !compressed) ? b.bytes : deflateSync(b.bytes);
  }
  if (spec.prvText !== undefined) streams.PrvText = utf16(spec.prvText);
  for (const o of spec.omit ?? []) delete streams[o];
  Object.assign(streams, spec.override ?? {});
  return buildCfb(streams);
}
