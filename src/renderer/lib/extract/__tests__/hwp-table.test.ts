import { describe, it, expect } from 'vitest';
import { readTable } from '../hwp-table';
import { buildTree, parseRecords } from '../hwp-records';
import { serialize, table, cell, para, ctrl, T, type Rec } from '../../../../../test/fixtures/hwp-builder';

const node = (rec: Rec) => buildTree(parseRecords(serialize([rec])))[0]!;
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as { code?: string }).code); }
  return 'no-throw';
};

describe('readTable', () => {
  it('셀 주소·병합은 LIST_HEADER @8~@14 에서 읽는다 (실물 확인 배치)', () => {
    const t = readTable(node(table(2, 3, [
      cell(0, 0, '분류', { rowSpan: 2 }), cell(0, 1, '항목'), cell(0, 2, '달성률', { colSpan: 1 }),
      cell(1, 1, '기능', { colSpan: 2 }),
    ])));
    expect([t.rows, t.cols]).toEqual([2, 3]);
    expect(t.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan])).toEqual([[0, 0, 2, 1], [0, 1, 1, 1], [0, 2, 1, 1], [1, 1, 1, 2]]);
  });

  it('셀 문단은 다음 LIST_HEADER 전까지의 형제 문단이다', () => {
    const t = readTable(node(table(1, 2, [{ row: 0, col: 0, paras: [para('a'), para('b')] }, cell(0, 1, 'c')])));
    expect(t.cells.map((c) => c.paras.length)).toEqual([2, 1]);
  });

  it('표 캡션(TABLE 앞 LIST_HEADER)은 셀이 아니다 — 짧은 머리여도 DOC_CORRUPT 가 되지 않는다', () => {
    const t = table(1, 2, [cell(0, 0, 'a'), cell(0, 1, 'b')]);
    const at = t.children!.findIndex((k) => k.tag === T.TABLE);
    for (const len of [47, 6]) {
      const kids = [...t.children!];
      kids.splice(at, 0, { tag: T.LIST_HEADER, data: new Uint8Array(len) }, para('표 1. 캡션'));
      const r = readTable(node({ ...t, children: kids }));
      expect(r.cells.map((c) => [c.row, c.col])).toEqual([[0, 0], [0, 1]]);
    }
  });

  it('TABLE 레코드가 없거나 셀 머리가 16바이트보다 짧으면 DOC_CORRUPT', () => {
    expect(codeOf(() => readTable(node(ctrl('tbl ', [{ tag: T.LIST_HEADER, data: new Uint8Array(20) }]))))).toBe('DOC_CORRUPT');
    const short = ctrl('tbl ', [{ tag: T.TABLE, data: new Uint8Array(20) }, { tag: T.LIST_HEADER, data: new Uint8Array(8) }]);
    expect(codeOf(() => readTable(node(short)))).toBe('DOC_CORRUPT');
  });
});
