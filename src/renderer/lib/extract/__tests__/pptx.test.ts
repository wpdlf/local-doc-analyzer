// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { createPptxExtractor, readSlideRelIds, readPresentationIndex } from '../pptx';
import { createImageFitter, type ImageCodec } from '../image-fit';
import { toPdfDocument } from '../normalize';
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

  it('401장 모두에 같은 로고가 있어도 마지막 슬라이드의 고유 그림을 잃지 않는다(중복은 검사 예산 밖)', async () => {
    const n = 401;
    const slides: Record<string, string> = {};
    const extra: Record<string, string | Uint8Array> = {
      'ppt/media/logo.png': pngHeader(200, 100),
      'ppt/media/unique.png': pngHeader(300, 100),
    };
    const order: string[] = [];
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      slides[`s${i}.xml`] = slide(sp(`t${i}`) + pic('rIdL') + (last ? pic('rIdP') : ''));
      extra[`ppt/slides/_rels/s${i}.xml.rels`] = `<Relationships ${REL}><Relationship Id="rIdL" Type="x/image" Target="../media/logo.png"/>`
        + (last ? `<Relationship Id="rIdP" Type="x/image" Target="../media/unique.png"/>` : '') + `</Relationships>`;
      order.push(`s${i}.xml`);
    }
    const doc = await pptxImg.extract(deck(slides, order, extra), { extractImages: true });
    expect(doc.images.map((i) => [i.unitIndex, i.width])).toEqual([[0, 200], [n - 1, 300]]);
    expect(doc.imageBudgetExceeded).toBeUndefined();
  });

  it('extractImages=false 면 그림을 모으지 않는다', async () => {
    const doc = await pptxImg.extract(deck({ 's1.xml': slide(sp('a') + pic('rIdP')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': pngHeader(200, 100),
    }), { extractImages: false });
    expect(doc.images).toEqual([]);
  });

  // R7(컨트롤러 판정): DOC_NO_TEXT 는 그림 **후보**가 아니라 실제로 **채택된** 그림 수로
  // 판정해야 한다 — extractImages=false 나, 지원하지 않는 그림 형식뿐이면 후보는 있어도
  // 실채택은 0장이라 요약할 것이 없는 문서가 그대로 통과했다(R4 편차의 사각).
  it('텍스트 없이 그림만 있는데 extractImages=false 면 DOC_NO_TEXT (R7)', async () => {
    await expect(pptxImg.extract(deck({ 's1.xml': slide(pic('rIdP')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': pngHeader(200, 100),
    }), { extractImages: false })).rejects.toMatchObject({ code: 'DOC_NO_TEXT' });
  });

  it('텍스트 없이 그림만 있는데 그 그림이 지원하지 않는 형식이면 DOC_NO_TEXT (R7)', async () => {
    // PNG/JPEG/BMP 매직이 아닌 임의 바이트 — probeImage 가 null 을 돌려 fitImage 가 그 그림을
    // 건너뛴다(EMF/WMF 를 흉내낸 것과 같은 경로).
    const unsupported = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(pptxImg.extract(deck({ 's1.xml': slide(pic('rIdP')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': unsupported,
    }), { extractImages: true })).rejects.toMatchObject({ code: 'DOC_NO_TEXT' });
  });
});

describe('pptx — 그래픽 기본값 배선', () => {
  it('추출기가 병합 표를 pptxGraphics 로 텍스트화한다(기본값 배선)', async () => {
    const frame = `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>`
      + `<a:tblGrid><a:gridCol/><a:gridCol/></a:tblGrid>`
      + `<a:tr><a:tc rowSpan="2"><a:txBody><a:p><a:r><a:t>분류</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc></a:tr>`
      + `<a:tr><a:tc vMerge="1"/><a:tc><a:txBody><a:p><a:r><a:t>y</a:t></a:r></a:p></a:txBody></a:tc></a:tr>`
      + `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const doc = await run(deck({ 's.xml': slide(frame) }, ['s.xml']));
    expect(doc.units[0]).toBe('| 분류 | x |\n| --- | --- |\n| 분류 | y |');
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

  // fix-round1(리뷰 Important): 홑따옴표 속성도 유효한 XML 이다 — DOM 경로였다면 인용부호를
  // 가리지 않았을 것이다.
  it('홑따옴표 속성도 읽는다', () => {
    const xml = "<p:sldIdLst><p:sldId id='256' r:id='rId2'/></p:sldIdLst>";
    expect(readSlideRelIds(`<p:presentation>${xml}</p:presentation>`)).toEqual(['rId2']);
  });

  // fix-round1(리뷰 Important): 자기 닫힘 <p:extLst/> 는 스키마상 p:sldMasterId 안에도 허용되고,
  // 진짜 sldIdLst **앞**에 올 수 있다. 짝 태그 제거만 쓰면 비탐욕 매칭이 이 자기 닫힘 태그의
  // 시작부터 그 뒤(p14 섹션 확장)의 진짜 </…extLst> 까지를 통째로 삼켜 그 사이의 진짜
  // sldIdLst 가 사라진다(슬라이드 0장).
  it('sldIdLst 앞의 자기 닫힘 <p:extLst/>(sldMasterId 안)가 진짜 sldIdLst 를 삼키지 않는다', () => {
    const xml = '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"><p:extLst/></p:sldMasterId></p:sldMasterIdLst>'
      + '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
      + '<p:extLst><p:ext><p14:sectionLst><p14:section><p14:sldIdLst><p14:sldId id="999" r:id="rId99"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>';
    expect(readSlideRelIds(`<p:presentation>${xml}</p:presentation>`)).toEqual(['rId1']);
  });
});

// ── QA35 ─────────────────────────────────────────────────────────────────────────────────

/** presentation.xml 을 직접 주는 덱 — 섹션·주석 같은 presentation 수준 구조를 시험할 때 쓴다. */
function deckWithPres(pres: string, relIds: Record<string, string>, slides: Record<string, string>) {
  const rels = `<Relationships ${REL}>${Object.entries(relIds).map(([rid, f]) => `<Relationship Id="${rid}" Type="x/slide" Target="slides/${f}"/>`).join('')}</Relationships>`;
  const files: Record<string, string> = { 'ppt/presentation.xml': pres, 'ppt/_rels/presentation.xml.rels': rels };
  for (const [f, xml] of Object.entries(slides)) files[`ppt/slides/${f}`] = xml;
  return zipOf(files);
}

describe('pptx — 도형 채우기 그림 (QA35 Important)', () => {
  function pngHeader(w: number, h: number): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  }
  const passThrough: ImageCodec = { async reencode(bytes, mimeType) { return { bytes, mimeType: mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' }; } };
  const pptxImg = createPptxExtractor({ fitImage: createImageFitter(passThrough) });
  // Canva 류: 사진이 p:pic 이 아니라 도형(p:sp)의 채우기(spPr > a:blipFill)로 들어 있다. 텍스트 없음.
  const fillShape = (tag: 'sp' | 'cxnSp', rid: string) => `<p:${tag}><p:nvSpPr><p:cNvPr id="4" name="photo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:prstGeom prst="rect"/></p:spPr></p:${tag}>`;
  const rels = `<Relationships ${REL}><Relationship Id="rIdA" Type="x/image" Target="../media/a.png"/><Relationship Id="rIdB" Type="x/image" Target="../media/b.png"/></Relationships>`;

  it('그림만 있는 덱의 도형 채우기 사진을 그림으로 모으고 DOC_NO_TEXT 로 거절하지 않는다', async () => {
    const doc = await pptxImg.extract(deck(
      { 's1.xml': slide(fillShape('sp', 'rIdA')), 's2.xml': slide(fillShape('cxnSp', 'rIdB')) },
      ['s1.xml', 's2.xml'],
      {
        'ppt/slides/_rels/s1.xml.rels': rels, 'ppt/slides/_rels/s2.xml.rels': rels,
        'ppt/media/a.png': pngHeader(200, 100), 'ppt/media/b.png': pngHeader(300, 100),
      },
    ), { extractImages: true });
    expect(doc.images.map((i) => [i.unitIndex, i.width])).toEqual([[0, 200], [1, 300]]);
  });
});

describe('readPresentationIndex — 주석·선형성·엔티티 (QA35)', () => {
  const list = '<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>';

  it('주석 안의 가짜 sldIdLst 를 진짜 목록으로 읽지 않는다', () => {
    const xml = `<p:presentation><!-- <p:sldIdLst><p:sldId id="9" r:id="rId9"/></p:sldIdLst> -->${list}</p:presentation>`;
    expect(readSlideRelIds(xml)).toEqual(['rId1', 'rId2']);
  });

  it('주석 안의 <p:extLst> 가 진짜 목록을 삼키지 않는다', () => {
    const xml = `<p:presentation><!-- <p:extLst> -->${list}<p:extLst><p:ext uri="x"/></p:extLst></p:presentation>`;
    expect(readSlideRelIds(xml)).toEqual(['rId1', 'rId2']);
  });

  // 루트 직계만 순서다 — 확장 안의 sldIdLst 가 진짜 목록보다 **앞**에 와도(첫 것을 잡는 방식이면
  // 확장 쪽을 읽는다) 깊이로 거른다.
  it('진짜 목록 앞에 있는 확장 안의 sldIdLst 를 읽지 않는다', () => {
    const ext = '<p:extLst><p:ext uri="x"><p14:sectionLst><p14:section name="s"><p14:sldIdLst><p14:sldId id="256" r:id="rId9"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>';
    expect(readSlideRelIds(`<p:presentation><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rM">${ext}</p:sldMasterId></p:sldMasterIdLst>${list}</p:presentation>`))
      .toEqual(['rId1', 'rId2']);
  });

  it('CDATA 안의 가짜 목록도 읽지 않는다', () => {
    const xml = `<p:presentation><p:custData><![CDATA[<p:sldIdLst><p:sldId id="9" r:id="rId9"/></p:sldIdLst>]]></p:custData>${list}</p:presentation>`;
    expect(readSlideRelIds(xml)).toEqual(['rId1', 'rId2']);
  });

  it('닫는 > 없는 <p:extLst 가 1MB 반복된 주석도 선형으로 끝난다(< 500ms)', () => {
    const junk = '<p:extLst '.repeat(Math.ceil(1_000_000 / 10));
    const xml = `<p:presentation><!-- ${junk} -->${list}</p:presentation>`;
    const t0 = performance.now();
    const ids = readSlideRelIds(xml);
    const elapsed = performance.now() - t0;
    expect(ids).toEqual(['rId1', 'rId2']);
    expect(elapsed).toBeLessThan(500);
  });

  it('숫자 문자 참조(&#NN; · &#xNN;)를 푼다 — 이중 디코드는 하지 않는다', () => {
    const xml = '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId&#49;"/><p:sldId id="257" r:id="rId&#x32;"/><p:sldId id="258" r:id="a&amp;lt;b"/></p:sldIdLst></p:presentation>';
    expect(readSlideRelIds(xml)).toEqual(['rId1', 'rId2', 'a&lt;b']);
  });

  it('속성 값 안의 > 는 태그 끝이 아니다', () => {
    const xml = '<p:presentation><p:sldIdLst><p:sldId name="a>b" id="256" r:id="rId1"/></p:sldIdLst></p:presentation>';
    expect(readPresentationIndex(xml).slides).toEqual([{ relId: 'rId1', id: '256' }]);
  });

  it('sldId 의 숫자 id 와 p14 섹션(이름·소속 id)을 함께 읽는다', () => {
    const xml = `<p:presentation>${list}<p:extLst><p:ext uri="{521415D9}"><p14:sectionLst>`
      + `<p14:section name="도입 &amp; 배경" id="{A}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section>`
      + `<p14:section name='본론' id="{B}"><p14:sldIdLst><p14:sldId id="257"/></p14:sldIdLst></p14:section>`
      + `</p14:sectionLst></p:ext></p:extLst></p:presentation>`;
    expect(readPresentationIndex(xml)).toEqual({
      slides: [{ relId: 'rId1', id: '256' }, { relId: 'rId2', id: '257' }],
      sections: [{ name: '도입 & 배경', slideIds: ['256'] }, { name: '본론', slideIds: ['257'] }],
    });
  });
});

describe('pptx — 섹션 → sections (QA35)', () => {
  const sectionPres = (sections: string) => `<p:presentation ${NS} xmlns:p14="urn:p14"><p:sldIdLst>`
    + `<p:sldId id="256" r:id="rA"/><p:sldId id="257" r:id="rB"/><p:sldId id="258" r:id="rC"/><p:sldId id="259" r:id="rD"/>`
    + `</p:sldIdLst><p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst>${sections}</p14:sectionLst></p:ext></p:extLst></p:presentation>`;
  const section = (name: string, ids: number[]) =>
    `<p14:section name="${name}" id="{x}"><p14:sldIdLst>${ids.map((id) => `<p14:sldId id="${id}"/>`).join('')}</p14:sldIdLst></p14:section>`;
  const fourSlides = { 'a.xml': slide(sp('1')), 'b.xml': slide(sp('2')), 'c.xml': slide(sp('3')), 'd.xml': slide(sp('4')) };
  const rels = { rA: 'a.xml', rB: 'b.xml', rC: 'c.xml', rD: 'd.xml' };

  it('섹션마다 표시 순서상 첫 슬라이드의 단위 번호를 준다 — 빈 섹션은 건너뛴다', async () => {
    const pres = sectionPres(section('도입', [257, 256]) + section('빈 섹션', []) + section('본론', [258, 259]));
    const doc = await run(deckWithPres(pres, rels, fourSlides));
    expect(doc.sections).toEqual([{ title: '도입', unitIndex: 0 }, { title: '본론', unitIndex: 2 }]);
  });

  // 두 에이전트가 각자 끝을 만든 배선이다(pptx 가 sections 를 내고 normalize 가 우선 쓴다) —
  // 한쪽만 테스트되면 이름이 어긋나도 둘 다 초록이다. 슬라이드마다 제목이 있어도 섹션이 이긴다.
  it('추출 → toPdfDocument 를 거치면 챕터가 섹션을 따른다 (슬라이드 제목보다 우선)', async () => {
    const titled = { 'a.xml': slide(sp('T1', 'title')), 'b.xml': slide(sp('T2', 'title')), 'c.xml': slide(sp('T3', 'title')), 'd.xml': slide(sp('T4', 'title')) };
    const pres = sectionPres(section('도입', [256, 257]) + section('본론', [258, 259]));
    const doc = await run(deckWithPres(pres, rels, titled));
    expect(doc.headings.length, '픽스처가 제목을 내지 않으면 우선순위를 재지 못한다').toBe(4);
    const pdf = toPdfDocument(doc, { fileName: 'x.pptx', filePath: 'C:/x.pptx' });
    expect(pdf.chapters.map((c) => [c.title, c.startPage, c.endPage])).toEqual([['도입', 1, 2], ['본론', 3, 4]]);
  });

  it('섹션이 하나뿐이면 sections 를 내지 않는다', async () => {
    const doc = await run(deckWithPres(sectionPres(section('전부', [256, 257, 258, 259])), rels, fourSlides));
    expect(doc.sections).toBeUndefined();
  });

  it('섹션 목록이 없는 덱은 sections 를 내지 않는다', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('a')) }, ['s.xml']));
    expect(doc.sections).toBeUndefined();
  });
});

describe('pptx — 그룹 중첩 상한 초과 (QA35 Low)', () => {
  it('40단 중첩 그룹 안의 텍스트를 버리지 않는다(상한 뒤는 평문으로)', async () => {
    let inner = sp('깊은 곳');
    for (let i = 0; i < 40; i++) inner = `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${inner}</p:grpSp>`;
    const doc = await run(deck({ 's.xml': slide(sp('겉') + inner) }, ['s.xml']));
    expect(doc.units[0]).toBe('겉\n\n깊은 곳');
  });
});

describe('pptx — 배선 (QA35 뮤테이션 감사가 찾은 빈 자리)', () => {
  const graphicFrame = (uri: string, inner: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr/><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></p:graphicFrame>`;
  const chartRels = `<Relationships ${REL}><Relationship Id="rIdC" Type="x/chart" Target="../charts/chart1.xml"/><Relationship Id="rIdD" Type="x/diagramData" Target="../diagrams/data1.xml"/></Relationships>`;
  const C_NS = `${NS} xmlns:c="urn:c"`;
  const ser = (name: string, cats: string[], vals: number[]) => `<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + `<c:cat><c:strRef><c:strCache>${cats.map((c, i) => `<c:pt idx="${i}"><c:v>${c}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:numCache>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`;
  const chartXml = (series: string, title = '') => `<c:chartSpace ${C_NS}><c:chart>`
    + (title ? `<c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>` : '')
    + `<c:plotArea><c:barChart>${series}</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
  const chartFrame = graphicFrame('http://schemas.openxmlformats.org/drawingml/2006/chart', `<c:chart xmlns:c="urn:c" r:id="rIdC"/>`);
  const chartDeck = (xml: string) => deck({ 's.xml': slide(chartFrame) }, ['s.xml'], {
    'ppt/slides/_rels/s.xml.rels': chartRels, 'ppt/charts/chart1.xml': xml,
  });

  it('P30: uri 가 /chart 로 끝나는 graphicFrame 은 차트 제목 + 표로 단위에 들어간다', async () => {
    const doc = await run(chartDeck(chartXml(ser('2025', ['Q1', 'Q2'], [10, 12]), '분기 매출')));
    expect(doc.units[0]).toBe('분기 매출\n\n|  | Q1 | Q2 |\n| --- | --- | --- |\n| 2025 | 10 | 12 |');
  });

  const dgm = (pts: string) => `<dgm:dataModel ${NS} xmlns:dgm="urn:dgm"><dgm:ptLst>${pts}</dgm:ptLst></dgm:dataModel>`;
  const dgmPt = (id: number, text: string, type?: string) =>
    `<dgm:pt modelId="${id}"${type ? ` type="${type}"` : ''}><dgm:t><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
  const smartArtDeck = (data: string) => deck({
    's.xml': slide(graphicFrame('http://schemas.openxmlformats.org/drawingml/2006/diagram', `<dgm:relIds xmlns:dgm="urn:dgm" r:dm="rIdD" r:lo="x" r:qs="y" r:cs="z"/>`)),
  }, ['s.xml'], { 'ppt/slides/_rels/s.xml.rels': chartRels, 'ppt/diagrams/data1.xml': data });

  it('P31: uri 가 /diagram 으로 끝나는 graphicFrame 은 SmartArt 목록으로 들어간다', async () => {
    const doc = await run(smartArtDeck(dgm(dgmPt(1, '기획') + dgmPt(2, '개발', 'node'))));
    expect(doc.units[0]).toBe('- 기획\n- 개발');
  });

  it('G13: SmartArt 의 보조(asst) 점도 남긴다', async () => {
    const doc = await run(smartArtDeck(dgm(dgmPt(1, '대표') + dgmPt(2, '비서실', 'asst') + dgmPt(3, '연결', 'sibTrans'))));
    expect(doc.units[0]).toBe('- 대표\n- 비서실');
  });

  it('P12: ctrTitle(표지 제목) 자리표시자도 제목 — 맨 앞에 두고 첫 줄을 제목으로', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('부제') + sp('표지 제목\n둘째 줄', 'ctrTitle')) }, ['s.xml']));
    expect(doc.units[0]).toBe('표지 제목\n둘째 줄\n\n부제');
    expect(doc.headings).toEqual([{ level: 1, title: '표지 제목', unitIndex: 0 }]);
  });

  it('P20: 제목에 a:br 이 있으면 제목(heading)은 첫 줄만', async () => {
    const title = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`
      + `<p:txBody><a:p><a:r><a:t>큰 제목</a:t></a:r><a:br/><a:r><a:t>작은 설명</a:t></a:r></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(title) }, ['s.xml']));
    expect(doc.headings).toEqual([{ level: 1, title: '큰 제목', unitIndex: 0 }]);
    expect(doc.units[0]).toBe('큰 제목\n작은 설명');
  });

  it('P07: AlternateContent 의 Choice 와 Fallback 텍스트가 다르면 Choice 만 들어간다', async () => {
    const alt = `<mc:AlternateContent><mc:Choice Requires="p14">${sp('새 도형')}</mc:Choice><mc:Fallback>${sp('옛 그림 대체')}</mc:Fallback></mc:AlternateContent>`;
    const doc = await run(deck({ 's.xml': slide(alt) }, ['s.xml']));
    expect(doc.units[0]).toBe('새 도형');
  });

  it('T01: 문단 안의 런 수준 AlternateContent 는 텍스트를 한 번만 낸다', async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>앞 </a:t></a:r>`
      + `<mc:AlternateContent><mc:Choice Requires="a14"><a:r><a:t>수식</a:t></a:r></mc:Choice><mc:Fallback><a:r><a:t>수식그림</a:t></a:r></mc:Fallback></mc:AlternateContent>`
      + `<a:r><a:t> 뒤</a:t></a:r></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(body) }, ['s.xml']));
    expect(doc.units[0]).toBe('앞 수식 뒤');
  });

  it('T02: 자리표시자가 아닌 텍스트 상자 안의 slidenum 필드도 버린다', async () => {
    const box = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="box"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:txBody>`
      + `<a:p><a:r><a:t>쪽 </a:t></a:r><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(box + sp('본문')) }, ['s.xml']));
    expect(doc.units[0]).toBe('쪽\n\n본문');
  });

  it('G08: 계열이 25개면 표는 20행까지 — 잘린 개수를 밝힌다', async () => {
    const series = Array.from({ length: 25 }, (_, i) => ser(`S${i}`, ['Q1'], [i])).join('');
    const doc = await run(chartDeck(chartXml(series)));
    const rows = doc.units[0]!.split('\n').filter((l) => /^\| S\d+ \|/.test(l));
    expect(rows).toHaveLength(20);
    expect(doc.units[0]).toContain('S19');
    expect(doc.units[0]).not.toContain('S20');
    expect(doc.units[0]).toContain('20/25');
  });

  it('G11: 항목 머리글은 가장 긴 계열의 항목에서 온다', async () => {
    const doc = await run(chartDeck(chartXml(ser('짧음', ['Q1'], [1]) + ser('김', ['Q1', 'Q2', 'Q3'], [4, 5, 6]) + ser('중간', ['Q1', 'Q2'], [7, 8]))));
    expect(doc.units[0]!.split('\n')[0]).toBe('|  | Q1 | Q2 | Q3 |');
  });
});
