/**
 * 네임스페이스 프리픽스에 의존하지 않는 XML 순회.
 *
 * 네 포맷의 프리픽스가 전부 다르다(OOXML w:/a:/p:, HWPX hp:, EPUB 무프리픽스).
 * getElementsByTagName('w:t') 는 프리픽스가 달라지면 **조용히 0건**을 주므로 쓰지 않는다.
 */

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'DOC_CORRUPT' });
}

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // DOMParser 는 throw 하지 않고 parsererror 요소를 심는다.
  if (doc.getElementsByTagName('parsererror').length > 0) fail('malformed xml');
  if (!doc.documentElement) fail('empty xml');
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

/** 프리픽스를 무시하고 로컬명으로 속성을 읽는다. */
export function attr(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) {
    const ln = a.localName || a.name.replace(/^[^:]*:/, '');
    if (ln === name) return a.value;
  }
  return null;
}
