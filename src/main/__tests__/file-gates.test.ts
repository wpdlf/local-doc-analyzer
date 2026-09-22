/**
 * Task 9: 진입 게이트(드롭 URL·다이얼로그 필터·재읽기·DOM 드롭)가 전부
 * document-formats.ts 단일 출처를 쓰도록 옮기는 리팩터의 회귀 넷.
 *
 * 이 테스트는 게이트 교체 **전후로 모두 통과**해야 한다 — 교체가 동작을
 * 바꾸지 않았다는 증거다.
 */
import { describe, it, expect } from 'vitest';
import { isSupportedExtension, DIALOG_FILTERS } from '../../shared/document-formats';

describe('진입 게이트가 받아들이는 것 / 막는 것', () => {
  it('PDF 는 계속 통과한다 (회귀 방지)', () => {
    expect(isSupportedExtension('C:/x/a.pdf')).toBe(true);
    expect(isSupportedExtension('file:///C:/x/a.PDF')).toBe(true);
  });

  it('DOCX 가 통과한다', () => {
    expect(isSupportedExtension('C:/x/보고서.docx')).toBe(true);
  });

  it('아직 지원하지 않는 포맷은 막는다 (P4 에서 열린다)', () => {
    for (const p of ['a.pptx', 'a.hwpx', 'a.epub', 'a.hwp']) {
      expect(isSupportedExtension(p), p).toBe(false);
    }
  });

  it('실행 파일·스크립트는 막는다', () => {
    for (const p of ['a.exe', 'a.bat', 'a.js', 'a.pdf.exe']) {
      expect(isSupportedExtension(p), p).toBe(false);
    }
  });

  it('다이얼로그 필터가 비어 있지 않다 (빈 필터는 모든 파일을 고르게 한다)', () => {
    expect(DIALOG_FILTERS.length).toBeGreaterThan(0);
    expect(DIALOG_FILTERS[0]!.extensions.length).toBeGreaterThan(0);
  });
});
