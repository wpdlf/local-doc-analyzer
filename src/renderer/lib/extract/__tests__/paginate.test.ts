import { describe, it, expect } from 'vitest';
import { paginate, DEFAULT_UNIT_CHARS, type Block } from '../paginate';

const b = (text: string, breakBefore = false): Block => ({ text, breakBefore });

describe('paginate', () => {
  it('명시적 쪽나눠에서 끊는다', () => {
    const r = paginate([b('표지'), b('요약', true), b('본문', true)], 10000);
    expect(r.units).toEqual(['표지', '요약', '본문']);
    expect(r.unitOfBlock).toEqual([0, 1, 2]);
  });

  it('첫 블록의 breakBefore 는 빈 단위를 만들지 않는다', () => {
    const r = paginate([b('첫', true), b('둘', true)], 10000);
    expect(r.units).toEqual(['첫', '둘']);
  });

  it('쪽나눠가 없으면 분량으로 끊되 문단 경계를 넘지 않는다', () => {
    const r = paginate([b('가'.repeat(60)), b('나'.repeat(60)), b('다'.repeat(60))], 100);
    // 60+60 이 100 을 넘으므로 첫 단위는 첫 블록만
    expect(r.units).toHaveLength(3);
    expect(r.unitOfBlock).toEqual([0, 1, 2]);
  });

  it('상한 안이면 여러 블록을 한 단위에 담고 빈 줄로 잇는다', () => {
    const r = paginate([b('가'), b('나'), b('다')], 100);
    expect(r.units).toEqual(['가\n\n나\n\n다']);
    expect(r.unitOfBlock).toEqual([0, 0, 0]);
  });

  it('단일 블록이 상한을 넘어도 쪼개지 않는다 (문장이 잘리면 인용이 무의미해진다)', () => {
    const long = '가'.repeat(500);
    const r = paginate([b(long)], 100);
    expect(r.units).toEqual([long]);
  });

  it('빈 블록은 단위를 만들지 않는다', () => {
    const r = paginate([b(''), b('   '), b('내용')], 100);
    expect(r.units).toEqual(['내용']);
  });

  it('블록이 없으면 빈 결과다', () => {
    expect(paginate([], 100)).toEqual({ units: [], unitOfBlock: [] });
  });

  it('기본 분량은 한국어 A4 한 쪽 기준이다', () => {
    expect(DEFAULT_UNIT_CHARS).toBe(1800);
  });
});
