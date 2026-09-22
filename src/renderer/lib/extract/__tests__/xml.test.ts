// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { parseXml, localName, walk, childrenNamed, firstNamed, attr } from '../xml';

const DOC = `<?xml version="1.0"?>
<w:body xmlns:w="urn:w" xmlns:a="urn:a">
  <w:p w:pageBreakBefore="1"><w:r><w:t>첫째</w:t></w:r></w:p>
  <w:p><w:r><w:t>둘째</w:t><a:t>다른ns</a:t></w:r></w:p>
</w:body>`;

describe('xml 순회 — 프리픽스에 의존하지 않는다', () => {
  it('parseXml 은 루트를 준다', () => {
    const root = parseXml(DOC).documentElement;
    expect(localName(root)).toBe('body');
  });

  it('잘못된 XML 은 DOC_CORRUPT 로 거부한다', () => {
    expect(() => parseXml('<a><b></a>')).toThrowError(
      expect.objectContaining({ code: 'DOC_CORRUPT' }),
    );
  });

  it('childrenNamed 는 직계 자식만, 로컬명으로 찾는다', () => {
    const root = parseXml(DOC).documentElement;
    expect(childrenNamed(root, 'p')).toHaveLength(2);
    // r 은 손자이므로 직계에서는 안 잡힌다
    expect(childrenNamed(root, 'r')).toHaveLength(0);
  });

  it('walk 는 프리픽스가 달라도 같은 로컬명을 모두 훑는다', () => {
    const root = parseXml(DOC).documentElement;
    const texts = [...walk(root)].filter((e) => localName(e) === 't').map((e) => e.textContent);
    expect(texts).toEqual(['첫째', '둘째', '다른ns']);
  });

  it('attr 은 없는 속성이면 null 이다', () => {
    const root = parseXml(DOC).documentElement;
    const first = childrenNamed(root, 'p')[0]!;
    expect(attr(first, '없는속성')).toBeNull();
  });

  it('attr 은 프리픽스가 붙은 속성도 로컬명으로 매칭한다', () => {
    const root = parseXml(DOC).documentElement;
    const first = childrenNamed(root, 'p')[0]!;
    expect(attr(first, 'pageBreakBefore')).toBe('1');
  });

  it('attr 은 프리픽스가 없는 속성도 그대로 매칭한다', () => {
    const doc = parseXml(
      `<root id="x"><w:pStyle xmlns:w="urn:w" w:val="Heading1"/></root>`,
    );
    const root = doc.documentElement;
    expect(attr(root, 'id')).toBe('x');
    const pStyle = firstNamed(root, 'pStyle')!;
    expect(attr(pStyle, 'val')).toBe('Heading1');
  });

  it('firstNamed 는 없으면 null 이다', () => {
    const root = parseXml(DOC).documentElement;
    expect(firstNamed(root, 'p')).not.toBeNull();
    expect(firstNamed(root, 'tbl')).toBeNull();
  });
});
