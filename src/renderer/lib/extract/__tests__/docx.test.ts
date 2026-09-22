// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { docxExtractor } from '../docx';

const W = 'xmlns:w="urn:w" xmlns:a="urn:a" xmlns:r="urn:r"';

function doc(body: string): string {
  return `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
}

function para(text: string, opts: { breakBefore?: boolean; style?: string } = {}): string {
  const pPr = `<w:pPr>${opts.breakBefore ? '<w:pageBreakBefore/>' : ''}${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}</w:pPr>`;
  return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function zipOf(files: Record<string, string | Uint8Array>) {
  const input: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) input[k] = typeof v === 'string' ? strToU8(v) : v;
  const out = zipSync(input);
  return openZip(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
}

// 1x1 PNG
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe('docxExtractor.sniff', () => {
  it('word/document.xml 이 있으면 참이다', () => {
    expect(docxExtractor.sniff(zipOf({ 'word/document.xml': doc('') }))).toBe(true);
  });

  it('없으면 거짓이다 — 확장자를 믿지 않는다', () => {
    expect(docxExtractor.sniff(zipOf({ 'ppt/presentation.xml': '<x/>' }))).toBe(false);
  });
});

describe('docxExtractor.extract', () => {
  it('문단을 순서대로 담고 unitKind 는 page 다', async () => {
    const zip = zipOf({ 'word/document.xml': doc(para('첫째') + para('둘째')) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.unitKind).toBe('page');
    expect(ex.units).toEqual(['첫째\n\n둘째']);
  });

  it('pageBreakBefore 에서 단위를 나눈다', async () => {
    const zip = zipOf({
      'word/document.xml': doc(para('표지') + para('본문', { breakBefore: true })),
    });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['표지', '본문']);
  });

  it('w:br type=page 는 쪽나눠지만 textWrapping 은 줄바꿈이다', async () => {
    const body =
      `<w:p><w:r><w:t>앞</w:t><w:br w:type="textWrapping"/><w:t>같은쪽</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>전</w:t><w:br w:type="page"/><w:t>후</w:t></w:r></w:p>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['앞\n같은쪽\n\n전', '후']);
  });

  it('표를 GFM 으로 직렬화한다', async () => {
    const body =
      `<w:tbl>` +
      `<w:tr><w:tc>${para('대분류')}</w:tc><w:tc>${para('달성률')}</w:tc></w:tr>` +
      `<w:tr><w:tc>${para('신규')}</w:tc><w:tc>${para('100%')}</w:tc></w:tr>` +
      `</w:tbl>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units[0]).toBe('| 대분류 | 달성률 |\n| --- | --- |\n| 신규 | 100% |');
  });

  it('Heading 스타일을 제목으로 잡는다 (한국어 스타일명도)', async () => {
    const body = para('1장', { style: 'Heading1' }) + para('본문') + para('가', { style: '제목 2' });
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.headings).toEqual([
      { level: 1, title: '1장', unitIndex: 0 },
      { level: 2, title: '가', unitIndex: 0 },
    ]);
  });

  it('그림을 rels 로 따라가 속한 단위에 매핑한다', async () => {
    const body =
      para('앞') +
      `<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>` +
      para('뒤', { breakBefore: true });
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.unitIndex).toBe(0);
    expect(ex.images[0]!.mimeType).toBe('image/png');
    expect(ex.images[0]!.base64.length).toBeGreaterThan(0);
  });

  it('extractImages:false 면 그림을 수집하지 않는다', async () => {
    // 그림 문단 앞에 텍스트를 둔다 — 그림만 있는 문단은 빈 블록이라 paginate 가 버리고,
    // units 가 비어 DOC_NO_TEXT 가 먼저 발화한다(아래 별도 테스트로 고정). 실제 DOCX 도
    // 그림 옆에 본문이 있다.
    const zip = zipOf({
      'word/document.xml': doc(
        para('앞') + `<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>`,
      ),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.images).toEqual([]);
  });

  it('텍스트가 없고 그림만 있으면 DOC_NO_TEXT 다', async () => {
    // 의도된 동작이다. 텍스트가 0 이면 인용 [p.N] 이 가리킬 자리도, RAG 가 색인할 것도,
    // 요약이 근거로 삼을 것도 없다. PDF 의 PDF_NO_TEXT 와 같은 판단이며, PDF 에 있는 OCR
    // 폴백은 DOCX 에 없다(P1 범위 밖). 사용자는 "텍스트가 없다"는 명확한 안내를 받는다.
    const zip = zipOf({
      'word/document.xml': doc(`<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>`),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    await expect(docxExtractor.extract(zip, {})).rejects.toThrowError(
      expect.objectContaining({ code: 'DOC_NO_TEXT' }),
    );
  });

  it('document.xml 이 없으면 DOC_CORRUPT 다', async () => {
    const zip = zipOf({ 'word/styles.xml': '<x/>' });
    await expect(docxExtractor.extract(zip, {})).rejects.toThrowError(
      expect.objectContaining({ code: 'DOC_CORRUPT' }),
    );
  });

  it('본문에 텍스트가 없으면 DOC_NO_TEXT 다', async () => {
    const zip = zipOf({ 'word/document.xml': doc('') });
    await expect(docxExtractor.extract(zip, {})).rejects.toThrowError(
      expect.objectContaining({ code: 'DOC_NO_TEXT' }),
    );
  });

  it('signal 이 이미 abort 면 ABORTED 로 조기 종료한다', async () => {
    const zip = zipOf({ 'word/document.xml': doc(para('x')) });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(docxExtractor.extract(zip, { signal: ctrl.signal })).rejects.toThrowError(
      expect.objectContaining({ code: 'ABORTED' }),
    );
  });
});
