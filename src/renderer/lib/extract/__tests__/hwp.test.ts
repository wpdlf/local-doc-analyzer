// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { openCfb } from '../cfb';
import { createHwpExtractor, hwpExtractor } from '../hwp';
import type { ExtractOptions } from '../types';
import { buildCfb } from '../../../../../test/fixtures/cfb-builder';
import {
  buildHwp, para, table, cell, textBox, picture, groupedPicture, equation, ctrl, toArrayBuffer, T, type HwpSpec,
} from '../../../../../test/fixtures/hwp-builder';

const FIT = vi.fn(async (b: Uint8Array) => ({ base64: `b${b[0]}`, width: 100, height: 100, mimeType: 'image/jpeg' as const }));
const x = createHwpExtractor({ fitImage: FIT });
const indexOf = (spec: HwpSpec) => openCfb(toArrayBuffer(buildHwp(spec).bytes));
const extract = (spec: HwpSpec, opts: ExtractOptions = { extractImages: false }) => x.extract(indexOf(spec), opts);
const failCode = (p: Promise<unknown>) => p.then(() => 'no-throw', (e) => String((e as { code?: string }).code));
const LIST = { tag: T.LIST_HEADER, data: new Uint8Array(34) };

describe('sniff', () => {
  it('FileHeader 서명이 있는 CFB 만 고른다 — 암호 걸린 OOXML(CFB)·다른 서명은 아니다', () => {
    expect(hwpExtractor.sniff(indexOf({ sections: [[para('a')]] }))).toBe(true);
    const ooxml = openCfb(toArrayBuffer(buildCfb({ EncryptionInfo: new Uint8Array(200), EncryptedPackage: new Uint8Array(5000) }).bytes));
    expect(hwpExtractor.sniff(ooxml)).toBe(false);
    const other = openCfb(toArrayBuffer(buildCfb({ FileHeader: new TextEncoder().encode('NOT A Document File' + ' '.repeat(40)) }).bytes));
    expect(hwpExtractor.sniff(other)).toBe(false);
  });
});

describe('본문 · 쪽 나눔', () => {
  it('쪽 나눔(@11 bit2)과 구역 경계로 단위를 나눈다', async () => {
    const doc = await extract({ sections: [[para('첫 쪽'), para('둘째 쪽', { breakType: 0x04 }), para('같은 쪽')], [para('둘째 구역')]] });
    expect(doc.unitKind).toBe('page');
    expect(doc.units).toEqual(['첫 쪽', '둘째 쪽\n\n같은 쪽', '둘째 구역']);
  });

  it('다단 나눔(bit1)·글자 모양 수(@12)는 쪽을 나누지 않는다', async () => {
    const doc = await extract({ sections: [[para('가'), para('나', { breakType: 0x02 })]] });
    expect(doc.units).toEqual(['가\n\n나']);
  });

  it('PUA 글머리 기호는 본문에서 지운다', async () => {
    expect((await extract({ sections: [[para('\uDB80\uDEB1 항목')]] })).units).toEqual(['항목']);
  });

  it('구역 정의·머리말·각주의 텍스트는 본문에 들어가지 않는다', async () => {
    const doc = await extract({ sections: [[para([
      ctrl('secd'), ctrl('cold'), '본문',
      ctrl('head', [LIST, para('머리말 문구')]), ctrl('fn  ', [LIST, para('각주 문구')]),
    ])]] });
    expect(doc.units).toEqual(['본문']);
  });

  it('본문에 자리표시가 없는 컨트롤(비표준 작성기)도 잃지 않는다', async () => {
    const p = para('앞');
    p.children!.push(table(1, 1, [cell(0, 0, '숨은 표')]));
    expect((await extract({ sections: [[p]] })).units[0]).toContain('숨은 표');
  });

  it('텍스트가 없으면 DOC_NO_TEXT', async () => {
    expect(await failCode(extract({ sections: [[para('')]] }))).toBe('DOC_NO_TEXT');
  });

  it('압축 안 된 문서(flags bit0 = 0)도 읽는다', async () => {
    expect((await extract({ flags: 0, sections: [[para('무압축')]] })).units).toEqual(['무압축']);
  });
});

describe('표', () => {
  it('좌표 격자 GFM — 세로 병합 칸은 위 칸을 이어받고, 표 앞뒤 텍스트 순서를 지킨다', async () => {
    const t = table(2, 3, [cell(0, 0, '분류', { rowSpan: 2 }), cell(0, 1, '항목'), cell(0, 2, '달성률'), cell(1, 1, '기능 개발'), cell(1, 2, '100%')]);
    const doc = await extract({ sections: [[para(['앞 문장', t, '뒤 문장'])]] });
    expect(doc.units[0]).toBe('앞 문장\n\n| 분류 | 항목 | 달성률 |\n| --- | --- | --- |\n| 분류 | 기능 개발 | 100% |\n\n뒤 문장');
  });

  it('256행을 넘는 표도 잘리지 않는다 (QA35 회귀)', async () => {
    const cells = Array.from({ length: 300 }, (_, r) => cell(r, 0, `행${r}`));
    expect((await extract({ sections: [[para(table(300, 1, cells))]] })).units.join('\n')).toContain('| 행299 |');
  });

  it('선언 행 수가 모자라도 셀은 버리지 않는다 (R18)', async () => {
    const doc = await extract({ sections: [[para(table(1, 2, [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(1, 0, 'c'), cell(1, 1, 'd')]))]] });
    expect(doc.units[0]).toBe('| a | b |\n| --- | --- |\n| c | d |');
  });

  it('병리적 rowSpan 은 선언 행 수 밖으로 빈 행을 만들지 않는다 (R18)', async () => {
    const doc = await extract({ sections: [[para(table(2, 1, [cell(0, 0, 'a', { rowSpan: 60000 })]))]] });
    expect(doc.units[0]!.split('\n')).toHaveLength(3);
  });

  it('셀 안 표는 평탄화한다 (hwpx 와 같은 규칙)', async () => {
    const inner = table(1, 2, [cell(0, 0, '안1'), cell(0, 1, '안2')]);
    const doc = await extract({ sections: [[para(table(1, 1, [{ row: 0, col: 0, paras: [para(['밖 ', inner])] }]))]] });
    expect(doc.units[0]).toContain('밖 안1 / 안2');
  });

  it('중첩이 깊이 상한(16)을 넘어도 던지지 않고 텍스트를 남긴다', async () => {
    let t = table(1, 1, [cell(0, 0, '가장 안쪽')]);
    for (let i = 0; i < 20; i++) t = table(1, 1, [{ row: 0, col: 0, paras: [para(t)] }]);
    expect((await extract({ sections: [[para(t)]] })).units.join('')).toContain('가장 안쪽');
  });
});

describe('캡션 · 비본문 컨트롤', () => {
  const captioned = (t: ReturnType<typeof table>) => {
    const kids = [...t.children!];
    kids.splice(kids.findIndex((k) => k.tag === T.TABLE), 0, { tag: T.LIST_HEADER, data: new Uint8Array(47) }, para('표 1. 캡션'));
    return { ...t, children: kids };
  };
  it('표 캡션은 셀도 본문도 아니다 (hwpx 와 같다)', async () => {
    const doc = await extract({ sections: [[para(captioned(table(1, 2, [cell(0, 0, 'a'), cell(0, 1, 'b')])))]] });
    expect(doc.units[0]).toBe('| a | b |\n| --- | --- |');
  });

  it('그림 캡션은 글상자 블록이 되지 않고 그림은 그대로 모은다', async () => {
    const pic = picture(1);
    pic.children!.unshift({ tag: T.LIST_HEADER, data: new Uint8Array(34) }, para('그림 1. 캡션'));
    const doc = await extract({
      bins: [{ id: 1, ext: 'jpg', bytes: new Uint8Array(64).fill(1) }],
      sections: [[para(['본문', pic])]],
    }, { extractImages: true });
    expect(doc.units).toEqual(['본문']);
    expect(doc.images.map((i) => i.base64)).toEqual(['b1']);
  });

  it('표 셀 안 각주의 그림은 Vision 대상이 아니다 (텍스트가 빠지는 것과 같은 규칙)', async () => {
    const bins = [1, 2].map((id) => ({ id, ext: 'jpg', bytes: new Uint8Array(64).fill(id) }));
    const inCell = para(['칸', picture(1), ctrl('fn  ', [LIST, para(['각주', picture(2)])])]);
    const doc = await extract({
      bins, sections: [[para(table(1, 1, [{ row: 0, col: 0, paras: [inCell] }]))]],
    }, { extractImages: true });
    expect(doc.images.map((i) => i.base64)).toEqual(['b1']);
  });
});

describe('글상자 · 수식 · 제목', () => {
  it('글상자 텍스트는 호스트 문단 뒤 블록이 된다', async () => {
    const doc = await extract({ sections: [[para(['본문', textBox([para('상자 안 제목')])]), para('다음 문단')]] });
    expect(doc.units[0]).toBe('본문\n\n상자 안 제목\n\n다음 문단');
  });

  it('수식은 [수식: 스크립트] — 앞뒤 글자와 한 칸 띄운다', async () => {
    const doc = await extract({ sections: [[para(['값은', equation('{a} over {b}'), '이다'])]] });
    expect(doc.units[0]).toBe('값은 [수식: {a} over {b}] 이다');
  });

  it('개요 문단 모양을 쓰는 문단은 제목(수준 동반)이다', async () => {
    const doc = await extract({
      paraShapes: [{ head: 0, level: 0 }, { head: 1, level: 0 }, { head: 1, level: 1 }],
      sections: [[para('Ⅰ. 서비스 명세', { shape: 1 }), para('본문'), para('가. 개요', { shape: 2 }), para('본문2')]],
    });
    expect(doc.headings).toEqual([{ level: 1, title: 'Ⅰ. 서비스 명세', unitIndex: 0 }, { level: 2, title: '가. 개요', unitIndex: 0 }]);
  });
});

describe('그림', () => {
  const bin = (id: number, over: Partial<{ type: number; compress: 0 | 1 | 2 }> = {}) => ({ id, ext: 'jpg', bytes: new Uint8Array(64).fill(id), ...over });

  it('BinData 를 풀어 Vision 대상으로 — 본문·표 안·글상자 안·그룹 안 모두, 단위 매핑 유지', async () => {
    FIT.mockClear();
    const doc = await extract({
      bins: [bin(1), bin(2), bin(3), bin(4)],
      sections: [[
        para(['첫 쪽', picture(1)]),
        para(['둘째 쪽', table(1, 1, [{ row: 0, col: 0, paras: [para(['칸', picture(2)])] }])], { breakType: 0x04 }),
        para(['셋째 쪽', textBox([para(['상자', picture(3)])])], { breakType: 0x04 }),
        para(['넷째 쪽', groupedPicture(5, 4)], { breakType: 0x04 }),
      ]],
    }, { extractImages: true });
    expect(doc.images.map((i) => [i.base64, i.unitIndex])).toEqual([['b1', 0], ['b2', 1], ['b3', 2], ['b4', 3]]);
  });

  it('깨진 그림은 그 그림만 건너뛴다 · 무압축(2) 그림은 그대로 · 링크형은 무시', async () => {
    const doc = await extract({
      bins: [bin(1, { compress: 2 }), bin(2), bin(3, { type: 0 })],
      override: { 'BinData/BIN0002.jpg': new Uint8Array([0xff, 0xff, 0xff]) },
      sections: [[para(['a', picture(1), picture(2), picture(3)])]],
    }, { extractImages: true });
    expect(doc.images.map((i) => i.base64)).toEqual(['b1']);
  });

  it('extractImages=false 면 그림을 풀지도 않는다', async () => {
    FIT.mockClear();
    const doc = await extract({ bins: [bin(1)], sections: [[para(['a', picture(1)])]] });
    expect(doc.images).toEqual([]);
    expect(FIT).not.toHaveBeenCalled();
  });
});

describe('거절 · 손상 · 상한', () => {
  it.each<[string, Partial<HwpSpec>, string]>([
    ['암호(bit1)', { flags: 0x03 }, 'DOC_ENCRYPTED'],
    ['DRM(bit4)', { flags: 0x11 }, 'DOC_ENCRYPTED'],
    ['배포용(bit2)', { flags: 0x05 }, 'DOC_DISTRIBUTION'],
    ['배포용 + 암호 — 배포용 안내가 먼저', { flags: 0x07 }, 'DOC_DISTRIBUTION'],
    ['주 버전 3', { version: 0x03000000 }, 'DOC_UNSUPPORTED'],
    ['본문이 ViewText/ 에만 있음', { bodyDir: 'ViewText' }, 'DOC_DISTRIBUTION'],
    ['본문 구역 없음', { omit: ['BodyText/Section0'] }, 'DOC_CORRUPT'],
    ['DocInfo 없음', { omit: ['DocInfo'] }, 'DOC_CORRUPT'],
  ])('%s → %s', async (_name, over, code) => {
    expect(await failCode(extract({ sections: [[para('본문')]], ...over }))).toBe(code);
  });

  it('구역 하나가 깨지면 일부만 내지 않고 문서 전체가 DOC_CORRUPT (압축 · 무압축)', async () => {
    const broken = { 'BodyText/Section1': new Uint8Array([1, 2, 3]) };
    expect(await failCode(extract({ sections: [[para('정상')], [para('x')]], override: broken }))).toBe('DOC_CORRUPT');
    expect(await failCode(extract({ flags: 0, sections: [[para('정상')], [para('x')]], override: broken }))).toBe('DOC_CORRUPT');
  });

  it('압축 해제 누적이 상한을 넘으면 DOC_TOO_LARGE — 구역마다가 아니라 합계로 센다', async () => {
    const big = 'ㄱ'.repeat(30_000); // 구역당 ~60KB(UTF-16)
    const small = () => createHwpExtractor({ fitImage: FIT, maxInflateBytes: 100_000 });
    expect(await failCode(small().extract(indexOf({ sections: [[para(big)], [para(big)]] }), { extractImages: false }))).toBe('DOC_TOO_LARGE');
    await expect(small().extract(indexOf({ sections: [[para(big)]] }), { extractImages: false })).resolves.toBeDefined();
  });

  it('무압축 문서도 읽은 바이트를 같은 예산으로 센다 — 상한은 "읽거나 푼 바이트" 합계다', async () => {
    const big = 'ㄱ'.repeat(30_000);
    const small = () => createHwpExtractor({ fitImage: FIT, maxInflateBytes: 100_000 });
    expect(await failCode(small().extract(indexOf({ flags: 0, sections: [[para(big)], [para(big)]] }), { extractImages: false }))).toBe('DOC_TOO_LARGE');
    await expect(small().extract(indexOf({ flags: 0, sections: [[para(big)]] }), { extractImages: false })).resolves.toBeDefined();
  });

  it('무압축 구역 항목들이 한 섹터 체인을 나눠 가져도 읽을 때마다 센다(읽기 증폭)', async () => {
    const big = 'ㄱ'.repeat(30_000);
    const layout = buildHwp({ flags: 0, sections: [[para(big)], [para('x')]] });
    // Section1 항목의 시작 섹터·크기를 Section0 것으로 바꾼다 — 같은 체인을 두 번 읽는다.
    const dv = new DataView(layout.bytes.buffer, layout.bytes.byteOffset);
    const s0 = layout.entryOffset('BodyText/Section0');
    const s1 = layout.entryOffset('BodyText/Section1');
    dv.setUint32(s1 + 116, dv.getUint32(s0 + 116, true), true);
    dv.setUint32(s1 + 120, dv.getUint32(s0 + 120, true), true);
    const small = createHwpExtractor({ fitImage: FIT, maxInflateBytes: 100_000 });
    expect(await failCode(small.extract(openCfb(toArrayBuffer(layout.bytes)), { extractImages: false }))).toBe('DOC_TOO_LARGE');
  });

  it('압축 그림은 구역과 같은 예산을 나눠 쓴다 — 구역만은 상한 안이어도 그림까지 합치면 DOC_TOO_LARGE', async () => {
    const big = 'ㄱ'.repeat(30_000); // 구역 ~60KB
    // 그림 하나(60KB)만으로는 상한(100KB) 안이다 — 새 예산을 쓰거나 DOC_TOO_LARGE 를 삼키면 통과해 버린다.
    const spec: HwpSpec = { bins: [{ id: 1, ext: 'jpg', bytes: new Uint8Array(60_000).fill(7) }], sections: [[para([big, picture(1)])]] };
    const small = createHwpExtractor({ fitImage: FIT, maxInflateBytes: 100_000 });
    await expect(small.extract(indexOf(spec), { extractImages: false })).resolves.toBeDefined();
    expect(await failCode(small.extract(indexOf(spec), { extractImages: true }))).toBe('DOC_TOO_LARGE');
  });

  it('무압축 그림도 같은 예산으로 센다', async () => {
    const pic = new Uint8Array(80_000).fill(7);
    const spec: HwpSpec = { flags: 0, bins: [{ id: 1, ext: 'jpg', bytes: pic }], sections: [[para(['본문', picture(1)])]] };
    const small = createHwpExtractor({ fitImage: FIT, maxInflateBytes: 50_000 });
    expect(await failCode(small.extract(indexOf(spec), { extractImages: true }))).toBe('DOC_TOO_LARGE');
    // 그림을 싣지 않으면 읽지 않으므로 같은 상한 안이다
    await expect(small.extract(indexOf(spec), { extractImages: false })).resolves.toBeDefined();
  });
});

describe('컨트롤 짝 맞추기 규모', () => {
  it('문단 하나의 컨트롤이 수만 개여도 선형으로 짝을 맞춘다 — 세그먼트마다 컨트롤 전체를 훑지 않는다', async () => {
    const n = 40_000;
    const items: (string | ReturnType<typeof ctrl>)[] = ['앞'];
    for (let i = 0; i < n; i++) items.push(ctrl('atno'));
    items.push(equation('x'), '뒤');
    const index = indexOf({ sections: [[para(items)]] });
    const t0 = performance.now();
    const doc = await x.extract(index, { extractImages: false });
    const ms = performance.now() - t0;
    expect(doc.units[0]).toContain('앞 [수식: x] 뒤');
    expect(ms).toBeLessThan(1_500);
  });
});

describe('취소 · 진행률', () => {
  it('이미 취소된 신호면 바로 ABORTED', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await failCode(x.extract(indexOf({ sections: [[para('a')]] }), { signal: ac.signal }))).toBe('ABORTED');
  });

  it('구역마다 취소를 확인한다 — 둘째 구역 시작에서 멈춘다', async () => {
    const ac = new AbortController();
    const onProgress = vi.fn((cur: number) => { if (cur === 1) ac.abort(); });
    const spec = { sections: [[para('a')], [para('b')], [para('c')]] };
    expect(await failCode(x.extract(indexOf(spec), { extractImages: false, signal: ac.signal, onProgress }))).toBe('ABORTED');
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });

  it('진행률은 구역 단위 n / total 이고 끝에 total / total', async () => {
    const onProgress = vi.fn();
    await x.extract(indexOf({ sections: [[para('a')], [para('b')]] }), { extractImages: false, onProgress });
    expect(onProgress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
  });
});
