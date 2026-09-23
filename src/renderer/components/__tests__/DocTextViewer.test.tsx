// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { DocTextViewerPanel } from '../DocTextViewer';
import { useAppStore } from '../../lib/store';

function setDoc(pageTexts: string[], unitKind: 'page' | 'slide' | 'chapter' = 'page'): void {
  useAppStore.setState({
    document: {
      id: 'd1', fileName: 'a.docx', filePath: 'C:/x/a.docx',
      pageCount: pageTexts.length, extractedText: pageTexts.join('\n\n'),
      pageTexts, chapters: [], images: [], createdAt: new Date(), unitKind,
    },
    citationTarget: null,
  });
}

describe('DocTextViewerPanel', () => {
  beforeEach(() => {
    // store 는 uiLanguage 를 settings 아래에 둔다(플랫 필드가 아니다).
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' }, pdfViewerZoom: 1 }));
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => cleanup());

  it('단위마다 헤더와 본문을 렌더한다', () => {
    setDoc(['첫째 쪽 내용', '둘째 쪽 내용']);
    render(<DocTextViewerPanel />);
    expect(screen.getByText('p.1')).toBeTruthy();
    expect(screen.getByText('p.2')).toBeTruthy();
    expect(screen.getByText(/첫째 쪽 내용/)).toBeTruthy();
  });

  it('헤더 라벨이 unitKind 를 따른다', () => {
    setDoc(['a'], 'slide');
    render(<DocTextViewerPanel />);
    expect(screen.getByText('슬라이드 1')).toBeTruthy();
  });

  it('각 단위에 인용 점프용 id 를 단다', () => {
    setDoc(['a', 'b']);
    const { container } = render(<DocTextViewerPanel />);
    expect(container.querySelector('#unit-1')).not.toBeNull();
    expect(container.querySelector('#unit-2')).not.toBeNull();
  });

  it('citationTarget 이 가리키는 단위로 스크롤한다', () => {
    setDoc(['a', 'b', 'c']);
    const spy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = spy;
    useAppStore.setState({ citationTarget: { page: 2 } });
    render(<DocTextViewerPanel />);
    expect(spy).toHaveBeenCalled();
  });

  /**
   * fix1(Minor 3): 첫 렌더 전에 대상을 지정하는 위 테스트만으로는 effect 의 deps 배열이
   * `[citationTarget]` 이든 `[]` 이든 통과한다(마운트 시 1회는 항상 발화하므로). 실제로 두 번째
   * 인용을 클릭해 대상이 바뀌는 경로를 재현해야 deps 누락(재스크롤 불능 회귀)을 잡는다.
   */
  it('마운트 후 citationTarget 이 다른 단위로 바뀌면 그 새 단위로 다시 스크롤한다', () => {
    setDoc(['a', 'b', 'c']);
    const scrolledIds: string[] = [];
    window.HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
      scrolledIds.push(this.id);
    });
    useAppStore.setState({ citationTarget: { page: 1 } });
    render(<DocTextViewerPanel />);
    expect(scrolledIds).toEqual(['unit-1']);
    act(() => { useAppStore.setState({ citationTarget: { page: 3 } }); });
    expect(scrolledIds).toEqual(['unit-1', 'unit-3']);
  });

  it('배율을 글꼴 크기로 매핑한다', () => {
    setDoc(['a']);
    useAppStore.setState({ pdfViewerZoom: 1.5 });
    const { container } = render(<DocTextViewerPanel />);
    const root = container.querySelector('[data-testid="doc-text-viewer"]') as HTMLElement;
    expect(root.style.fontSize).toBe('24px');
  });

  it('문서가 없으면 아무것도 렌더하지 않는다', () => {
    useAppStore.setState({ document: null });
    const { container } = render(<DocTextViewerPanel />);
    expect(container.firstChild).toBeNull();
  });
});
