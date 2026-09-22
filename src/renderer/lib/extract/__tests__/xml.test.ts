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

  // happy-dom(정확 핀 20.10.6) 의 XML 파싱은 Element 쪽 네임스페이스 분리는 맞다
  // (위 'parseXml 은 루트를 준다' 에서 localName(root) === 'body' 로 확인됨 — 프리픽스 w: 가
  // 잘 벗겨진다). 하지만 **Attr 쪽은 벗기지 않는다** — 실측: xmlns:w="urn:w" 선언 하에서
  // w:pageBreakBefore 속성의 a.localName 이 'pageBreakBefore' 가 아니라 프리픽스가 붙은
  // 'w:pageBreakBefore' 그대로 나오고, a.namespaceURI 도 null, el.getAttributeNS('urn:w',
  // 'pageBreakBefore') 도 null 이다(스펙/Chromium 이라면 각각 'pageBreakBefore' · 'urn:w' 여야
  // 한다). attr() 구현은 스펙대로(localName 우선, 없을 때만 콜론 스트립)라 실제 Electron
  // 렌더러(Chromium)에서는 정상 동작하지만, attr.localName 이 이미 "값이 있는(틀린) 문자열"을
  // 주는 바람에 `||` 폴백이 걸리지 않아 이 환경에서는 매칭이 안 된다. 프로덕션 코드를
  // happy-dom 에 맞춰 우회하지 않기로 했으므로(그러면 실제로는 불필요한 이중 매칭 로직이
  // 들어간다), 이 한 가지 케이스 — "프리픽스 붙은 속성이 실제로 로컬명으로 매칭되는가" —
  // 는 이 테스트 스위트로 검증 불가. 아래는 그 사실을 기록해두는 스킵 테스트다.
  it.skip('attr 은 프리픽스가 붙은 속성도 로컬명으로 매칭한다 — happy-dom 20.10.6 의 Attr.localName 이 프리픽스를 벗기지 않아 이 환경에서는 미검증(Chromium 실동작과 별개)', () => {
    const root = parseXml(DOC).documentElement;
    const first = childrenNamed(root, 'p')[0]!;
    expect(attr(first, 'pageBreakBefore')).toBe('1');
  });

  it('firstNamed 는 없으면 null 이다', () => {
    const root = parseXml(DOC).documentElement;
    expect(firstNamed(root, 'p')).not.toBeNull();
    expect(firstNamed(root, 'tbl')).toBeNull();
  });
});
