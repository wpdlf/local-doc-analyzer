import { describe, it, expect } from 'vitest';
import { hashDocumentText, hashDocumentForSession, bufferToHex } from '../session-hash';

// session-persistence module-1 (L1): 콘텐츠 해시 — 동일 내용 → 동일 키, 변경 → 무효화.
describe('session-hash (L1)', () => {
  it('동일 텍스트는 동일한 64자 hex 해시', async () => {
    const a = await hashDocumentText('강의 자료 본문 내용');
    const b = await hashDocumentText('강의 자료 본문 내용');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('다른 텍스트는 다른 해시 (콘텐츠 변경 → 캐시 무효화)', async () => {
    const a = await hashDocumentText('document A');
    const b = await hashDocumentText('document B');
    expect(a).not.toBe(b);
  });

  it('알려진 SHA-256 테스트 벡터 ("abc")', async () => {
    expect(await hashDocumentText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  /**
   * QA34(Important): DOCX 의 쪽나눔만 바꾼 편집은 extractedText 가 같아(단위를 '\n\n' 으로 이어 붙여
   * 경계가 보이지 않는다) 같은 docHash 가 나왔다 → 옛 요약·index.bin(청크 쪽번호)이 새 pageTexts
   * 위에 복원돼 인용이 엉뚱한 단위로 튀었다. 비-PDF 는 단위 경계를 해시에 넣는다.
   */
  describe('hashDocumentForSession (QA34)', () => {
    it('PDF(unitKind 없음)는 종전과 바이트 동일 — extractedText 해시, pageTexts 무시 (기존 세션 호환 핀)', async () => {
      const pdf = { extractedText: 'abc', pageTexts: ['a', 'bc'] };
      expect(await hashDocumentForSession(pdf)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(await hashDocumentForSession({ ...pdf, pageTexts: ['abc'] })).toBe(await hashDocumentText('abc'));
    });

    it('비-PDF: extractedText 가 같아도 단위 분할이 다르면 다른 해시', async () => {
      const a = { extractedText: 'x\n\ny\n\nz', pageTexts: ['x', 'y\n\nz'], unitKind: 'page' as const };
      const b = { extractedText: 'x\n\ny\n\nz', pageTexts: ['x\n\ny', 'z'], unitKind: 'page' as const };
      expect(await hashDocumentForSession(a)).not.toBe(await hashDocumentForSession(b));
    });

    it('비-PDF: 같은 분할이면 같은 해시(세션 복원 hit 유지)', async () => {
      const a = { extractedText: 'x\n\ny', pageTexts: ['x', 'y'], unitKind: 'page' as const };
      expect(await hashDocumentForSession(a)).toBe(await hashDocumentForSession({ ...a, pageTexts: ['x', 'y'] }));
    });
  });

  it('bufferToHex 는 0-padding 된 lowercase hex', () => {
    const buf = new Uint8Array([0, 1, 15, 16, 255]).buffer;
    expect(bufferToHex(buf)).toBe('00010f10ff');
  });
});
