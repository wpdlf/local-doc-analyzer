import { describe, it, expect } from 'vitest';
import { toGfmTable, placeGridCells } from '../table';

describe('toGfmTable', () => {
  it('첫 행을 머리글로 삼아 GFM 표를 만든다', () => {
    const out = toGfmTable([
      ['대분류', '중분류', '달성률'],
      ['신규 개발', 'M400 S/W', '100%'],
    ]);
    expect(out).toBe(
      '| 대분류 | 중분류 | 달성률 |\n| --- | --- | --- |\n| 신규 개발 | M400 S/W | 100% |',
    );
  });

  it('한 행짜리 표도 머리글+구분선을 갖춘다 (GFM 은 구분선이 없으면 표로 안 읽는다)', () => {
    expect(toGfmTable([['A', 'B']])).toBe('| A | B |\n| --- | --- |');
  });

  it('셀 안의 파이프를 이스케이프한다 (열이 밀리면 대응이 깨진다)', () => {
    const out = toGfmTable([['a|b', 'c']]);
    expect(out.split('\n')[0]).toBe('| a\\|b | c |');
  });

  it('셀 안의 역슬래시를 파이프보다 먼저 이스케이프한다 (끝 역슬래시가 경계 파이프를 먹으면 열이 밀린다)', () => {
    // 'C:\' 를 그대로 두면 `| C:\ | x |` 에서 `\|` 가 이스케이프된 파이프로 읽혀 열이 하나 준다.
    // 순서가 뒤집혀 파이프를 먼저 이스케이프하면 `a\|b` 의 역슬래시가 다시 두 배가 되어
    // `a\\|b` 가 된다 — 이번에는 역슬래시가 문자로 읽히고 파이프가 경계가 된다.
    expect(toGfmTable([['C:\\', 'x']]).split('\n')[0]).toBe('| C:\\\\ | x |');
    expect(toGfmTable([['a|b']]).split('\n')[0]).toBe('| a\\|b |');
    expect(toGfmTable([['a\\|b']]).split('\n')[0]).toBe('| a\\\\\\|b |');
  });

  it('셀 안의 줄바꿈을 공백으로 접는다 (표 한 줄 = 한 행이어야 한다)', () => {
    const out = toGfmTable([['첫 줄\n둘째 줄', 'x']]);
    expect(out.split('\n')[0]).toBe('| 첫 줄 둘째 줄 | x |');
  });

  it('행마다 열 수가 다르면 가장 넓은 행에 맞춰 빈 칸을 채운다', () => {
    const out = toGfmTable([['A'], ['x', 'y']]);
    expect(out).toBe('| A |  |\n| --- | --- |\n| x | y |');
  });

  it('빈 표는 빈 문자열이다 (빈 구분선만 남기지 않는다)', () => {
    expect(toGfmTable([])).toBe('');
    expect(toGfmTable([[]])).toBe('');
  });
});

describe('placeGridCells — 좌표로 놓는 격자(HWPX: 가려진 칸이 XML 에 없다)', () => {
  const c = (row: number, col: number, text: string, rowSpan = 1, colSpan = 1) => ({ row, col, rowSpan, colSpan, text });

  it('가로 병합은 첫 칸에 텍스트, 나머지는 빈 칸', () => {
    expect(placeGridCells([c(0, 0, 'H', 1, 2), c(1, 0, 'a'), c(1, 1, 'b')], 2, 2))
      .toEqual([['H', ''], ['a', 'b']]);
  });

  it('세로 병합은 아래 칸에 텍스트를 복사한다(분류 열이 행마다 남게 — DOCX vMerge 와 같은 규칙)', () => {
    expect(placeGridCells([c(0, 0, '분류', 2), c(0, 1, 'x'), c(1, 1, 'y')], 2, 2))
      .toEqual([['분류', 'x'], ['분류', 'y']]);
  });

  it('입력 순서와 무관하게 좌표로 놓는다', () => {
    expect(placeGridCells([c(1, 1, 'd'), c(0, 0, 'a'), c(1, 0, 'c'), c(0, 1, 'b')], 2, 2))
      .toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('범위를 벗어난 좌표·스팬은 잘라내고, 겹치면 먼저 놓인 칸을 유지한다', () => {
    expect(placeGridCells([c(0, 0, 'a', 1, 99), c(0, 1, 'z'), c(5, 5, 'out')], 1, 2))
      .toEqual([['a', '']]);
  });

  it('원점이 이미 차 있으면 그 셀 전체를 버린다 — 스팬 일부만 놓지 않는다', () => {
    // (0,0)~(0,1) 을 'a' 가로 병합으로 먼저 채운 뒤, (0,1)에서 시작해 아래로 뻗는 'z' 세로 병합을
    // 놓으려 하면 원점 (0,1)이 이미 'a' 가 채운 빈 칸이므로 셀 전체(그 아래 (1,1)까지)를 버려야
    // 한다 — 원점만 막고 스팬의 나머지 칸(1,1)에는 여전히 쓰면 반쪽짜리 셀이 격자에 남는다.
    expect(placeGridCells([c(0, 0, 'a', 1, 2), c(0, 1, 'z', 2, 1)], 2, 2))
      .toEqual([['a', ''], ['', '']]);
  });

  it('비어 있는 칸은 빈 문자열, 행·열 수는 MAX_TABLE_COLUMNS 로 제한', () => {
    expect(placeGridCells([], 1, 3)).toEqual([['', '', '']]);
    expect(placeGridCells([], 1, 1e9)[0]!.length).toBe(256);
  });
});
