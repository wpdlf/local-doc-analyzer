import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { paginate, type Block } from './paginate';
import { toGfmTable } from './table';
import { readOcfPackage, hasEncryptionData, type OcfPackage } from './ocf';
import { readOutlineLevels } from './hwpx-header';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractOptions, ZipIndex } from './types';
import { HWPX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';

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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
}

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
  const flush = () => { if (buf.trim()) out.parts.push(buf); buf = ''; };
  const skip = (el: Element): boolean => {
    if (el === p) return false;
    const name = localName(el);
    if (SKIPPED.has(name)) return true;
    // 표·글상자·그림은 여기서 따로 처리하고 서브트리는 건너뛴다(셀 문단을 본문 문단으로 다시 읽지 않게).
    if (name === 'tbl') { flush(); const tb = tableText(el, depth + 1); if (tb) out.parts.push(tb); return true; }
    if (name === 'drawText') { for (const sl of childrenNamed(el, 'subList')) out.boxes.push(sl); return true; }
    if (name === 'pic') {
      const img = [...walk(el)].find((e) => localName(e) === 'img');
      const ref = img ? attr(img, 'binaryItemIDRef') : null;
      if (ref) out.pics.push({ ref, part: out.parts.length });
      return true;
    }
    return false;
  };
  for (const el of walk(p, skip)) {
    if (localName(el) === 't') buf += tText(el);
  }
  flush();
  return out;
}

/** 셀·글상자의 subList → 한 덩어리 텍스트(문단은 줄바꿈). Task 8 이 표 배치를 교체한다. */
function containerText(subList: Element, depth: number, tableText: (tbl: Element, depth: number) => string): string {
  if (depth > MAX_NEST_DEPTH) {
    let s = '';
    for (const e of walk(subList, (x) => SKIPPED.has(localName(x)))) if (localName(e) === 't') s += tText(e);
    return s;
  }
  const lines: string[] = [];
  for (const para of childrenNamed(subList, 'p')) {
    const r = readParagraph(para, depth, tableText);
    lines.push(...r.parts);
    for (const box of r.boxes) lines.push(containerText(box, depth + 1, tableText));
  }
  return lines.join('\n');
}

/** Task 7 임시: 셀 텍스트를 나온 순서대로 행에 담는다(병합 좌표 무시). Task 8 이 placeGridCells 로 교체한다. */
function naiveTableText(tbl: Element, depth: number): string {
  const rows = childrenNamed(tbl, 'tr').map((tr) =>
    childrenNamed(tr, 'tc').map((tc) => {
      const sl = childrenNamed(tc, 'subList')[0];
      return sl ? containerText(sl, depth, naiveTableText) : '';
    }));
  return toGfmTable(rows);
}

function bodySections(zip: ZipIndex, pkg: OcfPackage | null): string[] {
  const fromSpine = (pkg?.spine ?? []).map((i) => i.path).filter((path) => SECTION_PATH.test(path));
  if (fromSpine.length > 0) return fromSpine;
  // 폴백: spine 이 비었거나 섹션을 못 가리킬 때 — 번호순(사전순이면 section10 이 section2 앞에 온다).
  return zip.names()
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(SECTION_PATH.exec(a)![2]) - Number(SECTION_PATH.exec(b)![2]));
}

export interface HwpxExtractorDeps {
  fitImage?: ImageFitter;
  /** Task 8: 표 텍스트화 교체 지점 */
  tableText?: (tbl: Element, depth: number) => string;
}

export function createHwpxExtractor(deps: HwpxExtractorDeps = {}): Extractor {
  const tableText = deps.tableText ?? naiveTableText;
  void (deps.fitImage ?? fitImage); // Task 9 에서 사용
  return {
    id: HWPX_FORMAT_ID,

    sniff: (zip) => zip.text('mimetype')?.trim() === HWPX_MIMETYPE,

    extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      if (hasEncryptionData(zip)) extractFail('DOC_ENCRYPTED', 'encrypted hwpx');

      let pkg: OcfPackage | null = null;
      try { pkg = readOcfPackage(zip, HWPX_PACKAGE); } catch { pkg = null; }
      const headerPath = pkg ? [...pkg.items.values()].find((i) => /(^|\/)header\.xml$/i.test(i.path))?.path : 'Contents/header.xml';
      const outline = readOutlineLevels(headerPath ? zip.text(headerPath) : null);

      const sections = bodySections(zip, pkg);
      if (sections.length === 0) extractFail('DOC_CORRUPT', 'no body section');

      const blocks: Block[] = [];
      const headingAt: { level: number; title: string; blockIndex: number }[] = [];
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
            await new Promise((r) => setTimeout(r, 0));
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
          for (const [i, text] of r.parts.entries()) {
            if (i === 0 && level !== undefined && text.trim()) headingAt.push({ level, title: text.trim().split('\n')[0]!, blockIndex: blocks.length });
            blocks.push({ text, breakBefore: i === 0 && breakBefore });
          }
          // 글상자는 떠 있는 개체 — 쪽나눔·제목을 만들지 않는다.
          for (const box of r.boxes) {
            const text = containerText(box, 1, tableText);
            if (text.trim()) blocks.push({ text, breakBefore: false });
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
      return { units, images: [], headings, unitKind: 'page' };
    },
  };
}

export const hwpxExtractor: Extractor = createHwpxExtractor();
