import { describe, it, expect } from 'vitest';
import { toGfmTable, placeGridCells, gridExtent, MAX_GRID_CELLS, MAX_GRID_CELLS_PER_AXIS } from '../table';

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

  it('비어 있는 칸은 빈 문자열, 열 수는 MAX_GRID_CELLS_PER_AXIS 로 제한', () => {
    expect(placeGridCells([], 1, 3)).toEqual([['', '', '']]);
    expect(placeGridCells([], 1, 1e9)[0]!.length).toBe(MAX_GRID_CELLS_PER_AXIS);
  });

  // QA35(Important): 열 상한(256)이 행에도 걸려 257행째부터 조용히 잘렸다 — 긴 명단·실적표가 흔하다.
  it('256 행을 넘는 표도 모든 행을 유지한다', () => {
    // 2열로 둔다 — 행이 잘려 평문 행으로 밀려나면 ['r299 / v299', ''] 가 되어 구분된다.
    const cells = Array.from({ length: 300 }, (_, r) => [c(r, 0, `r${r}`), c(r, 1, `v${r}`)]).flat();
    const grid = placeGridCells(cells, 300, 2);
    expect(grid).toHaveLength(300);
    expect(grid[299]).toEqual(['r299', 'v299']);
  });

  it('열 상한 밖의 칸은 버리지 않고 표 뒤에 평문 행으로 붙인다', () => {
    const W = MAX_GRID_CELLS_PER_AXIS;
    const cells = [c(0, 0, 'a'), c(0, W, '넘친1'), c(0, W + 1, '넘친2'), c(1, 0, 'b'), c(1, W + 5, '넘친3')];
    const grid = placeGridCells(cells, 2, W + 10);
    expect(grid.slice(0, 2).map((r) => r.length)).toEqual([W, W]);
    expect(grid.slice(2).map((r) => r[0])).toEqual(['넘친1 / 넘친2', '넘친3']);
    for (const r of grid) expect(r).toHaveLength(W);
  });

  it(`칸 총수가 MAX_GRID_CELLS(${MAX_GRID_CELLS}) 를 넘으면 행을 줄이되 잘린 행은 평문으로 붙인다`, () => {
    const W = 100;
    const rowsFit = Math.floor(MAX_GRID_CELLS / W);
    const cells = [c(0, 0, '첫'), c(rowsFit, 0, '넘친 행'), c(rowsFit, 1, '둘째 칸'), c(rowsFit + 1e6, 0, '먼 행')];
    const grid = placeGridCells(cells, rowsFit + 1e6 + 1, W);
    expect(grid.length * W).toBeLessThanOrEqual(MAX_GRID_CELLS + 2 * W);
    expect(grid[0]![0]).toBe('첫');
    expect(grid.slice(rowsFit).map((r) => r[0])).toEqual(['넘친 행 / 둘째 칸', '먼 행']);
  });

  it('상한에 걸리지 않으면 덧붙이는 행이 없다', () => {
    expect(placeGridCells([c(0, 0, 'a')], 1, 1)).toEqual([['a']]);
  });
});

describe('gridExtent — 격자 한 축의 크기 (R18, hwpx·hwp 공유)', () => {
  const at = (row: number, rowSpan = 1) => ({ row, col: 0, rowSpan, colSpan: 1, text: '' });
  it('셀 원점은 선언값을 넘어도 포함한다 (선언값이 모자란 손상 파일에서 셀을 버리지 않게)', () => {
    expect(gridExtent([at(0), at(2)], 'row', 1)).toBe(3);
  });
  it('스팬 끝은 선언값 안에서만 믿는다 (병리적 rowSpan 이 빈 행을 만들지 않게)', () => {
    expect(gridExtent([at(0, 60000)], 'row', 2)).toBe(2);
  });
  it('선언값이 커도 셀이 차지하지 않으면 늘리지 않는다', () => {
    expect(gridExtent([at(0)], 'row', 100000)).toBe(1);
  });
});
