import { extractFail } from './errors';
import { TAG, u16, type HwpRecord } from './hwp-records';

export interface HwpCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** 이 셀의 문단(PARA_HEADER 노드) */
  paras: HwpRecord[];
}

/** LIST_HEADER 뒤에 이어지는 형제 문단들 — 셀·글상자의 내용이다(실물: 같은 level 의 형제). */
export function followingParagraphs(siblings: HwpRecord[], start: number): HwpRecord[] {
  const out: HwpRecord[] = [];
  for (let j = start; j < siblings.length && siblings[j]!.tag === TAG.PARA_HEADER; j++) out.push(siblings[j]!);
  return out;
}

/**
 * 표 컨트롤(CTRL_HEADER 'tbl ') → 선언 행·열 수와 셀 목록. 격자 배치(gridExtent·placeGridCells)는 호출자가 한다.
 *
 * 셀 LIST_HEADER 는 **8바이트 머리**(문단 수 u16 · 미상 u16 · 속성 u32) 뒤에 열 @8 · 행 @10 · 열 병합 @12 ·
 * 행 병합 @14 를 둔다 — 공식 스펙 표는 머리를 6바이트로 적어 두 칸 어긋난다(실물 3×5 병합 표로 확인, 설계 §0).
 */
export function readTable(ctrl: HwpRecord): { rows: number; cols: number; cells: HwpCell[] } {
  const kids = ctrl.children;
  const table = kids.find((k) => k.tag === TAG.TABLE);
  if (!table || table.data.length < 8) extractFail('DOC_CORRUPT', 'table record missing');
  const cells: HwpCell[] = [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k.tag !== TAG.LIST_HEADER) continue;
    if (k.data.length < 16) extractFail('DOC_CORRUPT', 'table cell header too short');
    cells.push({
      col: u16(k.data, 8),
      row: u16(k.data, 10),
      colSpan: Math.max(1, u16(k.data, 12)),
      rowSpan: Math.max(1, u16(k.data, 14)),
      paras: followingParagraphs(kids, i + 1),
    });
  }
  return { rows: u16(table.data, 4), cols: u16(table.data, 6), cells };
}
