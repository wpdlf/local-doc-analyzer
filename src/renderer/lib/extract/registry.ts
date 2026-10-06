import { docxExtractor } from './docx';
import { pptxExtractor } from './pptx';
import { hwpxExtractor } from './hwpx';
import { hwpExtractor } from './hwp';
import type { ContainerIndex, Extractor } from './types';

/**
 * 컨테이너별 포맷 판별.
 *
 * zip 포맷은 매직만으로는 구분되지 않아 엔트리 목록으로 sniff 한다 — 확장자는 힌트일 뿐 신뢰하지 않는다.
 * CFB 는 HWP 5.x 와 암호 걸린 OOXML 이 같은 컨테이너다 — HWP 추출기가 고르지 않으면 호출자가 암호 안내로 간다.
 */
export const ZIP_EXTRACTORS: readonly Extractor[] = [docxExtractor, pptxExtractor, hwpxExtractor];
export const CFB_EXTRACTORS: readonly Extractor[] = [hwpExtractor];

export function resolveExtractor(index: ContainerIndex, container: 'zip' | 'cfb' = 'zip'): Extractor | null {
  return (container === 'cfb' ? CFB_EXTRACTORS : ZIP_EXTRACTORS).find((e) => e.sniff(index)) ?? null;
}
