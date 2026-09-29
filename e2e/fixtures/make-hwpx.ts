import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 합성 HWPX 픽스처(실물은 개인정보가 있어 커밋하지 않는다 — 설계 §11 A1). 실물 조사의 함정을
 * 담는다: rootfile 3개, spine 에 header, 표의 pageBreak="CELL", 세로 병합으로 **가려진 칸 생략**,
 * subList 가 cellAddr 보다 앞, 글상자(drawText) 안의 본문, shapeComment 자동 문구, 잘린 PrvText.
 */
const NS = 'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"';
/**
 * fix(brief): 문자열 접합(기본 속성 + override 문자열)은 override 가 있을 때 `pageBreak` 가
 * **두 번** 나와 XML well-formedness 위반이 된다. happy-dom 은 중복 속성을 관용해 첫 값(`0`)만
 * 남기지만(hwpx.test.ts fix-round2 주석이 이미 경고한 바로 그 함정) 실 Chromium 의 DOMParser 는
 * parsererror 를 내 이 문서 전체가 DOC_CORRUPT 로 죽는다 — 실앱에서만 드러난 함정이다. 속성을
 * 객체로 병합해 중복 자체를 없앤다(hwpx.test.ts 의 `p()` 와 동일 수정).
 */
const P_DEFAULTS = { paraPrIDRef: '0', styleIDRef: '0', pageBreak: '0', columnBreak: '0', merged: '0' } as const;
const p = (inner: string, override: Record<string, string> = {}) => {
  const attrs = { ...P_DEFAULTS, ...override };
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<hp:p ${attrStr}>${inner}</hp:p>`;
};
const run = (inner: string) => `<hp:run charPrIDRef="0">${inner}</hp:run>`;
const t = (s: string) => `<hp:t>${s}</hp:t>`;
const tc = (row: number, col: number, text: string, rowSpan = 1) =>
  `<hp:tc><hp:subList>${p(run(t(text)))}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="${rowSpan}"/><hp:cellSz width="1" height="1"/></hp:tc>`;
const table = `<hp:tbl rowCnt="2" colCnt="3" pageBreak="CELL">`
  + `<hp:tr>${tc(0, 0, '분류', 2)}${tc(0, 1, '항목')}${tc(0, 2, '달성률')}</hp:tr>`
  + `<hp:tr>${tc(1, 1, '기능 개발')}${tc(1, 2, '100%')}</hp:tr></hp:tbl>`;
const box = `<hp:rect><hp:shapeComment>사각형입니다.</hp:shapeComment><hp:drawText><hp:subList>${p(run(t('상자 안 제목')))}</hp:subList></hp:drawText></hp:rect>`;
const section = `<?xml version="1.0"?><hs:sec ${NS}>`
  + p(run(t('첫 쪽의 내용입니다')))
  + p(run(t('둘째 쪽의 내용입니다') + box), { pageBreak: '1' })
  + p(run(table))
  + `</hs:sec>`;

export function writeSampleHwpx(path: string): void {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/hwp+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles>'
      + '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>'
      + '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>'),
    'Contents/content.hpf': strToU8('<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>'
      + '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>'
      + '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>'
      + '</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'),
    'Contents/header.xml': strToU8('<?xml version="1.0"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"/>'),
    'Contents/section0.xml': strToU8(section),
    'Preview/PrvText.txt': strToU8('첫 쪽의 내'),
  };
  mkdirSync(dirname(path), { recursive: true });
  // mimetype 은 첫 엔트리·무압축(OCF 규약, 실물도 그렇다).
  writeFileSync(path, zipSync(files, { level: 0 }));
}
