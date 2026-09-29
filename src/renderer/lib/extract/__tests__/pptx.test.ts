// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { createPptxExtractor, readSlideRelIds } from '../pptx';
import { createImageFitter, type ImageCodec } from '../image-fit';
import type { ZipIndex } from '../types';

const NS = 'xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r" xmlns:mc="urn:mc"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function zipOf(files: Record<string, string | Uint8Array>): ZipIndex {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? strToU8(v) : v;
  const u8 = zipSync(entries);
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}

/** 슬라이드 파일 이름 배열(표시 순서) → presentation.xml + rels. rId 는 순서와 무관하게 거꾸로 준다. */
function deck(slides: Record<string, string>, order: string[], extra: Record<string, string | Uint8Array> = {}) {
  const ids = order.map((_, i) => `rId${100 - i}`);
  const pres = `<p:presentation ${NS}><p:sldIdLst>${order.map((_, i) => `<p:sldId id="${256 + i}" r:id="${ids[i]}"/>`).join('')}</p:sldIdLst>`
    + `<p:extLst><p:ext><p14:sectionLst xmlns:p14="urn:p14"><p14:section><p14:sldIdLst><p14:sldId id="999"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>`;
  const rels = `<Relationships ${REL}>${order.map((f, i) => `<Relationship Id="${ids[i]}" Type="x/slide" Target="slides/${f}"/>`).join('')}</Relationships>`;
  const files: Record<string, string | Uint8Array> = { 'ppt/presentation.xml': pres, 'ppt/_rels/presentation.xml.rels': rels, ...extra };
  for (const [f, xml] of Object.entries(slides)) files[`ppt/slides/${f}`] = xml;
  return zipOf(files);
}

const sp = (text: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>`
  + `<p:txBody>${text.split('\n').map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
const slide = (inner: string, attrs = '') => `<p:sld ${NS} ${attrs}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;

const pptx = createPptxExtractor();
const run = (zip: ZipIndex) => pptx.extract(zip, { extractImages: false });

describe('pptx — 슬라이드 순서', () => {
  it('sldIdLst 순서를 따른다 — 파일 번호·rId 순서가 아니라', async () => {
    const zip = deck(
      { 'slide1.xml': slide(sp('첫 파일')), 'slide15.xml': slide(sp('열다섯째 파일')) },
      ['slide15.xml', 'slide1.xml'],
    );
    const doc = await run(zip);
    expect(doc.units).toEqual(['열다섯째 파일', '첫 파일']);
    expect(doc.unitKind).toBe('slide');
  });

  it('p14 확장의 두 번째 sldIdLst 는 무시한다', async () => {
    const doc = await run(deck({ 'slide1.xml': slide(sp('a')) }, ['slide1.xml']));
    expect(doc.units).toHaveLength(1);
  });

  it('숨김 슬라이드도 포함한다 — 번호가 PowerPoint 의 슬라이드 번호와 맞아야 한다', async () => {
    const doc = await run(deck(
      { 's1.xml': slide(sp('보임')), 's2.xml': slide(sp('숨김'), 'show="0"'), 's3.xml': slide(sp('셋째')) },
      ['s1.xml', 's2.xml', 's3.xml'],
    ));
    expect(doc.units).toEqual(['보임', '숨김', '셋째']);
  });

  it('빈 슬라이드는 빈 단위로 남는다 — 뒤 슬라이드 번호가 밀리지 않게', async () => {
    const doc = await run(deck(
      { 's1.xml': slide(sp('하나')), 's2.xml': slide(''), 's3.xml': slide(sp('셋')) },
      ['s1.xml', 's2.xml', 's3.xml'],
    ));
    expect(doc.units).toEqual(['하나', '', '셋']);
  });
});

describe('pptx — 텍스트', () => {
  it('그룹 안 텍스트를 깊이 우선으로 모은다', async () => {
    const grp = (inner: string) => `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${inner}</p:grpSp>`;
    const doc = await run(deck({ 's.xml': slide(sp('밖') + grp(sp('안1') + grp(sp('안2')))) }, ['s.xml']));
    expect(doc.units[0]).toBe('밖\n\n안1\n\n안2');
  });

  it('제목 자리표시자를 맨 앞에 두고 제목으로 보고한다 — spTree 에서 뒤에 있어도', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('본문') + sp('슬라이드 제목', 'title')) }, ['s.xml']));
    expect(doc.units[0]).toBe('슬라이드 제목\n\n본문');
    expect(doc.headings).toEqual([{ level: 1, title: '슬라이드 제목', unitIndex: 0 }]);
  });

  it('제목 자리표시자가 없으면 제목을 추측하지 않는다', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('큰 글씨 텍스트 상자')) }, ['s.xml']));
    expect(doc.headings).toEqual([]);
  });

  it('슬라이드 번호·날짜·바닥글 자리표시자와 번호 필드는 버린다 — Google 의 ‹#› 포함', async () => {
    const fld = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>`
      + `<p:txBody><a:p><a:fld type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const inlineFld = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + `<p:txBody><a:p><a:r><a:t>본문 </a:t></a:r><a:fld type="datetime1"><a:t>2026-09-28</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(fld + inlineFld + sp('꼬리', 'ftr')) }, ['s.xml']));
    expect(doc.units[0]).toBe('본문');
  });

  // 브리프의 위 필드 테스트는 a:fld(type=slidenum) 자체의 skipNonText 로 이미 텍스트가 비어,
  // sldNum **자리표시자 종류** 필터(NON_BODY_PLACEHOLDERS)가 독립적으로 걸리는지는 증명하지
  // 못한다(뮤테이션 ②가 살아남음 — Task4 보강). 필드 없이 고정 텍스트를 넣은 sldNum 자리표시자로
  // 그 필터 자체를 직접 겨눈다.
  it('필드 없이 고정 텍스트를 넣은 슬라이드 번호 자리표시자도 자리표시자 종류로 버린다', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('본문') + sp('7', 'sldNum')) }, ['s.xml']));
    expect(doc.units[0]).toBe('본문');
  });

  it('a:br 은 줄바꿈, a:tab 은 탭, 엔티티는 풀린다', async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody>`
      + `<a:p><a:r><a:t>A&amp;B</a:t></a:r><a:br/><a:r><a:t>둘째</a:t></a:r><a:tab/><a:r><a:t>탭뒤</a:t></a:r></a:p><a:p><a:r><a:t/></a:r></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(body) }, ['s.xml']));
    expect(doc.units[0]).toBe('A&B\n둘째\t탭뒤');
  });

  it('mc:AlternateContent 는 Choice 만 읽는다 — Fallback 까지 읽으면 두 번 들어간다', async () => {
    const alt = `<mc:AlternateContent><mc:Choice Requires="p14">${sp('한 번')}</mc:Choice><mc:Fallback>${sp('한 번')}</mc:Fallback></mc:AlternateContent>`;
    const doc = await run(deck({ 's.xml': slide(alt) }, ['s.xml']));
    expect(doc.units[0]).toBe('한 번');
  });

  it('레이아웃·마스터의 안내문은 읽지 않는다', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('본문')) }, ['s.xml'], {
      'ppt/slideLayouts/slideLayout1.xml': slide(sp('마스터 제목 스타일 편집', 'title')),
    }));
    expect(doc.units[0]).toBe('본문');
  });
});

describe('pptx — 발표자 노트', () => {
  const notes = (body: string) => `<p:notes ${NS}><p:cSld><p:spTree>${sp('슬라이드 이미지', 'sldImg')}${sp(body, 'body')}${sp('3', 'sldNum')}</p:spTree></p:cSld></p:notes>`;
  const slideRels = `<Relationships ${REL}><Relationship Id="rId9" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`;

  it('노트 본문을 슬라이드 단위 끝에 인용부로 붙인다', async () => {
    const doc = await run(deck({ 's1.xml': slide(sp('본문')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': slideRels,
      'ppt/notesSlides/notesSlide1.xml': notes('근거 수치는 부록 참조\n둘째 줄'),
    }));
    expect(doc.units[0]).toBe('본문\n\n> 근거 수치는 부록 참조\n> 둘째 줄');
  });

  it('빈 노트는 붙이지 않는다', async () => {
    const doc = await run(deck({ 's1.xml': slide(sp('본문')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': slideRels,
      'ppt/notesSlides/notesSlide1.xml': notes(' '),
    }));
    expect(doc.units[0]).toBe('본문');
  });
});

describe('pptx — 그림', () => {
  function pngHeader(w: number, h: number): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  }
  const passThrough: ImageCodec = { async reencode(bytes, mimeType) { return { bytes, mimeType: mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' }; } };
  const pptxImg = createPptxExtractor({ fitImage: createImageFitter(passThrough) });
  const pic = (rid: string) => `<p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="${rid}"><a:extLst><a:ext><asvg:svgBlip xmlns:asvg="urn:asvg" r:embed="rIdSvg"/></a:ext></a:extLst></a:blip></p:blipFill></p:pic>`;
  const rels = (target: string) => `<Relationships ${REL}><Relationship Id="rIdP" Type="x/image" Target="${target}"/><Relationship Id="rIdSvg" Type="x/image" Target="../media/image9.svg"/></Relationships>`;

  it('slide 의 blip 을 그 슬라이드 단위에 매핑하고, svg 확장은 세지 않는다', async () => {
    const doc = await pptxImg.extract(deck(
      { 's1.xml': slide(sp('a')), 's2.xml': slide(sp('b') + pic('rIdP')) },
      ['s1.xml', 's2.xml'],
      { 'ppt/slides/_rels/s2.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': pngHeader(200, 100), 'ppt/media/image9.svg': '<svg/>' },
    ), { extractImages: true });
    expect(doc.images.map((i) => i.unitIndex)).toEqual([1]);
  });

  it('여러 슬라이드에 재사용된 그림은 처음 나온 슬라이드에만', async () => {
    const doc = await pptxImg.extract(deck(
      { 's1.xml': slide(pic('rIdP')), 's2.xml': slide(pic('rIdP')) },
      ['s1.xml', 's2.xml'],
      {
        'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'),
        'ppt/slides/_rels/s2.xml.rels': rels('../media/image1.png'),
        'ppt/media/image1.png': pngHeader(200, 100),
      },
    ), { extractImages: true });
    expect(doc.images.map((i) => i.unitIndex)).toEqual([0]);
  });

  it('extractImages=false 면 그림을 모으지 않는다', async () => {
    const doc = await pptxImg.extract(deck({ 's1.xml': slide(sp('a') + pic('rIdP')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': pngHeader(200, 100),
    }), { extractImages: false });
    expect(doc.images).toEqual([]);
  });
});

describe('pptx — 실패 계약', () => {
  it('모든 슬라이드가 비면 DOC_NO_TEXT', async () => {
    await expect(run(deck({ 's.xml': slide('') }, ['s.xml']))).rejects.toMatchObject({ code: 'DOC_NO_TEXT' });
  });

  it('presentation.xml 이 깨지면 DOC_CORRUPT', async () => {
    await expect(run(zipOf({ 'ppt/presentation.xml': '<p:presentation' }))).rejects.toMatchObject({ code: 'DOC_CORRUPT' });
  });

  it('sldIdLst 가 가리키는 슬라이드가 없으면 그 자리를 빈 단위로 둔다(번호 유지)', async () => {
    const doc = await run(deck({ 's1.xml': slide(sp('있음')) }, ['s1.xml', 'missing.xml']));
    expect(doc.units).toEqual(['있음', '']);
  });

  it('501장이면 PDF_TOO_MANY_PAGES(pages/max 동봉)', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `s${i}.xml`);
    const slides = Object.fromEntries(names.map((n) => [n, slide(sp('x'))]));
    await expect(run(deck(slides, names))).rejects.toMatchObject({ code: 'PDF_TOO_MANY_PAGES', params: { pages: '501', max: '500' } });
  });

  it('중간에 취소하면 ABORTED', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `s${i}.xml`);
    const slides = Object.fromEntries(names.map((n) => [n, slide(sp('x'))]));
    const ac = new AbortController();
    const p = pptx.extract(deck(slides, names), { extractImages: false, signal: ac.signal, onProgress: () => ac.abort() });
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('readSlideRelIds — happy-dom 의 속성 드롭 회피(R4)', () => {
  /**
   * happy-dom 20.10.6 은 `<p:sldId id="256" r:id="rId2"/>` 처럼 무접두 동명 속성(id)이 접두
   * 속성(r:id) **앞**에 오면 r:id 를 조용히 버린다(attributes 순회에서 사라짐). 실제 PowerPoint
   * 파일도 이 순서다. 그래서 슬라이드 순서는 DOM 속성이 아니라 태그 레벨 정규식으로 읽는다.
   * (Chromium 실물은 문제 없다 — Task10 의 E2E 가 실제 순서를 별도로 검증한다.)
   */
  it('id 가 r:id 보다 앞에 와도(실물 순서) r:id 값을 순서대로 읽는다', () => {
    const xml = '<p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId7"/></p:sldIdLst>';
    expect(readSlideRelIds(`<p:presentation>${xml}</p:presentation>`)).toEqual(['rId3', 'rId7']);
  });

  it('r:id 가 id 보다 앞에 와도 마찬가지다', () => {
    const xml = '<p:sldIdLst><p:sldId r:id="rId5" id="256"/></p:sldIdLst>';
    expect(readSlideRelIds(`<p:presentation>${xml}</p:presentation>`)).toEqual(['rId5']);
  });

  it('p14 확장(extLst/p14:sectionLst) 안의 두 번째 sldIdLst 는 무시한다', () => {
    const xml = '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
      + '<p:extLst><p:ext><p14:sectionLst><p14:section><p14:sldIdLst><p14:sldId id="999" r:id="rId99"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>';
    expect(readSlideRelIds(`<p:presentation>${xml}</p:presentation>`)).toEqual(['rId1']);
  });

  it('r:id 값의 XML 엔티티를 푼다', () => {
    const xml = '<p:sldIdLst><p:sldId id="256" r:id="rId&amp;1"/></p:sldIdLst>';
    expect(readSlideRelIds(`<p:presentation>${xml}</p:presentation>`)).toEqual(['rId&1']);
  });
});
