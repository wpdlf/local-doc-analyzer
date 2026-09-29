import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 합성 PPTX 픽스처(실물은 개인정보가 있어 커밋하지 않는다). 실물 조사에서 조용히 틀리던 자리를
 * 일부러 담는다: rels 의 rId 를 슬라이드 순서와 반대로(파일명·rId 정렬 금지), 모든 슬라이드에
 * Google 식 `‹#›` 슬라이드 번호, 둘째 슬라이드에 제목 자리표시자·자기 닫힘 병합 표·발표자 노트.
 */
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const sp = (text: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>`
  + `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slideNum = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>`
  + `<p:txBody><a:bodyPr/><a:p><a:fld id="{0}" type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`;
const slide = (inner: string) => `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${inner}${slideNum}</p:spTree></p:cSld></p:sld>`;
const tc = (text: string) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const table = `<p:graphicFrame><p:nvGraphicFramePr/><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>`
  + `<a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>`
  + `<a:tr h="1">${tc('항목').replace('<a:tc>', '<a:tc rowSpan="2">')}${tc('매출')}</a:tr>`
  + `<a:tr h="1"><a:tc vMerge="1"/>${tc('영업이익')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const notes = `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sp('', 'sldImg')}${sp('근거 수치는 부록 참조', 'body')}</p:spTree></p:cSld></p:notes>`;

export function writeSamplePptx(path: string): void {
  const ids = ['rId9', 'rId8', 'rId7']; // 슬라이드 1·2·3 — rId 가 역순
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8(`<Relationships ${REL}><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${ids.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join('')}</p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<Relationships ${REL}>${ids.map((id, i) => `<Relationship Id="${id}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`),
    'ppt/slides/slide1.xml': strToU8(slide(sp('첫 슬라이드 본문'))),
    'ppt/slides/slide2.xml': strToU8(slide(sp('분기 실적 요약') + sp('둘째 슬라이드', 'title') + table)),
    'ppt/slides/_rels/slide2.xml.rels': strToU8(`<Relationships ${REL}><Relationship Id="rId2" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`),
    'ppt/notesSlides/notesSlide1.xml': strToU8(notes),
    'ppt/slides/slide3.xml': strToU8(slide(sp('셋째 슬라이드 본문'))),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zipSync(files));
}
