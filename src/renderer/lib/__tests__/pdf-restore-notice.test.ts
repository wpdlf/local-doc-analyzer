// @vitest-environment happy-dom

// QA34: 세션 복원 시 빈 페이지 재통지는 PDF 만. 탭 복원 경로가 문서 종류를 가리지 않아
// 그림만 있는 쪽이 여럿인 DOCX 에도 "스캔 PDF 라면 OCR 을 켜라" 고지가 떴다.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), OPS: {} }));

import { notifyRestoredEmptyPages } from '../pdf-parser';
import { useAppStore } from '../store';
import { t } from '../i18n';

/** 10쪽 중 8쪽이 빈 문서 — countEmptyPages 가 유의미로 판정하는 형태. */
const MOSTLY_EMPTY = ['표지 본문', '', '', '', '', '', '', '', '', '마지막'];

describe('notifyRestoredEmptyPages', () => {
  beforeEach(() => useAppStore.getState().setNotice(null));

  it('PDF(unitKind 부재)는 빈 페이지 고지를 띄운다', () => {
    notifyRestoredEmptyPages({ pageTexts: MOSTLY_EMPTY });
    expect(useAppStore.getState().notice?.message)
      .toBe(t('pdf.emptyPagesNotice', { count: '8', total: '10' }));
  });

  it('OCR 로 연 PDF 는 OCR 부분 실패 문구를 쓴다', () => {
    notifyRestoredEmptyPages({ pageTexts: MOSTLY_EMPTY, isOcr: true });
    expect(useAppStore.getState().notice?.message)
      .toBe(t('pdf.ocrPartialFailNotice', { count: '8', total: '10' }));
  });

  it('비-PDF(unitKind 있음)에는 PDF·OCR 고지를 띄우지 않는다', () => {
    notifyRestoredEmptyPages({ pageTexts: MOSTLY_EMPTY, unitKind: 'page' });
    expect(useAppStore.getState().notice).toBeNull();
  });
});
