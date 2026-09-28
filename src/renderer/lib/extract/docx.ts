import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { readRels } from './ooxml';
import { toGfmTable, MAX_GRID_CELLS_PER_AXIS } from './table';
import { paginate, type Block } from './paginate';
import { MAX_EXAMINED_IMAGES, MAX_PAGE_COUNT, MAX_TOTAL_IMAGES } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractedImage, ExtractOptions, ZipIndex } from './types';
import { DOCX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { HEADING_STYLE_RE, onOff, outlineLevelOf, readStyles, type StyleTable } from './docx-styles';
import { fitImage, type ImageFitter } from './image-fit';

const DOCUMENT_PART = 'word/document.xml';

/**
 * 표 한 행의 격자 칸 상한. gridSpan/gridBefore 는 파일이 주는 정수라 1e9 같은 값이 그대로
 * 배열 길이가 되면 렌더러가 멈춘다. 실물 업무 서식의 최대 폭(수십 칸)보다 넉넉하게 둔다.
 */
export const MAX_TABLE_COLUMNS = MAX_GRID_CELLS_PER_AXIS;

/**
 * 표·글상자 중첩 깊이 상한. 이보다 깊은 내용은 구조 없이 텍스트만 모은다 — 병리적 중첩에서
 * 재귀가 스택을 넘기지 않게 한다(실물 문서의 중첩은 2~3 단계다).
 */
const MAX_NEST_DEPTH = 16;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
}

/**
 * 이만큼 요소를 처리할 때마다 이벤트 루프에 한 번 양보한다.
 *
 * QA34: 추출이 처음부터 끝까지 동기로 돌아 await 지점이 없었다 — 렌더러가 그동안 얼고,
 * 사용자의 취소(AbortController.abort)는 추출이 끝난 뒤에야 실행돼 루프 안 throwIfAborted
 * 가 취소를 한 번도 관측하지 못하는 죽은 코드였다. 양보 비용(setTimeout 최소 지연)이 문단당
 * 처리 비용보다 훨씬 커서 너무 자주 양보하면 정상 문서가 느려진다 — 수백 요소 단위로 둔다.
 */
const YIELD_EVERY = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── 순회 규칙 ───

/**
 * 본문 텍스트·그림 순회에서 **통째로 없는 셈** 치는 서브트리.
 *  - `mc:Fallback`: `mc:Choice` 와 같은 내용의 구형 표현(VML 글상자 등). 둘 다 훑으면 글상자
 *    텍스트가 두 번 들어갔다(QA34).
 *  - `w:moveFrom`: 변경 추적에서 "옮겨지기 전 자리". 같은 텍스트가 `w:moveTo` 에도 있다.
 *  - `w:del`: 삭제 추적. 텍스트는 w:delText 라 원래 안 잡히지만 삭제된 그림(blip)이 남는다.
 *  - `w:pPr`/`w:rPr`: 서식. pPr 의 탭 정지 정의(`w:tabs/w:tab`)가 탭 문자로 읽히고, pPr 안
 *    sectPr·pStyle 은 문단 자신의 속성으로만 따로 본다.
 *  - `w:sdtPr`/`w:sdtEndPr`: 콘텐츠 컨트롤 속성(체크박스 상태 등). 보이는 글리프는
 *    sdtContent 쪽 런에 이미 있다.
 */
const SKIPPED_SUBTREES = new Set(['Fallback', 'moveFrom', 'del', 'pPr', 'rPr', 'sdtPr', 'sdtEndPr']);

/** 숨김 텍스트 런(`w:rPr/w:vanish`). `w:specVanish` 는 다른 의미(단락 기호 숨김)라 보지 않는다. */
function isHiddenRun(r: Element): boolean {
  const rPr = childrenNamed(r, 'rPr')[0];
  const vanish = rPr ? childrenNamed(rPr, 'vanish')[0] : undefined;
  return vanish !== undefined && onOff(vanish);
}

function skipNonContent(el: Element): boolean {
  const name = localName(el);
  if (SKIPPED_SUBTREES.has(name)) return true;
  return name === 'r' && isHiddenRun(el);
}

/**
 * 블록 수준 래퍼를 풀어 평평한 자식 목록을 만든다 — 순서 보존.
 *  - `w:sdt` → `w:sdtContent` 의 자식
 *  - `w:customXml` → 자식(customXmlPr 는 호출부가 p/tbl/tr/tc 만 골라 쓰므로 자연히 빠진다)
 *  - `mc:AlternateContent` → 첫 `mc:Choice` 의 자식(Fallback 은 같은 내용의 구형 표현)
 *
 * 본문·글상자·표 행·표 셀 순회가 전부 이 규칙을 공유한다. 따로 두면 한쪽만 래퍼를 풀고 다른
 * 쪽은 잊는 사각이 생긴다 — 이 파일이 이미 그 대가를 치렀다(본문, 표 셀, 그리고 QA34 에서 표
 * 행과 customXml 까지 같은 실수가 네 번). 명시적 스택이라 중첩이 깊어도 스택을 넘기지 않는다.
 */
function expandWrappers(children: ArrayLike<Element>): Element[] {
  const out: Element[] = [];
  const stack: Element[] = Array.from(children).reverse();
  const pushChildren = (el: Element | undefined): void => {
    if (!el) return;
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]!);
  };
  while (stack.length > 0) {
    const el = stack.pop()!;
    const name = localName(el);
    if (name === 'sdt') pushChildren(childrenNamed(el, 'sdtContent')[0]);
    else if (name === 'customXml') pushChildren(el);
    else if (name === 'AlternateContent') pushChildren(childrenNamed(el, 'Choice')[0]);
    else out.push(el);
  }
  return out;
}

// ─── 런 안의 특수 문자 ───

/**
 * `w:sym`(기호 글꼴의 문자 코드) → 유니코드. **아는 것만** 옮기고 나머지는 뺀다 — 기호 글꼴의
 * 코드는 글꼴마다 뜻이 달라서(Symbol 의 0xA7 은 ♣, Wingdings 의 0xA7 은 ▪) 추측으로 옮기면
 * 엉뚱한 글자가 본문에 들어간다. 실물 한국 업무 서식에서 의미를 갖는 것은 체크박스와
 * 글머리표뿐이라 그것만 담는다. Wingdings 2/3·Webdings 는 코드 체계가 또 달라 다루지 않는다.
 *
 *   Wingdings 0xFE ☑ / 0xFD ☒ / 0x78 ☒ / 0xA8 ☐ / 0x6F ☐ / 0xFC ✓ / 0xFB ✗
 *             0xA7 · 0x9F · 0x6C → • (글머리표 용도 — 모양보다 "항목"이라는 뜻을 남긴다)
 *   Symbol    0xB7 → •
 *
 * 값은 유니코드 이스케이프로 적는다. 이 글자들은 UI 아이콘이 아니라 **문서 본문 데이터**인데,
 * a11y-contract 의 소스 스캔 가드(문자열 안 장식 기호는 aria-hidden 을 거쳐야 한다)가 렌더러
 * 소스의 리터럴 ✓ 를 UI 아이콘으로 오인한다. 가드를 넓게 유지하려고 여기서 이스케이프한다.
 */
const SYM_MAP: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  wingdings: {
    // ☑ ☒ ☒ ☐ ☐ ✓ ✗
    0xfe: '\u2611', 0xfd: '\u2612', 0x78: '\u2612', 0xa8: '\u2610', 0x6f: '\u2610', 0xfc: '\u2713', 0xfb: '\u2717',
    // • • •
    0xa7: '\u2022', 0x9f: '\u2022', 0x6c: '\u2022',
  },
  symbol: { 0xb7: '\u2022' },
};

function symText(el: Element): string {
  const table = SYM_MAP[(attr(el, 'font') ?? '').trim().toLowerCase()];
  if (!table) return '';
  let code = Number.parseInt(attr(el, 'char') ?? '', 16);
  if (!Number.isFinite(code)) return '';
  // Word 는 기호 글꼴 코드를 사설 영역(U+F000 + 코드)으로 저장하는 일이 많다. 접두가 없는
  // 형태("00FE")도 들어오므로 둘을 같은 코드로 접는다.
  if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000;
  return table[code] ?? '';
}

/** 문단 안에서 조각 하나의 텍스트와, 그 조각 구간(직전 쪽나눔~이 쪽나눔) 안에서 만난 그림. */
interface ParagraphPiece {
  text: string;
  /** 이 구간 안의 `a:blip/@r:embed` — 실제로 이 조각과 같은 쪽에 남는 그림이다. */
  blipRelIds: string[];
}

interface ParagraphContent {
  pieces: ParagraphPiece[];
  /**
   * 문단 안에 떠 있는 글상자(`w:txbxContent`). 본문 흐름과 별개의 텍스트라 문단 텍스트에
   * 붙이지 않고, 호출부가 문단 **뒤에** 따로 블록으로 낸다 — 붙이면 "앞상자뒤" 처럼 앞뒤
   * 문장과 구분자 없이 이어졌다(QA34).
   */
  textBoxes: Element[];
}

/** 문단 하나를 텍스트 조각으로. `w:br type=page` 에서 조각이 끊긴다. */
function paragraphContent(p: Element): ParagraphContent {
  const pieces: ParagraphPiece[] = [];
  const textBoxes: Element[] = [];
  let buf = '';
  let blips: string[] = [];
  // skip 콜백은 문서 순서대로 요소마다 한 번씩 불린다 — 글상자를 여기서 수집하고 건너뛴다.
  const skip = (el: Element): boolean => {
    if (localName(el) === 'txbxContent') { textBoxes.push(el); return true; }
    return el !== p && skipNonContent(el);
  };
  for (const el of walk(p, skip)) {
    switch (localName(el)) {
      case 't': buf += el.textContent ?? ''; break;
      case 'tab':
      case 'ptab': buf += '\t'; break;
      case 'cr': buf += '\n'; break;
      case 'noBreakHyphen': buf += '-'; break;
      // softHyphen 은 줄 끝에서만 보이는 선택적 하이픈이다 — 본문 텍스트에는 없는 글자다.
      case 'softHyphen': break;
      case 'sym': buf += symText(el); break;
      case 'blip': {
        const relId = attr(el, 'embed');
        if (relId) blips.push(relId);
        break;
      }
      case 'br':
        // 실물 DOCX 의 w:br 은 대부분 textWrapping(줄바꿈)이다. page 인 것만 쪽나눠다.
        if (attr(el, 'type') === 'page') { pieces.push({ text: buf, blipRelIds: blips }); buf = ''; blips = []; }
        else buf += '\n';
        break;
    }
  }
  pieces.push({ text: buf, blipRelIds: blips });
  return { pieces, textBoxes };
}

// ─── 문단 자신의 속성 ───
//
// QA34: headingLevel/hasPageBreakBefore 가 문단 **자손 전체**를 훑어, 글상자 안 문단의
// Heading1·pageBreakBefore 가 바깥(호스트) 문단을 제목으로 만들고 쪽을 나눴다. 문단 속성은
// 그 문단의 직계 `w:pPr` 에만 있다.

function ownPPr(p: Element): Element | undefined {
  return childrenNamed(p, 'pPr')[0];
}

function styleIdOf(pPr: Element | undefined): string | null {
  const el = pPr ? childrenNamed(pPr, 'pStyle')[0] : undefined;
  const v = el ? attr(el, 'val')?.trim() : undefined;
  return v ? v : null;
}

/**
 * 제목 수준. 우선순위: 문단 직접 outlineLvl → 스타일 표(basedOn 체인) → 스타일 ID 정규식 폴백
 * (styles.xml 이 없거나 그 ID 가 표에 없을 때). outlineLvl 9 는 "본문 수준" 명시라 제목이 아니다.
 */
function headingLevelOf(pPr: Element | undefined, styles: StyleTable): number | null {
  const outlineEl = pPr ? childrenNamed(pPr, 'outlineLvl')[0] : undefined;
  if (outlineEl) {
    const v = outlineLevelOf(outlineEl);
    if (v !== undefined) return v === 0 ? null : v;
  }
  const styleId = styleIdOf(pPr);
  if (!styleId) return null;
  const fromTable = styles.headingLevel(styleId);
  if (fromTable !== undefined) return fromTable === 0 ? null : fromTable;
  const m = HEADING_STYLE_RE.exec(styleId);
  return m ? Number(m[1]) : null;
}

/** 직접 pageBreakBefore(참/거짓 모두)가 이기고, 없으면 스타일(없으면 기본 문단 스타일) 체인. */
function pageBreakBeforeOf(pPr: Element | undefined, styles: StyleTable): boolean {
  const direct = pPr ? childrenNamed(pPr, 'pageBreakBefore')[0] : undefined;
  if (direct) return onOff(direct);
  const styleId = styleIdOf(pPr) ?? styles.defaultParagraphStyle;
  return styleId ? styles.pageBreakBefore(styleId) ?? false : false;
}

/**
 * 이 문단이 구역을 끝내며 **다음 쪽에서** 새 구역을 시작하는가. 구역 나눔은 끝나는 구역의
 * 마지막 문단 `w:pPr/w:sectPr` 에 기록된다. `w:type` 이 없으면 기본값 nextPage 다.
 * continuous 만 같은 쪽에서 이어진다(설계 §2 D5: 작성자가 넣은 나눔이 분량 분할보다 우선).
 */
function endsSectionWithBreak(pPr: Element | undefined): boolean {
  const sectPr = pPr ? childrenNamed(pPr, 'sectPr')[0] : undefined;
  if (!sectPr) return false;
  const typeEl = childrenNamed(sectPr, 'type')[0];
  return (typeEl ? attr(typeEl, 'val') : null) !== 'continuous';
}

// ─── 표 ───

function gridCount(parent: Element | undefined, name: string, min: number): number {
  const el = parent ? childrenNamed(parent, name)[0] : undefined;
  const n = el ? Number.parseInt(attr(el, 'val') ?? '', 10) : NaN;
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), MAX_TABLE_COLUMNS);
}

/** 깊이 상한을 넘은 컨테이너 — 구조 없이 보이는 텍스트만 모은다(반복 순회라 스택 안전). */
function plainText(el: Element): string {
  let out = '';
  for (const e of walk(el, skipNonContent)) if (localName(e) === 't') out += e.textContent ?? '';
  return out;
}

/**
 * 블록 컨테이너(표 셀·글상자) → 한 덩어리 텍스트. 문단은 줄바꿈으로, 중첩 표는
 * flattenTable 로, 글상자는 문단 뒤 새 줄로 잇는다.
 */
function containerText(container: Element, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return plainText(container);
  const parts: string[] = [];
  for (const el of expandWrappers(container.children)) {
    const name = localName(el);
    if (name === 'p') {
      const { pieces, textBoxes } = paragraphContent(el);
      parts.push(pieces.map((piece) => piece.text).join('\n'));
      for (const box of textBoxes) parts.push(containerText(box, depth + 1));
    } else if (name === 'tbl') {
      parts.push(flattenTable(el, depth + 1));
    }
  }
  return parts.join('\n');
}

/**
 * 셀 안의 중첩 표 → 한 줄 텍스트(행은 "; ", 칸은 " / "). GFM 표는 셀 안에 표를 담을 수 없어
 * 평탄화한다 — 예전에는 셀 자식 중 문단만 골라 중첩 표의 텍스트가 통째로 사라졌다(QA34).
 */
function flattenTable(tbl: Element, depth: number): string {
  return tableRows(tbl, depth)
    .map((row) => row.map((c) => c.trim()))
    .filter((row) => row.some((c) => c !== ''))
    .map((row) => row.join(' / '))
    .join('; ');
}

/**
 * 표 → 직사각형 행렬(격자 기준).
 *
 * QA34(High): 셀을 tc 순서대로만 늘어놓아 병합 셀이 있으면 그 뒤 칸이 전부 왼쪽으로 밀렸다
 * (머리글 "달성률" 아래에 다른 열의 값). Word 표는 `w:tblGrid` 격자 위에 놓인다:
 *  - `w:trPr/w:gridBefore`·`w:gridAfter`: 행 앞뒤의 빈 격자 칸
 *  - `w:tcPr/w:gridSpan`: 가로 병합 — 텍스트는 첫 칸, 나머지 칸은 비운다
 *  - `w:vMerge`(val≠restart): 세로 병합의 연속 셀 — 위 행 **같은 격자 열**의 텍스트를 복사한다
 *    (셀 순번이 아니라 격자 열로 찾아야 앞에 gridSpan 이 있어도 맞는다)
 * 행과 셀이 `w:sdt`/`w:customXml` 로 감싸일 수 있어 expandWrappers 로 먼저 푼다.
 */
function tableRows(tbl: Element, depth = 0): string[][] {
  const rows: string[][] = [];
  let above: string[] = [];
  for (const tr of expandWrappers(tbl.children)) {
    if (localName(tr) !== 'tr') continue;
    const trPr = childrenNamed(tr, 'trPr')[0];
    const row: string[] = [];
    const place = (text: string, span: number): void => {
      for (let k = 0; k < span && row.length < MAX_TABLE_COLUMNS; k++) row.push(k === 0 ? text : '');
    };
    place('', gridCount(trPr, 'gridBefore', 0));
    for (const tc of expandWrappers(tr.children)) {
      if (localName(tc) !== 'tc') continue;
      if (row.length >= MAX_TABLE_COLUMNS) break;
      const tcPr = childrenNamed(tc, 'tcPr')[0];
      const vMerge = tcPr ? childrenNamed(tcPr, 'vMerge')[0] : undefined;
      const continues = vMerge !== undefined && attr(vMerge, 'val') !== 'restart';
      const text = continues ? above[row.length] ?? '' : containerText(tc, depth);
      place(text, gridCount(tcPr, 'gridSpan', 1));
    }
    place('', gridCount(trPr, 'gridAfter', 0));
    rows.push(row);
    above = row;
  }
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

/** 요소 서브트리 안의 `a:blip/@r:embed` 전부. 표 안 그림처럼 문단 조각 단위가 아닌 경우에 쓴다. */
function blipsIn(el: Element): string[] {
  const ids: string[] = [];
  for (const e of walk(el, skipNonContent)) {
    if (localName(e) !== 'blip') continue;
    const relId = attr(e, 'embed');
    if (relId) ids.push(relId);
  }
  return ids;
}

export interface DocxExtractorDeps {
  /** 그림 크기 규칙(image-fit.ts). 테스트가 디코드를 대체하려고 주입한다. */
  fitImage?: ImageFitter;
}

export function createDocxExtractor(deps: DocxExtractorDeps = {}): Extractor {
  const fit = deps.fitImage ?? fitImage;
  return {
    id: DOCX_FORMAT_ID,

    sniff: (zip: ZipIndex): boolean => zip.has(DOCUMENT_PART),

    extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);

      const xml = zip.text(DOCUMENT_PART);
      if (!xml) extractFail('DOC_CORRUPT', 'word/document.xml missing');

      // walk 는 제너레이터라 .find 가 없다. 펼쳐서 찾는다.
      const body = [...walk(parseXml(xml).documentElement)].find((el) => localName(el) === 'body')
        ?? extractFail('DOC_CORRUPT', 'w:body missing');
      const styles = readStyles(zip);

      const blocks: Block[] = [];
      const headingAt: { level: number; title: string; blockIndex: number }[] = [];
      const imageAt: { relId: string; blockIndex: number }[] = [];

      /**
       * 순회 프레임. 본문이 바닥 프레임이고, 문단의 글상자는 그 문단 바로 뒤에 처리되도록 위에
       * 프레임을 쌓는다(재귀 대신 명시적 스택 — 글상자 중첩이 깊어도 스택을 넘기지 않는다).
       * nested 프레임(글상자)은 떠 있는 개체라 쪽 흐름에 관여하지 않는다: 제목·쪽나눔·구역
       * 나눔을 만들지도, 대기 중인 구역 나눔을 소비하지도 않는다.
       */
      interface Frame { items: Element[]; i: number; nested: boolean }
      const stack: Frame[] = [{ items: expandWrappers(body.children), i: 0, nested: false }];
      /** 직전 문단이 구역을 끝냈다 — 다음 본문 블록 앞에서 쪽을 나눈다. */
      let pendingSectionBreak = false;
      const takeSectionBreak = (nested: boolean): boolean => {
        if (nested || !pendingSectionBreak) return false;
        pendingSectionBreak = false;
        return true;
      };

      // 진행률은 본문 최상위 항목 기준이다 — 글상자 프레임은 그 항목 하나의 일부로 친다.
      const top = stack[0]!;
      let processed = 0;
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.i >= frame.items.length) { stack.pop(); continue; }
        const child = frame.items[frame.i++]!;
        processed += 1;
        if (processed % YIELD_EVERY === 0) {
          await yieldToEventLoop();
          opts.onProgress?.(top.i, top.items.length);
        }
        throwIfAborted(opts.signal);
        const name = localName(child);

        if (name === 'tbl') {
          const blockIndex = blocks.length;
          blocks.push({ text: toGfmTable(tableRows(child)), breakBefore: takeSectionBreak(frame.nested) });
          // 표 셀 안 그림 — 셀 나눔은 단위 경계가 아니므로 표 전체를 담은 이 블록에 붙인다.
          for (const relId of blipsIn(child)) imageAt.push({ relId, blockIndex });
          continue;
        }
        if (name !== 'p') continue;

        const pPr = ownPPr(child);
        const { pieces: rawPieces, textBoxes } = paragraphContent(child);
        // 글상자 안에서는 쪽나눔이 의미가 없다(떠 있는 개체) — 조각을 하나로 접는다.
        const pieces = frame.nested
          ? [{ text: rawPieces.map((p) => p.text).join('\n'), blipRelIds: rawPieces.flatMap((p) => p.blipRelIds) }]
          : rawPieces;
        const level = frame.nested ? null : headingLevelOf(pPr, styles);
        let breakBefore = takeSectionBreak(frame.nested) || (!frame.nested && pageBreakBeforeOf(pPr, styles));
        let headingPlaced = level === null;

        for (const [i, piece] of pieces.entries()) {
          const blockIndex = blocks.length;
          blocks.push({ text: piece.text, breakBefore: breakBefore || i > 0 });
          breakBefore = false;
          // 제목은 조각이 아니라 문단의 스타일이므로 한 번만 붙인다 — **첫 비지 않은** 조각에.
          // 첫 조각에만 붙이던 때는 쪽나눔으로 시작하는 제목 문단(빈 첫 조각)이 제목을 잃었다.
          if (!headingPlaced && piece.text.trim()) {
            headingAt.push({ level: level!, title: piece.text.trim(), blockIndex });
            headingPlaced = true;
          }
          // 그림은 실제로 그 조각(쪽나눔 이전 구간) 에 속한 것만 붙인다 — 문단 중간의
          // 쪽나눔 뒤에 오는 그림이 앞쪽 조각에 잘못 매핑되는 것을 막는다.
          for (const relId of piece.blipRelIds) imageAt.push({ relId, blockIndex });
        }

        if (!frame.nested && endsSectionWithBreak(pPr)) pendingSectionBreak = true;
        if (textBoxes.length > 0) {
          stack.push({ items: textBoxes.flatMap((box) => expandWrappers(box.children)), i: 0, nested: true });
        }
      }

      opts.onProgress?.(top.items.length, top.items.length);

      const { units, unitOfBlock } = paginate(blocks);
      if (units.length === 0) extractFail('DOC_NO_TEXT', 'no text in document');
      // 단위 수 상한은 PDF 와 같은 예산을 쓴다 — 요약·임베딩이 단위 수에 선형으로 확장된다.
      // Task10 fix round2: 번역 파라미터를 함께 싣는다 — PDF 경로(parsePdf)는 이미 번역된
      // 문자열을 던지지만 이쪽(DOCX)은 코드만 던지므로, document-open.ts 의 경계가 pages/max 로
      // uploader.tooManyPages 를 채울 수 있어야 한다(그래야 "unit count 501 exceeds 500" 같은
      // 개발자용 영어가 화면에 그대로 노출되지 않는다).
      if (units.length > MAX_PAGE_COUNT) {
        extractFail(
          'PDF_TOO_MANY_PAGES',
          `unit count ${units.length} exceeds ${MAX_PAGE_COUNT}`,
          { pages: String(units.length), max: String(MAX_PAGE_COUNT) },
        );
      }

      const headings: ExtractedHeading[] = headingAt.map((h) => ({
        level: h.level,
        title: h.title,
        unitIndex: unitOfBlock[h.blockIndex] ?? 0,
      }));

      const images: ExtractedImage[] = [];
      let imageBudgetExceeded = false;
      if (opts.extractImages !== false && imageAt.length > 0) {
        const rels = readRels(zip, DOCUMENT_PART);
        const seen = new Set<string>();
        let examined = 0;
        for (const { relId, blockIndex } of imageAt) {
          throwIfAborted(opts.signal);
          if (examined >= MAX_EXAMINED_IMAGES) break;
          examined += 1;
          const path = rels.get(relId);
          if (!path || seen.has(path)) continue;
          const bytes = zip.bytes(path);
          if (!bytes) continue;
          seen.add(path);
          if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
          // 형식은 확장자가 아니라 바이트로 가린다(EMF/WMF/TIFF 는 건너뛴다). 크기 규칙은 PDF
          // 경로와 같다 — 50px 미만·4M 픽셀 초과는 건너뛰고, 긴 변 1024 초과는 줄인다.
          const fitted = await fit(bytes);
          if (!fitted) continue;
          images.push({ unitIndex: unitOfBlock[blockIndex] ?? 0, ...fitted });
        }
      }

      return {
        units,
        images,
        headings,
        unitKind: 'page',
        ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
      };
    },
  };
}

export const docxExtractor: Extractor = createDocxExtractor();
