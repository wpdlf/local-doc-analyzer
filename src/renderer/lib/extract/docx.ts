import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { readRels } from './ooxml';
import { toGfmTable } from './table';
import { paginate, type Block } from './paginate';
import { MAX_EXAMINED_IMAGES, MAX_PAGE_COUNT, MAX_TOTAL_IMAGES } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractedImage, ExtractOptions, ZipIndex } from './types';

const DOCUMENT_PART = 'word/document.xml';

/** 제목 스타일 — 워드가 붙이는 스타일 ID 는 보통 영문이지만 한국어 스타일명도 들어온다. */
const HEADING_STYLE_RE = /^(?:Heading|제목)\s*([1-9])$/i;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('ABORTED', 'aborted');
}

function mimeOf(path: string): 'image/png' | 'image/jpeg' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 문단 안에서 조각 하나의 텍스트와, 그 조각 구간(직전 쪽나눔~이 쪽나눔) 안에서 만난 그림. */
interface ParagraphPiece {
  text: string;
  /** 이 구간 안의 `a:blip/@r:embed` — 실제로 이 조각과 같은 쪽에 남는 그림이다. */
  blipRelIds: string[];
}

/** 문단 하나를 텍스트 조각으로. `w:br type=page` 에서 조각이 끊긴다. */
function paragraphPieces(p: Element): ParagraphPiece[] {
  const pieces: ParagraphPiece[] = [];
  let buf = '';
  let blips: string[] = [];
  for (const el of walk(p)) {
    const name = localName(el);
    if (name === 't') buf += el.textContent ?? '';
    else if (name === 'tab') buf += '\t';
    else if (name === 'blip') {
      const relId = attr(el, 'embed');
      if (relId) blips.push(relId);
    } else if (name === 'br') {
      // 실물 DOCX 의 w:br 은 대부분 textWrapping(줄바꿈)이다. page 인 것만 쪽나눠다.
      if (attr(el, 'type') === 'page') { pieces.push({ text: buf, blipRelIds: blips }); buf = ''; blips = []; }
      else buf += '\n';
    }
  }
  pieces.push({ text: buf, blipRelIds: blips });
  return pieces;
}

function headingLevel(p: Element): number | null {
  for (const el of walk(p)) {
    if (localName(el) !== 'pStyle') continue;
    const m = HEADING_STYLE_RE.exec((attr(el, 'val') ?? '').trim());
    if (m) return Number(m[1]);
  }
  return null;
}

/** ST_OnOff 의 거짓 값 — 값이 없으면(빈 요소) 참으로 본다. */
const ON_OFF_FALSE = new Set(['0', 'false', 'off']);

function hasPageBreakBefore(p: Element): boolean {
  for (const el of walk(p)) {
    if (localName(el) === 'pageBreakBefore') {
      const val = attr(el, 'val');
      return val === null || !ON_OFF_FALSE.has(val);
    }
  }
  return false;
}

/** 표 → 행렬. 셀 안의 문단을 줄바꿈으로 이어 한 셀로 만든다. */
function tableRows(tbl: Element): string[][] {
  return childrenNamed(tbl, 'tr').map((tr) =>
    childrenNamed(tr, 'tc').map((tc) =>
      childrenNamed(tc, 'p').map((p) => paragraphPieces(p).map((piece) => piece.text).join('\n')).join('\n'),
    ),
  );
}

/** 요소 서브트리 안의 `a:blip/@r:embed` 전부. 표 안 그림처럼 문단 조각 단위가 아닌 경우에 쓴다. */
function blipsIn(el: Element): string[] {
  const ids: string[] = [];
  for (const e of walk(el)) {
    if (localName(e) !== 'blip') continue;
    const relId = attr(e, 'embed');
    if (relId) ids.push(relId);
  }
  return ids;
}

export const docxExtractor: Extractor = {
  id: 'docx',
  extensions: ['.docx'],

  sniff: (zip: ZipIndex): boolean => zip.has(DOCUMENT_PART),

  extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
    throwIfAborted(opts.signal);

    const xml = zip.text(DOCUMENT_PART);
    if (!xml) fail('DOC_CORRUPT', 'word/document.xml missing');

    // walk 는 제너레이터라 .find 가 없다. 펼쳐서 찾는다.
    const body = [...walk(parseXml(xml).documentElement)].find((el) => localName(el) === 'body')
      ?? fail('DOC_CORRUPT', 'w:body missing');

    const blocks: Block[] = [];
    const headingAt: { level: number; title: string; blockIndex: number }[] = [];
    const imageAt: { relId: string; blockIndex: number }[] = [];

    for (const child of Array.from(body.children)) {
      throwIfAborted(opts.signal);
      const name = localName(child);

      if (name === 'tbl') {
        const blockIndex = blocks.length;
        blocks.push({ text: toGfmTable(tableRows(child)), breakBefore: false });
        // 표 셀 안 그림 — 셀 나눔은 단위 경계가 아니므로 표 전체를 담은 이 블록에 붙인다.
        for (const relId of blipsIn(child)) imageAt.push({ relId, blockIndex });
        continue;
      }
      if (name !== 'p') continue;

      const pieces = paragraphPieces(child);
      const level = headingLevel(child);
      let breakBefore = hasPageBreakBefore(child);

      for (const [i, piece] of pieces.entries()) {
        const blockIndex = blocks.length;
        blocks.push({ text: piece.text, breakBefore: breakBefore || i > 0 });
        breakBefore = false;
        // 제목은 조각이 아니라 문단의 스타일이므로 첫 조각에만 붙인다.
        if (i === 0 && level !== null && piece.text.trim()) {
          headingAt.push({ level, title: piece.text.trim(), blockIndex });
        }
        // 그림은 실제로 그 조각(쪽나눔 이전 구간) 에 속한 것만 붙인다 — 문단 중간의
        // 쪽나눔 뒤에 오는 그림이 앞쪽 조각에 잘못 매핑되는 것을 막는다.
        for (const relId of piece.blipRelIds) imageAt.push({ relId, blockIndex });
      }
    }

    const { units, unitOfBlock } = paginate(blocks);
    if (units.length === 0) fail('DOC_NO_TEXT', 'no text in document');
    // 단위 수 상한은 PDF 와 같은 예산을 쓴다 — 요약·임베딩이 단위 수에 선형으로 확장된다.
    if (units.length > MAX_PAGE_COUNT) {
      fail('PDF_TOO_MANY_PAGES', `unit count ${units.length} exceeds ${MAX_PAGE_COUNT}`);
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
        const mimeType = mimeOf(path);
        const bytes = zip.bytes(path);
        if (!mimeType || !bytes) continue;
        seen.add(path);
        if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
        images.push({
          unitIndex: unitOfBlock[blockIndex] ?? 0,
          base64: toBase64(bytes),
          // 원본 픽셀 크기는 디코드해야 알 수 있는데 Vision 경로가 쓰지 않는다. 0 으로 둔다.
          width: 0,
          height: 0,
          mimeType,
        });
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
