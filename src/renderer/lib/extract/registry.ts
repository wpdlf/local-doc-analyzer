import { docxExtractor } from './docx';
import type { Extractor, ZipIndex } from './types';

/**
 * zip 컨테이너 포맷의 판별.
 *
 * 네 포맷 전부 zip 이라 매직만으로는 구분되지 않는다. 엔트리 목록으로 sniff 한다 —
 * 확장자는 힌트일 뿐 신뢰하지 않는다(위장 파일).
 */
export const ZIP_EXTRACTORS: readonly Extractor[] = [docxExtractor];

export function resolveExtractor(zip: ZipIndex): Extractor | null {
  return ZIP_EXTRACTORS.find((e) => e.sniff(zip)) ?? null;
}
