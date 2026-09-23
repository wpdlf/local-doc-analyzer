// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
