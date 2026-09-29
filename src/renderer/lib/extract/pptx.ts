import { parseXml, walk, localName, attr, childrenNamed, prefixedAttr } from './xml';
import { readRels } from './ooxml';
import { textBodyText, skipNonText, type PptxGraphicsText } from './pptx-text';
import { pptxGraphics } from './pptx-graphics';
import { MAX_EXAMINED_IMAGES, MAX_PAGE_COUNT, MAX_TOTAL_IMAGES } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractedImage, ExtractOptions, ZipIndex } from './types';
import { PPTX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';

const PRESENTATION_PART = 'ppt/presentation.xml';

/** 그룹 중첩 상한 — 병리적 중첩에서 재귀가 스택을 넘기지 않게(실물 최대 2단계). */
const MAX_GROUP_DEPTH = 32;

/** 이만큼 슬라이드를 처리할 때마다 이벤트 루프에 양보한다(docx.ts YIELD_EVERY 와 같은 이유 — 취소가 닿게). */
const YIELD_EVERY_SLIDES = 20;

/**
 * 본문이 아닌 자리표시자. 슬라이드 번호(`sldNum`)는 PowerPoint 가 숫자, Google Slides 가 `‹#›` 를
 * 캐시해 두어, 거르지 않으면 **모든 단위**에 번호가 샌다(실물 24개 덱 전부에 있었다).
 */
const NON_BODY_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** XML 5종 엔티티 디코드 — `&amp;` 는 다른 넷을 먼저 풀고 마지막에 풀어야 이중 디코드가 안 된다. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `presentation.xml` 루트 **직계** `sldIdLst` 의 `sldId` 목록에서, 접두가 붙은 `id`(=`r:id`) 값을
 * 문서 순서대로 읽는다.
 *
 * R4(컨트롤러 판정): happy-dom 20.10.6 은 `<p:sldId id="256" r:id="rId2"/>` 처럼 **무접두 동명
 * 속성(`id`)이 접두 속성(`r:id`) 앞에 오면 뒤의 r:id 를 조용히 버린다**(Element.attributes 순회에서
 * 사라짐 — 실제 PowerPoint 파일이 쓰는 순서라 실물에서 그대로 재현된다). `prefixedAttr`(DOM 기반)
 * 로는 이 환경에서 슬라이드가 0장이 되므로, DOM 을 거치지 않고 태그 텍스트를 정규식으로 읽는다.
 * Chromium(실제 앱)에는 이 버그가 없다 — Task10 의 실물 E2E 가 진짜 순서를 별도로 검증한다.
 *
 * p14 확장(`extLst/…/p14:sectionLst` 안의 두 번째 `sldIdLst`)은 순서 정보가 아니므로, 먼저
 * `extLst` 서브트리를 통째로 지운 뒤 첫 `sldIdLst` 만 본다.
 *
 * fix-round1(리뷰 Important): 짝 태그 제거(`<extLst>…</extLst>`)만으로는 **자기 닫힘**
 * `<p:extLst/>`(스키마상 `p:sldMasterId` 안에도 허용되고, 실제 sldIdLst **앞**에 올 수 있다)를
 * 못 다룬다 — 비탐욕 `[\s\S]*?` 가 자기 닫힘 태그의 `<…extLst` 시작부터 매칭을 시작해, 그
 * 뒤에 오는 **진짜** `</…extLst>`(예: p14 섹션 확장의 닫는 태그)까지를 통째로 삼켜 그 사이의
 * 진짜 `sldIdLst` 가 사라진다(슬라이드 0장 → DOC_NO_TEXT). 자기 닫힘 형태를 **먼저** 제거해야
 * 짝 태그 제거가 엉뚱한 시작점을 잡지 않는다.
 */
export function readSlideRelIds(presentationXml: string): string[] {
  const withoutSelfClosingExt = presentationXml.replace(/<(?:[\w.-]+:)?extLst\b[^>]*\/>/g, '');
  const withoutExt = withoutSelfClosingExt.replace(/<(?:[\w.-]+:)?extLst\b[\s\S]*?<\/(?:[\w.-]+:)?extLst>/g, '');
  const listMatch = /<(?:[\w.-]+:)?sldIdLst\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?sldIdLst>/.exec(withoutExt);
  if (!listMatch) return [];
  const ids: string[] = [];
  const sldIdTagRe = /<(?:[\w.-]+:)?sldId\b([^>]*)>/g;
  for (const tagMatch of listMatch[1]!.matchAll(sldIdTagRe)) {
    // fix-round1: 홑따옴표 속성(`r:id='rId2'`)도 받는다 — XML 은 둘 다 유효하고, DOM 경로였다면
    // 애초에 인용부호를 가리지 않았다.
    const idMatch = /\b[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tagMatch[1] ?? '');
    const raw = idMatch?.[1] ?? idMatch?.[2];
    if (raw !== undefined) ids.push(decodeXmlEntities(raw));
  }
  return ids;
}

/** `mc:AlternateContent` 를 Choice 쪽 자식으로 푼 자식 목록(순서 보존). */
function expandAlternate(children: ArrayLike<Element>): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(children)) {
    if (localName(el) === 'AlternateContent') {
      const choice = childrenNamed(el, 'Choice')[0];
      if (choice) out.push(...expandAlternate(choice.children));
    } else out.push(el);
  }
  return out;
}

function placeholderType(shape: Element): string | null {
  for (const el of walk(shape)) {
    if (localName(el) === 'txBody') return null; // ph 는 nvSpPr 안 — 본문까지 내려가지 않는다
    if (localName(el) === 'ph') return attr(el, 'type') ?? 'body';
  }
  return null;
}

interface SlideParts {
  titles: string[];
  rest: string[];
  blipRelIds: string[];
}

function visitShapes(
  container: Element, out: SlideParts, depth: number,
  ctx: { graphics: PptxGraphicsText; slidePart: string; zip: ZipIndex },
): void {
  for (const el of expandAlternate(container.children)) {
    switch (localName(el)) {
      case 'grpSp':
        if (depth < MAX_GROUP_DEPTH) visitShapes(el, out, depth + 1, ctx);
        break;
      case 'sp':
      case 'cxnSp': {
        const ph = placeholderType(el);
        if (ph && NON_BODY_PLACEHOLDERS.has(ph)) break;
        const body = childrenNamed(el, 'txBody')[0];
        const text = body ? textBodyText(body) : '';
        if (!text) break;
        (ph && TITLE_PLACEHOLDERS.has(ph) ? out.titles : out.rest).push(text);
        break;
      }
      case 'graphicFrame': {
        const data = [...walk(el)].find((e) => localName(e) === 'graphicData');
        const uri = data ? attr(data, 'uri') ?? '' : '';
        let text = '';
        if (uri.endsWith('/table')) {
          const tbl = [...walk(data!)].find((e) => localName(e) === 'tbl');
          if (tbl) text = ctx.graphics.table(tbl);
        } else if (uri.endsWith('/chart')) text = ctx.graphics.chart(el, ctx.slidePart, ctx.zip);
        else if (uri.endsWith('/diagram')) text = ctx.graphics.smartArt(el, ctx.slidePart, ctx.zip);
        if (text) out.rest.push(text);
        break;
      }
      case 'pic':
        for (const e of walk(el, skipNonText)) {
          if (localName(e) !== 'blip') continue;
          const relId = prefixedAttr(e, 'embed');
          if (relId) out.blipRelIds.push(relId);
        }
        break;
    }
  }
}

function spTreeOf(root: Element): Element | null {
  return [...walk(root)].find((e) => localName(e) === 'spTree') ?? null;
}

/** 슬라이드 rels 에서 발표자 노트 파트 → body 자리표시자 텍스트. */
function notesText(zip: ZipIndex, rels: Map<string, string>): string {
  const notesPart = [...rels.values()].find((p) => /(^|\/)notesSlides\/[^/]+\.xml$/i.test(p));
  const xml = notesPart ? zip.text(notesPart) : null;
  if (!xml) return '';
  const tree = spTreeOf(parseXml(xml).documentElement);
  if (!tree) return '';
  const parts: string[] = [];
  for (const el of walk(tree)) {
    if (localName(el) !== 'sp' || placeholderType(el) !== 'body') continue;
    const body = childrenNamed(el, 'txBody')[0];
    const text = body ? textBodyText(body) : '';
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n');
}

export interface PptxExtractorDeps {
  fitImage?: ImageFitter;
  graphics?: PptxGraphicsText;
}

export function createPptxExtractor(deps: PptxExtractorDeps = {}): Extractor {
  const fit = deps.fitImage ?? fitImage;
  const graphics = deps.graphics ?? pptxGraphics;
  return {
    id: PPTX_FORMAT_ID,

    sniff: (zip) => zip.has(PRESENTATION_PART),

    extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      const presXml = zip.text(PRESENTATION_PART) ?? extractFail('DOC_CORRUPT', 'presentation.xml missing');
      // 파싱은 유효성 확인용(깨진 xml → DOC_CORRUPT). 순서 값 자체는 readSlideRelIds 가 태그
      // 레벨로 읽는다(R4 — happy-dom 의 속성 드롭 회피, 위 주석 참조).
      parseXml(presXml);
      const presRels = readRels(zip, PRESENTATION_PART);
      const slideParts = readSlideRelIds(presXml).map((id) => presRels.get(id) ?? null);
      if (slideParts.length > MAX_PAGE_COUNT) {
        extractFail('PDF_TOO_MANY_PAGES', `slide count ${slideParts.length} exceeds ${MAX_PAGE_COUNT}`,
          { pages: String(slideParts.length), max: String(MAX_PAGE_COUNT) });
      }

      const units: string[] = [];
      const headings: ExtractedHeading[] = [];
      const imageAt: { path: string; unitIndex: number }[] = [];

      for (const [index, part] of slideParts.entries()) {
        if (index > 0 && index % YIELD_EVERY_SLIDES === 0) {
          await yieldToEventLoop();
          opts.onProgress?.(index, slideParts.length);
        }
        throwIfAborted(opts.signal);
        const xml = part ? zip.text(part) : null;
        // 가리키는 슬라이드가 없어도 자리를 비워 둔다 — 뒤 슬라이드 번호가 밀리면 인용이 전부 어긋난다.
        if (!part || !xml) { units.push(''); continue; }
        const tree = spTreeOf(parseXml(xml).documentElement);
        const out: SlideParts = { titles: [], rest: [], blipRelIds: [] };
        if (tree) visitShapes(tree, out, 0, { graphics, slidePart: part, zip });

        const rels = readRels(zip, part);
        const notes = notesText(zip, rels);
        const blocks = [...out.titles, ...out.rest];
        if (notes) blocks.push(notes.split('\n').map((l) => `> ${l}`).join('\n'));
        units.push(blocks.join('\n\n'));

        const title = out.titles[0]?.split('\n')[0]?.trim();
        if (title) headings.push({ level: 1, title, unitIndex: index });
        for (const relId of out.blipRelIds) {
          const path = rels.get(relId);
          if (path) imageAt.push({ path, unitIndex: index });
        }
      }
      opts.onProgress?.(slideParts.length, slideParts.length);

      const images: ExtractedImage[] = [];
      let imageBudgetExceeded = false;
      if (opts.extractImages !== false) {
        const seen = new Set<string>();
        let examined = 0;
        for (const { path, unitIndex } of imageAt) {
          throwIfAborted(opts.signal);
          if (examined >= MAX_EXAMINED_IMAGES) break;
          examined += 1;
          if (seen.has(path)) continue;
          const bytes = zip.bytes(path);
          if (!bytes) continue;
          seen.add(path);
          if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
          const fitted = await fit(bytes);
          if (fitted) images.push({ unitIndex, ...fitted });
        }
      }

      // R7(컨트롤러 판정, R4 편차를 대체): 그림 **후보**(imageAt)가 아니라 실제로 **채택된**
      // 그림(images)을 봐야 한다. extractImages=false 거나, 후보가 있어도 전부 지원하지 않는
      // 형식(EMF/WMF 등 — fitImage 가 null)이면 후보는 있어도 실채택은 0장이라, 텍스트도 없는
      // 문서를 "빈 문서 아님"으로 잘못 판정해 요약할 것이 없는 문서가 그대로 통과했다(R4 편차의
      // 사각). 그래서 이미지 추출 루프 **뒤**에서, 실채택 수로 최종 판정한다.
      if (!units.some((u) => u.trim()) && images.length === 0) extractFail('DOC_NO_TEXT', 'no text in presentation');

      return {
        units,
        images,
        headings,
        unitKind: 'slide',
        ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
      };
    },
  };
}

export const pptxExtractor: Extractor = createPptxExtractor();
