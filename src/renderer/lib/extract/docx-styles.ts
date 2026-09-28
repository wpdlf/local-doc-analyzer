import { parseXml, localName, attr, childrenNamed } from './xml';
import type { ZipIndex } from './types';

/**
 * DOCX 스타일 표(word/styles.xml) 해석 — 제목 수준과 상속된 쪽나눔.
 *
 * QA34(High): 한국어판 Word 는 제목 스타일의 styleId 를 "1","2" 같은 숫자로 저장하고, 제목이라는
 * 사실은 styles.xml 의 `<w:name w:val="heading 1"/>` 와 `w:pPr/w:outlineLvl` 에만 남긴다. 문단의
 * pStyle 값(styleId)만 정규식으로 보던 때는 이런 문서에서 제목이 **하나도** 잡히지 않아 목차가
 * 비고 챕터 요약이 휴리스틱 폴백으로 떨어졌다.
 */

export const STYLES_PART = 'word/styles.xml';

/** 스타일 ID·이름 공용 — 영문 "Heading 1"/"heading1" 과 한국어 "제목 1" 을 받는다. */
export const HEADING_STYLE_RE = /^(?:Heading|제목)\s*([1-9])$/i;

/** ST_OnOff 의 거짓 값 — 값이 없으면(빈 요소) 참으로 본다. */
const ON_OFF_FALSE = new Set(['0', 'false', 'off']);

export function onOff(el: Element): boolean {
  const val = attr(el, 'val');
  return val === null || !ON_OFF_FALSE.has(val);
}

/**
 * `w:outlineLvl` → 제목 수준. 0..8 은 수준 1..9, 9 는 "본문 수준"(명시적 비제목)이라 0 을
 * 돌려준다. 해석할 수 없는 값은 undefined — 그 요소가 없는 것과 같게 다룬다.
 */
export function outlineLevelOf(el: Element): number | undefined {
  const n = Number(attr(el, 'val'));
  if (!Number.isInteger(n)) return undefined;
  if (n >= 0 && n <= 8) return n + 1;
  if (n === 9) return 0;
  return undefined;
}

interface RawStyle {
  basedOn: string | null;
  /** 스타일 자신의 pPr/outlineLvl (outlineLevelOf 결과) */
  outline: number | undefined;
  /** w:name 이 제목 이름이면 그 수준 */
  nameLevel: number | undefined;
  /** 스타일 자신의 pPr/pageBreakBefore */
  pageBreakBefore: boolean | undefined;
}

export interface StyleTable {
  has(styleId: string): boolean;
  /** 1..9 = 제목 수준, 0 = 본문 수준 명시, undefined = 체인 어디에도 정보 없음 */
  headingLevel(styleId: string): number | undefined;
  /** 체인에서 처음 정의된 pageBreakBefore. 어디에도 없으면 undefined */
  pageBreakBefore(styleId: string): boolean | undefined;
  /** w:default="1" 인 문단 스타일 — pStyle 이 없는 문단이 따르는 스타일 */
  defaultParagraphStyle: string | null;
}

export const EMPTY_STYLES: StyleTable = {
  has: () => false,
  headingLevel: () => undefined,
  pageBreakBefore: () => undefined,
  defaultParagraphStyle: null,
};

/** basedOn 체인 상한 — 순환은 visited 로 끊지만 비정상적으로 긴 체인도 유한하게 만든다. */
const MAX_CHAIN = 64;

function childVal(parent: Element | undefined, name: string): string | null {
  const el = parent ? childrenNamed(parent, name)[0] : undefined;
  return el ? attr(el, 'val') : null;
}

/**
 * styles.xml 을 읽어 스타일 표를 만든다. 선택 파트다 — 없거나 손상돼 있으면 빈 표를 돌려주고
 * 문서 열기를 실패시키지 않는다(스타일은 제목·쪽나눔 **힌트**일 뿐 본문이 아니다).
 */
export function readStyles(zip: ZipIndex): StyleTable {
  const xml = zip.text(STYLES_PART);
  if (!xml) return EMPTY_STYLES;
  let root: Element;
  try {
    root = parseXml(xml).documentElement;
  } catch {
    return EMPTY_STYLES;
  }

  const styles = new Map<string, RawStyle>();
  let defaultParagraphStyle: string | null = null;
  for (const st of childrenNamed(root, 'style')) {
    if (attr(st, 'type') !== 'paragraph') continue;
    const id = attr(st, 'styleId');
    if (!id) continue;
    const pPr = childrenNamed(st, 'pPr')[0];
    const outlineEl = pPr ? childrenNamed(pPr, 'outlineLvl')[0] : undefined;
    const pbbEl = pPr ? childrenNamed(pPr, 'pageBreakBefore')[0] : undefined;
    const nameMatch = HEADING_STYLE_RE.exec((childVal(st, 'name') ?? '').trim());
    styles.set(id, {
      basedOn: childVal(st, 'basedOn'),
      outline: outlineEl ? outlineLevelOf(outlineEl) : undefined,
      nameLevel: nameMatch ? Number(nameMatch[1]) : undefined,
      pageBreakBefore: pbbEl ? onOff(pbbEl) : undefined,
    });
    const def = attr(st, 'default');
    if (def !== null && !ON_OFF_FALSE.has(def) && defaultParagraphStyle === null) {
      defaultParagraphStyle = id;
    }
  }

  /** 체인을 따라 처음으로 undefined 가 아닌 값을 준다. 순환·과잉 길이에서 멈춘다. */
  function resolve<T>(styleId: string, pick: (s: RawStyle) => T | undefined): T | undefined {
    const visited = new Set<string>();
    let id: string | null = styleId;
    while (id !== null && !visited.has(id) && visited.size < MAX_CHAIN) {
      visited.add(id);
      const s = styles.get(id);
      if (!s) return undefined;
      const v = pick(s);
      if (v !== undefined) return v;
      id = s.basedOn;
    }
    return undefined;
  }

  return {
    has: (id) => styles.has(id),
    // 한 스타일 안에서는 outlineLvl(명시 속성, 실제로 Word 가 목차에 쓰는 값)을 이름보다 먼저
    // 본다. 이름은 상속되지 않지만, 제목 스타일을 basedOn 한 사용자 스타일은 기반 스타일의
    // outlineLvl 을 상속하므로 체인을 따라가면 잡힌다.
    headingLevel: (id) => resolve(id, (s) => s.outline ?? s.nameLevel),
    pageBreakBefore: (id) => resolve(id, (s) => s.pageBreakBefore),
    defaultParagraphStyle,
  };
}
