import { describe, it, expect } from 'vitest';
import { toPdfDocument } from '../normalize';
import type { ExtractedDoc } from '../types';

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
      ['1장', 1, 2],
      ['2장', 2, 3],
    ]);
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
      ['다장', 2, 3],
    ]);
  });
});
