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
  id: 'pdf' | 'docx' | 'pptx' | 'hwpx' | 'epub';
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
] as const;

export const SUPPORTED_EXTENSIONS: readonly string[] = SUPPORTED_FORMATS.map((f) => f.ext);

/** Electron dialog 의 filters — extensions 는 점 없는 형태여야 한다. */
export const DIALOG_FILTERS: readonly { name: string; extensions: string[] }[] = [
  { name: '문서', extensions: SUPPORTED_FORMATS.map((f) => f.ext.slice(1)) },
  ...SUPPORTED_FORMATS.map((f) => ({ name: f.label, extensions: [f.ext.slice(1)] })),
];

export function isSupportedExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
