// @vitest-environment happy-dom

/**
 * QA34(M5·L12): useZoomControls 의 상한·키 필터가 무보호였다.
 * - zoomBy 의 `Math.min(next, maxZoomRef.current)` 를 지워도,
 * - 저장값이 상한을 넘을 때 즉시 내리는 분기를 지워도,
 * - Ctrl+Alt 조합 제외(`e.altKey`)를 지워도 전 스위트가 초록이었다.
 * PdfViewer 는 캔버스 상한을 목 환경에서 도출하기 어렵고, DocTextViewer 는 maxZoom=ZOOM_MAX 라
 * store clamp 와 겹쳐 이 분기가 드러나지 않는다 — 훅을 직접 작은 상한으로 띄운다.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useZoomControls } from '../use-zoom-controls';
import { useAppStore } from '../store';
import { ZOOM_STEP_BUTTON } from '../viewer-zoom';

function useHarness(maxZoom: number) {
  const ref = useRef<HTMLDivElement>(document.createElement('div'));
  return useZoomControls(ref, maxZoom);
}

afterEach(() => cleanup());
beforeEach(() => {
  useAppStore.setState({ pdfViewerZoom: 1 });
});

describe('useZoomControls — 상한', () => {
  it('zoomBy 를 반복해도 maxZoom(1.5)에서 멈춘다', () => {
    const { result } = renderHook(() => useHarness(1.5));
    for (let i = 0; i < 6; i++) act(() => result.current.zoomBy(1, ZOOM_STEP_BUTTON));
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.5);
  });

  it('저장된 배율(2.0)이 상한(1.5)을 넘으면 마운트 즉시 상한으로 내린다', () => {
    useAppStore.setState({ pdfViewerZoom: 2 });
    renderHook(() => useHarness(1.5));
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.5);
  });

  it('상한이 좁아지면(문서 전환) 그 자리에서 내린다', () => {
    useAppStore.setState({ pdfViewerZoom: 2 });
    const { rerender } = renderHook(({ max }) => useHarness(max), { initialProps: { max: 3 } });
    expect(useAppStore.getState().pdfViewerZoom).toBe(2);
    rerender({ max: 1.25 });
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.25);
  });
});

describe('useZoomControls — 키 필터', () => {
  it('Ctrl+= 는 확대한다 (양성 대조)', () => {
    renderHook(() => useHarness(3));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true })); });
    expect(useAppStore.getState().pdfViewerZoom).toBe(1.25);
  });

  it('Ctrl+Alt+= 는 가로채지 않는다 (AltGr 조합 문자 입력 보호)', () => {
    renderHook(() => useHarness(3));
    const e = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, altKey: true, cancelable: true });
    act(() => { window.dispatchEvent(e); });
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
    expect(e.defaultPrevented).toBe(false);
  });
});
