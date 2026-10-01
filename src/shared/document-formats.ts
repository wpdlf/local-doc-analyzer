/**
 * 지원 입력 포맷의 단일 출처 — Main/Renderer 공용.
 *
 * constants.ts 와 같은 규칙으로 순수 값/타입만 둔다(런타임 API 참조 금지).
 * 확장자를 아는 자리가 흩어져 있으면 포맷이 늘 때 한 곳이 안 따라간다 — 이 저장소에서 가장
 * 자주 반복된 형태라(QA32 형제 누락, QA33 H6) 진입 게이트 전부가 여기를 참조한다.
 *
 * ⚠️ 판별은 확장자가 아니라 **내용**으로 한다. 확장자는 다이얼로그 필터와 초기 힌트일 뿐이다.
 */

export interface DocumentFormat {
  id: 'pdf' | 'docx' | 'pptx' | 'hwpx';
  /** 소문자, 점 포함 */
  ext: string;
  /** 다이얼로그에 보일 이름 */
  label: string;
  /** zip 컨테이너 기반 포맷인가 (아니면 PDF 처럼 고유 매직) */
  container: 'zip' | 'pdf';
}

export const SUPPORTED_FORMATS: readonly DocumentFormat[] = [
  { id: 'pdf', ext: '.pdf', label: 'PDF', container: 'pdf' },
  { id: 'docx', ext: '.docx', label: 'Word', container: 'zip' },
  { id: 'pptx', ext: '.pptx', label: 'PowerPoint', container: 'zip' },
  { id: 'hwpx', ext: '.hwpx', label: 'HWPX', container: 'zip' },
] as const;

export const SUPPORTED_EXTENSIONS: readonly string[] = SUPPORTED_FORMATS.map((f) => f.ext);

/**
 * 사용자 안내용 지원 형식 목록("PDF · Word"). i18n 문구가 `{list}` 로 받는다 — 문구에 형식을
 * 하드코딩하면 포맷을 등록할 때마다 틀려진다(P4 이전 네 곳이 "PDF · Word" 로 박혀 있었다).
 */
export const SUPPORTED_LABEL = SUPPORTED_FORMATS.map((f) => f.label).join(' · ');

/**
 * docx 추출기(`extract/docx.ts`)의 판별 값. 포맷 id 리터럴은 이 파일 한 곳에서만 쓴다 —
 * `Extractor.id`(extract/types.ts)가 이 상수의 타입을 derive 해서 쓰므로 그쪽엔 리터럴이
 * 남지 않는다(소스 스캔 가드 대상 — Task9).
 */
export const DOCX_FORMAT_ID = 'docx' as const satisfies DocumentFormat['id'];

/** pptx 추출기(`extract/pptx.ts`)의 판별 값. 위 DOCX_FORMAT_ID 주석 참조 — 리터럴은 이 한 곳뿐. */
export const PPTX_FORMAT_ID = 'pptx' as const satisfies DocumentFormat['id'];

/** hwpx 추출기(`extract/hwpx.ts`)의 판별 값. 위 DOCX_FORMAT_ID 주석 참조 — 리터럴은 이 한 곳뿐. */
export const HWPX_FORMAT_ID = 'hwpx' as const satisfies DocumentFormat['id'];

/**
 * pdf 를 제외한 나머지 포맷 id. pdf 는 pdf-parser.ts 전용 파이프라인이 처리하고, zip 기반
 * 추출기(`Extractor`, extract/types.ts)는 그 나머지만 다룬다 — 그쪽 타입이 이걸 derive 해서
 * 'pdf' 리터럴을 다시 쓰지 않게 한다.
 */
export type NonPdfFormatId = Exclude<DocumentFormat['id'], 'pdf'>;

/**
 * Electron dialog 의 filters — extensions 는 점 없는 형태여야 한다.
 *
 * QA34(L11): "모든 지원 문서" 필터 이름은 main 프로세스가 쓰는데 main 에는 i18n 이 없다 — 종전
 * 한국어 '문서' 가 영어 UI 에서도 그대로 보였다. 포맷 라벨(고유명사) 나열로 언어 중립화한다
 * ('PDF, Word'). 포맷이 늘면 자동으로 따라간다.
 */
export const DIALOG_FILTERS: readonly { name: string; extensions: string[] }[] = [
  { name: SUPPORTED_FORMATS.map((f) => f.label).join(', '), extensions: SUPPORTED_FORMATS.map((f) => f.ext.slice(1)) },
  ...SUPPORTED_FORMATS.map((f) => ({ name: f.label, extensions: [f.ext.slice(1)] })),
];

/**
 * 확장자 판정 — 다이얼로그 필터·초기 게이트용(내용 판별은 sniff/매직바이트가 한다).
 *
 * fix-round1(item6): 파일명 전체가 확장자뿐인 경우(`C:\x\.pdf`)는 거부한다. 옛 게이트가
 * `path.extname()` 을 썼는데, `path.extname('.pdf')` 는 점 파일(dotfile)로 취급해 `''` 를
 * 반환하므로 그 경로는 항상 거부됐다 — `endsWith` 로 옮기며 조용히 통과 대상이 넓어지지
 * 않도록 "확장자를 뺀 나머지(stem)가 비어 있지 않다" 를 함께 요구한다.
 */
export function isSupportedExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split(/[\\/]/).pop() ?? lower;
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext) && base.length > ext.length);
}

/**
 * 파일명 끝의 지원 확장자를 벗긴다(대소문자 무관) — 내보내기 기본 파일명용 (QA34 L9).
 *
 * 종전 호출부(SummaryViewer)가 `.pdf` 만 벗겨 `보고서.docx_요약.md` 가 됐다. 확장자 목록을
 * 여기서 도출하므로 포맷이 늘어도 따라간다. 이름 전체가 확장자뿐이면(`.pdf`) 빈 문자열이
 * 되지 않도록 그대로 둔다(`isSupportedExtension` 의 stem 규칙과 같다).
 */
export function stripSupportedExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const ext = SUPPORTED_EXTENSIONS.find((e) => lower.endsWith(e) && fileName.length > e.length);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

/**
 * 인용 단위 종류의 런타임 단일 출처 (QA34 L7).
 *
 * 타입 선언은 extract/types.ts(`UnitKind`)와 session-types.ts(레이어링 때문에 복제)에 있고
 * unit-kind-drift.test.ts 가 셋을 대조한다. main 의 session-store 는 디스크에서 읽은 값을
 * 이 상수로 거른다 — 종전엔 거기에 세 번째 리터럴 사본이 있었고 drift 가드 밖이었다.
 */
export const UNIT_KINDS = ['page', 'slide', 'chapter'] as const;

export function isUnitKind(v: unknown): v is (typeof UNIT_KINDS)[number] {
  return typeof v === 'string' && (UNIT_KINDS as readonly string[]).includes(v);
}

/**
 * canvas(pdfjs) 뷰어 대상인가 — 파일명이 아니라 **내용**(어느 파이프라인이 추출했나)으로 가른다
 * (QA34 L10). 나머지는 텍스트 뷰어(`DocTextViewerPanel`)가 맡는다.
 *
 * PDF 파이프라인(pdf-parser.ts)은 unitKind 를 두지 않고, 비-PDF 추출기(extract/normalize.ts)는
 * 언제나 둔다(DOCX 도 `'page'`). 세션 복원·탭 전환도 저장된 unitKind 를 그대로 싣는다. 종전의
 * 확장자 판정은 `.pdf` 이름의 zip(내용 판별로 DOCX 파싱됨)을 pdfjs 뷰어로 보내 깨뜨렸다.
 */
export function usesCanvasViewer(unitKind: string | undefined): boolean {
  return unitKind === undefined;
}

/** zip 로컬 파일 헤더 `PK\x03\x04`. 암호가 걸린 OOXML 은 CFB 라 여기서 갈린다. */
export function hasZipMagic(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * `%PDF-` 시그니처. pdfjs 는 앞에 붙은 BOM·공백·잘못 덧붙은 헤더를 허용하므로 앞쪽 1KB 창에서
 * 스캔해 파서와 관용도를 맞춘다(QA13 C-LOW: 오프셋 0 정확 매칭이 유효 PDF 를 조기 오거부했다).
 */
export function hasPdfMagic(head: Uint8Array): boolean {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const limit = Math.min(head.length, 1024);
  for (let i = 0; i + sig.length <= limit; i++) {
    if (sig.every((b, j) => head[i + j] === b)) return true;
  }
  return false;
}

/**
 * OLE CFB(Compound File Binary) 컨테이너 매직 `D0 CF 11 E0 A1 B1 1A E1`(오프셋 0 고정 — zip 과
 * 달리 앞에 관용적 접두가 붙지 않는다). 암호가 걸린 OOXML(Word/Excel/PowerPoint 를 MS-OFFCRYPTO
 * 로 암호화하면 zip 이 아니라 이 컨테이너가 된다)이 이 시그니처를 쓴다 — document-open.ts 가
 * DOC_ENCRYPTED 판별에 사용한다.
 */
export function hasCfbMagic(head: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return head.length >= sig.length && sig.every((b, i) => head[i] === b);
}
