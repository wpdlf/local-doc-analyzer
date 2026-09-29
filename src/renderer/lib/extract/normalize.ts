import type { Chapter, PageImage, PdfDocument } from '../../types';
import { detectChapters } from '../pdf-parser';
import type { ExtractedDoc } from './types';

/**
 * 제목에서 만든 챕터 수의 상한. summarizeByChapter 는 챕터당 최소 1회 LLM 을 부르므로 챕터 수가
 * 곧 호출 수다 — 제목이 달린 112장 덱이 112회 호출이 되는 것을 막는다. 넘으면 인접 챕터를
 * 묶는다(detectChapters 가 제목을 못 찾을 때 10단위로 묶는 것과 대칭).
 */
export const MAX_HEADING_CHAPTERS = 50;

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

/** 챕터 경계 하나 — start 는 0-based 단위 인덱스 */
interface Boundary {
  title: string;
  start: number;
}

/**
 * 포맷이 알려준 구획(섹션·제목) → 챕터 경계. 쓸 만한 경계가 없으면 null(호출자가 휴리스틱 폴백).
 *
 * QA35(High): 예전에는 **모든 수준의 모든 제목**이 챕터였다. 한 단위에 제목이 여럿이면 그 단위가
 * N 개 챕터에 들어가(실물 DOCX: 11단위 → 32챕터, 요약 입력 ×2.9, 한 단위가 6챕터에), 제목 달린
 * 112장 덱은 112챕터 = LLM 112회였다. PDF 의 detectChapters 는 QA22 에서 같은 모양(러닝 헤더)을
 * 막았는데 이 형제 경로에는 가드가 없었다. 이제 단위를 **분할**한다 — 모든 단위가 정확히 한
 * 챕터에 들어간다(빈틈·겹침 없음). 규칙:
 *  a. 섹션(≥2개)이 있으면 섹션이 경계다 — 작성자가 직접 나눈 구획이 제목보다 믿을 만하다.
 *  b. 아니면 서로 다른 단위에 제목이 둘 이상인 가장 높은 수준(가장 작은 level)의 제목만 쓴다.
 *     그보다 아래 수준까지 쓰면 한 장이 잘게 쪼개진다. 그런 수준이 없으면 detectChapters 폴백.
 *  c. 경계의 단위가 직전 경계보다 **엄격히 뒤**여야 한다 — 같은 단위의 제목은 첫 제목에 합친다.
 *  d. 직전 경계와 제목이 같으면 흡수한다(여러 슬라이드에 걸친 "(계속)" 식 반복 제목).
 *  e. MAX_HEADING_CHAPTERS 를 넘으면 인접 경계를 묶는다(groupBoundaries).
 */
function headingBoundaries(ex: ExtractedDoc, length: number): Boundary[] | null {
  let candidates: { title: string; unitIndex: number }[];
  if (ex.sections && ex.sections.length >= 2) {
    candidates = ex.sections;
  } else {
    const usable = ex.headings.filter((h) => h.title.trim());
    // R17: "최상위 수준"은 **경계를 둘 이상 만드는** 가장 높은 수준이다. DOCX 는 흔히 문서 제목
    // 하나만 H1 이고 실제 장이 H2 다 — 단순히 가장 작은 level 을 쓰면 문서 전체가 한 챕터로 접힌다.
    // 서로 다른 단위에 제목이 둘 이상인 수준이 없으면 제목은 경계 정보가 없는 것과 같다(폴백).
    const levels = [...new Set(usable.map((h) => h.level))].sort((a, b) => a - b);
    const top = levels.find((lv) =>
      new Set(usable.filter((h) => h.level === lv).map((h) => clampUnitIndex(h.unitIndex, length))).size >= 2);
    if (top === undefined) return null;
    candidates = usable.filter((h) => h.level === top);
  }

  const kept: Boundary[] = [];
  for (const c of candidates) {
    const title = c.title.trim();
    if (!title) continue;
    const start = clampUnitIndex(c.unitIndex, length);
    const prev = kept[kept.length - 1];
    if (prev && start <= prev.start) continue; // c
    if (prev && title === prev.title) continue; // d
    kept.push({ title, start });
  }
  if (kept.length === 0) return null;
  // 첫 경계 앞 단위(머리말)는 첫 챕터에 접는다 — 버리면 요약에서 조용히 빠진다(R14).
  kept[0] = { ...kept[0]!, start: 0 };
  return groupBoundaries(kept);
}

/**
 * 경계가 MAX_HEADING_CHAPTERS 를 넘으면 인접한 것을 같은 크기(ceil(k/상한))로 묶는다. 묶인 챕터의
 * 제목은 "첫 제목 — 끝 제목"(한 개면 그 제목) — 어느 구간인지 제목만으로 알 수 있게 한다.
 */
function groupBoundaries(bounds: Boundary[]): Boundary[] {
  if (bounds.length <= MAX_HEADING_CHAPTERS) return bounds;
  const size = Math.ceil(bounds.length / MAX_HEADING_CHAPTERS);
  const out: Boundary[] = [];
  for (let i = 0; i < bounds.length; i += size) {
    const group = bounds.slice(i, i + size);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    out.push({ title: group.length === 1 ? first.title : `${first.title} — ${last.title}`, start: first.start });
  }
  return out;
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
  const bounds = pageTexts.length > 0 ? headingBoundaries(ex, pageTexts.length) : null;
  const chapters: Chapter[] = bounds
    ? bounds.map((b, i) => {
        // startPage·endPage 모두 1-based **inclusive** 다 — detectChapters 가 그렇게 만들고,
        // 소비자(use-summarize labelChaptersWithPages · page-range)가 전부
        // slice(startPage-1, endPage) 로 읽는다(types/index.ts 의 "exclusive 경계"는 0-based
        // 슬라이스 끝이라는 뜻이라 1-based 로는 마지막 페이지다). 경계의 start 가 엄격히 증가하므로
        // endPage = 다음 startPage - 1 ≥ startPage 이고 챕터끼리 겹치지 않는다.
        const startPage = b.start + 1;
        const next = bounds[i + 1];
        const endPage = next ? next.start : pageTexts.length;
        return {
          index: i,
          title: b.title,
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
