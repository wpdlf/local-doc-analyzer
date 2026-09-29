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

  const zipWith = (xml: string) => zipOf({
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdC" Type="x/chart" Target="../charts/chart1.xml"/></Relationships>`,
    'ppt/charts/chart1.xml': xml,
  });
  const oneSeries = `<c:ser><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>7</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`;

  // F6a: 제목의 문단이 둘이면 예전엔 "매출2025" 로 붙었다.
  it('여러 문단 제목은 문단을 붙이지 않는다', () => {
    const xml = `<c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>매출</a:t></a:r></a:p><a:p><a:r><a:t>2025</a:t></a:r></a:p></c:rich></c:tx></c:title>`
      + `<c:plotArea><c:barChart>${oneSeries}</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    const result = pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipWith(xml));
    expect(result).not.toContain('매출2025');
    expect(result.startsWith('매출\n2025\n\n|')).toBe(true);
  });

  // F6b: 제목은 차트 수준(`c:chart > c:title`)만 본다. 예전엔 서브트리의 첫 `title` 을 잡아,
  // 차트 제목이 없으면 축 제목("백만 원")이 차트 제목처럼 맨 앞에 나왔다.
  it('축 제목만 있는 차트는 제목 줄을 내지 않는다', () => {
    const xml = `<c:chartSpace ${NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:barChart>${oneSeries}</c:barChart>`
      + `<c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>백만 원</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx>`
      + `</c:plotArea></c:chart></c:chartSpace>`;
    const result = pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipWith(xml));
    expect(result).not.toContain('백만 원');
    expect(result.startsWith('|')).toBe(true);
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
    // QA35: 잘린 것을 밝힌다 — 모르면 AI 가 잘린 표를 전체로 읽는다.
    expect(result.endsWith('\n\n… (항목 categories 50/51)')).toBe(true);
  });

  it('잘리지 않았으면 잘림 표시 줄을 붙이지 않는다', () => {
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zip)).not.toContain('…');
  });

  // QA35: ptCount 가 캐시 점보다 많다고 말하면(뒤쪽 점이 캐시에 없음) 그것도 잘림이다.
  it('ptCount 가 상한을 넘으면 캐시 점이 적어도 잘림을 밝힌다', () => {
    const xml = `<c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart><c:ser>`
      + `<c:cat><c:strRef><c:strCache><c:ptCount val="80"/><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:strCache></c:strRef></c:cat>`
      + `<c:val><c:numRef><c:numCache><c:ptCount val="80"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val>`
      + `</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipWith(xml))).toContain('50/80');
  });

  // QA35: 다단계 항목 — 첫 c:lvl 이 안쪽(분기), 다음이 바깥(연도). 예전엔 바깥 lvl 이 안쪽 값을
  // 덮어 `Y2023 | Q2 | Y2024 | Q2` 가 됐다(Q1 이 사라짐).
  it('다단계 항목은 안쪽 값에, 바깥 값이 있는 칸에만 바깥 값을 앞에 붙인다', () => {
    const lvl = (vals: [number, string][]) => `<c:lvl>${vals.map(([i, v]) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:lvl>`;
    const xml = `<c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart><c:ser>`
      + `<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>매출</c:v></c:pt></c:strCache></c:strRef></c:tx>`
      + `<c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:ptCount val="4"/>`
      + lvl([[0, 'Q1'], [1, 'Q2'], [2, 'Q1'], [3, 'Q2']]) + lvl([[0, 'Y2023'], [2, 'Y2024']])
      + `</c:multiLvlStrCache></c:multiLvlStrRef></c:cat>`
      + `<c:val><c:numRef><c:numCache>${[1, 2, 3, 4].map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val>`
      + `</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipWith(xml)))
      .toBe('|  | Y2023 Q1 | Q2 | Y2024 Q1 | Q2 |\n| --- | --- | --- | --- | --- |\n| 매출 | 1 | 2 | 3 | 4 |');
  });

  // QA35: 분산형은 c:cat/c:val 이 아니라 c:xVal/c:yVal 이다 — 예전엔 표가 계열 이름만 남았다.
  it('분산형은 x 값을 머리글로, y 값을 행으로 둔다', () => {
    const pts = (vals: number[]) => vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
    const xml = `<c:chartSpace ${NS}><c:chart><c:plotArea><c:scatterChart><c:ser>`
      + `<c:tx><c:v>측정</c:v></c:tx>`
      + `<c:xVal><c:numRef><c:numCache>${pts([1, 2, 3])}</c:numCache></c:numRef></c:xVal>`
      + `<c:yVal><c:numRef><c:numCache>${pts([10, 20, 30])}</c:numCache></c:numRef></c:yVal>`
      + `</c:ser></c:scatterChart></c:plotArea></c:chart></c:chartSpace>`;
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipWith(xml)))
      .toBe('|  | 1 | 2 | 3 |\n| --- | --- | --- | --- |\n| 측정 | 10 | 20 | 30 |');
  });

  // QA35: 리터럴 계열 이름(c:tx > c:v)은 pt 가 없어 예전엔 빈 칸이 됐다.
  it('리터럴 계열 이름(c:tx > c:v)을 읽는다', () => {
    const xml = `<c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart>`
      + oneSeries.replace('<c:ser>', '<c:ser><c:tx><c:v>직접 입력</c:v></c:tx>')
      + `</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipWith(xml))).toContain('| 직접 입력 | 7 |');
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

  // F6a: 점 하나에 문단이 둘이면 예전엔 a:t 를 구분자 없이 이어 "첫째둘째" 가 됐다. 목록 항목은
  // 한 줄이어야 하므로 문단을 공백으로 잇는다.
  it('여러 문단으로 된 점은 문단을 공백으로 이어 한 항목으로 — 붙지 않는다', () => {
    const twoPara = `<dgm:dataModel ${NS}><dgm:ptLst>`
      + `<dgm:pt modelId="1"><dgm:t><a:bodyPr/><a:p><a:r><a:t>첫째</a:t></a:r></a:p><a:p><a:r><a:t>둘째</a:t></a:r></a:p></dgm:t></dgm:pt>`
      + `</dgm:ptLst></dgm:dataModel>`;
    const z = zipOf({
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdD" Type="x/diagramData" Target="../diagrams/data1.xml"/></Relationships>`,
      'ppt/diagrams/data1.xml': twoPara,
    });
    expect(pptxGraphics.smartArt(frame, 'ppt/slides/slide1.xml', z)).toBe('- 첫째 둘째');
  });
});
