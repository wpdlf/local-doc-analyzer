/**
 * 추출기(docx.ts · pptx.ts · hwpx.ts) 공용 헬퍼 — 단일 출처.
 *
 * 세 추출기가 취소 검사·이벤트 루프 양보·그림 수집 루프를 각자 복사해 갖고 있었고, 그림 수집
 * 루프의 같은 결함(아래 collectImages 참조)이 세 벌 모두에 있었다. 로컬 사본이 여럿이면 한
 * 곳만 고치는 형제 누락이 재현된다 — 이 프로젝트가 반복해서 치른 대가다(errors.ts 참조).
 */
import { MAX_EXAMINED_IMAGES, MAX_TOTAL_IMAGES } from '../pdf-parser';
import { extractFail } from './errors';
import type { ImageFitter } from './image-fit';
import type { ExtractedImage, ZipIndex } from './types';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
}

/**
 * 이벤트 루프에 한 번 양보한다. 추출이 끝까지 동기로 돌면 렌더러가 얼고, 사용자의 취소가
 * 추출이 끝난 뒤에야 실행돼 루프 안 throwIfAborted 가 취소를 관측하지 못한다(QA34).
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface ImageCandidate {
  /** zip 안 그림 파트 경로. 참조를 풀지 못했으면 null/undefined — 건너뛴다. */
  path: string | null | undefined;
  unitIndex: number;
}

/**
 * 그림 후보(문서 순서) → 채택된 그림. 규칙은 PDF 경로와 같은 예산을 쓴다.
 *  - 경로가 없거나 바이트가 없으면 건너뛴다.
 *  - 같은 경로는 처음 나온 단위에만 붙인다(중복 제거).
 *  - `examined` 는 **새 경로만** 센다(중복 확인 뒤). 예전에는 중복 참조까지 세어, 모든 슬라이드에
 *    같은 로고가 있는 400장 덱에서 로고 참조만으로 검사 예산이 바닥나 뒤쪽의 고유 그림을 조용히
 *    잃었다 — 그러고도 예산 초과 표식이 서지 않았다.
 *  - 검사 예산(MAX_EXAMINED_IMAGES)이 찼는데 새 후보가 남아 있으면 표식을 세우고 멈춘다.
 *  - 채택 수가 MAX_TOTAL_IMAGES 에 닿은 뒤의 그림은 표식을 세우고 건너뛴다.
 *  - fit 이 null(지원하지 않는 형식·너무 작음·디코드 실패)이면 건너뛴다.
 */
export async function collectImages(
  candidates: readonly ImageCandidate[],
  zip: ZipIndex,
  fit: ImageFitter,
  signal?: AbortSignal,
): Promise<{ images: ExtractedImage[]; imageBudgetExceeded: boolean }> {
  const images: ExtractedImage[] = [];
  let imageBudgetExceeded = false;
  const seen = new Set<string>();
  let examined = 0;
  for (const { path, unitIndex } of candidates) {
    throwIfAborted(signal);
    if (!path || seen.has(path)) continue;
    if (examined >= MAX_EXAMINED_IMAGES) { imageBudgetExceeded = true; break; }
    examined += 1;
    seen.add(path);
    const bytes = zip.bytes(path);
    if (!bytes) continue;
    if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
    // 형식은 확장자가 아니라 바이트로 가린다(EMF/WMF/TIFF 는 건너뛰고 BMP·GIF 는 재인코딩). 크기 규칙은 PDF 경로와
    // 같다 — 50px 미만·4M 픽셀 초과는 건너뛰고, 긴 변 1024 초과는 줄인다.
    const fitted = await fit(bytes);
    if (fitted) images.push({ unitIndex, ...fitted });
  }
  return { images, imageBudgetExceeded };
}
