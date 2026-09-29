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
          // startPage·endPage 모두 1-based **inclusive** 다 — detectChapters 가 그렇게 만들고,
          // 소비자(use-summarize labelChaptersWithPages · page-range)가 전부
          // slice(startPage-1, endPage) 로 읽는다(types/index.ts 의 "exclusive 경계"는 0-based
          // 슬라이스 끝이라는 뜻이라 1-based 로는 마지막 페이지다).
          // R14: 예전에는 endPage = 다음 제목 단위 + 1 이라 다음 챕터 첫 단위와 겹쳤고(PPTX 는
          // 슬라이드마다 제목이 있어 모든 슬라이드가 두 챕터에 들어가 이중 요약됐다), 첫 제목 앞
          // 단위(머리말)를 어느 챕터에도 넣지 않았다. 머리말은 detectChapters 처럼 첫 챕터에 접는다.
          // unitIndex 도 이미지와 같은 이유로 clamp 한다(범위 밖 unitIndex 는 헤딩에도 생길 수 있다).
          const startPage = i === 0 ? 1 : clampUnitIndex(h.unitIndex, pageTexts.length) + 1;
          const next = ex.headings[i + 1];
          // 같은 단위에 제목이 둘이면 다음 제목 단위가 이 챕터 시작과 같다 — endPage < startPage
          // 인 빈 챕터를 만들지 않도록 시작 단위를 하한으로 둔다.
          const endPage = next
            ? Math.max(startPage, clampUnitIndex(next.unitIndex, pageTexts.length))
            : pageTexts.length;
          return {
            index: i,
            title: h.title,
            startPage,
            endPage,
            text: pageTexts.slice(startPage - 1, endPage).join('\n\n'),
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
