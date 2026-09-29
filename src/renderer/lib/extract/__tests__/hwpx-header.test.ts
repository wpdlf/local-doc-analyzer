// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readOutlineLevels } from '../hwpx-header';

const H = 'xmlns:hh="urn:hh" xmlns:hp="urn:hp"';
const header = (paraPrs: string) => `<hh:head ${H}><hh:refList><hh:paraProperties>${paraPrs}</hh:paraProperties></hh:refList></hh:head>`;

describe('readOutlineLevels', () => {
  it('heading type=OUTLINE 의 0-based level 을 1-based 로', () => {
    const m = readOutlineLevels(header('<hh:paraPr id="3"><hh:heading type="OUTLINE" idRef="0" level="0"/></hh:paraPr><hh:paraPr id="4"><hh:heading type="OUTLINE" idRef="0" level="2"/></hh:paraPr>'));
    expect(m.get('3')).toBe(1);
    expect(m.get('4')).toBe(3);
  });

  it('BULLET·NONE 은 제목이 아니다', () => {
    const m = readOutlineLevels(header('<hh:paraPr id="1"><hh:heading type="BULLET" level="0"/></hh:paraPr><hh:paraPr id="2"><hh:heading type="NONE" level="0"/></hh:paraPr>'));
    expect(m.size).toBe(0);
  });

  it('hp:switch 가 있으면 case 한 갈래만 — default 의 NONE 과 섞지 않는다', () => {
    const m = readOutlineLevels(header('<hh:paraPr id="7"><hp:switch><hp:case hp:required-namespace="urn:2016"><hh:heading type="OUTLINE" level="1"/></hp:case><hp:default><hh:heading type="NONE" level="0"/></hp:default></hp:switch></hh:paraPr>'));
    expect(m.get('7')).toBe(2);
  });

  it('header 가 없거나 깨지면 빈 표(문서 열기를 실패시키지 않는다)', () => {
    expect(readOutlineLevels(null).size).toBe(0);
    expect(readOutlineLevels('<hh:head').size).toBe(0);
  });
});
