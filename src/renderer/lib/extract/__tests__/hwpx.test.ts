// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { createHwpxExtractor } from '../hwpx';
import type { ZipIndex } from '../types';

const NS = 'xmlns:hs="urn:hs" xmlns:hp="urn:hp" xmlns:hc="urn:hc" xmlns:hh="urn:hh"';
const PKG = 'application/hwpml-package+xml';

function zipOf(files: Record<string, string | Uint8Array>): ZipIndex {
  const e: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) e[k] = typeof v === 'string' ? strToU8(v) : v;
  const u8 = zipSync(e);
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}

/** 섹션 XML 배열 → 최소 HWPX 패키지. spine 에 header 와 스크립트를 섞어 실물처럼 만든다. */
export function hwpx(sections: string[], opts: { header?: string; extra?: Record<string, string | Uint8Array>; manifestItems?: string } = {}) {
  const items = sections.map((_, i) => `<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`).join('');
  const spine = sections.map((_, i) => `<opf:itemref idref="section${i}"/>`).join('');
  const files: Record<string, string | Uint8Array> = {
    mimetype: 'application/hwp+zip',
    'META-INF/container.xml': `<container><rootfiles><rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><rootfile full-path="Contents/content.hpf" media-type="${PKG}"/></rootfiles></container>`,
    'Contents/content.hpf': `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${items}<opf:item id="script" href="Scripts/headerScripts" media-type="application/x-javascript"/>${opts.manifestItems ?? ''}</opf:manifest><opf:spine><opf:itemref idref="header"/>${spine}<opf:itemref idref="script"/></opf:spine></opf:package>`,
    'Contents/header.xml': opts.header ?? `<hh:head ${NS}/>`,
    'Preview/PrvText.txt': '잘린 미리보기',
    ...opts.extra,
  };
  sections.forEach((s, i) => { files[`Contents/section${i}.xml`] = s; });
  return zipOf(files);
}

export const sec = (paras: string) => `<hs:sec ${NS}>${paras}</hs:sec>`;

const P_DEFAULTS = { paraPrIDRef: '0', styleIDRef: '0', pageBreak: '0', columnBreak: '0' } as const;

/**
 * 최상위 문단 조립기. 기본 속성에 `override` 를 **병합**한다 — 같은 이름은 override 값이
 * 이기고, 결과 태그에 그 이름은 정확히 한 번만 나온다.
 *
 * fix-round2(리뷰 지적): 이전 판은 override 를 문자열로 받아 기본값과 나란히 이어붙였는데,
 * 그러면 `paraPrIDRef="5"` 를 넘겨도 결과 태그에 `paraPrIDRef` 가 **두 번**(override 값 +
 * 기본값) 남는다. 이는 XML well-formedness 위반(중복 속성)이라 표준을 따르는 파서(Chromium
 * DOMParser 등)라면 parsererror → DOC_CORRUPT 가 나야 하는 입력이다. 이전 수정은 순서를
 * 뒤집어 "먼저 나오는 쪽이 이긴다"는 happy-dom 20.10.6 의 관용(중복을 parsererror 없이 받고
 * 첫 값만 남김)에 기대는 우회였다 — happy-dom 이 나중 값을 채택하도록 바뀌면 오버라이드가
 * 거꾸로 뒤집혀 "글상자 안 문단은 제목이 되지 않는다" 같은 테스트가 **우연히** 통과하는
 * 거짓 양성이 된다. 애초에 중복 자체를 만들지 않는 쪽(객체 병합)으로 고친다.
 */
export const p = (inner: string, override: Record<string, string> = {}): string => {
  const attrs = { ...P_DEFAULTS, ...override };
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<hp:p ${attrStr}>${inner}</hp:p>`;
};
export const run = (inner: string) => `<hp:run charPrIDRef="0">${inner}</hp:run>`;
export const t = (text: string) => `<hp:t>${text}</hp:t>`;

const x = createHwpxExtractor();
const extract = (zip: ZipIndex) => x.extract(zip, { extractImages: false });

// fix-round2 회귀 가드: p() 가 다시 문자열 접합(중복 속성)으로 퇴행하면 여기서 잡는다 —
// 프로덕션 파서(happy-dom)의 중복-허용 관용에 기대지 않고, 조립기가 만드는 문자열 자체를 본다.
describe('p() 조립기 — 속성은 병합되고 중복되지 않는다', () => {
  it('override 가 있어도 각 속성명이 정확히 한 번만 나온다', () => {
    const xml = p('', { pageBreak: '1', paraPrIDRef: '5' });
    expect((xml.match(/pageBreak="/g) ?? []).length).toBe(1);
    expect((xml.match(/paraPrIDRef="/g) ?? []).length).toBe(1);
    expect(xml).toContain('pageBreak="1"');
    expect(xml).toContain('paraPrIDRef="5"');
  });

  it('override 가 없으면 기본값 그대로, 역시 중복이 없다', () => {
    const xml = p('');
    expect((xml.match(/pageBreak="/g) ?? []).length).toBe(1);
    expect(xml).toContain('pageBreak="0"');
  });
});

describe('hwpx — 판별·섹션', () => {
  it('mimetype 으로 판별한다', () => {
    expect(x.sniff(hwpx([sec(p(run(t('a'))))]))).toBe(true);
    expect(x.sniff(zipOf({ mimetype: 'application/epub+zip' }))).toBe(false);
  });

  it('spine 의 header·스크립트는 본문이 아니다', async () => {
    const doc = await extract(hwpx([sec(p(run(t('본문'))))]));
    expect(doc.units).toEqual(['본문']);
    expect(doc.unitKind).toBe('page');
  });

  it('두 번째 섹션은 새 쪽에서 시작한다', async () => {
    const doc = await extract(hwpx([sec(p(run(t('일')))), sec(p(run(t('이'))))]));
    expect(doc.units).toEqual(['일', '이']);
  });

  it('Preview/PrvText.txt 를 쓰지 않는다', async () => {
    const doc = await extract(hwpx([sec(p(run(t('진짜 본문'))))]));
    expect(doc.units.join('')).not.toContain('잘린 미리보기');
  });
});

describe('hwpx — 문단 텍스트', () => {
  it('hp:p/@pageBreak="1" 만 쪽나눔 — 표의 pageBreak="CELL" 은 아니다', async () => {
    const tbl = `<hp:tbl rowCnt="1" colCnt="1" pageBreak="CELL"><hp:tr><hp:tc><hp:subList>${p(run(t('셀')))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
    const doc = await extract(hwpx([sec(p(run(t('앞'))) + p(run(tbl)) + p(run(t('뒤')), { pageBreak: '1' }))]));
    expect(doc.units).toHaveLength(2);
    expect(doc.units[1]).toBe('뒤');
  });

  it('hp:t 의 혼합 내용: lineBreak·tab·특수 공백, markpen 무시, 공백만 있는 런을 지우지 않는다', async () => {
    const body = run(`<hp:t>가<hp:lineBreak/>나<hp:markpenBegin/>다<hp:markpenEnd/><hp:tab/>라<hp:nbSpace/>마<hp:hyphen/>바</hp:t>`) + run(t(' ')) + run(t('사'));
    const doc = await extract(hwpx([sec(p(body))]));
    expect(doc.units[0]).toBe('가\n나다\t라 마-바 사');
  });

  it('shapeComment·머리말·꼬리말·쪽 번호는 본문이 아니다', async () => {
    const noise = run(`<hp:ctrl><hp:footer><hp:subList>${p(run('<hp:ctrl><hp:autoNum numType="PAGE"/></hp:ctrl>' + t('- 꼬리 -')))}</hp:subList></hp:footer></hp:ctrl>`)
      + run(`<hp:rect><hp:shapeComment>사각형입니다.</hp:shapeComment></hp:rect>`)
      + run(`<hp:pic><hp:shapeComment>그림입니다. 원본 그림의 이름: secret.png</hp:shapeComment><hc:img binaryItemIDRef="image1"/></hp:pic>`);
    const doc = await extract(hwpx([sec(p(run(t('본문')) + noise))]));
    expect(doc.units[0]).toBe('본문');
  });

  // 비공허 증명: 위 테스트의 shapeComment 는 원문처럼 hp:t 없는 평문이라, SKIPPED 에서
  // 'shapeComment' 를 지워도(뮤테이션) 이 자리는 안 걸린다(tText 는 hp:t 요소에서만 모으므로).
  // hp:rect(따로 처리하지 않는 컨테이너) 안 shapeComment 에 실제 hp:t 를 넣어 서브트리 스킵
  // 자체가 지켜지는지 직접 본다.
  it('shapeComment 안에 실제 hp:t 가 있어도 서브트리째 건너뛴다', async () => {
    const leak = run(`<hp:rect><hp:shapeComment><hp:t>사각형 설명 유출</hp:t></hp:shapeComment></hp:rect>`);
    const doc = await extract(hwpx([sec(p(run(t('본문')) + leak))]));
    expect(doc.units[0]).toBe('본문');
  });

  it('표가 런 사이에 끼면 앞 텍스트·표·뒤 텍스트가 순서대로 블록이 된다', async () => {
    const tbl = `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>${p(run(t('셀')))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
    const doc = await extract(hwpx([sec(p(run(t('앞') + tbl + t('뒤'))))]));
    expect(doc.units[0]!.indexOf('앞')).toBeLessThan(doc.units[0]!.indexOf('셀'));
    expect(doc.units[0]!.indexOf('셀')).toBeLessThan(doc.units[0]!.indexOf('뒤'));
  });

  it('글상자(drawText) 텍스트를 잃지 않고 호스트 문단 뒤에 둔다', async () => {
    const box = run(`<hp:rect><hp:drawText><hp:subList>${p(run(t('상자 제목')))}</hp:subList></hp:drawText></hp:rect>`);
    const doc = await extract(hwpx([sec(p(run(t('호스트')) + box) + p(run(t('다음'))))]));
    expect(doc.units[0]).toBe('호스트\n\n상자 제목\n\n다음');
  });
});

describe('hwpx — 제목·실패 계약', () => {
  const header = `<hh:head ${NS}><hh:paraPr id="5"><hh:heading type="OUTLINE" level="0"/></hh:paraPr></hh:head>`;

  it('paraPrIDRef 가 개요 paraPr 를 가리키면 제목', async () => {
    const doc = await extract(hwpx([sec(p(run(t('1. 개요')), { paraPrIDRef: '5' }) + p(run(t('본문'))))], { header }));
    expect(doc.headings).toEqual([{ level: 1, title: '1. 개요', unitIndex: 0 }]);
  });

  it('글상자 안 문단은 제목이 되지 않는다', async () => {
    const box = run(`<hp:rect><hp:drawText><hp:subList>${p(run(t('상자')), { paraPrIDRef: '5' })}</hp:subList></hp:drawText></hp:rect>`);
    const doc = await extract(hwpx([sec(p(run(t('호스트')) + box))], { header }));
    expect(doc.headings).toEqual([]);
  });

  it('manifest 에 encryption-data 가 있으면 DOC_ENCRYPTED', async () => {
    const enc = '<odf:manifest xmlns:odf="urn:odf"><odf:file-entry><odf:encryption-data/></odf:file-entry></odf:manifest>';
    await expect(extract(hwpx([sec(p(run(t('a'))))], { extra: { 'META-INF/manifest.xml': enc } }))).rejects.toMatchObject({ code: 'DOC_ENCRYPTED' });
  });

  it('섹션이 XML 이 아니면 DOC_CORRUPT — 빈 문서로 돌려주지 않는다', async () => {
    await expect(extract(hwpx(['\u0000binary']))).rejects.toMatchObject({ code: 'DOC_CORRUPT' });
  });

  it('본문이 전부 비면 DOC_NO_TEXT', async () => {
    await expect(extract(hwpx([sec(p(run(t(''))))]))).rejects.toMatchObject({ code: 'DOC_NO_TEXT' });
  });

  it('spine 에서 섹션을 못 찾으면 Contents/sectionN.xml 을 번호순으로', async () => {
    const zip = zipOf({
      mimetype: 'application/hwp+zip',
      'META-INF/container.xml': `<container><rootfiles><rootfile full-path="Contents/content.hpf" media-type="${PKG}"/></rootfiles></container>`,
      'Contents/content.hpf': '<opf:package xmlns:opf="urn:opf"><opf:manifest/><opf:spine/></opf:package>',
      'Contents/section10.xml': sec(p(run(t('열')))),
      'Contents/section2.xml': sec(p(run(t('둘')))),
    });
    expect((await extract(zip)).units).toEqual(['둘', '열']);
  });
});

describe('hwpx 표 (실물: 가려진 칸은 XML 에 없다)', () => {
  const tc = (row: number, col: number, text: string, rowSpan = 1, colSpan = 1) =>
    `<hp:tc><hp:subList>${p(run(t(text)))}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/><hp:cellSz width="1" height="1"/></hp:tc>`;
  const tbl = (rows: number, cols: number, trs: string[]) => `<hp:tbl rowCnt="${rows}" colCnt="${cols}" pageBreak="CELL">${trs.map((r) => `<hp:tr>${r}</hp:tr>`).join('')}</hp:tbl>`;

  it('세로 병합으로 가려진 칸이 없어도 열이 밀리지 않는다 — 분류 텍스트는 아래 행에 복사', async () => {
    const table = tbl(2, 3, [tc(0, 0, '분류', 2) + tc(0, 1, '항목') + tc(0, 2, '값'), tc(1, 1, '달성률') + tc(1, 2, '100%')]);
    const doc = await extract(hwpx([sec(p(run(table)))]));
    expect(doc.units[0]).toBe('| 분류 | 항목 | 값 |\n| --- | --- | --- |\n| 분류 | 달성률 | 100% |');
  });

  it('가로 병합은 첫 칸에만 텍스트', async () => {
    const table = tbl(2, 2, [tc(0, 0, '머리', 1, 2), tc(1, 0, 'a') + tc(1, 1, 'b')]);
    const doc = await extract(hwpx([sec(p(run(table)))]));
    expect(doc.units[0]).toBe('| 머리 |  |\n| --- | --- |\n| a | b |');
  });

  it('셀 안의 표는 평탄화한다(행 "; ", 칸 " / ")', async () => {
    const inner = tbl(2, 2, [tc(0, 0, 'i1') + tc(0, 1, 'i2'), tc(1, 0, 'i3') + tc(1, 1, 'i4')]);
    const outer = tbl(1, 1, [`<hp:tc><hp:subList>${p(run(t('밖') + inner))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`]);
    const doc = await extract(hwpx([sec(p(run(outer)))]));
    expect(doc.units[0]).toContain('밖');
    expect(doc.units[0]).toContain('i1 / i2; i3 / i4');
  });

  it('rowCnt/colCnt 가 병리 값이어도 256 으로 자른다', async () => {
    const doc = await extract(hwpx([sec(p(run(tbl(1, 1e9, [tc(0, 0, 'a')]))))]));
    expect(doc.units[0]!.split('\n')[0]!.split('|').length - 2).toBe(256);
  });

  // fix-round1(리뷰 지적): MAX_NEST_DEPTH(16) 를 넘는 중첩은 구조를 포기하더라도 텍스트는
  // 잃지 않아야 한다(docx.ts containerText 의 plainText 폴백과 같은 규칙). 이전 코드는 ''
  // 를 돌려줘 마커가 통째로 사라졌다.
  it('MAX_NEST_DEPTH 를 넘는 중첩도 마커 텍스트를 잃지 않는다 — 평문 폴백', async () => {
    const marker = '깊은마커';
    let cellContent = p(run(t(marker)));
    for (let i = 0; i < 18; i++) {
      const nested = tbl(1, 1, [`<hp:tc><hp:subList>${cellContent}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`]);
      cellContent = p(run(nested));
    }
    const doc = await extract(hwpx([sec(cellContent)]));
    expect(doc.units.join('\n')).toContain(marker);
  });
});
