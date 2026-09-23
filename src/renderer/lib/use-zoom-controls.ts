import { useEffect, useRef, type RefObject } from 'react';
import { useAppStore } from './store';
import { ZOOM_STEP_BUTTON, ZOOM_STEP_WHEEL, stepZoom } from './viewer-zoom';

/**
 * 편집 요소에 포커스가 있는가 — window 레벨 단축키(Ctrl+배율·Escape)가 입력을 가로채지 않도록.
 * v0.18.5 L1: Shadow DOM 내부에 포커스가 있을 때 `document.activeElement` 는 shadow 호스트를
 * 반환하므로 shadowRoot.activeElement 를 재귀적으로 따라가 실제 포커스 element 를 찾는다.
 * (원래 PdfViewer.tsx 안에만 있던 모듈 함수를 Task13 fix1 에서 여기로 옮겨 ESC 핸들러(PdfViewer)와
 * 배율 키 핸들러(본 훅) 양쪽이 같은 판정을 쓰도록 했다.)
 */
export function isEditableFocused(): boolean {
  let active = document.activeElement as Element | null;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  if (!active) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active as HTMLElement).isContentEditable;
}

/**
 * Ctrl+휠 / Ctrl+(=|+|-|0) 배율 컨트롤 배선 — PdfViewer·DocTextViewer 공유 (Task13 fix1).
 *
 * 계획은 "viewer-zoom.ts 를 재사용한다" 고 했는데, 그 파일은 순수 산술(state 변환)만 가진다.
 * 실제 입력 배선(휠·키 리스너)은 PdfViewer 안에만 있어서, DocTextViewer 가 `pdfViewerZoom`
 * 값을 *읽기*만 하고 아무도 그 값을 바꾸지 못해 비-PDF 문서에서 Ctrl+휠/Ctrl+키가 조용히
 * 죽어 있었다. 이 훅이 그 배선의 단일 출처다 — 두 뷰어가 각자 구현을 두면 한쪽만 고쳐지고
 * 갈라지는 이 저장소의 반복된 실패 패턴(두 사본이 드리프트)을 반복하게 된다.
 *
 * `maxZoom` 은 호출자가 정한다:
 * - PdfViewer: 캔버스 면적 상한(`MAX_CANVAS_PIXELS`)에서 도출한 문서별 상한 — 그 이상 올려도
 *   렌더가 그대로라 버튼을 비활성화해야 한다.
 * - DocTextViewer: 텍스트는 면적 상한이 무의미하므로 `ZOOM_MAX`(전역 300%) 를 그대로 넘긴다 —
 *   store 의 `setPdfViewerZoom` 자체가 이미 [ZOOM_MIN, ZOOM_MAX] 로 clamp 하므로, maxZoom 이
 *   ZOOM_MAX 와 같을 때 아래 "상한 초과 시 즉시 내림" 분기는 항상 no-op 이다.
 */
export function useZoomControls<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  maxZoom: number,
): { zoom: number; zoomBy: (direction: 1 | -1, step: number) => void; setZoom: (zoom: number) => void } {
  const zoom = useAppStore((s) => s.pdfViewerZoom);
  const setZoom = useAppStore((s) => s.setPdfViewerZoom);
  // 이벤트 리스너(마운트 1회 등록)가 최신 상한을 보도록 ref 로도 들고 있는다.
  const maxZoomRef = useRef(maxZoom);
  useEffect(() => {
    maxZoomRef.current = maxZoom;
    // 저장된 배율이 상한을 넘으면(문서 전환으로 캔버스 상한이 좁아진 경우 등) 즉시 내린다 —
    // 화면과 숫자를 맞춘다. maxZoom === ZOOM_MAX(텍스트 뷰어) 면 이 분기는 항상 false.
    if (useAppStore.getState().pdfViewerZoom > maxZoom) setZoom(maxZoom);
  }, [maxZoom, setZoom]);

  const zoomBy = (direction: 1 | -1, step: number) => {
    const next = stepZoom(useAppStore.getState().pdfViewerZoom, direction, step);
    // 도달 불가능한 값으로는 올리지 않는다 — 올려 봐야 렌더는 그대로이고 숫자만 거짓이 된다.
    setZoom(Math.min(next, maxZoomRef.current));
  };

  // Ctrl+휠. React 의 onWheel 은 passive 로 등록돼 preventDefault 가 먹지 않으므로
  // 네이티브 리스너(passive:false). preventDefault 는 Chromium 의 페이지 줌(앱 전체 확대)으로
  // 새는 것을 막는다. Ctrl 없는 휠은 손대지 않는다(스크롤).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1 : -1, ZOOM_STEP_WHEEL);
    };
    container.addEventListener('wheel', handler, { passive: false });
    return () => container.removeEventListener('wheel', handler);
    // zoomBy 는 store getState/ref 만 닫아 두므로 안정 — 의존성 불필요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+(=|+|-|0) — 뷰어가 열려 있는 동안 window 레벨(Escape 와 같은 방식). 뷰어 영역
  // 핸들러로 두면 인용 버튼을 누른 직후(포커스가 요약 쪽)엔 키가 닿지 않는다(E2E 실측). 편집
  // 요소 포커스 중에는 무시 — 입력창의 Ctrl+- 같은 조합을 가로채지 않는다.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEditableFocused()) return;
      if (e.key === '=' || e.key === '+') zoomBy(1, ZOOM_STEP_BUTTON);
      else if (e.key === '-') zoomBy(-1, ZOOM_STEP_BUTTON);
      else if (e.key === '0') setZoom(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // zoomBy/setZoom 은 store setter/ref 만 닫아 두므로 안정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { zoom, zoomBy, setZoom };
}
