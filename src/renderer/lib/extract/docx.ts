import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { readRels } from './ooxml';
import { toGfmTable } from './table';
import { paginate, type Block } from './paginate';
import { MAX_EXAMINED_IMAGES, MAX_PAGE_COUNT, MAX_TOTAL_IMAGES } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractedImage, ExtractOptions, ZipIndex } from './types';
import { DOCX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';

const DOCUMENT_PART = 'word/document.xml';

/** 제목 스타일 — 워드가 붙이는 스타일 ID 는 보통 영문이지만 한국어 스타일명도 들어온다. */
const HEADING_STYLE_RE = /^(?:Heading|제목)\s*([1-9])$/i;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
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

/**
 * `w:sdt`(구조적 콘텐츠 컨트롤)를 그 `w:sdtContent` 자식들로 재귀 치환해 평평한 자식
 * 목록을 만든다 — 순서는 그대로 보존한다. 본문 순회와 표 셀 순회가 이 규칙을 공유한다.
 * 따로 두면 한쪽만 sdt 를 풀고 다른 쪽은 잊는 사각이 생긴다 — 이 파일이 이미 그 대가를
 * 치렀다(본문에서 한 번, 표 셀에서 또 한 번, 같은 실수).
 */
function expandSdt(children: Element[]): Element[] {
  const out: Element[] = [];
  for (const child of children) {
    if (localName(child) === 'sdt') {
      const content = childrenNamed(child, 'sdtContent')[0];
      if (content) out.push(...expandSdt(Array.from(content.children)));
      continue;
    }
    out.push(child);
  }
  return out;
}

/**
 * 표 → 행렬. 셀 안의 문단을 줄바꿈으로 이어 한 셀로 만든다.
 *
 * fix-round2(I3 후속): 셀 안 문단이 `w:sdt` 로 감싸여 있으면(Korean 업무 서식이 흔히 이
 * 형태다) 직계 자식만 보는 `childrenNamed(tc, 'p')` 가 그 문단을 통째로 놓쳤다 — expandSdt
 * 로 먼저 풀어서 본문 순회와 같은 규칙을 적용한다.
 */
function tableRows(tbl: Element): string[][] {
  return childrenNamed(tbl, 'tr').map((tr) =>
    childrenNamed(tr, 'tc').map((tc) =>
      expandSdt(Array.from(tc.children))
        .filter((el) => localName(el) === 'p')
        .map((p) => paragraphPieces(p).map((piece) => piece.text).join('\n'))
        .join('\n'),
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
  id: DOCX_FORMAT_ID,

  sniff: (zip: ZipIndex): boolean => zip.has(DOCUMENT_PART),

  extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
    throwIfAborted(opts.signal);

    const xml = zip.text(DOCUMENT_PART);
    if (!xml) extractFail('DOC_CORRUPT', 'word/document.xml missing');

    // walk 는 제너레이터라 .find 가 없다. 펼쳐서 찾는다.
    const body = [...walk(parseXml(xml).documentElement)].find((el) => localName(el) === 'body')
      ?? extractFail('DOC_CORRUPT', 'w:body missing');

    const blocks: Block[] = [];
    const headingAt: { level: number; title: string; blockIndex: number }[] = [];
    const imageAt: { relId: string; blockIndex: number }[] = [];

    // body 직계 자식을 처리한다. `w:sdt`(구조적 콘텐츠 컨트롤 — 생성 목차나 템플릿 섹션
    // 전체를 감싸는 데 흔히 쓰인다)는 그 자신이 문단/표가 아니라 `w:sdtContent` 안에
    // 그것들을 담으므로, expandSdt 로 먼저 풀어서 본다(중첩 sdt 도 재귀로 풀린다) — 이
    // 규칙은 tableRows 의 셀 순회와 공유한다(expandSdt 정의부 주석 참조).
    function walkChildren(children: Element[]): void {
      for (const child of expandSdt(children)) {
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
    }

    walkChildren(Array.from(body.children));

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
