import { useEffect, useRef } from 'react';
import { useAppStore } from '../lib/store';
import { formatUnitLabel } from '../lib/citation';
// 원문은 신뢰할 수 없는 문서에서 온 텍스트다. 에러 경계와 안전 컴포넌트가 붙은 SafeMarkdown 을
// 쓴다(markdown-renderer 의 기본 내보내기는 경계 없이 raw 렌더한다).
import { SafeMarkdown } from '../lib/safe-markdown';

/** 배율 1.0 일 때의 본문 글꼴 크기(px). canvas 배율 대신 이것을 곱한다. */
const BASE_FONT_PX = 16;

/**
 * 비-PDF 문서의 원문 패널.
 *
 * PdfViewer 는 원본 바이트를 pdfjs canvas 로 그리는데, 비-PDF 는 그릴 대상이 없다(DOCX·HWPX 의
 * 페이지는 파일에 없고 PPTX 슬라이드를 그리려면 레이아웃 엔진이 필요하다). 대신 추출된 단위를
 * 그대로 보여주고 인용 클릭 → 근거 확인이라는 핵심 동작을 유지한다.
 *
 * 본문을 마크다운으로 렌더하는 이유: 추출기가 표를 GFM 으로 직렬화하므로 여기서 표가 표로
 * 보인다. 이 패널에 들어오는 것은 언제나 추출기 출력뿐이라(PDF 는 canvas 뷰어) 안전하다.
 */
export function DocTextViewerPanel() {
  const pageTexts = useAppStore((s) => s.document?.pageTexts);
  const unitKind = useAppStore((s) => s.document?.unitKind) ?? 'page';
  const citationTarget = useAppStore((s) => s.citationTarget);
  const zoom = useAppStore((s) => s.pdfViewerZoom);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const page = citationTarget?.page;
    if (!page || !rootRef.current) return;
    const el = rootRef.current.querySelector(`#unit-${page}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [citationTarget]);

  if (!pageTexts) return null;

  return (
    <div
      ref={rootRef}
      data-testid="doc-text-viewer"
      className="h-full overflow-y-auto px-4 py-3 bg-white dark:bg-gray-900"
      style={{ fontSize: `${BASE_FONT_PX * zoom}px` }}
    >
      {pageTexts.map((text, i) => {
        const page = i + 1;
        const isTarget = citationTarget?.page === page;
        return (
          <section
            key={page}
            id={`unit-${page}`}
            aria-label={formatUnitLabel(page, unitKind)}
            className={`mb-6 scroll-mt-2 rounded-lg border p-3 transition-colors ${
              isTarget
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">
              {formatUnitLabel(page, unitKind)}
            </h3>
            <SafeMarkdown content={text} />
          </section>
        );
      })}
    </div>
  );
}
