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

  it('모든 입력이 비어 있으면 units 는 빈 배열이고 unitOfBlock 길이는 입력 길이와 같다', () => {
    const r = paginate([b(''), b('   '), b('\t\n')], 100);
    expect(r.units).toEqual([]);
    expect(r.unitOfBlock).toHaveLength(3);
  });

  it('쪽나눔 후 빈 블록에서 unitOfBlock 값이 정확하다', () => {
    // 쪽나눔이 flush 를 트리거하면, 빈 블록은 새로운 units.length 를 참조해야 한다.
    // 이 경우 ternary 의 units.length > 0 브랜치를 타므로 hardcoded(0) 과 달라진다.
    const r = paginate([b('가'), b('나', true), b('')], 100);
    // Block 0: '가' → units.length=0, unitOfBlock[0]=0
    // Block 1: '나' + breakBefore → flush(['가']), units=['가'], unitOfBlock[1]=1
    // Block 2: '' → units.length=1, ternary 타고 unitOfBlock[2]=1
    expect(r.units).toEqual(['가', '나']);
    expect(r.unitOfBlock).toEqual([0, 1, 1]);
  });

  it('빈 블록도 breakBefore 면 직전 누적을 새 단위로 민다 (예: 문단 끝 쪽나눔)', () => {
    // 문단 끝의 w:br type=page 는 텍스트 없는 조각(빈 블록)을 만들되 breakBefore 를 지닌다.
    // 이 신호를 놓치면 두 번째 블록이 첫 블록과 한 단위로 합쳐진다.
    const r = paginate([b('가'), b('', true), b('나')], 10000);
    expect(r.units).toEqual(['가', '나']);
    expect(r.unitOfBlock).toEqual([0, 1, 1]);
  });

  it('두 블록의 합이 정확히 상한과 같으면 한 단위에 담는다', () => {
    const r = paginate([b('가'.repeat(50)), b('나'.repeat(50))], 100);
    // 50 + 50 = 100, 정확히 budget 과 같음 → 한 단위에 담긴다
    expect(r.units).toEqual(['가'.repeat(50) + '\n\n' + '나'.repeat(50)]);
    expect(r.unitOfBlock).toEqual([0, 0]);
  });
});
