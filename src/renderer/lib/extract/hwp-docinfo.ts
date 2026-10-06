import { TAG, u16, u32, readUtf16, type HwpRecord } from './hwp-records';

/** 그림 스트림 하나. compress: 'doc' = 문서 압축 플래그를 따름(실물 기본값) */
export interface BinDataEntry {
  stream: string;
  compress: 'doc' | 'yes' | 'no';
}

export interface HwpDocInfo {
  /** 문단 모양 id → 제목 수준(1-based). 개요 문단 모양만 들어 있다. */
  outlineLevels: Map<number, number>;
  /** BinItem id(1-based) - 1 → 그림 스트림. 링크형·OLE 저장형은 null */
  binData: (BinDataEntry | null)[];
}

const HEAD_OUTLINE = 1;
const BIN_EMBEDDING = 1;

function readBinData(d: Uint8Array): BinDataEntry | null {
  if (d.length < 6) return null;
  const attr = u16(d, 0);
  if ((attr & 0xf) !== BIN_EMBEDDING) return null;
  const id = u16(d, 2);
  const extLen = u16(d, 4);
  if (6 + extLen * 2 > d.length) return null;
  const ext = readUtf16(d, 6, extLen).toLowerCase();
  // 스트림 이름에 붙는다 — 경로 문자나 이상한 길이는 받지 않는다.
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return null;
  const mode = (attr >>> 4) & 3;
  return {
    stream: `BinData/BIN${id.toString(16).toUpperCase().padStart(4, '0')}.${ext}`,
    compress: mode === 1 ? 'yes' : mode === 2 ? 'no' : 'doc',
  };
}

/** DocInfo 레코드(평평한 목록) → 개요 수준 · 그림 목록. 문단 모양·BinData id 는 등장 순번이다. */
export function readDocInfo(flat: HwpRecord[]): HwpDocInfo {
  const outlineLevels = new Map<number, number>();
  const binData: (BinDataEntry | null)[] = [];
  let shapeId = 0;
  for (const r of flat) {
    if (r.tag === TAG.PARA_SHAPE) {
      const attr = u32(r.data, 0);
      // 머리 종류 bit23-24(1 = 개요) · 수준 bit25-27(0-based). 스타일 이름("개요 1")은 보지 않는다 —
      // hwpx-header.ts 와 같은 이유(문단이 실제로 참조하는 모양 하나로 판정).
      if (r.data.length >= 4 && ((attr >>> 23) & 3) === HEAD_OUTLINE) outlineLevels.set(shapeId, ((attr >>> 25) & 7) + 1);
      shapeId += 1;
    } else if (r.tag === TAG.BIN_DATA) {
      binData.push(readBinData(r.data));
    }
  }
  return { outlineLevels, binData };
}
