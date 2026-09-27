// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../../lib/i18n';
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
  // QA34(M4): 툴바 배율 버튼의 콜백이 무보호였다 — `onZoomIn={() => {}}` 로 바꿔도 초록이었다
  // (기존 테스트는 store 값→글꼴 매핑만 봤다). 클릭 → store 영속 값 + 실제 글꼴 크기까지 본다.
  it('확대/축소/맞춤 버튼이 store 배율과 글꼴 크기를 바꾼다', async () => {
    setDoc(['a']);
    const user = userEvent.setup();
    const { container } = render(<DocTextViewerPanel />);
    const root = container.querySelector('[data-testid="doc-text-viewer"]') as HTMLElement;
    expect(root.style.fontSize).toBe('16px');

    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomIn') }));
    expect(useAppStore.getState().pdfViewerZoom).toBeCloseTo(1.25);
    expect(root.style.fontSize).toBe('20px');

    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomOut') }));
    await user.click(screen.getByRole('button', { name: t('pdfviewer.zoomOut') }));
    expect(useAppStore.getState().pdfViewerZoom).toBeCloseTo(0.75);
    expect(root.style.fontSize).toBe('12px');

    await user.click(screen.getByRole('button', { name: (n: string) => n.includes(t('pdfviewer.zoomReset')) }));
    expect(useAppStore.getState().pdfViewerZoom).toBe(1);
    expect(root.style.fontSize).toBe('16px');
  });

  // QA34(L12): 표시·접근성 층 — 인용 대상 강조, 단원 section 의 이름, 배율 라이브 리전.
  it('인용 대상 단위만 강조되고 section 이 단위 라벨을 접근성 이름으로 갖는다', () => {
    setDoc(['a', 'b', 'c'], 'slide');
    useAppStore.setState({ citationTarget: { page: 2 } });
    const { container } = render(<DocTextViewerPanel />);
    const target = container.querySelector('#unit-2') as HTMLElement;
    const other = container.querySelector('#unit-1') as HTMLElement;
    expect(target.className).toContain('border-blue-500');
    expect(other.className).not.toContain('border-blue-500');
    expect(target.getAttribute('aria-label')).toBe('슬라이드 2');
    expect(screen.getByRole('region', { name: '슬라이드 3' })).toBeTruthy();
  });

  it('배율 라이브 리전이 현재 배율을 알린다', () => {
    setDoc(['a']);
    useAppStore.setState({ pdfViewerZoom: 1.5 });
    render(<DocTextViewerPanel />);
    expect(screen.getByRole('status').textContent).toBe(t('pdfviewer.zoomLevel', { percent: '150%' }));
  });

  // QA34(M6): 원문의 물결표 범위("9/1~9/30", "10~20명")가 GFM 단일 물결 취소선으로 먹혀
  // 두 물결 사이가 <del> 로 그려졌다. 강조(**…**)를 함께 넣어 지연 청크가 **실제로 렌더한 뒤**를
  // 본다 — 청크 로드 전 fallback 은 원문 평문이라 <del> 이 없어 항상 초록이 된다.
  it("원문의 '~' 범위 표기를 취소선으로 그리지 않는다", async () => {
    setDoc(['**일정** 기간 9/1~9/30, 인원 10~20명']);
    const { container } = render(<DocTextViewerPanel />);
    await waitFor(() => expect(container.querySelector('strong')).not.toBeNull(), { timeout: 5000 });
    expect(container.querySelector('del')).toBeNull();
    expect(container.textContent).toContain('기간 9/1~9/30, 인원 10~20명');
  });

  it('이중 물결(~~x~~)은 여전히 취소선이다 (GFM 기능 자체는 유지)', async () => {
    setDoc(['**a** ~~지운 글~~']);
    const { container } = render(<DocTextViewerPanel />);
    await waitFor(() => expect(container.querySelector('strong')).not.toBeNull(), { timeout: 5000 });
    expect(container.querySelector('del')?.textContent).toBe('지운 글');
  });
});
