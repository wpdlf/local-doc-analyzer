// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { parseXml } from '../xml';
import { pptxGraphics } from '../pptx-graphics';
import type { ZipIndex } from '../types';

const NS = 'xmlns:a="urn:a" xmlns:r="urn:r" xmlns:c="urn:c" xmlns:dgm="urn:dgm" xmlns:p="urn:p"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const el = (xml: string) => parseXml(xml).documentElement;
function zipOf(files: Record<string, string>): ZipIndex {
  const u8 = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}
const tc = (text: string, attrs = '') => `<a:tc ${attrs}><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;

describe('pptx 표', () => {
  it('세로 연속 칸은 위 칸 텍스트를 복사, 가로 연속 칸은 비운다 — Google 의 자기 닫힘 연속 칸 포함', () => {
    const tbl = el(`<a:tbl ${NS}><a:tblGrid><a:gridCol/><a:gridCol/><a:gridCol/></a:tblGrid>`
      + `<a:tr>${tc('분류', 'rowSpan="2"')}${tc('머리', 'gridSpan="2"')}${tc('', 'hMerge="1"')}</a:tr>`
      + `<a:tr><a:tc vMerge="1"/>${tc('x')}${tc('y')}</a:tr></a:tbl>`);
    expect(pptxGraphics.table(tbl)).toBe('| 분류 | 머리 |  |\n| --- | --- | --- |\n| 분류 | x | y |');
  });

  it('행이 격자보다 짧으면 빈 칸으로 채운다', () => {
    const tbl = el(`<a:tbl ${NS}><a:tblGrid><a:gridCol/><a:gridCol/></a:tblGrid><a:tr>${tc('a')}</a:tr><a:tr>${tc('b')}${tc('c')}</a:tr></a:tbl>`);
    expect(pptxGraphics.table(tbl)).toBe('| a |  |\n| --- | --- |\n| b | c |');
  });
});

describe('pptx 차트 (합성 — 실물 코퍼스에 없었다)', () => {
  const frame = el(`<p:graphicFrame ${NS}><a:graphic><a:graphicData uri="…/chart"><c:chart r:id="rIdC"/></a:graphicData></a:graphic></p:graphicFrame>`);
  const chartXml = `<c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>분기 매출</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart>`
    + `<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2025</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + `<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`
    + `</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
  const zip = zipOf({
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdC" Type="x/chart" Target="../charts/chart1.xml"/></Relationships>`,
    'ppt/charts/chart1.xml': chartXml,
  });

  it('제목 + 캐시 값 표(행=계열, 열=항목)', () => {
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zip)).toBe('분기 매출\n\n|  | Q1 | Q2 |\n| --- | --- | --- |\n| 2025 | 10 | 12 |');
  });

  it('차트 파트가 없으면 빈 문자열(문서 열기를 실패시키지 않는다)', () => {
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipOf({}))).toBe('');
  });

  it('항목이 50개를 넘으면 자른다(수백 항목 차트가 표를 도배하지 않게)', () => {
    const idxs = Array.from({ length: 51 }, (_, i) => i);
    const catPts = idxs.map((i) => `<c:pt idx="${i}"><c:v>C${i}</c:v></c:pt>`).join('');
    const valPts = idxs.map((i) => `<c:pt idx="${i}"><c:v>${i}</c:v></c:pt>`).join('');
    const manyChartXml = `<c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart><c:ser>`
      + `<c:cat><c:strRef><c:strCache>${catPts}</c:strCache></c:strRef></c:cat>`
      + `<c:val><c:numRef><c:numCache>${valPts}</c:numCache></c:numRef></c:val>`
      + `</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    const manyZip = zipOf({
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdC" Type="x/chart" Target="../charts/chart1.xml"/></Relationships>`,
      'ppt/charts/chart1.xml': manyChartXml,
    });
    const result = pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', manyZip);
    expect(result).toContain('C49');
    expect(result).not.toContain('C50');
  });
});

describe('pptx SmartArt (합성)', () => {
  const frame = el(`<p:graphicFrame ${NS}><a:graphic><a:graphicData uri="…/diagram"><dgm:relIds r:dm="rIdD" r:lo="x" r:qs="y" r:cs="z"/></a:graphicData></a:graphic></p:graphicFrame>`);
  const data = `<dgm:dataModel ${NS}><dgm:ptLst>`
    + `<dgm:pt modelId="0" type="doc"><dgm:t><a:p><a:r><a:t>루트</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `<dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>기획</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `<dgm:pt modelId="2" type="parTrans"><dgm:t><a:p><a:r><a:t>연결선</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `<dgm:pt modelId="3" type="node"><dgm:t><a:p><a:r><a:t>개발</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `</dgm:ptLst></dgm:dataModel>`;
  const zip = zipOf({
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdD" Type="x/diagramData" Target="../diagrams/data1.xml"/></Relationships>`,
    'ppt/diagrams/data1.xml': data,
    'ppt/diagrams/drawing1.xml': '<dsp:drawing xmlns:dsp="urn:dsp"><a:t xmlns:a="urn:a">기획</a:t></dsp:drawing>',
  });

  it('node 점의 텍스트만 목록으로 — 연결선·문서 루트·drawing 중복은 제외', () => {
    expect(pptxGraphics.smartArt(frame, 'ppt/slides/slide1.xml', zip)).toBe('- 기획\n- 개발');
  });
});
