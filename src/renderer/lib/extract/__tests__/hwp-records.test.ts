import { describe, it, expect, vi } from 'vitest';
import { deflateSync, Inflate } from 'fflate';
import { TAG, parseRecords, buildTree, inflateBudgeted, readParaText, ctrlIdAt, stripPua } from '../hwp-records';
import { T, serialize, para, table, cell } from '../../../../../test/fixtures/hwp-builder';

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as { code?: string }).code); }
  return 'no-throw';
};
const u16s = (...units: number[]) => {
  const b = new Uint8Array(units.length * 2);
  units.forEach((u, i) => { b[i * 2] = u & 0xff; b[i * 2 + 1] = u >>> 8; });
  return b;
};
let seed = 1;
// xorshift32 — LCG 상위 바이트는 규칙이 남아 100KB 가 16KB 미만으로 압축된다
const noise = (n: number) => Uint8Array.from({ length: n }, () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed & 0xff;
});

describe('레코드 분해', () => {
  it('TAG 는 스펙 값이다 — 작성기의 독립 상수와 대조', () => {
    expect(TAG).toMatchObject({
      DOCUMENT_PROPERTIES: T.DOCUMENT_PROPERTIES, BIN_DATA: T.BIN_DATA, PARA_SHAPE: T.PARA_SHAPE,
      PARA_HEADER: T.PARA_HEADER, PARA_TEXT: T.PARA_TEXT, CTRL_HEADER: T.CTRL_HEADER, LIST_HEADER: T.LIST_HEADER,
      SHAPE_COMPONENT: T.SHAPE_COMPONENT, TABLE: T.TABLE, SHAPE_COMPONENT_PICTURE: T.PICTURE, EQEDIT: T.EQEDIT,
    });
  });

  it('태그·레벨·크기를 분해하고 레벨로 트리를 묶는다', () => {
    const flat = parseRecords(serialize([para(['앞', table(1, 1, [cell(0, 0, '칸')])])]));
    expect(flat.map((r) => [r.tag, r.level])).toEqual([
      [T.PARA_HEADER, 0], [T.PARA_TEXT, 1], [T.PARA_CHAR_SHAPE, 1], [T.CTRL_HEADER, 1],
      [T.TABLE, 2], [T.LIST_HEADER, 2], [T.PARA_HEADER, 2], [T.PARA_TEXT, 3], [T.PARA_CHAR_SHAPE, 3],
    ]);
    const [root] = buildTree(flat);
    expect(root!.children.map((c) => c.tag)).toEqual([T.PARA_TEXT, T.PARA_CHAR_SHAPE, T.CTRL_HEADER]);
    expect(root!.children[2]!.children.map((c) => c.tag)).toEqual([T.TABLE, T.LIST_HEADER, T.PARA_HEADER]);
  });

  it('크기 필드가 0xFFF 면 다음 4바이트가 실제 크기다', () => {
    const [r] = parseRecords(serialize([{ tag: T.PARA_TEXT, data: new Uint8Array(5000).fill(7) }]));
    expect(r!.data.length).toBe(5000);
  });

  it('크기가 남은 바이트를 넘거나 헤더가 잘리면 DOC_CORRUPT', () => {
    const b = serialize([{ tag: T.PARA_TEXT, data: new Uint8Array(10) }]);
    expect(codeOf(() => parseRecords(b.slice(0, 8)))).toBe('DOC_CORRUPT');
    expect(codeOf(() => parseRecords(b.slice(0, 2)))).toBe('DOC_CORRUPT');
  });

  it('레벨이 건너뛰어도(손상) 가장 가까운 얕은 조상에 붙는다', () => {
    const flat = [0, 3, 1].map((level) => ({ tag: 1, level, data: new Uint8Array(0), children: [] }));
    const roots = buildTree(flat);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children.map((c) => c.level)).toEqual([3, 1]);
  });
});

describe('inflateBudgeted — 문서 전체 누적 예산', () => {
  it('여러 청크로 나뉘는 입력(>16KB 압축)도 원문을 복원한다', () => {
    const src = noise(100_000);
    const z = deflateSync(src);
    expect(z.length).toBeGreaterThan(16 * 1024);
    expect(inflateBudgeted(z, { remaining: 1_000_000 })).toEqual(src);
  });

  it('예산은 호출 사이에 누적된다 — 각각은 상한 안이어도 합이 넘으면 DOC_TOO_LARGE', () => {
    const budget = { remaining: 150_000 };
    const z = deflateSync(noise(100_000));
    inflateBudgeted(z, budget);
    expect(codeOf(() => inflateBudgeted(z, budget))).toBe('DOC_TOO_LARGE');
  });

  it('압축 폭탄은 다 풀기 전에 멈춘다', () => {
    const bomb = deflateSync(new Uint8Array(50_000_000));
    const budget = { remaining: 1_000_000 };
    expect(codeOf(() => inflateBudgeted(bomb, budget))).toBe('DOC_TOO_LARGE');
    expect(budget.remaining).toBeGreaterThan(-20_000_000); // 50MB 를 다 푼 뒤가 아니다
  });

  it('스트림 끝 뒤의 꼬리 바이트는 버리고 푼 내용을 낸다 — 꼬리를 계속 밀어 넣지 않는다(O(n²) 방지)', () => {
    // fflate Inflate 는 스트림이 끝난 뒤 push 된 바이트를 소비하지 않고 내부 버퍼에 이어 붙여 매번 복사한다.
    // 꼬리가 크면 push 횟수 × 버퍼 크기 = O(n²) 이고, 출력이 없어 예산도 걸리지 않는다.
    const src = noise(1_000);
    const z = deflateSync(src);
    const padded = new Uint8Array(z.length + 8 * 1024 * 1024);
    padded.set(z, 0);
    const push = vi.spyOn(Inflate.prototype, 'push');
    try {
      const t0 = performance.now();
      expect(inflateBudgeted(padded, { remaining: 1_000_000 })).toEqual(src);
      // 8MB 꼬리를 16KB 씩 다 넣으면 512회다. 스트림이 첫 청크에서 끝나므로 한 번이면 된다.
      expect(push.mock.calls.length).toBeLessThanOrEqual(2);
      expect(performance.now() - t0).toBeLessThan(2_000);
    } finally {
      push.mockRestore();
    }
  });

  it('여러 청크에 걸친 스트림 뒤의 꼬리도 버린다 — 끝난 뒤로는 push 하지 않는다', () => {
    const src = noise(100_000);
    const z = deflateSync(src);
    const padded = new Uint8Array(z.length + 4 * 1024 * 1024);
    padded.set(z, 0);
    const push = vi.spyOn(Inflate.prototype, 'push');
    try {
      expect(inflateBudgeted(padded, { remaining: 1_000_000 })).toEqual(src);
      expect(push.mock.calls.length).toBeLessThanOrEqual(Math.ceil(z.length / (16 * 1024)) + 1);
    } finally {
      push.mockRestore();
    }
  });

  it('저장(무압축) 블록은 16KB push 에 출력이 0 일 수 있다 — 그것을 스트림 끝으로 오인하지 않는다', () => {
    const src = noise(200_000);
    const z = deflateSync(src, { level: 0 });
    const padded = new Uint8Array(z.length + 100_000);
    padded.set(z, 0);
    expect(inflateBudgeted(z, { remaining: 1_000_000 })).toEqual(src);
    expect(inflateBudgeted(padded, { remaining: 1_000_000 })).toEqual(src);
  });

  it('deflate 가 아니면 DOC_CORRUPT', () => {
    expect(codeOf(() => inflateBudgeted(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), { remaining: 1e6 }))).toBe('DOC_CORRUPT');
  });
});

describe('readParaText', () => {
  it('확장 컨트롤은 8 wchar 를 건너뛰고 그 자리에 컨트롤 id 를 남긴다', () => {
    const p = para(['앞 ', table(1, 1, [cell(0, 0, 'x')]), ' 뒤']);
    expect(readParaText(p.children![0]!.data)).toEqual([
      { kind: 'text', text: '앞 ' }, { kind: 'ctrl', id: 'tbl ' }, { kind: 'text', text: ' 뒤' },
    ]);
  });

  it('탭(인라인 8 wchar) · 줄바꿈(10) · 하이픈(24) · 빈칸(30·31) · 문단 끝(13)', () => {
    const d = u16s(0x61, 9, 0, 0, 0, 0, 0, 0, 9, 0x62, 10, 0x63, 24, 0x64, 30, 31, 0x65, 13);
    expect(readParaText(d)).toEqual([{ kind: 'text', text: 'a\tb\nc-d  e' }]);
  });

  it('사용자 정의 영역(PUA) 문자는 BMP·보충 평면 모두 지운다', () => {
    expect(readParaText(para('가\uE000나\u{F02B1}다').children![0]!.data)).toEqual([{ kind: 'text', text: '가나다' }]);
    expect(stripPua('\uF8FF a \u{10FFFF}')).toBe(' a ');
  });

  it('컨트롤이 문단 끝에서 잘리면 DOC_CORRUPT', () => {
    expect(codeOf(() => readParaText(u16s(0x41, 11, 0, 0)))).toBe('DOC_CORRUPT');
  });

  it('ctrlIdAt 은 저장 바이트를 뒤집어 읽는다 (실물 20 6c 62 74 → "tbl ")', () => {
    expect(ctrlIdAt(new Uint8Array([0x20, 0x6c, 0x62, 0x74]), 0)).toBe('tbl ');
  });
});
