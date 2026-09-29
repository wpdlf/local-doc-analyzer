import { describe, it, expect } from 'vitest';
import { toPdfDocument, MAX_HEADING_CHAPTERS } from '../normalize';
import type { ExtractedDoc, ExtractedHeading } from '../types';
import type { Chapter } from '../../../types';

const base: ExtractedDoc = { units: ['가', '나'], images: [], headings: [], unitKind: 'page' };
const meta = { fileName: 'a.docx', filePath: 'C:/x/a.docx' };

describe('toPdfDocument', () => {
  it('units 를 pageTexts·pageCount·extractedText 로 옮긴다', () => {
    const doc = toPdfDocument(base, meta);
    expect(doc.pageTexts).toEqual(['가', '나']);
    expect(doc.pageCount).toBe(2);
    expect(doc.extractedText).toBe('가\n\n나');
  });

  it('unitKind 와 파일 메타를 싣는다', () => {
    const doc = toPdfDocument({ ...base, unitKind: 'slide' }, meta);
    expect(doc.unitKind).toBe('slide');
    expect(doc.fileName).toBe('a.docx');
    expect(doc.filePath).toBe('C:/x/a.docx');
    expect(doc.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('ExtractedImage.unitIndex 를 PageImage.pageIndex 로 옮긴다', () => {
    const doc = toPdfDocument(
      { ...base, images: [{ unitIndex: 1, base64: 'x', width: 0, height: 0, mimeType: 'image/png' }] },
      meta,
    );
    expect(doc.images).toEqual([
      { pageIndex: 1, imageIndex: 0, base64: 'x', width: 0, height: 0, mimeType: 'image/png' },
    ]);
  });

  it('제목이 있으면 그것으로 챕터를 만든다 (휴리스틱을 건너뛴다)', () => {
    const doc = toPdfDocument(
      {
        ...base,
        units: ['1장 본문', '2장 본문'],
        headings: [
          { level: 1, title: '1장', unitIndex: 0 },
          { level: 1, title: '2장', unitIndex: 1 },
        ],
      },
      meta,
    );
    expect(doc.chapters.map((c) => [c.title, c.startPage, c.endPage])).toEqual([
      ['1장', 1, 1],
      ['2장', 2, 2],
    ]);
    expect(doc.chapters.map((c) => c.text)).toEqual(['1장 본문', '2장 본문']);
  });

  // R14: endPage 는 소비자(labelChaptersWithPages · page-range · detectChapters)가 모두
  // **inclusive** 로 읽는다(slice(startPage-1, endPage)). 예전 값(next+1)은 다음 챕터 첫 단위와
  // 겹쳐, PPTX 에서는 슬라이드마다 두 챕터에 들어가 이중 요약됐다. 첫 제목 앞 단위(머리말)는
  // detectChapters 처럼 첫 챕터에 접는다 — 버리면 요약에서 조용히 빠진다.
  it('슬라이드마다 제목이 있으면 챕터가 겹치지 않는다 (R14)', () => {
    const doc = toPdfDocument(
      {
        ...base,
        units: ['a', 'b', 'c'],
        headings: [0, 1, 2].map((u) => ({ level: 1, title: `t${u}`, unitIndex: u })),
      },
      meta,
    );
    expect(doc.chapters.map((c) => [c.startPage, c.endPage])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(doc.chapters.map((c) => c.text)).toEqual(['a', 'b', 'c']);
  });

  it('첫 제목 앞 단위(머리말)는 첫 챕터에 접는다 (R14)', () => {
    const doc = toPdfDocument(
      {
        ...base,
        units: ['머리말', 'h1', 'h2', 'x'],
        headings: [
          { level: 1, title: 'h1', unitIndex: 1 },
          { level: 1, title: 'h2', unitIndex: 2 },
        ],
      },
      meta,
    );
    expect(doc.chapters.map((c) => [c.startPage, c.endPage])).toEqual([[1, 2], [3, 4]]);
    expect(doc.chapters[0]!.text).toBe(['머리말', 'h1'].join('\n\n'));
  });

  it('같은 단위에 제목이 둘이어도 endPage < startPage 가 되지 않는다 (R14)', () => {
    const doc = toPdfDocument(
      {
        ...base,
        units: ['a', 'b', 'c'],
        headings: [
          { level: 1, title: 'h0', unitIndex: 0 },
          { level: 1, title: 'h1a', unitIndex: 1 },
          { level: 2, title: 'h1b', unitIndex: 1 },
        ],
      },
      meta,
    );
    for (const c of doc.chapters) expect(c.endPage).toBeGreaterThanOrEqual(c.startPage);
    // QA35: 예전 값 [[1,1],[2,2],[2,3]] 은 2쪽이 두 챕터에 들어가는 겹침이었다. 이제 최상위(H1)만
    // 경계가 되고 단위를 분할한다.
    expect(doc.chapters.map((c) => [c.startPage, c.endPage])).toEqual([[1, 1], [2, 3]]);
  });

  it('제목이 없으면 detectChapters 폴백을 쓴다', () => {
    const doc = toPdfDocument({ ...base, headings: [] }, meta);
    expect(doc.chapters.length).toBeGreaterThan(0);
  });

  it('imagesSkipped·hadImages 를 설정하지 않는다 (호출자·영속화의 책임)', () => {
    const doc = toPdfDocument(base, meta);
    expect(doc.imagesSkipped).toBeUndefined();
    expect(doc.hadImages).toBeUndefined();
  });

  it('imageBudgetExceeded 는 있을 때만 싣는다', () => {
    expect(toPdfDocument(base, meta).imageBudgetExceeded).toBeUndefined();
    expect(toPdfDocument({ ...base, imageBudgetExceeded: true }, meta).imageBudgetExceeded).toBe(true);
  });

  // 컨트롤러 판정: 문서 끝의 빈 조각이 unitIndex === units.length 인 이미지를 낼 수 있다
  // (쪽나눔 + 이미지만 있고 뒤에 블록이 없는 경우). normalize 가 유일한 unitIndex→pageIndex
  // 변환 지점이므로 여기서 [0, units.length - 1] 로 클램프한다.
  it('이미지 unitIndex 가 범위를 벗어나면 클램프한다', () => {
    const doc = toPdfDocument(
      { ...base, images: [{ unitIndex: 2, base64: 'x', width: 0, height: 0, mimeType: 'image/png' }] },
      meta,
    );
    expect(doc.images).toEqual([
      { pageIndex: 1, imageIndex: 0, base64: 'x', width: 0, height: 0, mimeType: 'image/png' },
    ]);
  });

  it('헤딩 unitIndex 가 범위를 벗어나도 클램프한다', () => {
    const doc = toPdfDocument(
      { ...base, headings: [{ level: 1, title: '다장', unitIndex: 5 }] },
      meta,
    );
    expect(doc.chapters.map((c) => [c.title, c.startPage, c.endPage])).toEqual([
      ['다장', 1, 2],
    ]);
    // 첫 챕터는 머리말을 접어 1 에서 시작하므로, clamp 는 두 번째 챕터의 시작·첫 챕터의 끝에서 보인다.
    const two = toPdfDocument(
      { ...base, headings: [{ level: 1, title: '가장', unitIndex: 0 }, { level: 1, title: '다장', unitIndex: 5 }] },
      meta,
    );
    expect(two.chapters.map((c) => [c.title, c.startPage, c.endPage])).toEqual([
      ['가장', 1, 1],
      ['다장', 2, 2],
    ]);
  });
});

// QA35(High): 제목에서 만든 챕터가 폭증·중첩했다(실물 DOCX 11단위 → 32챕터, 한 단위가 6챕터에;
// 제목 달린 112장 덱 → 112챕터 = LLM 112회). 이제 단위를 **분할**한다 — 모든 단위가 정확히 한
// 챕터에, 빈틈·겹침 없이. 아래 불변식은 모든 테스트에 공통으로 건다.
function expectPartition(chapters: Chapter[], unitCount: number): void {
  expect(chapters.length).toBeGreaterThan(0);
  expect(chapters[0]!.startPage).toBe(1);
  expect(chapters[chapters.length - 1]!.endPage).toBe(unitCount);
  for (const [i, c] of chapters.entries()) {
    expect(c.endPage).toBeGreaterThanOrEqual(c.startPage);
    const next = chapters[i + 1];
    if (next) expect(next.startPage).toBe(c.endPage + 1);
  }
}

describe('toPdfDocument — 제목 챕터는 단위를 분할한다 (QA35)', () => {
  const units = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
  const h = (level: number, title: string, unitIndex: number): ExtractedHeading => ({ level, title, unitIndex });
  const chaptersOf = (ex: Partial<ExtractedDoc> & { units: string[] }) => toPdfDocument({ ...base, ...ex }, meta).chapters;

  it('한 단위에 제목이 셋이어도 챕터는 하나다 — 같은 단위의 제목은 첫 제목에 합친다', () => {
    const cs = chaptersOf({ units: ['본문'], headings: [h(1, 'A', 0), h(1, 'B', 0), h(1, 'C', 0)] });
    expect(cs.map((c) => [c.title, c.startPage, c.endPage])).toEqual([['A', 1, 1]]);
  });

  it('H1/H2 가 섞이면 최상위(H1)만 경계가 된다', () => {
    const cs = chaptersOf({
      units: units(4),
      headings: [h(1, '1장', 0), h(2, '1.1', 1), h(1, '2장', 2), h(2, '2.1', 3)],
    });
    expect(cs.map((c) => [c.title, c.startPage, c.endPage])).toEqual([['1장', 1, 2], ['2장', 3, 4]]);
    expectPartition(cs, 4);
  });

  it('최상위 수준은 문서마다 다르다 — H2 가 가장 위면 H2 가 경계다', () => {
    const cs = chaptersOf({ units: units(3), headings: [h(2, 'a', 0), h(3, 'a.1', 1), h(2, 'b', 2)] });
    expect(cs.map((c) => c.title)).toEqual(['a', 'b']);
  });

  it('연속된 같은 제목(계속 슬라이드)은 하나의 챕터로 흡수한다', () => {
    const cs = chaptersOf({
      units: units(4),
      headings: [h(1, '개요', 0), h(1, '개요', 1), h(1, ' 개요 ', 2), h(1, '결론', 3)],
    });
    expect(cs.map((c) => [c.title, c.startPage, c.endPage])).toEqual([['개요', 1, 3], ['결론', 4, 4]]);
  });

  it(`제목 달린 단위 400개 → 챕터는 ${MAX_HEADING_CHAPTERS}개 이하이고 모든 단위를 덮는다`, () => {
    const n = 400;
    const cs = chaptersOf({ units: units(n), headings: Array.from({ length: n }, (_, i) => h(1, `s${i}`, i)) });
    expect(cs.length).toBeLessThanOrEqual(MAX_HEADING_CHAPTERS);
    expect(cs.length).toBeGreaterThan(1);
    expectPartition(cs, n);
    expect(cs.map((c) => c.text).join('\n\n')).toBe(units(n).join('\n\n'));
    // 묶인 챕터의 제목은 "첫 — 끝" 이다(어느 구간인지 제목만으로 보이게).
    expect(cs[0]!.title).toBe(`s0 — s${cs[0]!.endPage - 1}`);
  });

  it(`정확히 ${MAX_HEADING_CHAPTERS}개면 묶지 않는다`, () => {
    const n = MAX_HEADING_CHAPTERS;
    const cs = chaptersOf({ units: units(n), headings: Array.from({ length: n }, (_, i) => h(1, `s${i}`, i)) });
    expect(cs).toHaveLength(n);
    expect(cs[0]!.title).toBe('s0');
  });

  it('섹션(≥2)이 있으면 제목보다 섹션이 경계다', () => {
    const cs = chaptersOf({
      units: units(5),
      headings: [0, 1, 2, 3, 4].map((u) => h(1, `slide${u}`, u)),
      sections: [{ title: '도입', unitIndex: 0 }, { title: '본론', unitIndex: 2 }],
    });
    expect(cs.map((c) => [c.title, c.startPage, c.endPage])).toEqual([['도입', 1, 2], ['본론', 3, 5]]);
  });

  it('섹션이 하나뿐이면 구획 정보가 없는 것과 같다 — 제목을 쓴다', () => {
    const cs = chaptersOf({
      units: units(2),
      headings: [h(1, 'a', 0), h(1, 'b', 1)],
      sections: [{ title: '기본 섹션', unitIndex: 0 }],
    });
    expect(cs.map((c) => c.title)).toEqual(['a', 'b']);
  });

  it('빈 섹션(같은 단위의 두 섹션)은 앞 섹션에 합쳐 빈 챕터를 만들지 않는다', () => {
    const cs = chaptersOf({
      units: units(3),
      headings: [],
      sections: [{ title: 'A', unitIndex: 0 }, { title: '빈', unitIndex: 1 }, { title: 'B', unitIndex: 1 }],
    });
    expect(cs.map((c) => [c.title, c.startPage, c.endPage])).toEqual([['A', 1, 1], ['빈', 2, 3]]);
  });

  it('제목이 모두 빈 문자열이면 detectChapters 폴백을 쓴다', () => {
    const cs = chaptersOf({ units: ['제1장 서론', '본문'], headings: [h(1, '  ', 1)] });
    expect(cs.map((c) => c.title)).toEqual(['제1장 서론']);
  });

  it('분할 불변식 — 무작위 제목 배치(수준·단위·반복 제목) 500 회', () => {
    // 결정적 PRNG(mulberry32) — 실패가 재현 가능해야 한다.
    let seed = 0x35;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(rand() * n);
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + int(trial % 5 === 0 ? 300 : 20);
      const count = int(n * 3);
      const headings: ExtractedHeading[] = [];
      let u = 0;
      for (let k = 0; k < count; k++) {
        // 대체로 문서 순서지만 가끔 범위 밖(clamp)·역행 단위도 섞는다.
        u = rand() < 0.05 ? int(n + 3) - 1 : Math.min(n - 1, u + int(3));
        headings.push(h(1 + int(3), `t${int(6)}`, u));
      }
      const sections = rand() < 0.2
        ? Array.from({ length: int(5) }, () => ({ title: `S${int(4)}`, unitIndex: int(n + 1) })).sort((a, b) => a.unitIndex - b.unitIndex)
        : undefined;
      const cs = chaptersOf({ units: units(n), headings, sections });
      expectPartition(cs, n);
      if (headings.length > 0 || (sections?.length ?? 0) >= 2) expect(cs.length).toBeLessThanOrEqual(MAX_HEADING_CHAPTERS);
      // 모든 단위가 정확히 한 번 — 텍스트를 이으면 원문과 같다.
      expect(cs.map((c) => c.text).join('\n\n')).toBe(units(n).join('\n\n'));
    }
  });
});
