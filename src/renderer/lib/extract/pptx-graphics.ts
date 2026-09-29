import { parseXml, walk, localName, attr, childrenNamed, prefixedAttr } from './xml';
import { readRels } from './ooxml';
import { toGfmTable, MAX_GRID_CELLS_PER_AXIS } from './table';
import { textBodyText, type PptxGraphicsText } from './pptx-text';
import type { ZipIndex } from './types';

/** 차트 캐시를 표로 옮길 때의 상한 — 수백 항목 차트가 단위 하나를 표로 도배하지 않게. */
const MAX_CHART_CATEGORIES = 50;
const MAX_CHART_SERIES = 20;

function isOn(v: string | null): boolean {
  return v === '1' || v === 'true';
}

/**
 * `a:tbl` → GFM. 격자의 모든 칸이 a:tc 로 있고(HWPX 와 다르다) 연속 칸은 속성으로 표시된다.
 * Google Slides 는 연속 칸을 `<a:tc vMerge="1"/>` 로 txBody 없이 쓴다 — 정규식 파서가 여기서
 * 다음 칸을 삼켰던 것이 실물 조사에서 확인됐다. 실제 파서로 읽으면 문제없다.
 */
function table(tbl: Element): string {
  const gridCols = childrenNamed(childrenNamed(tbl, 'tblGrid')[0] ?? tbl, 'gridCol').length;
  const rows: string[][] = [];
  let above: string[] = [];
  for (const tr of childrenNamed(tbl, 'tr')) {
    const row: string[] = [];
    for (const tc of childrenNamed(tr, 'tc')) {
      if (row.length >= MAX_GRID_CELLS_PER_AXIS) break;
      if (isOn(attr(tc, 'vMerge'))) row.push(above[row.length] ?? '');
      else if (isOn(attr(tc, 'hMerge'))) row.push('');
      else {
        const body = childrenNamed(tc, 'txBody')[0];
        row.push(body ? textBodyText(body) : '');
      }
    }
    while (row.length < Math.min(gridCols, MAX_GRID_CELLS_PER_AXIS)) row.push('');
    rows.push(row);
    above = row;
  }
  return toGfmTable(rows);
}

/** 그래픽 프레임에서 관계 id(접두사 속성)를 가진 첫 요소의 대상 파트를 읽는다. */
function relatedPart(frame: Element, elName: string, attrName: string, slidePart: string, zip: ZipIndex): Element | null {
  const ref = [...walk(frame)].find((e) => localName(e) === elName);
  const relId = ref ? prefixedAttr(ref, attrName) : null;
  const path = relId ? readRels(zip, slidePart).get(relId) : undefined;
  const xml = path ? zip.text(path) : null;
  return xml ? parseXml(xml).documentElement : null;
}

/** `c:pt` 들 → idx 순서의 값 배열(캐시에 빠진 idx 는 빈 칸). */
function cachePoints(container: Element | undefined, limit: number): string[] {
  if (!container) return [];
  const out: string[] = [];
  for (const pt of walk(container)) {
    if (localName(pt) !== 'pt') continue;
    const idx = Number.parseInt(attr(pt, 'idx') ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= limit) continue;
    const v = childrenNamed(pt, 'v')[0];
    out[idx] = v?.textContent ?? '';
  }
  return Array.from(out, (v) => v ?? '');
}

/**
 * 텍스트 본문 컨테이너(`dgm:t` · `c:rich` — 둘 다 a:bodyPr + a:p 목록인 txBody 형태) → 문단마다
 * 한 줄. F6a: 예전에는 서브트리의 `t` 를 구분자 없이 이어 두 문단이 "AB" 로 붙었다. 슬라이드
 * 본문과 같은 textBodyText 를 써서 문단·줄바꿈·필드 규칙을 한 곳에 둔다.
 */
function bodyText(el: Element | undefined): string {
  return el ? textBodyText(el).trim() : '';
}

/** 차트 → 제목 + 캐시 값 표. 원본 워크북(embeddings/)은 열지 않는다 — 캐시가 화면에 보이는 값이다. */
function chart(frame: Element, slidePart: string, zip: ZipIndex): string {
  const root = relatedPart(frame, 'chart', 'id', slidePart, zip);
  if (!root) return '';
  // F6b: 차트 수준 제목(`c:chart > c:title`)만 본다 — 서브트리의 첫 `title` 은 차트 제목이 없을 때
  // 축 제목(`c:valAx/c:title`)이라 그것이 차트 제목 자리에 나왔다.
  const chartEl = childrenNamed(root, 'chart')[0];
  const titleEl = chartEl ? childrenNamed(chartEl, 'title')[0] : undefined;
  const tx = titleEl ? childrenNamed(titleEl, 'tx')[0] : undefined;
  const rich = tx ? childrenNamed(tx, 'rich')[0] : undefined;
  const title = bodyText(rich);
  const series = [...walk(root)].filter((e) => localName(e) === 'ser').slice(0, MAX_CHART_SERIES);
  let categories: string[] = [];
  const rows: string[][] = [];
  for (const ser of series) {
    const cats = cachePoints(childrenNamed(ser, 'cat')[0], MAX_CHART_CATEGORIES);
    if (cats.length > categories.length) categories = cats;
    const name = cachePoints(childrenNamed(ser, 'tx')[0], 1)[0] ?? '';
    rows.push([name, ...cachePoints(childrenNamed(ser, 'val')[0], MAX_CHART_CATEGORIES)]);
  }
  const tableText = rows.length > 0 ? toGfmTable([['', ...categories], ...rows]) : '';
  return [title, tableText].filter(Boolean).join('\n\n');
}

/** SmartArt → 글머리 목록. data 파트만 읽는다(drawing 파트는 같은 텍스트의 렌더 사본). */
function smartArt(frame: Element, slidePart: string, zip: ZipIndex): string {
  const root = relatedPart(frame, 'relIds', 'dm', slidePart, zip);
  if (!root) return '';
  const lines: string[] = [];
  for (const pt of walk(root)) {
    if (localName(pt) !== 'pt') continue;
    const type = attr(pt, 'type');
    if (type !== null && type !== 'node' && type !== 'asst') continue;
    // 목록 항목은 한 줄이어야 하므로 점 안의 문단은 공백으로 잇는다.
    const text = bodyText(childrenNamed(pt, 't')[0]).split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

export const pptxGraphics: PptxGraphicsText = { table, chart, smartArt };
