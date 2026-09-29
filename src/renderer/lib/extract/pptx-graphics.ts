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

/** 캐시 점 목록 — 상한 안의 값(idx 순서, 빠진 idx 는 빈 칸)과, 상한을 넘겨 잘린 원래 개수. */
interface CachePoints {
  values: string[];
  /** 캐시가 말하는 전체 개수 — `c:ptCount` 와 가장 큰 idx+1 중 큰 쪽. values 보다 크면 잘린 것이다. */
  total: number;
}

/** `c:pt` 들 → idx 순서의 값 배열(캐시에 빠진 idx 는 빈 칸). */
function cachePoints(container: Element | undefined, limit: number): CachePoints {
  if (!container) return { values: [], total: 0 };
  const out: string[] = [];
  let total = 0;
  for (const e of walk(container)) {
    const name = localName(e);
    if (name === 'ptCount') {
      const n = Number.parseInt(attr(e, 'val') ?? '', 10);
      if (Number.isInteger(n) && n > total) total = n;
      continue;
    }
    if (name !== 'pt') continue;
    const idx = Number.parseInt(attr(e, 'idx') ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (idx + 1 > total) total = idx + 1;
    if (idx >= limit) continue;
    const v = childrenNamed(e, 'v')[0];
    out[idx] = v?.textContent ?? '';
  }
  const values = Array.from(out, (v) => v ?? '');
  return { values, total: Math.max(total, values.length) };
}

/**
 * 항목 축(`c:cat`, 분산형은 `c:xVal`) → 항목 이름.
 *
 * QA35: 다단계 항목(`c:multiLvlStrCache` — 연도 아래 분기 같은 묶음)은 `c:lvl` 이 여럿이고
 * **첫 lvl 이 가장 안쪽**(잎)이다. 예전엔 모든 lvl 의 점을 한 배열에 덮어써, 바깥 lvl 이 안쪽 값을
 * 지워 머리글이 `Y2023 | Q2 | Y2024 | Q2` 로 나왔다(Q1 이 사라짐). 이제 안쪽 lvl 의 값을 쓰고,
 * 바깥 lvl 이 **그 idx 에 값을 가진 곳에서만**(묶음의 첫 항목 — 캐시는 묶음 시작 idx 에만 값을 둔다)
 * 바깥→안쪽 순으로 앞에 붙인다: `Y2023 Q1 | Q2 | Y2024 Q1 | Q2`. 모든 칸에 바깥 값을 반복하면 표가
 * 길어질 뿐 정보가 늘지 않고, 묶음 경계는 첫 칸의 접두만으로 읽힌다.
 */
function categoryPoints(axis: Element | undefined, limit: number): CachePoints {
  const multi = axis ? [...walk(axis)].find((e) => localName(e) === 'multiLvlStrCache') : undefined;
  if (!multi) return cachePoints(axis, limit);
  const levels = childrenNamed(multi, 'lvl').map((lvl) => cachePoints(lvl, limit).values);
  const whole = cachePoints(multi, limit); // ptCount 는 multiLvlStrCache 직계에 있다
  const inner = levels[0] ?? [];
  const outer = levels.slice(1).reverse(); // 바깥쪽부터
  const width = Math.max(inner.length, ...outer.map((l) => l.length));
  const values = Array.from({ length: width }, (_, i) =>
    [...outer.map((l) => l[i] ?? ''), inner[i] ?? ''].filter((v) => v.trim()).join(' '));
  return { values, total: Math.max(whole.total, values.length) };
}

/** 계열 이름 — 참조 캐시(`c:tx > c:strRef > c:strCache > c:pt`) 또는 리터럴(`c:tx > c:v`). */
function seriesName(ser: Element): string {
  const tx = childrenNamed(ser, 'tx')[0];
  if (!tx) return '';
  // QA35: 리터럴 이름(`c:tx > c:v`)은 pt 가 없어 예전엔 빈 칸이 됐다(계열 구분이 사라짐).
  const literal = childrenNamed(tx, 'v')[0];
  if (literal) return literal.textContent ?? '';
  return cachePoints(tx, 1).values[0] ?? '';
}

/**
 * 텍스트 본문 컨테이너(`dgm:t` · `c:rich` — 둘 다 a:bodyPr + a:p 목록인 txBody 형태) → 문단마다
 * 한 줄. F6a: 예전에는 서브트리의 `t` 를 구분자 없이 이어 두 문단이 "AB" 로 붙었다. 슬라이드
 * 본문과 같은 textBodyText 를 써서 문단·줄바꿈·필드 규칙을 한 곳에 둔다.
 */
function bodyText(el: Element | undefined): string {
  return el ? textBodyText(el).trim() : '';
}

/**
 * 차트 → 제목 + 캐시 값 표. 원본 워크북(embeddings/)은 열지 않는다 — 캐시가 화면에 보이는 값이다.
 *
 * 분산형·거품형은 항목 축 대신 `c:xVal`/`c:yVal` 을 쓴다(QA35 — 예전엔 cat/val 만 봐 표가 이름만
 * 남았다). x 값을 머리글로, y 값을 행으로 둔다. 항목·계열이 상한에 잘리면 표 뒤에 개수를 밝힌
 * 표시 줄을 붙인다 — 잘린 것을 모르면 AI 가 표를 전체로 읽는다(조용한 손실).
 */
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
  const allSeries = [...walk(root)].filter((e) => localName(e) === 'ser');
  const series = allSeries.slice(0, MAX_CHART_SERIES);
  let categories: string[] = [];
  let categoryTotal = 0;
  const rows: string[][] = [];
  for (const ser of series) {
    const axis = childrenNamed(ser, 'cat')[0] ?? childrenNamed(ser, 'xVal')[0];
    const cats = categoryPoints(axis, MAX_CHART_CATEGORIES);
    if (cats.values.length > categories.length) categories = cats.values;
    const vals = cachePoints(childrenNamed(ser, 'val')[0] ?? childrenNamed(ser, 'yVal')[0], MAX_CHART_CATEGORIES);
    categoryTotal = Math.max(categoryTotal, cats.total, vals.total);
    rows.push([seriesName(ser), ...vals.values]);
  }
  const tableText = rows.length > 0 ? toGfmTable([['', ...categories], ...rows]) : '';
  const cut: string[] = [];
  if (categoryTotal > MAX_CHART_CATEGORIES) cut.push(`항목 categories ${MAX_CHART_CATEGORIES}/${categoryTotal}`);
  if (allSeries.length > MAX_CHART_SERIES) cut.push(`계열 series ${MAX_CHART_SERIES}/${allSeries.length}`);
  const marker = tableText && cut.length > 0 ? `… (${cut.join(' · ')})` : '';
  return [title, tableText, marker].filter(Boolean).join('\n\n');
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
