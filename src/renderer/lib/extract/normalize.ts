import type { Chapter, PageImage, PdfDocument } from '../../types';
import { detectChapters } from '../pdf-parser';
import type { ExtractedDoc } from './types';

/**
 * unitIndex 를 유효 범위 [0, length - 1] 로 clamp 한다.
 *
 * 문서 끝의 빈 조각이 쪽나눔 + 이미지만 갖고 뒤에 블록이 없으면, 그 이미지의 unitIndex 가
 * units.length 와 같아져 범위를 하나 벗어난다(컨트롤러 판정). unitIndex→pageIndex 변환은
 * 여기 한 곳뿐이므로 클램프도 여기서 한다 — docx.ts 에서 고치면 같은 파이프라인을 재사용할
 * hwpx/pptx/epub 추출기에 동일한 구멍이 그대로 남는다.
 */
function clampUnitIndex(unitIndex: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(unitIndex, 0), length - 1);
}

/**
 * ExtractedDoc → PdfDocument.
 *
 * 추출기가 PdfDocument 를 직접 조립하지 않는 이유가 여기다 — 필드를 채우는 자리가 한 곳이어야
 * 포맷이 늘 때 "한 포맷만 새 필드를 안 채움"이 생기지 않는다.
 *
 * imagesSkipped 는 **호출자**가 설정한다(설정 OFF 여부는 여기서 모른다). hadImages 는 영속화
 * 시점에 use-session 이 파생한다. PDF 경로(parsePdf)와 대칭을 유지한다 — 비대칭 자체가 결함이다.
 */
export function toPdfDocument(
  ex: ExtractedDoc,
  meta: { fileName: string; filePath: string },
): PdfDocument {
  const pageTexts = [...ex.units];

  const images: PageImage[] = ex.images.map((img, i) => ({
    pageIndex: clampUnitIndex(img.unitIndex, pageTexts.length),
    imageIndex: i,
    base64: img.base64,
    width: img.width,
    height: img.height,
    mimeType: img.mimeType,
  }));

  // 포맷이 제목을 알려주면 detectChapters 의 휴리스틱(본문 첫 줄 패턴 매칭)을 건너뛴다.
  // 제목이 하나도 없는 문서가 실제로 흔하므로(실물 DOCX 에 pStyle 이 없었다) 폴백을 유지한다.
  const chapters: Chapter[] =
    ex.headings.length > 0
      ? ex.headings.map((h, i) => {
          // startPage 는 1-based inclusive, endPage 는 slice 용 exclusive 경계다
          // (types/index.ts 의 Chapter 주석). 마지막 챕터는 pageTexts.length + 1 이다.
          // unitIndex 도 이미지와 같은 이유로 clamp 한다(범위 밖 unitIndex 는 헤딩에도 생길 수 있다).
          const unitIndex = clampUnitIndex(h.unitIndex, pageTexts.length);
          const startPage = unitIndex + 1;
          const next = ex.headings[i + 1];
          const endPage = next
            ? clampUnitIndex(next.unitIndex, pageTexts.length) + 1
            : pageTexts.length + 1;
          return {
            index: i,
            title: h.title,
            startPage,
            endPage,
            text: pageTexts.slice(startPage - 1, endPage - 1).join('\n\n'),
          };
        })
      : detectChapters(pageTexts);

  return {
    id: crypto.randomUUID(),
    fileName: meta.fileName,
    filePath: meta.filePath,
    pageCount: pageTexts.length,
    extractedText: pageTexts.join('\n\n'),
    pageTexts,
    chapters,
    images,
    createdAt: new Date(),
    unitKind: ex.unitKind,
    ...(ex.imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
  };
}
