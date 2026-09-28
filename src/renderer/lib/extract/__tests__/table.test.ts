import { describe, it, expect } from 'vitest';
import { toGfmTable } from '../table';

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
