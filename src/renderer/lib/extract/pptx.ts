import { parseXml, walk, localName, attr, childrenNamed, prefixedAttr } from './xml';
import { readRels } from './ooxml';
import { textBodyText, skipNonText, type PptxGraphicsText } from './pptx-text';
import { pptxGraphics } from './pptx-graphics';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractOptions, ZipIndex } from './types';
import { PPTX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';
import { collectImages, throwIfAborted, yieldToEventLoop } from './common';

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

/**
 * XML 엔티티 디코드 — 이름 5종과 숫자 참조(`&#NN;`·`&#xNN;`)를 **한 번의 치환**으로 푼다.
 * 여러 번 나눠 풀면 `&amp;lt;` 가 `<` 로 이중 디코드된다. 범위 밖 코드 포인트는 원문 그대로 둔다
 * (`String.fromCodePoint` 가 throw 해 문서 열기 전체가 실패하지 않게).
 */
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref] ?? whole;
    const cp = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

/**
 * 주석(`<!--…-->`)·CDATA(`<![CDATA[…]]>`)를 지운다 — indexOf 로 `<` 마다 한 번씩만 보므로 선형이다.
 *
 * QA35: 예전 정규식 스캐너는 주석을 몰라 ① 주석 안의 가짜 `<p:sldIdLst>` 를 진짜 목록으로 읽고,
 * ② 주석 안의 `<p:extLst>` 가 진짜 목록까지 삼켰으며, ③ `<!-- <p:extLst …` 가 닫는 태그 없이
 * 1MB 반복되면 비탐욕 매칭이 시작점마다 끝까지 훑어(이차) 렌더러가 양보 전에 71초 멈췄다.
 * 태그를 보기 **전에** 주석을 없애야 셋 다 구조적으로 닫힌다. 닫히지 않은 주석은 끝까지 버린다
 * (parseXml 을 통과한 문서에서는 나올 수 없다 — 방어적으로만).
 */
function stripCommentsAndCdata(xml: string): string {
  const parts: string[] = [];
  let from = 0;
  let i = xml.indexOf('<');
  while (i !== -1) {
    const close = xml.startsWith('<!--', i) ? '-->' : xml.startsWith('<![CDATA[', i) ? ']]>' : null;
    if (close === null) { i = xml.indexOf('<', i + 1); continue; }
    parts.push(xml.slice(from, i));
    const end = xml.indexOf(close, i + (close === '-->' ? 4 : 9));
    if (end === -1) { from = xml.length; break; }
    from = end + close.length;
    i = xml.indexOf('<', from);
  }
  parts.push(xml.slice(from));
  return parts.join('');
}

/** 태그 본문(`<` 다음부터 `>` 앞까지)의 속성 — 정규식 없이 한 번 훑는다(긴 이름에서 되추적이 없게). */
function tagAttributes(body: string, nameEnd: number): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = nameEnd;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(body[i]!)) i++;
    const nameStart = i;
    while (i < n && !/[\s=/]/.test(body[i]!)) i++;
    const name = body.slice(nameStart, i);
    while (i < n && /\s/.test(body[i]!)) i++;
    if (body[i] !== '=') { if (i === nameStart) i++; continue; }
    i++;
    while (i < n && /\s/.test(body[i]!)) i++;
    const quote = body[i];
    if (quote !== '"' && quote !== "'") continue;
    const valueEnd = body.indexOf(quote, i + 1);
    if (valueEnd === -1) break;
    // fix-round1: 홑따옴표 속성(`r:id='rId2'`)도 받는다 — XML 은 둘 다 유효하다.
    if (name && !attrs.has(name)) attrs.set(name, decodeXmlEntities(body.slice(i + 1, valueEnd)));
    i = valueEnd + 1;
  }
  return attrs;
}

/** 접두사가 붙은(`xmlns` 제외) 로컬명 `local` 속성 값. 무접두 동명 속성은 보지 않는다. */
function prefixedValue(attrs: Map<string, string>, local: string): string | undefined {
  for (const [name, value] of attrs) {
    const c = name.indexOf(':');
    if (c > 0 && name.slice(c + 1) === local && name.slice(0, c) !== 'xmlns') return value;
  }
  return undefined;
}

const localOf = (qname: string): string => qname.slice(qname.indexOf(':') + 1);

export interface PresentationSlideRef {
  /** 접두가 붙은 `id`(`r:id`) — presentation.xml.rels 의 관계 id */
  relId: string;
  /** 무접두 `id` — 섹션(`p14:sldId@id`)이 슬라이드를 가리키는 숫자 id. 없으면 '' */
  id: string;
}

export interface PresentationIndex {
  slides: PresentationSlideRef[];
  /** `p14:sectionLst` 의 섹션 — 이름과 소속 슬라이드의 숫자 id(문서 순서) */
  sections: { name: string; slideIds: string[] }[];
}

/**
 * `presentation.xml` → 슬라이드 순서(루트 **직계** `sldIdLst`) + p14 섹션.
 *
 * R4(컨트롤러 판정): happy-dom 20.10.6 은 `<p:sldId id="256" r:id="rId2"/>` 처럼 **무접두 동명
 * 속성(`id`)이 접두 속성(`r:id`) 앞에 오면 뒤의 r:id 를 조용히 버린다**(실제 PowerPoint 파일이
 * 쓰는 순서라 실물에서 그대로 재현된다). 그래서 DOM 을 거치지 않고 태그 텍스트를 읽는다.
 *
 * QA35: 정규식 대신 indexOf 기반 선형 태그 스캐너로 바꿨다. 주석·CDATA 를 먼저 지우고, 여는/닫는
 * 태그로 조상 스택을 유지해 **루트 직계** `sldIdLst` 만 순서로 본다 — p14 확장 안의 두 번째
 * `sldIdLst`(깊은 곳)나 자기 닫힘 `<p:extLst/>` 는 깊이만으로 자연히 걸러져, 예전처럼 extLst 를
 * 지우는 전처리(와 그 전처리의 자기 닫힘 함정 — fix-round1)가 필요 없다. 태그 끝 `>` 는 인용부호
 * 안의 `>` 를 건너뛰며 찾는다(속성 값에 `>` 는 합법이다).
 */
export function readPresentationIndex(presentationXml: string): PresentationIndex {
  const xml = stripCommentsAndCdata(presentationXml);
  const slides: PresentationSlideRef[] = [];
  const sections: { name: string; slideIds: string[] }[] = [];
  const stack: string[] = [];
  let i = xml.indexOf('<');
  while (i !== -1) {
    // 처리 지시(`<?xml …?>`)·DOCTYPE 등 `<!`/`<?` 는 요소가 아니다.
    if (xml[i + 1] === '?' || xml[i + 1] === '!') {
      const end = xml.indexOf('>', i + 2);
      if (end === -1) break;
      i = xml.indexOf('<', end + 1);
      continue;
    }
    // 인용부호를 존중하며 태그 끝을 찾는다 — 각 문자를 한 번만 본다(선형).
    let j = i + 1;
    let quote = '';
    for (; j < xml.length; j++) {
      const ch = xml[j]!;
      if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (j >= xml.length) break;
    const body = xml.slice(i + 1, j);
    i = xml.indexOf('<', j + 1);
    if (body[0] === '/') { stack.pop(); continue; }
    const selfClosing = body.endsWith('/');
    let nameEnd = 0;
    while (nameEnd < body.length && !/[\s/]/.test(body[nameEnd]!)) nameEnd++;
    const name = localOf(body.slice(0, nameEnd));
    const parent = stack[stack.length - 1];
    // 스택이 [루트, sldIdLst] 일 때만 순서 목록의 sldId 다(스키마상 루트 직계 sldIdLst 는 하나).
    if (name === 'sldId' && parent === 'sldIdLst' && stack.length === 2) {
      const attrs = tagAttributes(body, nameEnd);
      const relId = prefixedValue(attrs, 'id');
      if (relId !== undefined) slides.push({ relId, id: attrs.get('id') ?? '' });
    } else if (name === 'section' && parent === 'sectionLst') {
      sections.push({ name: tagAttributes(body, nameEnd).get('name') ?? '', slideIds: [] });
    } else if (name === 'sldId' && parent === 'sldIdLst' && stack[stack.length - 2] === 'section') {
      const id = tagAttributes(body, nameEnd).get('id');
      if (id !== undefined) sections[sections.length - 1]?.slideIds.push(id);
    }
    if (!selfClosing) stack.push(name);
  }
  return { slides, sections };
}

/** 슬라이드 순서의 관계 id 목록 — readPresentationIndex 의 얇은 투영(기존 호출부·테스트 계약). */
export function readSlideRelIds(presentationXml: string): string[] {
  return readPresentationIndex(presentationXml).slides.map((s) => s.relId);
}

/**
 * p14 섹션 → 장 경계. 섹션마다 **표시 순서상 첫 슬라이드**의 단위 번호를 쓴다(섹션 안 id 목록의
 * 순서가 아니라 — 표시 순서가 인용 번호의 기준이다). 가리키는 슬라이드가 하나도 없거나 이름이
 * 빈 섹션은 경계로 쓰지 않는다(그 슬라이드들은 앞 섹션에 붙는다 — 내용은 잃지 않는다). 둘 미만이면
 * 장으로 나눌 의미가 없으므로 undefined — normalize 가 기존 제목 기반 규칙을 그대로 쓴다.
 */
function sectionsOf(index: PresentationIndex): { title: string; unitIndex: number }[] | undefined {
  const unitById = new Map<string, number>();
  index.slides.forEach((s, unit) => { if (s.id && !unitById.has(s.id)) unitById.set(s.id, unit); });
  const out: { title: string; unitIndex: number }[] = [];
  const usedUnits = new Set<number>();
  for (const section of index.sections) {
    const title = section.name.trim();
    const units = section.slideIds.map((id) => unitById.get(id)).filter((u): u is number => u !== undefined);
    if (!title || units.length === 0) continue;
    const unitIndex = Math.min(...units);
    if (usedUnits.has(unitIndex)) continue;
    usedUnits.add(unitIndex);
    out.push({ title, unitIndex });
  }
  out.sort((a, b) => a.unitIndex - b.unitIndex);
  return out.length >= 2 ? out : undefined;
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

/**
 * 도형 채우기 그림(`p:sp > p:spPr > a:blipFill > a:blip@r:embed`)의 관계 id.
 *
 * QA35(Important): 그림을 `p:pic` 에서만 모았는데, Canva 류 덱은 **모든** 사진을 도형 채우기로
 * 넣는다 — 실물 한 덱에서 사진 14장이 0장으로 나왔고, 그림뿐인 덱은 DOC_NO_TEXT 로 거절됐다.
 * `spPr` 직계 `blipFill` 만 본다(txBody 의 글자 채우기 등 다른 채우기까지 넓히지 않는다). extLst
 * 안의 svgBlip 은 `pic` 과 같은 이유(래스터 사본이 이미 blip 에 있다)로 skipNonText 가 거른다.
 */
function collectShapeFillBlips(shape: Element, out: SlideParts): void {
  for (const spPr of childrenNamed(shape, 'spPr')) {
    for (const fill of childrenNamed(spPr, 'blipFill')) {
      for (const e of walk(fill, skipNonText)) {
        if (localName(e) !== 'blip') continue;
        const relId = prefixedAttr(e, 'embed');
        if (relId) out.blipRelIds.push(relId);
      }
    }
  }
}

/**
 * 그룹 중첩 상한을 넘은 서브트리의 텍스트 — 구조 해석 없이 텍스트 본문(`txBody`)마다 문단 줄로.
 *
 * QA35(Low): 예전엔 상한을 넘으면 서브트리를 **조용히** 버렸다(텍스트 손실). walk 는 명시적 스택이라
 * 깊어도 스택을 넘기지 않으므로, 재귀 대신 평면 순회로 텍스트만은 살린다. Fallback·extLst·번호 필드는
 * skipNonText 가 거른다(Choice 와 중복되거나 본문이 아니다).
 */
function plainSubtreeText(root: Element): string[] {
  const texts: string[] = [];
  for (const e of walk(root, skipNonText)) {
    if (localName(e) !== 'txBody') continue;
    const text = textBodyText(e);
    if (text) texts.push(text);
  }
  return texts;
}

function visitShapes(
  container: Element, out: SlideParts, depth: number,
  ctx: { graphics: PptxGraphicsText; slidePart: string; zip: ZipIndex },
): void {
  for (const el of expandAlternate(container.children)) {
    switch (localName(el)) {
      case 'grpSp':
        if (depth < MAX_GROUP_DEPTH) visitShapes(el, out, depth + 1, ctx);
        else out.rest.push(...plainSubtreeText(el));
        break;
      case 'sp':
      case 'cxnSp': {
        const ph = placeholderType(el);
        if (ph && NON_BODY_PLACEHOLDERS.has(ph)) break;
        collectShapeFillBlips(el, out);
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
      // 파싱은 유효성 확인용(깨진 xml → DOC_CORRUPT). 순서·섹션 값 자체는 readPresentationIndex 가
      // 태그 레벨로 읽는다(R4 — happy-dom 의 속성 드롭 회피, 위 주석 참조).
      parseXml(presXml);
      const presRels = readRels(zip, PRESENTATION_PART);
      const presIndex = readPresentationIndex(presXml);
      const slideParts = presIndex.slides.map((s) => presRels.get(s.relId) ?? null);
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

      const { images, imageBudgetExceeded } = opts.extractImages !== false
        ? await collectImages(imageAt, zip, fit, opts.signal)
        : { images: [], imageBudgetExceeded: false };

      // R7(컨트롤러 판정, R4 편차를 대체): 그림 **후보**(imageAt)가 아니라 실제로 **채택된**
      // 그림(images)을 봐야 한다. extractImages=false 거나, 후보가 있어도 전부 지원하지 않는
      // 형식(EMF/WMF 등 — fitImage 가 null)이면 후보는 있어도 실채택은 0장이라, 텍스트도 없는
      // 문서를 "빈 문서 아님"으로 잘못 판정해 요약할 것이 없는 문서가 그대로 통과했다(R4 편차의
      // 사각). 그래서 이미지 추출 루프 **뒤**에서, 실채택 수로 최종 판정한다.
      if (!units.some((u) => u.trim()) && images.length === 0) extractFail('DOC_NO_TEXT', 'no text in presentation');

      const sections = sectionsOf(presIndex);
      return {
        units,
        images,
        headings,
        ...(sections ? { sections } : {}),
        unitKind: 'slide',
        ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
      };
    },
  };
}

export const pptxExtractor: Extractor = createPptxExtractor();
