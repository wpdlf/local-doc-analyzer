import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_FORMATS, SUPPORTED_EXTENSIONS, SUPPORTED_LABEL, DIALOG_FILTERS,
  isSupportedExtension, hasZipMagic, hasPdfMagic, hasHwp3Magic, usesCanvasViewer, stripSupportedExtension,
  UNIT_KINDS, isUnitKind,
} from '../document-formats';

describe('document-formats — 지원 포맷 단일 출처', () => {
  // .hwp 를 받기 시작하면 HWP 3.x 이하(CFB 가 아니라 자체 서명) 파일이 "손상" 안내로 떨어진다 — 미지원으로 가른다.
  it('HWP 3.x 서명은 파일 맨 앞 "HWP Document File V" 다 (5.x 는 CFB 안의 FileHeader 라 여기 걸리지 않는다)', () => {
    const enc = new TextEncoder();
    expect(hasHwp3Magic(enc.encode('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05'))).toBe(true);
    expect(hasHwp3Magic(enc.encode('HWP Document File\0\0\0'))).toBe(false);
    expect(hasHwp3Magic(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(false);
    expect(hasHwp3Magic(enc.encode('HWP Doc'))).toBe(false);
  });
  it('.hwpx 와 .hwp 는 서로의 확장자 검사에 걸리지 않는다 (접미 관계)', () => {
    expect(isSupportedExtension('C:/x/a.hwp')).toBe(true);
    expect(stripSupportedExtension('보고서.hwpx')).toBe('보고서');
    expect(stripSupportedExtension('보고서.hwp')).toBe('보고서');
  });
  it('지원 목록은 pdf · docx · pptx · hwpx · hwp 다', () => {
    expect(SUPPORTED_FORMATS.map((f) => f.id)).toEqual(['pdf', 'docx', 'pptx', 'hwpx', 'hwp']);
    expect(SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.docx', '.pptx', '.hwpx', '.hwp']);
  });

  // Task3(P4 선행): 사용자 안내 문구("PDF · Word 파일만 지원됩니다")가 이 목록에서 도출돼야
  // 포맷 등록만으로 문구가 따라간다 — 하드코딩되면 등록 순간 문구가 틀려진다.
  it('SUPPORTED_LABEL 은 등록된 포맷 라벨을 순서대로 잇는다', () => {
    expect(SUPPORTED_LABEL).toBe(SUPPORTED_FORMATS.map((f) => f.label).join(' · '));
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
    expect(DIALOG_FILTERS[0]?.extensions).toEqual(['pdf', 'docx', 'pptx', 'hwpx', 'hwp']);
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

  // QA34(M13): 4번째 바이트(0x04)만 다른 경계 — `head[3] === 0x04` 조건이 빠져도 위 샘플은
  // 전부 그대로다(CFB 는 첫 바이트, 2바이트 입력은 길이에서 이미 갈린다). zip 의 다른 레코드
  // 시그니처(`PK 03 03`, 빈 아카이브의 EOCD `PK 05 06`)는 로컬 파일 헤더가 아니다.
  it('zip 매직은 4번째 바이트까지 본다 (PK 03 03 · PK 05 06 거부)', () => {
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x03, 0x00]))).toBe(false);
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0x00]))).toBe(false);
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x03]))).toBe(false);
  });

  // QA34(L11): 다이얼로그 필터 이름은 main 이 쓴다 — main 에는 i18n 이 없어 한국어 '문서' 가
  // 영어 UI 에도 그대로 떴다. 언어 중립 라벨(포맷 이름 나열)로 도출한다.
  it('"모든 지원 문서" 필터 이름은 언어 중립(포맷 라벨 나열)이다', () => {
    expect(DIALOG_FILTERS[0]?.name).toBe('PDF, Word, PowerPoint, HWPX, HWP');
    expect(DIALOG_FILTERS[0]?.name).not.toMatch(/[가-힣]/);
  });

  // QA34(L9): 내보내기 파일명이 `.pdf` 만 벗겨 `보고서.docx_요약.md` 가 됐다.
  describe('stripSupportedExtension — 지원 확장자 제거', () => {
    it('지원 확장자를 대소문자 무관하게 벗긴다', () => {
      expect(stripSupportedExtension('보고서.docx')).toBe('보고서');
      expect(stripSupportedExtension('Report.PDF')).toBe('Report');
      expect(stripSupportedExtension('a.b.DocX')).toBe('a.b');
    });

    it('지원하지 않는 확장자·확장자 없음은 그대로 둔다', () => {
      expect(stripSupportedExtension('notes.txt')).toBe('notes.txt');
      expect(stripSupportedExtension('no-extension')).toBe('no-extension');
    });

    it('이름 전체가 확장자뿐이면 벗기지 않는다 (빈 파일명 방지)', () => {
      expect(stripSupportedExtension('.pdf')).toBe('.pdf');
    });

    it('모든 지원 확장자에 대해 동작한다 (목록에서 도출)', () => {
      for (const ext of SUPPORTED_EXTENSIONS) expect(stripSupportedExtension(`x${ext.toUpperCase()}`)).toBe('x');
    });
  });

  // QA34(L10): 뷰어는 확장자가 아니라 **내용**(추출 경로)으로 고른다. PDF 파이프라인(pdf-parser)은
  // unitKind 를 두지 않고, 비-PDF 추출기(extract/normalize.ts)는 언제나 둔다 — `.pdf` 이름의 zip
  // 은 DOCX 로 파싱되므로 unitKind 가 있고, 확장자로 고르면 pdfjs 뷰어가 깨졌다.
  describe('usesCanvasViewer — canvas(PDF) 뷰어 대상 판정', () => {
    it('unitKind 가 없으면(PDF 파이프라인) canvas 뷰어다', () => {
      expect(usesCanvasViewer(undefined)).toBe(true);
    });

    it("추출기 문서는 unitKind 'page' 라도 텍스트 뷰어다 (DOCX)", () => {
      expect(usesCanvasViewer('page')).toBe(false);
      expect(usesCanvasViewer('slide')).toBe(false);
      expect(usesCanvasViewer('chapter')).toBe(false);
    });
  });

  // QA34(L7): unitKind 리터럴 집합의 런타임 단일 출처 — main(session-store)이 신뢰 경계에서 쓴다.
  describe('isUnitKind — 신뢰 경계 판정', () => {
    it('UNIT_KINDS 의 값만 통과한다', () => {
      for (const k of UNIT_KINDS) expect(isUnitKind(k)).toBe(true);
      expect(isUnitKind('Page')).toBe(false);
      expect(isUnitKind('')).toBe(false);
      expect(isUnitKind(undefined)).toBe(false);
      expect(isUnitKind(3)).toBe(false);
      expect(isUnitKind('__proto__')).toBe(false);
    });
  });
});
