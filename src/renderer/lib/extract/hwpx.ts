import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { paginate, type Block } from './paginate';
import { toGfmTable, placeGridCells, type GridCell } from './table';
import { readOcfPackage, readOpf, hasEncryptionData, type OcfPackage } from './ocf';
import { readOutlineLevels } from './hwpx-header';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractOptions, ZipIndex } from './types';
import { HWPX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';
import { collectImages, throwIfAborted, yieldToEventLoop } from './common';

const HWPX_MIMETYPE = 'application/hwp+zip';
const HWPX_PACKAGE = 'application/hwpml-package+xml';
const SECTION_PATH = /(^|\/)section(\d+)\.xml$/i;
const MAX_NEST_DEPTH = 16;
const YIELD_EVERY = 200;

/**
 * 본문 텍스트가 아닌 서브트리. `ctrl` 은 머리말·꼬리말·각주·쪽 번호·단 정의를 담는다 — 필드의
 * **결과** 텍스트는 ctrl 밖 hp:t 에 있으므로 ctrl 을 통째로 건너뛰어도 잃지 않는다.
 * `shapeComment` 는 "그림입니다. 원본 그림의 이름: <파일명>" 자동 문구라 요약에 파일명이 샜다.
 */
const SKIPPED = new Set(['ctrl', 'secPr', 'linesegarray', 'shapeComment', 'hiddenComment']);

/** hp:t 의 혼합 내용 → 텍스트. 런 단위로 trim 하지 않는다(공백만 있는 런이 실제 단어 사이 공백이다). */
function tText(t: Element): string {
  let s = '';
  for (const node of Array.from(t.childNodes)) {
    if (node.nodeType === 3) { s += node.nodeValue ?? ''; continue; }
    if (node.nodeType !== 1) continue;
    switch (localName(node as Element)) {
      case 'lineBreak': s += '\n'; break;
      case 'tab': s += '\t'; break;
      case 'nbSpace':
      case 'fwSpace': s += ' '; break;
      case 'hyphen': s += '-'; break;
      // markpenBegin/End(형광펜) 등 서식 표식은 글자가 아니다.
    }
  }
  return s;
}

/**
 * 수식(hp:equation) → `[수식: <스크립트>]`. 스크립트는 LaTeX 가 아니라 한글 수식 문법(`{a} over {b}`)이다.
 * LaTeX 로 옮기지 않는다 — 문법(행렬·첨자 우선순위·예약어)을 틀리게 옮기면 확신에 찬 오답이 되고,
 * 원문을 넘기면 요약 모델이 읽을 수 있다. 원문 뷰어도 수식을 렌더하지 않는 것이 정책이다.
 * 스크립트의 줄바꿈·연속 공백은 한 칸으로 접는다(`#` 이 수식의 줄바꿈이고, 실제 개행은 서식일 뿐이다).
 */
function equationText(eq: Element): string {
  const script = childrenNamed(eq, 'script')[0];
  const s = (script?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return s ? `[수식: ${s}]` : '';
}

/** 깊이 상한 폴백용 — 수식 스크립트(hp:equation 의 자식 hp:script)면 그 표기, 아니면 null. */
function equationScriptText(el: Element): string | null {
  const parent = el.parentElement;
  if (localName(el) !== 'script' || !parent || localName(parent) !== 'equation') return null;
  const m = equationText(parent);
  return m ? ` ${m} ` : '';
}

/** 문단 하나를 읽은 결과 — 런 사이에 표가 끼면 텍스트가 여러 조각으로 갈린다. */
interface ParaOut {
  /** 순서대로의 블록 텍스트(텍스트 조각 · 표) */
  parts: string[];
  /** 떠 있는 글상자의 subList — 호스트 문단 뒤에 처리 */
  boxes: Element[];
  /** 그림의 binaryItemIDRef 와, 그 그림이 속한 parts 인덱스 */
  pics: { ref: string; part: number }[];
}

function readParagraph(p: Element, depth: number, tableText: (tbl: Element, depth: number) => string): ParaOut {
  const out: ParaOut = { parts: [], boxes: [], pics: [] };
  let buf = '';
  // 수식 뒤 글자가 공백 없이 붙어 있으면 한 칸 띄운다("[수식: x^2]이다" 가 되지 않게).
  let padNext = false;
  const flush = () => { if (buf.trim()) out.parts.push(buf); buf = ''; padNext = false; };
  const append = (s: string) => {
    if (!s) return;
    if (padNext && !/^\s/.test(s)) buf += ' ';
    padNext = false;
    buf += s;
  };
  const skip = (el: Element): boolean => {
    if (el === p) return false;
    const name = localName(el);
    if (SKIPPED.has(name)) return true;
    // 표·글상자·그림은 여기서 따로 처리하고 서브트리는 건너뛴다(셀 문단을 본문 문단으로 다시 읽지 않게).
    if (name === 'tbl') {
      flush();
      // 셀 안 그림 — 셀 경계는 단위 경계가 아니므로 표 블록에 붙인다(실물 그림 4개가 전부 셀 안이었다).
      for (const e of walk(el, (x) => SKIPPED.has(localName(x)))) {
        if (localName(e) !== 'img') continue;
        const ref = attr(e, 'binaryItemIDRef');
        if (ref) out.pics.push({ ref, part: out.parts.length });
      }
      const tb = tableText(el, depth + 1);
      if (tb) out.parts.push(tb);
      return true;
    }
    if (name === 'drawText') { for (const sl of childrenNamed(el, 'subList')) out.boxes.push(sl); return true; }
    if (name === 'pic') {
      const img = [...walk(el)].find((e) => localName(e) === 'img');
      const ref = img ? attr(img, 'binaryItemIDRef') : null;
      if (ref) out.pics.push({ ref, part: out.parts.length });
      return true;
    }
    // 수식 — 스크립트만 읽고 서브트리(shapeComment "수식입니다." 포함)는 건너뛴다.
    if (name === 'equation') {
      const m = equationText(el);
      if (m) {
        if (buf && !/\s$/.test(buf)) buf += ' ';
        buf += m;
        padNext = true;
      }
      return true;
    }
    return false;
  };
  for (const el of walk(p, skip)) {
    if (localName(el) === 't') append(tText(el));
  }
  flush();
  return out;
}

/** 깊이 상한을 넘은 서브트리 — 구조 없이 hp:t 텍스트만 모은다(잃지 않는다, docx.ts plainText 와 같은 규칙). */
function plainText(el: Element): string {
  let s = '';
  for (const e of walk(el, (x) => SKIPPED.has(localName(x)))) {
    if (localName(e) === 't') s += tText(e);
    else s += equationScriptText(e) ?? '';
  }
  return s;
}

/** plainText 와 같은 폴백이지만 그림도 잃지 않는다(글상자 안, 깊이 상한을 넘은 자리). */
function plainTextWithPics(el: Element): { text: string; pics: string[] } {
  let s = '';
  const pics: string[] = [];
  for (const e of walk(el, (x) => SKIPPED.has(localName(x)))) {
    const name = localName(e);
    if (name === 't') s += tText(e);
    else if (name === 'img') { const ref = attr(e, 'binaryItemIDRef'); if (ref) pics.push(ref); }
    else s += equationScriptText(e) ?? '';
  }
  return { text: s, pics };
}

/**
 * 셀·글상자의 subList → 한 덩어리 텍스트(문단은 줄바꿈) + 그 안(중첩 글상자·표 포함)의 그림
 * binaryItemIDRef 전부. fix-round1(리뷰 지적): 글상자 안 그림(직접 또는 글상자 안 표 안)이
 * r.pics 에 담기고도 여기서 버려져 조용히 사라졌다 — 실물 표의 28% 가 글상자 안이었다.
 */
function containerText(subList: Element, depth: number, tableText: (tbl: Element, depth: number) => string): { text: string; pics: string[] } {
  if (depth > MAX_NEST_DEPTH) return plainTextWithPics(subList);
  const lines: string[] = [];
  const pics: string[] = [];
  for (const para of childrenNamed(subList, 'p')) {
    const r = readParagraph(para, depth, tableText);
    lines.push(...r.parts);
    pics.push(...r.pics.map((pc) => pc.ref));
    for (const box of r.boxes) {
      const nested = containerText(box, depth + 1, tableText);
      lines.push(nested.text);
      pics.push(...nested.pics);
    }
  }
  return { text: lines.join('\n'), pics };
}

function intAttr(el: Element | undefined, name: string, fallback: number): number {
  const n = el ? Number.parseInt(attr(el, name) ?? '', 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 표 → 직사각형 행렬. 셀은 cellAddr 좌표로 놓는다(가려진 칸이 XML 에 없다 — 실물 28개 표 전부). */
function tableGrid(tbl: Element, depth: number): string[][] {
  const trs = childrenNamed(tbl, 'tr');
  const cells: GridCell[] = [];
  let maxCol = 0;
  for (const [ri, tr] of trs.entries()) {
    let nextCol = 0;
    for (const tc of childrenNamed(tr, 'tc')) {
      const addr = childrenNamed(tc, 'cellAddr')[0];
      const span = childrenNamed(tc, 'cellSpan')[0];
      const row = intAttr(addr, 'rowAddr', ri);
      const col = intAttr(addr, 'colAddr', nextCol);
      const colSpan = Math.max(1, intAttr(span, 'colSpan', 1));
      const sl = childrenNamed(tc, 'subList')[0];
      // 셀 안의 표는 GFM 셀에 담을 수 없어 평탄화한다.
      // 이 그림들은 이미 readParagraph 의 tbl 분기(표 전체를 훑는 raw walk)가 imageAt 에
      // 실었다 — 여기서 pics 를 또 쓰면 같은 참조가 두 번 들어가 unitIndex 선점 순서(첫 항목이
      // 이긴다)가 흔들린다. 그래서 text 만 쓴다.
      const text = sl ? containerText(sl, depth, flattenTableText).text : '';
      cells.push({ row, col, rowSpan: Math.max(1, intAttr(span, 'rowSpan', 1)), colSpan, text });
      nextCol = col + colSpan;
      maxCol = Math.max(maxCol, nextCol);
    }
  }
  return placeGridCells(cells, gridExtent(cells, 'row', intAttr(tbl, 'rowCnt', trs.length)), gridExtent(cells, 'col', intAttr(tbl, 'colCnt', maxCol)));
}

/**
 * 격자 한 축의 크기 — 선언값(rowCnt/colCnt)이 아니라 셀이 실제로 차지하는 범위로 정한다(R18).
 * 선언값만 믿으면 rowCnt="100000" 에 실제 2행인 표가 빈 행 수천 개(칸 상한까지)의 쓰레기 표가 된다.
 * 셀 **원점**은 선언값을 넘어도 항상 포함한다 — 선언값이 모자란 손상 파일에서 셀을 버리지 않게
 * (크기는 placeGridCells 의 상한이 묶고, 넘친 셀은 평문 행으로 남는다). 스팬 끝은 선언값 안에서만
 * 믿는다 — 병리적 rowSpan 하나가 빈 행을 만들지 않게.
 */
function gridExtent(cells: GridCell[], axis: 'row' | 'col', declared: number): number {
  let origins = 0;
  let spans = 0;
  for (const c of cells) {
    const o = Math.floor(axis === 'row' ? c.row : c.col);
    if (!(o >= 0)) continue;
    const span = Math.max(1, Math.floor(axis === 'row' ? c.rowSpan : c.colSpan) || 1);
    origins = Math.max(origins, o + 1);
    spans = Math.max(spans, o + span);
  }
  return Math.max(origins, Math.min(spans, Math.max(0, declared)));
}

function flattenTableText(tbl: Element, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return plainText(tbl);
  return tableGrid(tbl, depth)
    .map((row) => row.map((c) => c.replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some((c) => c !== ''))
    .map((row) => row.join(' / '))
    .join('; ');
}

/** 최상위(본문·글상자)의 표 → GFM 표. */
function gridTableText(tbl: Element, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return flattenTableText(tbl, depth);
  return toGfmTable(tableGrid(tbl, depth));
}

function bodySections(zip: ZipIndex, pkg: OcfPackage | null): string[] {
  const fromSpine = (pkg?.spine ?? []).map((i) => i.path).filter((path) => SECTION_PATH.test(path));
  if (fromSpine.length > 0) return fromSpine;
  // 폴백: spine 이 비었거나 섹션을 못 가리킬 때 — 번호순(사전순이면 section10 이 section2 앞에 온다).
  return zip.names()
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(SECTION_PATH.exec(a)![2]) - Number(SECTION_PATH.exec(b)![2]));
}

/** 한글이 쓰는 관례 경로 — container.xml 이 가리키지 못할 때의 폴백 */
const DEFAULT_OPF_PATH = 'Contents/content.hpf';
const DEFAULT_HEADER_PATH = 'Contents/header.xml';

/** container.xml → OPF, 실패하면 관례 경로의 OPF, 그것도 실패하면 null(섹션은 번호순 폴백). */
function readHwpxPackage(zip: ZipIndex): OcfPackage | null {
  try { return readOcfPackage(zip, HWPX_PACKAGE); } catch { /* 아래 폴백 */ }
  try { return readOpf(zip, DEFAULT_OPF_PATH); } catch { return null; }
}

/**
 * 그림 참조(binaryItemIDRef) → zip 경로. manifest 에서 풀리지 않으면(OPF 가 없거나 항목이 빠짐)
 * 마지막 수단으로 `BinData/<ref>.<확장자>` 를 찾는다 — 실물 한글 파일은 항목 id 와 BinData 파일
 * 이름 줄기가 같다(image1 ↔ BinData/image1.bmp). 형식은 어차피 바이트로 가린다(image-fit).
 */
function binDataResolver(zip: ZipIndex, pkg: OcfPackage | null): (ref: string) => string | undefined {
  let byStem: Map<string, string> | null = null;
  return (ref) => {
    const viaManifest = pkg?.items.get(ref)?.path;
    if (viaManifest && zip.has(viaManifest)) return viaManifest;
    if (!byStem) {
      // 이름 목록은 한 번만 훑는다(그림 후보마다 전체 엔트리를 훑지 않게). 같은 줄기가 둘이면 첫 것.
      byStem = new Map();
      for (const n of zip.names()) {
        const m = /^BinData\/([^/]+)\.[^./]+$/i.exec(n);
        if (m && !byStem.has(m[1]!.toLowerCase())) byStem.set(m[1]!.toLowerCase(), n);
      }
    }
    return byStem.get(ref.toLowerCase()) ?? viaManifest;
  };
}

export interface HwpxExtractorDeps {
  fitImage?: ImageFitter;
  /** 표 텍스트화 교체 지점(테스트용) — 기본값은 gridTableText */
  tableText?: (tbl: Element, depth: number) => string;
}

export function createHwpxExtractor(deps: HwpxExtractorDeps = {}): Extractor {
  const tableText = deps.tableText ?? gridTableText;
  const fit = deps.fitImage ?? fitImage;
  return {
    id: HWPX_FORMAT_ID,

    sniff: (zip) => zip.text('mimetype')?.trim() === HWPX_MIMETYPE,

    extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      if (hasEncryptionData(zip)) extractFail('DOC_ENCRYPTED', 'encrypted hwpx');

      // QA35: container.xml 이 없거나 깨지면 pkg 가 null 이 되어 그림 참조(binaryItemIDRef →
      // manifest)를 풀 수 없었고 그림이 **조용히 0개**가 됐다. 한글이 늘 쓰는 관례 경로의 OPF 를
      // 직접 읽어 본다. 본문 섹션·header 는 원래도 관례 경로로 폴백했다.
      const pkg = readHwpxPackage(zip);
      const headerPath = (pkg ? [...pkg.items.values()].find((i) => /(^|\/)header\.xml$/i.test(i.path))?.path : undefined) ?? DEFAULT_HEADER_PATH;
      const outline = readOutlineLevels(headerPath ? zip.text(headerPath) : null);

      const sections = bodySections(zip, pkg);
      if (sections.length === 0) extractFail('DOC_CORRUPT', 'no body section');

      const blocks: Block[] = [];
      const headingAt: { level: number; title: string; blockIndex: number }[] = [];
      const imageAt: { ref: string; blockIndex: number }[] = [];
      let processed = 0;

      for (const [si, path] of sections.entries()) {
        const xml = zip.text(path) ?? extractFail('DOC_CORRUPT', `${path} missing`);
        const root = parseXml(xml).documentElement;
        if (localName(root) !== 'sec') extractFail('DOC_CORRUPT', `${path} is not a section`);

        let firstInSection = si > 0;
        // 최상위 문단 + 그 문단의 글상자(뒤에 이어서)를 명시적 큐로 — 글상자 중첩이 깊어도 스택 안전.
        for (const para of childrenNamed(root, 'p')) {
          processed += 1;
          if (processed % YIELD_EVERY === 0) {
            await yieldToEventLoop();
            opts.onProgress?.(si, sections.length);
          }
          throwIfAborted(opts.signal);

          const r = readParagraph(para, 0, tableText);
          const breakBefore = firstInSection || attr(para, 'pageBreak') === '1';
          firstInSection = false;
          const level = outline.get(attr(para, 'paraPrIDRef') ?? '');
          if (r.parts.length === 0) {
            // 빈 문단도 쪽나눔은 전한다(paginate 가 빈 breakBefore 블록을 flush 로 처리한다).
            if (breakBefore) blocks.push({ text: '', breakBefore: true });
          }
          const firstBlock = blocks.length;
          for (const [i, text] of r.parts.entries()) {
            if (i === 0 && level !== undefined && text.trim()) headingAt.push({ level, title: text.trim().split('\n')[0]!, blockIndex: blocks.length });
            blocks.push({ text, breakBefore: i === 0 && breakBefore });
          }
          // 그림이 속한 조각의 블록. 조각이 없는 문단(그림만 있는 문단)은 직전 블록(없으면 0)에 붙인다.
          for (const pic of r.pics) {
            const blockIndex = r.parts.length === 0 ? Math.max(0, blocks.length - 1) : firstBlock + Math.min(pic.part, r.parts.length - 1);
            imageAt.push({ ref: pic.ref, blockIndex });
          }
          // 글상자는 떠 있는 개체 — 쪽나눔·제목을 만들지 않는다.
          for (const box of r.boxes) {
            const boxResult = containerText(box, 1, tableText);
            let boxBlockIndex: number;
            if (boxResult.text.trim()) {
              boxBlockIndex = blocks.length;
              blocks.push({ text: boxResult.text, breakBefore: false });
            } else {
              // 텍스트 없는 상자(그림만 있는 상자)는 블록을 만들지 않는다 — 그림을 잃지
              // 않으려면 지금까지의 마지막 블록(없으면 0)에 붙인다.
              boxBlockIndex = Math.max(0, blocks.length - 1);
            }
            for (const ref of boxResult.pics) imageAt.push({ ref, blockIndex: boxBlockIndex });
          }
        }
      }
      opts.onProgress?.(sections.length, sections.length);

      const { units, unitOfBlock } = paginate(blocks);
      if (units.length === 0 || !units.some((u) => u.trim())) extractFail('DOC_NO_TEXT', 'no text in document');
      if (units.length > MAX_PAGE_COUNT) {
        extractFail('PDF_TOO_MANY_PAGES', `unit count ${units.length} exceeds ${MAX_PAGE_COUNT}`,
          { pages: String(units.length), max: String(MAX_PAGE_COUNT) });
      }
      const headings: ExtractedHeading[] = headingAt.map((h) => ({ level: h.level, title: h.title, unitIndex: unitOfBlock[h.blockIndex] ?? 0 }));

      const resolveBinData = binDataResolver(zip, pkg);
      const { images, imageBudgetExceeded } = opts.extractImages !== false && imageAt.length > 0
        ? await collectImages(
          imageAt.map(({ ref, blockIndex }) => ({ path: resolveBinData(ref), unitIndex: unitOfBlock[blockIndex] ?? 0 })),
          zip, fit, opts.signal,
        )
        : { images: [], imageBudgetExceeded: false };
      return { units, images, headings, unitKind: 'page', ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}) };
    },
  };
}

export const hwpxExtractor: Extractor = createHwpxExtractor();
