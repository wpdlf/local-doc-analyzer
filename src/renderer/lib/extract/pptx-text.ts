import { walk, localName, attr, childrenNamed } from './xml';
import { toGfmTable } from './table';
import type { ZipIndex } from './types';

/**
 * PPTX 텍스트화 공용부 — 추출기(pptx.ts)와 그래픽 텍스트화(pptx-graphics.ts, Task 5)가 함께 쓴다.
 * 두 파일이 서로 import 하면 순환이 되므로 여기에 둔다.
 */

/** 텍스트 순회에서 통째로 건너뛰는 서브트리 — Fallback(Choice 와 중복), extLst(svgBlip·a14 확장), 번호·날짜 필드. */
export function skipNonText(el: Element): boolean {
  const name = localName(el);
  if (name === 'Fallback' || name === 'extLst') return true;
  if (name === 'fld') {
    const type = attr(el, 'type') ?? '';
    return type === 'slidenum' || type.startsWith('datetime');
  }
  return false;
}

/** `p:txBody`(또는 `a:txBody`) → 문단마다 한 줄. 빈 문단은 뺀다. */
export function textBodyText(txBody: Element): string {
  const lines: string[] = [];
  for (const p of childrenNamed(txBody, 'p')) {
    let line = '';
    for (const el of walk(p, (e) => e !== p && skipNonText(e))) {
      switch (localName(el)) {
        case 't': line += el.textContent ?? ''; break;
        case 'br': line += '\n'; break;
        case 'tab': line += '\t'; break;
      }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/** 표·차트·SmartArt 의 텍스트화 — Task 5 가 차트·SmartArt·병합 표를 채운다. */
export interface PptxGraphicsText {
  table(tbl: Element): string;
  chart(frame: Element, slidePart: string, zip: ZipIndex): string;
  smartArt(frame: Element, slidePart: string, zip: ZipIndex): string;
}

/** Task 4 기본값: 표는 행마다 셀(병합 미고려), 차트·SmartArt 는 빈 문자열. Task 5 가 교체한다. */
export const basicGraphics: PptxGraphicsText = {
  table(tbl) {
    const rows = childrenNamed(tbl, 'tr').map((tr) =>
      childrenNamed(tr, 'tc').map((tc) => {
        const body = childrenNamed(tc, 'txBody')[0];
        return body ? textBodyText(body) : '';
      }));
    return toGfmTable(rows);
  },
  chart: () => '',
  smartArt: () => '',
};
