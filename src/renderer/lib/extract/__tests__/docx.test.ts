// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { docxExtractor, MAX_TABLE_COLUMNS } from '../docx';

const W =
  'xmlns:w="urn:w" xmlns:a="urn:a" xmlns:r="urn:r" xmlns:mc="urn:mc" xmlns:wps="urn:wps" ' +
  'xmlns:v="urn:v" xmlns:w14="urn:w14"';

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
// 위 PNG 바이트를 base64 로 직접 인코딩한 값 — toBase64 가 상수를 반환하는 뮤테이션을 잡는다.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

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
    expect(ex.images[0]!.base64).toBe(PNG_BASE64);
  });

  it('문단 끝 쪽나눔(Ctrl+Enter)에서도 단위가 갈린다', async () => {
    const body = `<w:p><w:r><w:t>본문</w:t><w:br w:type="page"/></w:r></w:p>` + para('다음');
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['본문', '다음']);
  });

  it('표 셀 안 그림도 수집해 표 블록에 매핑한다', async () => {
    const body =
      `<w:tbl><w:tr><w:tc>${para('설명')}</w:tc>` +
      `<w:tc><w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.unitIndex).toBe(0);
  });

  it('문단 중간 쪽나눔 뒤의 그림은 다음 단위로 매핑된다', async () => {
    const body =
      para('앞') +
      `<w:p><w:r><w:t>전</w:t><w:br w:type="page"/><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>` +
      para('후');
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.units).toEqual(['앞\n\n전', '후']);
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.unitIndex).toBe(1);
  });

  it('제목과 그림이 0 이 아닌 단위에 있으면 그 단위 인덱스를 정확히 반영한다', async () => {
    const body =
      para('앞') +
      para('제목', { breakBefore: true, style: 'Heading1' }) +
      `<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>`;
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.units).toEqual(['앞', '제목']);
    expect(ex.headings).toEqual([{ level: 1, title: '제목', unitIndex: 1 }]);
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.unitIndex).toBe(1);
  });

  it('JPEG 확장자 그림도 image/jpeg 로 수집한다', async () => {
    // 바이트 내용은 실제 JPEG 가 아니어도 된다 — mimeOf 는 확장자만 보고, 추출기는
    // 이미지를 디코드하지 않는다(Vision 호출부가 바이트를 그대로 넘긴다).
    const body = para('앞') + `<w:p><w:r><w:drawing><a:blip r:embed="rId7"/></w:drawing></w:r></w:p>`;
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId7" Type="urn:x/image" Target="media/image2.jpg"/></Relationships>`,
      'word/media/image2.jpg': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.mimeType).toBe('image/jpeg');
  });

  it('같은 그림을 서로 다른 rId 로 두 번 참조해도 한 번만 담는다', async () => {
    const body =
      `<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>` +
      para('가운데') +
      `<w:p><w:r><w:drawing><a:blip r:embed="rId7"/></w:drawing></w:r></w:p>`;
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel">` +
        `<Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/>` +
        `<Relationship Id="rId7" Type="urn:x/image" Target="media/image1.png"/>` +
        `</Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.images).toHaveLength(1);
  });

  it('w:sdt(구조적 콘텐츠 컨트롤) 안의 문단도 추출한다 — Word 가 생성 목차를 이렇게 감싼다', async () => {
    const body = `<w:sdt><w:sdtContent>${para('본문')}</w:sdtContent></w:sdt>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['본문']);
  });

  it('w:sdt 안의 표도 추출한다', async () => {
    const body =
      `<w:sdt><w:sdtContent><w:tbl>` +
      `<w:tr><w:tc>${para('가')}</w:tc><w:tc>${para('나')}</w:tc></w:tr>` +
      `</w:tbl></w:sdtContent></w:sdt>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units[0]).toBe('| 가 | 나 |\n| --- | --- |');
  });

  it('본문 전체가 sdt 하나뿐이어도 텍스트를 추출한다 (DOC_NO_TEXT 로 오판하지 않는다)', async () => {
    const body = `<w:sdt><w:sdtContent>${para('첫째')}${para('둘째')}</w:sdtContent></w:sdt>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['첫째\n\n둘째']);
  });

  it('표 셀 안 문단이 w:sdt 로 감싸여 있어도 추출한다 (업무 서식이 흔히 이 형태다)', async () => {
    const body =
      `<w:tbl><w:tr><w:tc><w:sdt><w:sdtContent>${para('내용')}</w:sdtContent></w:sdt></w:tc>` +
      `<w:tc>${para('둘째칸')}</w:tc></w:tr></w:tbl>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units[0]).toBe('| 내용 | 둘째칸 |\n| --- | --- |');
  });

  it('한 셀 안에 sdt 로 감싼 문단과 감싸지 않은 문단이 섞여도 순서대로 합친다', async () => {
    const body =
      `<w:tbl><w:tr><w:tc>${para('위')}<w:sdt><w:sdtContent>${para('아래')}</w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    // GFM 셀 직렬화(cell())가 줄바꿈을 공백으로 접는다 — "위 아래" 순서가 뒤집히면(예: sdt
    // 파싱이 먼저 온 감싸지 않은 문단을 건너뛰거나 순서를 바꾸면) 이 값이 어긋난다.
    expect(ex.units[0]).toBe('| 위 아래 |\n| --- |');
  });

  it('단위 수가 상한을 넘으면 PDF_TOO_MANY_PAGES 다', async () => {
    const paragraphs = Array.from({ length: 501 }, (_, i) => para(`p${i}`, { breakBefore: i > 0 }));
    const zip = zipOf({ 'word/document.xml': doc(paragraphs.join('')) });
    await expect(docxExtractor.extract(zip, { extractImages: false })).rejects.toThrowError(
      expect.objectContaining({ code: 'PDF_TOO_MANY_PAGES' }),
    );
  });

  it('pageBreakBefore 의 val=false/off 는 쪽나눔이 아니다 (ST_OnOff)', async () => {
    const body =
      `<w:p><w:pPr><w:pageBreakBefore w:val="false"/></w:pPr><w:r><w:t>가</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pageBreakBefore w:val="off"/></w:pPr><w:r><w:t>나</w:t></w:r></w:p>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['가\n\n나']);
  });

  it('추출 도중 abort 되면 ABORTED 로 즉시 멈춘다', async () => {
    const zip = zipOf({ 'word/document.xml': doc(para('첫째') + para('둘째')) });
    let calls = 0;
    // 진입 전 가드(1회차)는 통과시키고, 본문 순회 루프 안의 가드(2회차)에서 abort 로 만든다 —
    // "pre-entry 만 테스트됨" 뮤테이션을 잡는다.
    const signal = {
      get aborted() {
        calls += 1;
        return calls > 1;
      },
    } as unknown as AbortSignal;
    await expect(docxExtractor.extract(zip, { signal })).rejects.toThrowError(
      expect.objectContaining({ code: 'ABORTED' }),
    );
    expect(calls).toBeGreaterThan(1);
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

// ─── QA34: 실물 DOCX 에서 확인된 누락·중복 ───

describe('docxExtractor — 큰 문서의 중단·진행률', () => {
  const bigDoc = () =>
    zipOf({ 'word/document.xml': doc(Array.from({ length: 2000 }, (_, i) => para(`p${i}`)).join('')) });

  it('다른 작업(타이머)이 건 abort 를 추출 도중에 관측해 ABORTED 로 멈춘다', async () => {
    // 추출이 이벤트 루프에 한 번도 양보하지 않으면 타이머 콜백은 추출이 끝난 **뒤에야** 돈다 —
    // 그러면 루프 안 throwIfAborted 는 사용자의 취소를 영영 볼 수 없는 죽은 코드다.
    const zip = bigDoc();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 0);
    await expect(docxExtractor.extract(zip, { signal: ctrl.signal, extractImages: false })).rejects.toThrowError(
      expect.objectContaining({ code: 'ABORTED' }),
    );
  });

  it('onProgress 를 단조 증가로 부르고 마지막에 total 에 닿는다', async () => {
    const calls: [number, number][] = [];
    await docxExtractor.extract(bigDoc(), { extractImages: false, onProgress: (c, t) => calls.push([c, t]) });
    expect(calls.length).toBeGreaterThan(1);
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBeGreaterThanOrEqual(calls[i - 1]![0]);
    const last = calls[calls.length - 1]!;
    expect(last[0]).toBe(last[1]);
    expect(last[1]).toBe(2000);
  });
});

/** PNG 와 다른 바이트 — 어느 그림이 담겼는지 base64 로 가린다. */
const PNG_B = new Uint8Array([...PNG, 0x00]);

function styles(inner: string): string {
  return `<?xml version="1.0"?><w:styles ${W}>${inner}</w:styles>`;
}

function pStyle(id: string, inner: string): string {
  return `<w:style w:type="paragraph" w:styleId="${id}">${inner}</w:style>`;
}

async function unitsOf(body: string, extra: Record<string, string> = {}) {
  const zip = zipOf({ 'word/document.xml': doc(body), ...extra });
  return docxExtractor.extract(zip, { extractImages: false });
}

describe('docxExtractor — 제목 스타일 해석 (styles.xml)', () => {
  it('한국어 Word 의 숫자 styleId 를 w:name "heading N" 으로 해석한다', async () => {
    const ex = await unitsOf(para('1장', { style: '1' }) + para('본문') + para('가', { style: '2' }), {
      'word/styles.xml': styles(
        pStyle('1', '<w:name w:val="heading 1"/>') + pStyle('2', '<w:name w:val="Heading 2"/>'),
      ),
    });
    expect(ex.headings).toEqual([
      { level: 1, title: '1장', unitIndex: 0 },
      { level: 2, title: '가', unitIndex: 0 },
    ]);
  });

  it('이름이 제목이 아니어도 스타일의 outlineLvl(0-based)로 수준을 잡는다', async () => {
    const ex = await unitsOf(para('절', { style: 'a3' }), {
      'word/styles.xml': styles(pStyle('a3', '<w:name w:val="내 절"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>')),
    });
    expect(ex.headings).toEqual([{ level: 2, title: '절', unitIndex: 0 }]);
  });

  it('basedOn 체인을 따라 상속된 제목 수준을 찾는다', async () => {
    const ex = await unitsOf(para('파생', { style: 'Mine' }), {
      'word/styles.xml': styles(
        pStyle('1', '<w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>') +
          pStyle('Mine', '<w:name w:val="내 제목"/><w:basedOn w:val="1"/>'),
      ),
    });
    expect(ex.headings).toEqual([{ level: 1, title: '파생', unitIndex: 0 }]);
  });

  it('basedOn 순환이 있어도 멈추고 제목으로 보지 않는다', async () => {
    const ex = await unitsOf(para('본문', { style: 'x' }), {
      'word/styles.xml': styles(
        pStyle('x', '<w:name w:val="X"/><w:basedOn w:val="y"/>') +
          pStyle('y', '<w:name w:val="Y"/><w:basedOn w:val="x"/>'),
      ),
    });
    expect(ex.units).toEqual(['본문']);
    expect(ex.headings).toEqual([]);
  });

  it('문단의 직접 outlineLvl 도 제목이다 (스타일 없이)', async () => {
    const body = `<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>직접</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.headings).toEqual([{ level: 1, title: '직접', unitIndex: 0 }]);
  });

  it('outlineLvl 9(본문 수준)는 제목이 아니다 — 제목 스타일을 문단이 직접 끌 수 있다', async () => {
    const body = `<w:p><w:pPr><w:pStyle w:val="1"/><w:outlineLvl w:val="9"/></w:pPr><w:r><w:t>본문</w:t></w:r></w:p>`;
    const ex = await unitsOf(body, {
      'word/styles.xml': styles(pStyle('1', '<w:name w:val="heading 1"/>')),
    });
    expect(ex.headings).toEqual([]);
  });

  it('styles.xml 이 손상돼 있어도 문서는 열린다 (선택 파트)', async () => {
    const ex = await unitsOf(para('제목', { style: 'Heading1' }), { 'word/styles.xml': '<w:styles' });
    expect(ex.units).toEqual(['제목']);
    // 스타일 표가 없으면 기존 스타일 ID 정규식이 폴백으로 남는다.
    expect(ex.headings).toEqual([{ level: 1, title: '제목', unitIndex: 0 }]);
  });

  it('스타일이 상속한 pageBreakBefore 로 쪽을 나눈다 (ST_OnOff 거짓 값은 무시)', async () => {
    const ex = await unitsOf(
      para('표지') + para('장', { style: 'Chap' }) + para('끝', { style: 'NoBreak' }),
      {
        'word/styles.xml': styles(
          pStyle('Base', '<w:pPr><w:pageBreakBefore/></w:pPr>') +
            pStyle('Chap', '<w:basedOn w:val="Base"/>') +
            pStyle('NoBreak', '<w:basedOn w:val="Base"/><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr>'),
        ),
      },
    );
    expect(ex.units).toEqual(['표지', '장\n\n끝']);
  });

  it('문단의 직접 pageBreakBefore=false 가 스타일의 쪽나눔을 이긴다', async () => {
    const body =
      para('앞') +
      `<w:p><w:pPr><w:pStyle w:val="Chap"/><w:pageBreakBefore w:val="false"/></w:pPr><w:r><w:t>뒤</w:t></w:r></w:p>`;
    const ex = await unitsOf(body, {
      'word/styles.xml': styles(pStyle('Chap', '<w:pPr><w:pageBreakBefore/></w:pPr>')),
    });
    expect(ex.units).toEqual(['앞\n\n뒤']);
  });
});

describe('docxExtractor — 문단 자신의 pPr 만 본다', () => {
  const textBox = (inner: string) =>
    `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;

  it('mc:Fallback 을 건너뛰어 글상자 텍스트를 한 번만, 본문과 떨어진 블록으로 담는다', async () => {
    const body = `<w:p><w:r><w:t>앞</w:t></w:r>${textBox(para('상자'))}<w:r><w:t>뒤</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['앞뒤\n\n상자']);
  });

  it('글상자 안의 제목 스타일이 바깥 문단을 제목으로 만들지 않는다', async () => {
    const body = `<w:p><w:r><w:t>본문</w:t></w:r>${textBox(para('상자제목', { style: 'Heading1' }))}</w:p>`;
    const ex = await unitsOf(body);
    expect(ex.headings).toEqual([]);
  });

  it('글상자 안의 pageBreakBefore 가 바깥 문단의 쪽을 나누지 않는다', async () => {
    const body = para('앞') + `<w:p><w:r><w:t>본문</w:t></w:r>${textBox(para('상자', { breakBefore: true }))}</w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['앞\n\n본문\n\n상자']);
  });

  it('mc:Fallback 안의 그림은 수집하지 않는다', async () => {
    const body =
      para('앞') +
      `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:blip r:embed="rId6"/></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><a:blip r:embed="rId7"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel">` +
        `<Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/>` +
        `<Relationship Id="rId7" Type="urn:x/image" Target="media/image2.png"/>` +
        `</Relationships>`,
      'word/media/image1.png': PNG,
      'word/media/image2.png': PNG_B,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.base64).toBe(PNG_BASE64);
  });
});

describe('docxExtractor — 런 안의 특수 요소', () => {
  it('cr·noBreakHyphen·softHyphen·ptab 을 텍스트로 옮긴다', async () => {
    const body =
      `<w:p><w:r><w:t>a</w:t><w:cr/><w:t>b</w:t><w:noBreakHyphen/><w:t>c</w:t><w:softHyphen/>` +
      `<w:t>d</w:t><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/><w:t>e</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['a\nb-cd\te']);
  });

  it('w:sym 의 알려진 체크박스·글머리 코드만 옮기고 모르는 것은 뺀다', async () => {
    const sym = (font: string, ch: string) => `<w:sym w:font="${font}" w:char="${ch}"/>`;
    const body =
      `<w:p><w:r>${sym('Wingdings', 'F0FE')}<w:t>완료</w:t>${sym('Wingdings', 'F0A8')}<w:t>미완</w:t>` +
      `${sym('Wingdings', 'F0FD')}<w:t>취소</w:t>${sym('Symbol', 'F0B7')}<w:t>항목</w:t>` +
      `${sym('Wingdings', '00FE')}<w:t>접두없음</w:t>${sym('Webdings', 'F0FE')}<w:t>모름</w:t>` +
      `${sym('Symbol', 'F041')}</w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['☑완료☐미완☒취소•항목☑접두없음모름']);
  });

  it('w14:checkbox 콘텐츠 컨트롤은 sdtContent 의 글리프로 한 번만 담긴다', async () => {
    const body =
      `<w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr>` +
      `<w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t> 동의</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['☒ 동의']);
  });

  it('w:moveFrom(옮겨진 원래 자리)은 빼고 w:moveTo 만 담는다', async () => {
    const body =
      `<w:p><w:moveFrom><w:r><w:t>옛자리</w:t></w:r></w:moveFrom><w:r><w:t>본문</w:t></w:r>` +
      `<w:moveTo><w:r><w:t>새자리</w:t></w:r></w:moveTo></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['본문새자리']);
  });

  it('숨김 텍스트(w:vanish)는 빼고, vanish=false 와 specVanish 는 담는다', async () => {
    const body =
      `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>숨김</w:t></w:r>` +
      `<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>보임</w:t></w:r>` +
      `<w:r><w:rPr><w:specVanish/></w:rPr><w:t>특수</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['보임특수']);
  });
});

describe('docxExtractor — 구역 나눔과 제목 조각', () => {
  it('pPr/sectPr(유형 없음=nextPage)이 끝낸 구역 뒤에서 단위를 나눈다', async () => {
    const body =
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr><w:r><w:t>1구역</w:t></w:r></w:p>` +
      para('2구역');
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['1구역', '2구역']);
  });

  it('continuous 구역 나눔은 단위를 나누지 않는다', async () => {
    const body =
      `<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr><w:r><w:t>가</w:t></w:r></w:p>` +
      para('나');
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['가\n\n나']);
  });

  it('구역 나눔 뒤가 표여도 표 앞에서 나눈다', async () => {
    const body =
      `<w:p><w:pPr><w:sectPr><w:type w:val="oddPage"/></w:sectPr></w:pPr><w:r><w:t>앞</w:t></w:r></w:p>` +
      `<w:tbl><w:tr><w:tc>${para('셀')}</w:tc></w:tr></w:tbl>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['앞', '| 셀 |\n| --- |']);
  });

  it('쪽나눔으로 시작하는 제목 문단도 제목을 잃지 않는다 (첫 비지 않은 조각에 붙인다)', async () => {
    const body =
      para('앞') +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:br w:type="page"/><w:t>제목</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['앞', '제목']);
    expect(ex.headings).toEqual([{ level: 1, title: '제목', unitIndex: 1 }]);
  });

  it('제목 문단 중간의 쪽나눔이 챕터를 둘로 만들지 않는다', async () => {
    const body =
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>상</w:t><w:br w:type="page"/><w:t>하</w:t></w:r></w:p>`;
    const ex = await unitsOf(body);
    expect(ex.units).toEqual(['상', '하']);
    expect(ex.headings).toEqual([{ level: 1, title: '상', unitIndex: 0 }]);
  });
});

describe('docxExtractor — 표 격자 배치', () => {
  const tbl = (rows: string) => `<w:tbl>${rows}</w:tbl>`;
  const tr = (cells: string, trPr = '') => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`;
  const tc = (text: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${para(text)}</w:tc>`;

  it('gridSpan 셀은 첫 칸에 텍스트, 나머지 칸은 비워 열을 맞춘다', async () => {
    const ex = await unitsOf(
      tbl(tr(tc('A', '<w:gridSpan w:val="2"/>') + tc('C')) + tr(tc('a') + tc('b') + tc('c'))),
    );
    expect(ex.units[0]).toBe('| A |  | C |\n| --- | --- | --- |\n| a | b | c |');
  });

  it('vMerge 연속 셀은 위 셀의 텍스트를 같은 열에 복사한다', async () => {
    const ex = await unitsOf(
      tbl(
        tr(tc('X', '<w:vMerge w:val="restart"/>') + tc('y')) +
          tr(tc('', '<w:vMerge/>') + tc('z')) +
          tr(tc('', '<w:vMerge w:val="continue"/>') + tc('w')),
      ),
    );
    expect(ex.units[0]).toBe('| X | y |\n| --- | --- |\n| X | z |\n| X | w |');
  });

  it('gridSpan 뒤의 vMerge 연속 셀은 격자 열 기준으로 위 셀을 찾는다', async () => {
    // 행 2 의 두 번째 tc 는 **셀 순번 1** 이지만 격자 열 2 에 놓인다 — 셀 순번으로 찾으면 'B' 를 복사한다.
    const ex = await unitsOf(
      tbl(
        tr(tc('A') + tc('B') + tc('C', '<w:vMerge w:val="restart"/>')) +
          tr(tc('ab', '<w:gridSpan w:val="2"/>') + tc('', '<w:vMerge/>')),
      ),
    );
    expect(ex.units[0]).toBe('| A | B | C |\n| --- | --- | --- |\n| ab |  | C |');
  });

  it('gridBefore/gridAfter 는 앞뒤에 빈 칸을 둔다', async () => {
    const ex = await unitsOf(
      tbl(
        tr(tc('a') + tc('b') + tc('c')) +
          tr(tc('b2'), '<w:gridBefore w:val="1"/><w:gridAfter w:val="1"/>'),
      ),
    );
    expect(ex.units[0]).toBe('| a | b | c |\n| --- | --- | --- |\n|  | b2 |  |');
  });

  it('비정상적으로 큰 gridSpan 은 상한에서 자른다 (배열 폭주 방지)', async () => {
    const ex = await unitsOf(tbl(tr(tc('A', '<w:gridSpan w:val="1000000000"/>'))));
    const header = ex.units[0]!.split('\n')[0]!;
    expect(header.startsWith('| A |')).toBe(true);
    expect(header.split('|').length - 2).toBeLessThanOrEqual(MAX_TABLE_COLUMNS);
  });

  it('w:sdt·w:customXml 로 감싼 행과 셀도 담는다', async () => {
    const ex = await unitsOf(
      tbl(
        `<w:sdt><w:sdtContent>${tr(tc('행sdt') + tc('b'))}</w:sdtContent></w:sdt>` +
          `<w:customXml w:element="row">${tr(`<w:sdt><w:sdtContent>${tc('셀sdt')}</w:sdtContent></w:sdt>` + `<w:customXml w:element="c">${tc('셀cx')}</w:customXml>`)}</w:customXml>`,
      ),
    );
    expect(ex.units[0]).toBe('| 행sdt | b |\n| --- | --- |\n| 셀sdt | 셀cx |');
  });

  it('본문 수준 w:customXml 블록의 문단도 담는다', async () => {
    const ex = await unitsOf(`<w:customXml w:element="sec"><w:customXmlPr/>${para('안')}</w:customXml>` + para('밖'));
    expect(ex.units).toEqual(['안\n\n밖']);
  });

  it('셀 안의 중첩 표를 셀 텍스트로 평탄화한다 (행은 "; ", 칸은 " / ")', async () => {
    const inner = tbl(tr(tc('a') + tc('b')) + tr(tc('c') + tc('d')));
    const ex = await unitsOf(tbl(tr(`<w:tc>${para('위')}${inner}</w:tc>` + tc('x'))));
    expect(ex.units[0]).toBe('| 위 a / b; c / d | x |\n| --- | --- |');
  });
});
