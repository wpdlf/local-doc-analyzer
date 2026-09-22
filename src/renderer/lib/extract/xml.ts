/**
 * 네임스페이스 프리픽스에 의존하지 않는 XML 순회.
 *
 * 네 포맷의 프리픽스가 전부 다르다(OOXML w:/a:/p:, HWPX hp:, EPUB 무프리픽스).
 * getElementsByTagName('w:t') 는 프리픽스가 달라지면 **조용히 0건**을 주므로 쓰지 않는다.
 */

import { extractFail } from './errors';

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // DOMParser 는 throw 하지 않고 parsererror 요소를 심는다.
  if (doc.getElementsByTagName('parsererror').length > 0) extractFail('DOC_CORRUPT', 'malformed xml');
  if (!doc.documentElement) extractFail('DOC_CORRUPT', 'empty xml');
  return doc;
}

export function localName(el: Element): string {
  return el.localName || el.nodeName.replace(/^[^:]*:/, '');
}

/** 자기 자신을 포함한 깊이 우선 순회. */
export function* walk(el: Element): Generator<Element> {
  yield el;
  for (const child of Array.from(el.children)) yield* walk(child);
}

export function childrenNamed(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => localName(c) === name);
}

/** 자손 전체에서 로컬명이 일치하는 첫 요소. */
export function firstNamed(el: Element, name: string): Element | null {
  for (const e of walk(el)) {
    if (e !== el && localName(e) === name) return e;
  }
  return null;
}

/**
 * 프리픽스를 무시하고 로컬명으로 속성을 읽는다.
 *
 * a.localName 이 아니라 a.name(정규화된 전체 이름)에서 콜론 이후만 잘라 쓴다. happy-dom
 * 은 요소의 네임스페이스는 제대로 분해하지만 속성의 네임스페이스는 분해하지 않아
 * Attr.localName 이 프리픽스가 붙은 전체 이름을 그대로 돌려준다(예: w:pageBreakBefore).
 * a.name 은 Chromium 과 happy-dom 양쪽에서 똑같이 "w:pageBreakBefore" 형태의 정규화된
 * 전체 이름이라, 여기서 콜론 앞을 잘라내면 Chromium 에서도 동일한 결과이고 happy-dom
 * 에서도 정확한 결과가 나온다 — 환경에 의존하는 DOM 기능 없이 문자열만으로 로컬명을 얻는다.
 *
 * 서로 다른 프리픽스가 같은 로컬명을 가진 속성이 한 요소에 같이 있으면(예: w:val 과
 * a:val) el.attributes 순서상 먼저 나오는 쪽이 이긴다. 호출부는 그 순서가 어느 프리픽스인지
 * 기대해서는 안 된다 — 그런 충돌이 실제로 의미 있는 포맷이 나오면 그때 명시적으로 다룬다.
 */
export function attr(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) {
    const ln = a.name.replace(/^[^:]*:/, '');
    if (ln === name) return a.value;
  }
  return null;
}
