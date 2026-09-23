import { useT } from '../lib/i18n';
import { ZOOM_MIN, formatZoomPercent } from '../lib/viewer-zoom';

interface ZoomControlsProps {
  /** 현재 배율(store 값, 즉시 반영). 버튼 라벨·활성/비활성 판정에 쓰인다. */
  zoom: number;
  /** 이 문서/뷰에서 실제로 의미 있는 배율 상한 — 확대 버튼 비활성 기준. */
  maxZoom: number;
  /** 라이브 리전(status)에 알릴 배율. 호출자가 정한다(PdfViewer 는 렌더 반영 후 디바운스된 값). */
  announceZoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomReset: () => void;
}

/**
 * 확대·축소 툴바 버튼 3개 + 라이브 리전 — PdfViewer·DocTextViewer 공유 (Task13 fix1).
 *
 * 이전에는 PdfViewer 안에만 있었다. 컴포넌트 경계를 나눠도 렌더되는 DOM(속성·순서)은
 * 그대로이므로 PdfViewer 의 기존 배율 테스트(PdfViewer-zoom.test.tsx)는 손대지 않는다.
 */
export function ZoomControls({ zoom, maxZoom, announceZoom, onZoomOut, onZoomIn, onZoomReset }: ZoomControlsProps) {
  const t = useT();
  return (
    <div className="flex items-center gap-1 shrink-0">
      {/* v1.6.0 배율 — 버튼의 접근성 이름은 동작(확대/축소/맞춤)이고, 현재 배율은 아래 status 가 통지한다. */}
      <button
        type="button"
        onClick={onZoomOut}
        disabled={zoom <= ZOOM_MIN}
        aria-label={t('pdfviewer.zoomOut')}
        title={`${t('pdfviewer.zoomOut')} (Ctrl+-)`}
        className="inline-flex items-center justify-center min-w-[24px] min-h-[24px] text-sm rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:hover:text-gray-500"
      >
        −
      </button>
      <button
        type="button"
        onClick={onZoomReset}
        // QA33(M): 접근성 이름에 보이는 텍스트(현재 배율)를 포함한다. 종전에는 화면에 "160%" 가
        // 보이는데 이름은 "화면 맞춤으로 되돌리기" 뿐이라, 음성 조작 사용자가 보이는 대로 부를
        // 수 없었다(WCAG 2.5.3 Label in Name).
        aria-label={`${formatZoomPercent(zoom)} — ${t('pdfviewer.zoomReset')}`}
        title={`${t('pdfviewer.zoomReset')} (Ctrl+0)`}
        className="min-w-[44px] min-h-[24px] text-xs tabular-nums rounded text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100"
      >
        {formatZoomPercent(zoom)}
      </button>
      <button
        type="button"
        onClick={onZoomIn}
        // QA33(I1): 도달 가능한 상한에서 멈춘다 — 그 위로는 눌러도 렌더는 그대로다.
        disabled={zoom >= maxZoom}
        aria-label={t('pdfviewer.zoomIn')}
        title={`${t('pdfviewer.zoomIn')} (Ctrl + '+')`}
        className="inline-flex items-center justify-center min-w-[24px] min-h-[24px] text-sm rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:hover:text-gray-500"
      >
        +
      </button>
      {/* QA33(L): 통지는 호출자가 고른 배율로 — PdfViewer 는 Ctrl+휠 한 제스처에 수십 번 발화하는
          것을 피하려 렌더에 반영된(디바운스된) 값을 넘긴다. */}
      <span role="status" className="sr-only">{t('pdfviewer.zoomLevel', { percent: formatZoomPercent(announceZoom) })}</span>
    </div>
  );
}
