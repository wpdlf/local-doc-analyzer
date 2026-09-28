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

  it('walk 는 자기 자신을 첫 항목으로 포함하고, 문서 순서대로(깊이 우선) 훑는다', () => {
    const root = parseXml(DOC).documentElement;
    const nodes = [...walk(root)];
    // yield el 이 빠지거나 순서가 밀리면 여기서 잡힌다 — 멤버십이 아니라 자리(첫 항목)와
    // 정체성(root 그 자체인지)을 본다.
    expect(nodes[0]).toBe(root);
    // 중첩 구조 전체에 걸친 문서 순서: body → p → r → t → p → r → t → t
    expect(nodes.map(localName)).toEqual(['body', 'p', 'r', 't', 'p', 'r', 't', 't']);
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

  it('firstNamed 는 자기 자신은 후보에서 뺀다', () => {
    const root = parseXml(DOC).documentElement;
    const p = childrenNamed(root, 'p')[0]!;
    // p 자신의 로컬명이 'p' 이지만, 자손 중에는 'p' 가 없으므로 null 이어야 한다.
    // e !== el 가드가 빠지면 p 자신이 잡혀 이 테스트가 깨진다.
    expect(firstNamed(p, 'p')).toBeNull();
  });

  it('walk 는 깊은 중첩에서도 스택을 넘기지 않는다 (재귀 yield* 는 깊이만큼 쌓인다)', () => {
    // happy-dom 의 파서 자체가 수천 단계에서 먼저 넘치므로 DOM 대신 children 만 가진 가짜
    // 트리로 walk 만 격리해 본다 — walk 가 쓰는 것은 el.children 하나뿐이다. 재귀 yield*
    // 구현은 여기서 RangeError 가 나고, 얕은 깊이에서도 원소당 O(깊이) 재개 비용이 들었다.
    const DEPTH = 100_000;
    type Fake = { children: Fake[] };
    const root: Fake = { children: [] };
    let cur = root;
    for (let i = 1; i < DEPTH; i++) {
      const next: Fake = { children: [] };
      cur.children.push(next);
      cur = next;
    }
    let n = 0;
    for (const _ of walk(root as unknown as Element)) n++;
    expect(n).toBe(DEPTH);
  });

  it('walk 의 skip 은 그 요소와 서브트리를 통째로 뺀다 (형제는 계속 훑는다)', () => {
    const root = parseXml(
      `<r xmlns:mc="urn:mc"><a><x/></a><mc:Fallback><a/></mc:Fallback><b/></r>`,
    ).documentElement;
    const names = [...walk(root, (e) => localName(e) === 'Fallback')].map(localName);
    expect(names).toEqual(['r', 'a', 'x', 'b']);
  });

  it('walk 의 skip 은 루트 자신에게도 적용된다', () => {
    const root = parseXml(`<r><a/></r>`).documentElement;
    expect([...walk(root, () => true)]).toEqual([]);
  });

  it('attr 은 서로 다른 프리픽스가 같은 로컬명을 가지면 속성 순서상 먼저 나오는 쪽을 준다', () => {
    const root = parseXml(
      `<el xmlns:w="urn:w" xmlns:a="urn:a" w:val="1" a:val="2"/>`,
    ).documentElement;
    expect(attr(root, 'val')).toBe('1');
  });
});
