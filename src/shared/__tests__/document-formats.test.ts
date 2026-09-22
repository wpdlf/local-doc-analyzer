import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_FORMATS, SUPPORTED_EXTENSIONS, DIALOG_FILTERS,
  isSupportedExtension, hasZipMagic, hasPdfMagic,
} from '../document-formats';

describe('document-formats — 지원 포맷 단일 출처', () => {
  it('P1 시점의 지원 목록은 pdf 와 docx 다', () => {
    expect(SUPPORTED_FORMATS.map((f) => f.id)).toEqual(['pdf', 'docx']);
    expect(SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.docx']);
  });

  it('확장자 검사는 대소문자를 가리지 않는다', () => {
    expect(isSupportedExtension('C:/x/A.PDF')).toBe(true);
    expect(isSupportedExtension('/tmp/보고서.DocX')).toBe(true);
    expect(isSupportedExtension('/tmp/a.exe')).toBe(false);
    expect(isSupportedExtension('/tmp/확장자없음')).toBe(false);
  });

  // fix-round1(item6): 옛 게이트(`path.extname`)는 점 파일을 확장자 없음으로 보고 거부했다.
  // `endsWith` 로 옮기며 이 경계가 조용히 넓어지지 않도록 고정한다.
  it('파일명 전체가 확장자뿐이면 거부한다 (옛 path.extname 동작과 동일)', () => {
    expect(isSupportedExtension('C:/x/.pdf')).toBe(false);
    expect(isSupportedExtension('C:\\x\\.docx')).toBe(false);
    expect(isSupportedExtension('.pdf')).toBe(false);
  });

  it('다이얼로그 필터는 "모든 지원 문서" 를 먼저 둔다', () => {
    expect(DIALOG_FILTERS[0]?.extensions).toEqual(['pdf', 'docx']);
    // 필터의 extensions 는 점 없는 형태여야 한다 (Electron 규약)
    for (const f of DIALOG_FILTERS) {
      for (const e of f.extensions) expect(e.startsWith('.')).toBe(false);
    }
  });

  it('PDF 매직은 선행 바이트를 허용한다 (pdfjs 와 관용도를 맞춘다)', () => {
    const enc = new TextEncoder();
    expect(hasPdfMagic(enc.encode('%PDF-1.7'))).toBe(true);
    expect(hasPdfMagic(enc.encode('\uFEFF  %PDF-1.4'))).toBe(true);
    expect(hasPdfMagic(enc.encode('not a pdf'))).toBe(false);
  });

  it('zip 매직은 오프셋 0 정확 매칭이다', () => {
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    // 암호가 걸린 OOXML 은 CFB 컨테이너라 zip 이 아니다 — 여기서 갈린다
    expect(hasZipMagic(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});
