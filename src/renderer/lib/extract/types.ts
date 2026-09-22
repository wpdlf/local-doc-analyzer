/**
 * 포맷별 추출기의 공통 계약.
 *
 * 추출기는 PdfDocument 를 직접 만들지 않는다. 중간 표현 ExtractedDoc 만 내놓고, normalize.ts
 * 한 곳이 PdfDocument 로 옮긴다. 추출기가 직접 조립하면 포맷이 늘 때마다 "한 포맷만 새 필드를
 * 안 채움"(형제 누락)이 재현된다 — QA26/QA27/QA32/QA33 에서 반복된 형태다.
 */

/** 단위의 성격. 표시 라벨만 갈리고 내부 표현(정수 N)은 동일하다. */
export type UnitKind = 'page' | 'slide' | 'chapter';

/** zip 아카이브의 읽기 전용 색인. 디스크에 풀지 않는다. */
export interface ZipIndex {
  /** 아카이브에 든 엔트리 이름 전부 */
  names(): string[];
  has(name: string): boolean;
  /** UTF-8 로 디코드한 텍스트. 없으면 null */
  text(name: string): string | null;
  /** 원본 바이트. 없으면 null */
  bytes(name: string): Uint8Array | null;
}

export interface ExtractedImage {
  /** units 배열의 0-based 인덱스 */
  unitIndex: number;
  base64: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface ExtractedHeading {
  /** 1 = 최상위 */
  level: number;
  title: string;
  unitIndex: number;
}

export interface ExtractedDoc {
  units: string[];
  images: ExtractedImage[];
  headings: ExtractedHeading[];
  unitKind: UnitKind;
  imageBudgetExceeded?: boolean;
}

export interface ExtractOptions {
  /** 기본 true. false 면 이미지 수집을 통째로 건너뛴다(ParsePdfOptions 와 같은 계약). */
  extractImages?: boolean;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

export interface Extractor {
  id: 'docx' | 'pptx' | 'hwpx' | 'epub';
  /** 다이얼로그 필터용 힌트. 판별의 근거로 쓰지 않는다(위장 파일). */
  extensions: readonly string[];
  /** zip 내부 엔트리로 판별한다. 확장자를 믿지 않는다. */
  sniff(zip: ZipIndex): boolean;
  extract(zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc>;
}
