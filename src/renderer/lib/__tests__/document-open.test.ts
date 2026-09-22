// @vitest-environment happy-dom

// pdf-parser 보강 — openDocumentData 오케스트레이션(가드/성공/에러 매핑)과 cancelDocumentParse,
// parsePdf 의 pageCount 가드·OCR fallback 경로. parsePdf 의 텍스트 추출/이미지 캡/args 가드는
// pdf-parser.test.ts(node-env) 가 별도 커버. pdfjs-dist/worker/use-session 은 목 격리.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const P = vi.hoisted(() => {
  // getOperatorList(이미지 추출 경로의 비싼 호출)를 공유 spy 로 — extractImages 스킵 검증용.
  const getOperatorList = vi.fn(() => Promise.resolve({ fnArray: [], argsArray: [] }));
  function makePage(items: unknown[]) {
    return {
      getTextContent: () => Promise.resolve({ items }),
      getOperatorList,
      objs: { get: () => {} },
      getViewport: () => ({ width: 600, height: 800 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {},
    };
  }
  function fakePdf(numPages: number, items: unknown[]) {
    return {
      numPages,
      getPage: vi.fn(() => Promise.resolve(makePage(items))),
      destroy: vi.fn(() => Promise.resolve()),
    };
  }
  return { fakePdf, getOperatorList, getDocument: vi.fn(), restore: vi.fn(() => Promise.resolve()), persist: vi.fn(() => Promise.resolve()) };
});

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));
// pdfjs 6.x: 프로덕션 코드가 PDFDocumentProxy.destroy() 대신 loadingTask.destroy() 를 호출한다.
// mock 의 loadingTask({ promise }) 에 destroy 가 없으면 에러 분기(page 0 / too-many-pages)에서
// TypeError 가 나 기대 에러코드가 안 잡힌다. P.getDocument 에 위임하면서(호출수 검증 보존) destroy 부착.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => {
    const task = P.getDocument(...args) as { promise: Promise<unknown>; destroy?: unknown };
    if (task && typeof task.destroy !== 'function') task.destroy = vi.fn(() => Promise.resolve());
    return task;
  },
  OPS: { paintImageXObject: 85 },
}));
vi.mock('../use-session', () => ({ restoreSessionForDocument: P.restore, persistCurrentSession: P.persist }));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { ocrPage: vi.fn(() => Promise.resolve({ success: false, text: '' })), abort: vi.fn(() => Promise.resolve()) } },
}));
vi.stubGlobal('crypto', { randomUUID: () => 'doc-uuid' });

import { openDocumentData, cancelDocumentParse, EXTRACTOR_ERROR_MESSAGE_KEYS } from '../document-open';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import { useAppStore } from '../store';
import { DEFAULT_SETTINGS } from '../../types';
import { MAX_PDF_SIZE_BYTES } from '../../../shared/constants';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripJsComments } from '../../../shared/__tests__/helpers/source-scan';

const GOOD_ITEMS = [{ str: 'A'.repeat(60), transform: [12, 0, 0, 12, 0, 700], width: 100 }];
const SHORT_ITEMS = [{ str: 'ab', transform: [12, 0, 0, 12, 0, 700], width: 10 }];

function pdfBuf(extra = 200): ArrayBuffer {
  const u = new Uint8Array(5 + extra);
  u.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF-
  return u.buffer;
}

beforeEach(() => {
  vi.clearAllMocks();
  P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(2, GOOD_ITEMS)) });
  P.restore.mockResolvedValue(undefined);
  P.persist.mockResolvedValue(undefined);
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false },
    document: null, isGenerating: false, isQaGenerating: false, isParsing: false, isCollectionBusy: false,
    error: null, summary: null, summaryStream: '', qaMessages: [], pdfBytes: null,
  });
});
afterEach(() => { cancelDocumentParse(); });

describe('openDocumentData — 가드', () => {
  it('요약 생성 중이면 거부 + parse 미시도', async () => {
    useAppStore.setState({ isGenerating: true });
    await openDocumentData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  it('Q&A 생성 중이면 거부', async () => {
    useAppStore.setState({ isQaGenerating: true });
    await openDocumentData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  // QA post-v0.31.15(M2): 컬렉션 gather 단계(isCollectionBusy=true, isQaGenerating 아직 false)에도
  // 새 파일 열기를 차단 — isTabSwitchBlocked 와 대칭(누락 시 in-flight 멤버 요약 토큰 낭비).
  it('컬렉션 요약 gather 중(isCollectionBusy)이면 거부', async () => {
    useAppStore.setState({ isGenerating: false, isQaGenerating: false, isCollectionBusy: true });
    await openDocumentData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  // C5-M4(QA cycle5): openCollection(탭 세트 재구성) 진행 중에도 새 파일 열기 차단 — 드롭/최근
  // 문서/전역검색/Ctrl+O 는 isTabSwitchBlocked 를 안 거치므로 여기 진입 가드가 유일한 방어선.
  it('컬렉션 열기 중(collectionOpenInFlight)이면 거부', async () => {
    useAppStore.setState({ isGenerating: false, isQaGenerating: false, isCollectionBusy: false, collectionOpenInFlight: true });
    await openDocumentData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(P.getDocument).not.toHaveBeenCalled();
    useAppStore.setState({ collectionOpenInFlight: false });
  });

  // QA post-v0.31.16(i18n 갭): 진입 가드 메시지가 하드코딩 한글이 아니라 i18n 을 거친다.
  // en 로케일에서 영문으로 표시되어야 한다(이전엔 영어 UI 에도 한글 노출).
  it('en 로케일: 가드/검증 메시지가 i18n 영문으로 표시된다', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', uiLanguage: 'en' }, isGenerating: true });
    await openDocumentData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/Cannot open a new file while summarizing/);

    // 매직바이트 실패 메시지도 영문(위장 바이너리). Task10 후속 판정: `.pdf` 로 드롭된 파일은
    // 진입 게이트가 확장자를 이미 확인했으므로, 내용이 PDF/zip 매직과 안 맞으면 "지원하지
    // 않는 형식"이 아니라 "손상/형식 불일치"(DOC_CORRUPT)가 정확하다.
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', uiLanguage: 'en' }, isGenerating: false });
    await openDocumentData(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer, 'fake.pdf', '/d/fake.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/may be corrupted or in a different format/);
  });

  it('용량 초과 → PDF_PARSE_FAIL', async () => {
    const big = new ArrayBuffer(MAX_PDF_SIZE_BYTES + 1);
    await openDocumentData(big, 'big.pdf', '/d/big.pdf');
    expect(useAppStore.getState().error?.message).toMatch(/너무 큽니다/);
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  // Task10 후속 판정: `fake.pdf` 는 확장자가 지원 목록(진입 게이트가 이미 확인) 안이라, 내용이
  // PDF/zip 매직과 안 맞으면 "지원하지 않는 형식"(존재하지 않는 문제)이 아니라 "손상/형식
  // 불일치"(DOC_CORRUPT)로 안내해야 한다 — 사용자는 "내 건 .pdf 인데?" 가 되면 안 된다.
  it('매직바이트 불일치(위장 바이너리) → DOC_CORRUPT 로 거부', async () => {
    const u = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await openDocumentData(u.buffer, 'fake.pdf', '/d/fake.pdf');
    expect(useAppStore.getState().error?.code).toBe('DOC_CORRUPT');
    expect(useAppStore.getState().error?.message).toMatch(/손상되었거나 다른 형식/);
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  // QA13(C-LOW): pdfjs 는 %PDF- 앞의 선행 바이트(BOM 등)를 허용한다. 게이트가 오프셋0 정확매칭만
  // 하면 그런 유효 PDF 를 오거부 → 앞쪽 1KB 창 스캔으로 완화. BOM 접두 PDF 가 파싱 시도되어야 한다.
  it('선행 BOM 이 있는 유효 PDF 는 매직 게이트를 통과한다', async () => {
    const body = new Uint8Array(3 + 5 + 200);
    body.set([0xef, 0xbb, 0xbf], 0);            // UTF-8 BOM
    body.set([0x25, 0x50, 0x44, 0x46, 0x2d], 3); // %PDF-
    await openDocumentData(body.buffer, 'bom.pdf', '/d/bom.pdf');
    expect(P.getDocument).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().error).toBeNull();
  });
});

describe('openDocumentData — 성공 오케스트레이션', () => {
  it('유효 PDF(실경로) → 문서 설정 + 세션 복원 트리거, pdfBytes 는 비상주(lazy)', async () => {
    await openDocumentData(pdfBuf(), 'lecture.pdf', '/d/lecture.pdf');
    const s = useAppStore.getState();
    expect(P.getDocument).toHaveBeenCalledTimes(1);
    expect(s.document?.fileName).toBe('lecture.pdf');
    expect(s.document?.pageCount).toBe(2);
    expect(s.document?.chapters.length).toBeGreaterThan(0);
    // pdfBytes 비상주(메모리 M1): 재읽기 가능한 실경로는 상주 안 함 — 인용 클릭 시 lazy 로드.
    expect(s.pdfBytes).toBeNull();
    expect(P.restore).toHaveBeenCalledTimes(1);
    expect(s.error).toBeNull();
    expect(s.isParsing).toBe(false);
  });

  it('합성경로(경로 구분자 없음) 드롭 → 재읽기 불가라 pdfBytes 상주(fallback)', async () => {
    await openDocumentData(pdfBuf(), 'lecture.pdf', 'lecture.pdf'); // getPathForFile 실패 시 파일명 fallback
    const s = useAppStore.getState();
    expect(s.document?.fileName).toBe('lecture.pdf');
    expect(s.pdfBytes).not.toBeNull(); // 재읽기 불가 → 상주 유지
  });

  // perf(A1): 이미지 분석 OFF면 parsePdf 가 이미지 추출(getOperatorList=pdfjs 최고비용)을 스킵.
  it('enableImageAnalysis=true → getOperatorList 호출(이미지 경로 실행)', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: true } });
    await openDocumentData(pdfBuf(), 'a.pdf', '/d/a.pdf');
    expect(P.getOperatorList).toHaveBeenCalled();
  });

  it('enableImageAnalysis=false → getOperatorList 미호출(추출 스킵) + images 비어있음', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: false } });
    await openDocumentData(pdfBuf(), 'b.pdf', '/d/b.pdf');
    expect(P.getOperatorList).not.toHaveBeenCalled();
    expect(useAppStore.getState().document?.images).toEqual([]);
  });

  // QA22 백로그: 조립 로직을 순수 함수(assemblePageText)로 분리하면서, **그 함수가 실제로 파싱
  // 경로에 배선돼 있는지**를 별도로 잡는다. 순수 테스트만 두면 호출을 떼어내는 뮤테이션이 통과한다
  // (같은 실수를 이번 사이클 dedup 배선에서 한 번 했다).
  it('배선: 위치 기반 공백·줄바꿈이 실제 파싱 결과(pageTexts)에 반영된다', async () => {
    // PDF_NO_TEXT 가드(최소 길이)를 넘기려면 본문이 충분히 길어야 하므로 각 조각을 30자로 만든다.
    const seg = (ch: string) => ch.repeat(30);
    const items = [
      { str: seg('가'), transform: [10, 0, 0, 10, 0, 700], width: 300 },
      { str: seg('나'), transform: [10, 0, 0, 10, 300, 700], width: 300 }, // 바로 이어짐 → 붙여쓰기
      { str: seg('다'), transform: [10, 0, 0, 10, 0, 680], width: 300 },   // y 20 차 → 줄바꿈
      { str: seg('라'), transform: [10, 0, 0, 10, 360, 680], width: 300 }, // 넓은 간격 → 공백
    ];
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(1, items)) });
    await openDocumentData(pdfBuf(), 'pos.pdf', '/d/pos.pdf');
    expect(useAppStore.getState().document?.pageTexts[0])
      .toBe(`${seg('가')}${seg('나')}\n${seg('다')} ${seg('라')}`);
  });

  // QA23(C-MED) 배선: 검사 예산이 실제 파싱 루프에 걸려 있는지. 순수 판정만 테스트하면
  // 호출을 떼는 뮤테이션이 통과한다(이번 사이클 dedup 배선에서 겪은 형태).
  it('배선: 채택되지 않는 이미지만 반복돼도 페이지 열기가 무한히 계속되지 않는다', async () => {
    // 모든 이미지가 MAX_IMAGE_PIXELS 초과로 거절되는 문서(300 DPI 스캔) — 채택 수는 영원히 0.
    const huge = { width: 3000, height: 3000, data: new Uint8ClampedArray(4), kind: 3 };
    const opsPerPage = 40;
    const getOperatorList = vi.fn(() => Promise.resolve({
      fnArray: new Array(opsPerPage).fill(85),                       // OPS.paintImageXObject
      argsArray: new Array(opsPerPage).fill(['img_dup']),
    }));
    const page = {
      getTextContent: () => Promise.resolve({ items: [{ str: 'A'.repeat(80), transform: [12, 0, 0, 12, 0, 700], width: 100 }] }),
      getOperatorList,
      objs: { get: (_n: string, cb: (o: unknown) => void) => cb(huge) },
      getViewport: () => ({ width: 600, height: 800 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {},
    };
    P.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 60, getPage: vi.fn(() => Promise.resolve(page)), destroy: vi.fn(() => Promise.resolve()) }),
    });
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: true } });

    await openDocumentData(pdfBuf(), 'scan.pdf', '/d/scan.pdf');

    // 예산(400 검사)이 페이지당 40장이면 10페이지에서 소진 — 60페이지 전부를 열지 않아야 한다.
    expect(getOperatorList.mock.calls.length).toBeLessThan(60);
    expect(useAppStore.getState().document?.images).toEqual([]); // 전량 거절은 종전대로
  });

  // QA28(B2-Low → QA22 배선 누락): `pdf.imageBudgetNotice` 문구는 QA22 가 추가했지만 방출자가
  // 없어 한 번도 표시되지 않았다. 성공 경로의 stale notice 정리(setNotice(null)) **뒤**에
  // 고지가 남아야 한다 — 앞에 두면 곧바로 지워져 같은 결함이 된다.
  it('배선: Vision 이미지 예산(50장) 초과 문서를 열면 파싱 완료 후 imageBudgetNotice 가 남는다', async () => {
    const W = 64, H = 64;
    const fakeImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
    class FakeImageData {
      data: Uint8ClampedArray; width: number; height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; }
    }
    let blobSeq = 0; // 서로 다른 바이트 → 중복 제거에 접히지 않는 "신규" 이미지
    class FakeOffscreenCanvas {
      width: number; height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { putImageData() {}, drawImage() {} }; }
      async convertToBlob() {
        const n = blobSeq++;
        return { async arrayBuffer() { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, 1, 2, 3, 4, 5, 6]).buffer; } };
      }
    }
    const g = globalThis as unknown as Record<string, unknown>;
    const origOC = g.OffscreenCanvas, origID = g.ImageData;
    g.OffscreenCanvas = FakeOffscreenCanvas; g.ImageData = FakeImageData;
    const setNotice = vi.spyOn(useAppStore.getState(), 'setNotice');
    try {
      const page = {
        getTextContent: () => Promise.resolve({ items: [{ str: 'A'.repeat(80), transform: [12, 0, 0, 12, 0, 700], width: 100 }] }),
        getOperatorList: vi.fn(() => Promise.resolve({ fnArray: new Array(20).fill(85), argsArray: new Array(20).fill(['img']) })),
        objs: { get: (_n: string, cb: (o: unknown) => void) => cb(fakeImage) },
        getViewport: () => ({ width: 600, height: 800 }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: () => {},
      };
      // 10페이지 × 페이지당 10장(MAX_IMAGES_PER_PAGE) = 100 신규 > 50 예산
      P.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 10, getPage: vi.fn(() => Promise.resolve(page)), destroy: vi.fn(() => Promise.resolve()) }),
      });
      useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false, enableImageAnalysis: true, uiLanguage: 'ko' }, notice: null });

      await openDocumentData(pdfBuf(), 'many.pdf', '/d/many.pdf');

      expect(useAppStore.getState().document?.images.length).toBe(50);
      const { t } = await import('../i18n');
      const expected = t('pdf.imageBudgetNotice', { max: '50' });
      // 마지막 setNotice 가 고지여야 한다(null 정리가 뒤에 오면 즉시 소멸).
      const calls = setNotice.mock.calls.map((c) => c[0]);
      expect(calls).toContainEqual(null);
      expect(calls.at(-1)).toEqual({ message: expected });
      expect(calls.indexOf(null)).toBeLessThan(calls.length - 1);
      expect(useAppStore.getState().notice?.message).toBe(expected);
    } finally {
      g.OffscreenCanvas = origOC; g.ImageData = origID;
      setNotice.mockRestore();
    }
  });

  // QA24(A-I1): 드롭·Ctrl+O·최근 문서·전역 검색은 전부 이 함수로 직행한다. 영속화 OFF 면
  // 새 문서 로드가 현재 요약·Q&A 를 되돌릴 수 없이 파기하는데, 종전에는 탭 전환에만 확인이
  // 있었고 이 경로들은 무경고였다.
  describe('영속화 OFF 파기 확인 (직행 로드 경로)', () => {
    const seedWorkWithPersistOff = () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: false },
        document: { id: 'old', fileName: 'old.pdf', filePath: '/d/old.pdf', pageCount: 1, extractedText: 'x', pageTexts: ['x'], chapters: [], images: [], createdAt: new Date() },
        qaMessages: [{ id: 'q1', role: 'user', content: '질문' }],
      });
    };

    it('취소하면 파싱조차 시작하지 않는다 (수십 초 파싱 뒤 묻는 확인은 의미가 없다)', async () => {
      seedWorkWithPersistOff();
      P.getDocument.mockClear();
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await openDocumentData(pdfBuf(), 'new.pdf', '/d/new.pdf');
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(P.getDocument, '취소했는데 파싱이 돌면 안 된다').not.toHaveBeenCalled();
        expect(useAppStore.getState().document?.fileName, '기존 문서가 유지돼야 한다').toBe('old.pdf');
        expect(useAppStore.getState().qaMessages).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('확인하면 종전대로 진행한다', async () => {
      seedWorkWithPersistOff();
      vi.stubGlobal('confirm', vi.fn(() => true));
      try {
        await openDocumentData(pdfBuf(), 'new.pdf', '/d/new.pdf');
        expect(useAppStore.getState().document?.fileName).toBe('new.pdf');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('열린 문서가 없으면(첫 로드) 묻지 않는다 — 파기할 것이 없다', async () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: false },
        document: null,
        qaMessages: [],
      });
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await openDocumentData(pdfBuf(), 'first.pdf', '/d/first.pdf');
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('skipDiscardConfirm=true 면 묻지 않는다 (탭 전환 fallback 의 이중 질문 방지)', async () => {
      seedWorkWithPersistOff();
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await openDocumentData(pdfBuf(), 'new.pdf', '/d/new.pdf', { skipDiscardConfirm: true });
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('기존 문서가 있으면 새 문서 반영 전에 persist flush', async () => {
    useAppStore.setState({ document: { id: 'old', fileName: 'old.pdf', filePath: '/d/old.pdf', pageCount: 1, extractedText: 'x', pageTexts: ['x'], chapters: [], images: [], createdAt: new Date() } });
    await openDocumentData(pdfBuf(), 'new.pdf', '/d/new.pdf');
    expect(P.persist).toHaveBeenCalled();
    expect(useAppStore.getState().document?.fileName).toBe('new.pdf');
  });
});

describe('openDocumentData — parsePdf 경로/에러 매핑', () => {
  it('페이지 0 → PDF_NO_TEXT', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(0, GOOD_ITEMS)) });
    await openDocumentData(pdfBuf(), 'empty.pdf', '/d/empty.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
  });

  it('페이지 수 초과 → PDF_TOO_MANY_PAGES', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(MAX_PAGE_COUNT + 1, GOOD_ITEMS)) });
    await openDocumentData(pdfBuf(), 'huge.pdf', '/d/huge.pdf');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('PDF_TOO_MANY_PAGES');
    // Task10 리뷰 라운드2: parsePdf 는 이 코드를 이미 t() 로 번역된 문자열로 던진다(params 없음)
    // — document-open 의 EXTRACTOR_ERROR_MESSAGE_KEYS 매핑이 여길 다시 건드리면(무조건 덮어쓰기)
    // params 가 없어 `{pages}p` 미해석 placeholder 로 회귀한다. 그대로 통과해야 한다.
    expect(s.error?.message).toBe(
      `페이지 수가 너무 많습니다 (${MAX_PAGE_COUNT + 1}p). 최대 ${MAX_PAGE_COUNT}페이지까지 지원합니다. 문서를 분할해주세요.`,
    );
  });

  it('텍스트 거의 없음 + OCR 비활성 → PDF_NO_TEXT', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(2, SHORT_ITEMS)) });
    await openDocumentData(pdfBuf(), 'scan.pdf', '/d/scan.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
  });

  it('텍스트 거의 없음 + OCR 활성 → OCR 시도 후 OCR_FAIL', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: true } });
    P.getDocument.mockReturnValue({ promise: Promise.resolve(P.fakePdf(2, SHORT_ITEMS)) });
    await openDocumentData(pdfBuf(), 'scan.pdf', '/d/scan.pdf');
    expect(useAppStore.getState().error?.code).toBe('OCR_FAIL');
  });

  it('getDocument 가 ABORTED → 에러 배너 미표시(의도적 취소)', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.reject(Object.assign(new Error('취소'), { code: 'ABORTED' })) });
    await openDocumentData(pdfBuf(), 'x.pdf', '/d/x.pdf');
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().isParsing).toBe(false);
  });

  it('getDocument 일반 에러 → PDF_PARSE_FAIL 로 매핑', async () => {
    P.getDocument.mockReturnValue({ promise: Promise.reject(new Error('손상된 스트림')) });
    await openDocumentData(pdfBuf(), 'x.pdf', '/d/x.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(useAppStore.getState().error?.message).toMatch(/손상된 스트림/);
  });

  // QA13(C-MED): 암호화/손상 PDF 는 loadingTask.promise 가 try/finally 진입 전 reject 하므로
  // destroy 가 누락돼 pdfjs 워커가 누수됐다. reject 경로에서도 파기하고, PasswordException 은
  // 전용 로컬라이즈 코드(PDF_ENCRYPTED)로 매핑하는지 가드.
  it('암호화 PDF(PasswordException) → PDF_ENCRYPTED + loadingTask.destroy 로 워커 파기', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    P.getDocument.mockReturnValue({
      promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })),
      destroy,
    });
    await openDocumentData(pdfBuf(), 'locked.pdf', '/d/locked.pdf');
    expect(useAppStore.getState().error?.code).toBe('PDF_ENCRYPTED');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

// Task10 리뷰 라운드1(Critical 2): brief Step1 은 "이동 전 동작 고정"과 "신규 분기 테스트" 둘을
// 요구했는데, 앞쪽만 하고 뒤쪽을 취소한 것이 결함이었다. resolveExtractor·zip→DOC_UNSUPPORTED·
// CFB→DOC_ENCRYPTED·openZip 의 DOC_TOO_LARGE/DOC_CORRUPT 매핑·DOCX 성공경로(toPdfDocument 배선)·
// pdfBytesCopy 게이트의 `!isPdf` 절반 — 이 여섯 곳을 아래에서 채운다.
describe('openDocumentData — 포맷 dispatch (Task10 리뷰 라운드1)', () => {
  async function docxZip(bodyXml: string): Promise<ArrayBuffer> {
    const { zipSync, strToU8 } = await import('fflate');
    const xml = `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${bodyXml}</w:body></w:document>`;
    const out = zipSync({ 'word/document.xml': strToU8(xml) });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }
  function para(text: string): string {
    return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  }

  it('DOCX 성공 경로 — toPdfDocument 를 거쳐 문서가 채워지고, 재읽기 불가 경로여도 pdfBytes 는 null 이다', async () => {
    const zip = await docxZip(para('첫째 쪽') + para('둘째 쪽'));
    // 경로 구분자가 없는 합성 경로 — PDF 였다면 isReReadablePath 가 false 라 pdfBytes 가 상주해야
    // 하지만, DOCX(`!isPdf`)는 그 판정보다 먼저 항상 null 이어야 한다(리뷰 항목: !isPdf 절반).
    await openDocumentData(zip, 'report.docx', 'report.docx');
    const s = useAppStore.getState();
    expect(s.error).toBeNull();
    expect(s.document?.fileName).toBe('report.docx');
    expect(s.document?.unitKind).toBe('page');
    expect(s.document?.pageTexts).toEqual(['첫째 쪽\n\n둘째 쪽']);
    expect(s.pdfBytes).toBeNull();
    expect(P.getDocument).not.toHaveBeenCalled(); // pdfjs 를 거치지 않는다
  });

  it('zip 이지만 아는 추출기가 없으면 DOC_UNSUPPORTED 다', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const out = zipSync({ 'ppt/presentation.xml': strToU8('<p:presentation/>') });
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    await openDocumentData(buf, 'deck.docx', '/d/deck.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_UNSUPPORTED');
    expect(s.error?.message).toMatch(/PDF/); // SUPPORTED_LABEL 이 실려 있다
  });

  it('CFB 컨테이너(암호화된 OOXML)는 DOC_ENCRYPTED 다', async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await openDocumentData(cfb.buffer, 'locked.docx', '/d/locked.docx');
    expect(useAppStore.getState().error?.code).toBe('DOC_ENCRYPTED');
  });

  it('zip 매직은 맞지만 해제가 안 되는 손상 파일은 DOC_CORRUPT 다 — openZip 매핑이 document-open 을 거쳐도 살아있다', async () => {
    // PK 로컬 파일 헤더 시그니처만 있고 나머지는 쓰레기 — hasZipMagic 은 통과, unzipSync 는 실패.
    const bogus = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await openDocumentData(bogus.buffer, 'bad.docx', '/d/bad.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_CORRUPT');
    expect(s.error?.message).toBe('파일이 손상되었거나 다른 형식일 수 있습니다. 다른 파일로 다시 시도해주세요.');
  });

  it('엔트리 수 상한을 넘는 zip 은 DOC_TOO_LARGE 다 — openZip 매핑이 document-open 을 거쳐도 살아있다', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= 2000; i++) files[`f${i}.txt`] = strToU8('x');
    const out = zipSync(files);
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    await openDocumentData(buf, 'huge.docx', '/d/huge.docx');
    expect(useAppStore.getState().error?.code).toBe('DOC_TOO_LARGE');
  }, 20000);

  // Task10 리뷰 라운드1(Important 3): docx.ts 내부 throw 는 영어 원문이다. document-open 의
  // 바깥 catch 가 알려진 DOC_* 코드를 t() 로 덮어써야 한다 — 원문은 details 로만 남는다.
  it('word/document.xml 에 w:body 가 없으면 DOC_CORRUPT + 로컬라이즈 메시지(details 에 원문)', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const xml = '<?xml version="1.0"?><w:document xmlns:w="urn:w"></w:document>';
    const out = zipSync({ 'word/document.xml': strToU8(xml) });
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    await openDocumentData(buf, 'nobody.docx', '/d/nobody.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_CORRUPT');
    expect(s.error?.message).toBe('파일이 손상되었거나 다른 형식일 수 있습니다. 다른 파일로 다시 시도해주세요.');
    expect(s.error?.message).not.toMatch(/w:body/); // 개발자용 영어 원문이 화면에 그대로 노출되지 않는다
    expect(s.error?.details).toBe('w:body missing');
  });

  // Task10 리뷰 라운드1(항목5 — validCodes 핀): DOC_NO_TEXT 가 validCodes 에 없으면 모든 DOCX
  // 실패가 PDF_PARSE_FAIL 로 뭉개진다. 동시에 i18n 매핑(항목3)도 함께 확인한다.
  it('본문에 텍스트가 없는 DOCX 는 DOC_NO_TEXT 다 (PDF_PARSE_FAIL 로 뭉개지지 않는다) + 로컬라이즈 메시지', async () => {
    const zip = await docxZip('');
    await openDocumentData(zip, 'empty.docx', '/d/empty.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_NO_TEXT');
    expect(s.error?.message).toBe('문서에서 텍스트를 추출할 수 없습니다. 파일 내용을 확인해주세요.');
    expect(s.error?.details).toBe('no text in document');
  });

  // Task10 리뷰 라운드2(finding 3): docx.ts:159(현 번호 기준) 의 PDF_TOO_MANY_PAGES 가 개발자용
  // 영어("unit count 501 exceeds 500")를 그대로 던졌었다 — PDF 경로(parsePdf)는 이미 t() 로
  // 번역된 문자열을 던지므로 라운드1 의 매핑(코드만 보고 덮어쓰기)이 이 경우엔 안전한 줄
  // 알았는데, DOCX 경로는 코드만 던지고 번역하지 않아 그대로 새 나갔다. extractFail 의 params
  // 를 통해 t('uploader.tooManyPages', {pages,max}) 로 정확히 채워지는지 — 그리고 어떤 영어
  // 개발자 문구도 화면에 남지 않는지 확인한다.
  it('MAX_PAGE_COUNT 를 넘는 DOCX 는 PDF_TOO_MANY_PAGES + 번역된 메시지다(개발자용 영어 노출 없음)', async () => {
    // 명시적 쪽나눔으로 501개의 독립된 단위를 강제한다(분량 기반 자동분할에 기대지 않는다 —
    // paginate() 는 문단 하나가 아무리 길어도 그 문단 내부에서는 쪼개지 않는다).
    const pageCount = MAX_PAGE_COUNT + 1;
    let body = '';
    for (let i = 0; i < pageCount; i++) {
      const pPr = i === 0 ? '' : '<w:pPr><w:pageBreakBefore/></w:pPr>';
      body += `<w:p>${pPr}<w:r><w:t>쪽 ${i}</w:t></w:r></w:p>`;
    }
    const zip = await docxZip(body);
    await openDocumentData(zip, 'huge.docx', '/d/huge.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('PDF_TOO_MANY_PAGES');
    expect(s.error?.message).toBe(
      `페이지 수가 너무 많습니다 (${pageCount}p). 최대 ${MAX_PAGE_COUNT}페이지까지 지원합니다. 문서를 분할해주세요.`,
    );
    // 개발자용 원문("unit count ... exceeds ...")이 화면에 그대로 노출되지 않는다.
    expect(s.error?.message).not.toMatch(/unit count/);
    expect(s.error?.message).not.toMatch(/exceeds/);
    expect(s.error?.details).toBe(`unit count ${pageCount} exceeds ${MAX_PAGE_COUNT}`);
  });
});

// Task10 리뷰 라운드1(Critical 2 + mutation 킬): 동시 두 건이 겹칠 때 이전(추월당한) 파싱이
// 최신 파싱의 상태를 절대 건드리지 않아야 한다는 계약 전체 — abort-replace, 성공 후 supersede
// 재확인, flush 대기 중 재확인, 실패 후 supersede 재확인, 조건부 finally.
describe('openDocumentData — 동시성 (Task10 리뷰 라운드1)', () => {
  function slowPdf(numPages: number, gate: Promise<unknown>) {
    return {
      numPages,
      getPage: vi.fn(() => gate),
      destroy: vi.fn(() => Promise.resolve()),
    };
  }
  function page(items: unknown[]) {
    return {
      getTextContent: () => Promise.resolve({ items }),
      getOperatorList: () => Promise.resolve({ fnArray: [], argsArray: [] }),
      objs: { get: () => {} },
      getViewport: () => ({ width: 600, height: 800 }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => {},
    };
  }

  // Task10 리뷰 라운드1(mutation 킬 — abort-replace 의 실제 abort() 호출): 위 supersede 가드들은
  // 전부 `activeParseController !== controller`(참조 비교) 만으로 성립해, `.abort()` 호출 자체를
  // 지우는 뮤테이션은 이 스위트의 다른 어떤 테스트도 죽이지 못한다(직접 확인함 — .abort() 를
  // 주석 처리하고 돌려도 전부 통과했다). 그 호출의 유일한 관측 가능 효과는 진행 중이던 신호를
  // 실제로 aborted 로 만들어 in-flight OCR IPC 의 abort 리스너를 발화시키는 것이다(비용 절감 —
  // 상단 주석 "진행 중 8건의 토큰 청구도 함께 차단"). 그 발화를 직접 관측한다.
  it('새 파일이 이전 파싱을 실제로 abort 한다 — in-flight OCR IPC 가 취소된다', async () => {
    // renderPageToImage 가 OffscreenCanvas 를 쓴다 — happy-dom 엔 없으므로 최소 스텁이 필요하다
    // (imageBudgetNotice 테스트와 동일 패턴). 없으면 canvas 생성 시점에서 조용히 실패해 ocrPage
    // 호출 자체에 도달하지 못하고, 이 테스트가 의도와 다른 이유로 무의미하게 통과/실패한다.
    class FakeOffscreenCanvas {
      width: number; height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return { async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer; } }; }
    }
    const g = globalThis as unknown as Record<string, unknown>;
    const origOC = g.OffscreenCanvas;
    g.OffscreenCanvas = FakeOffscreenCanvas;
    try {
      useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: true } });
      P.getDocument.mockReturnValueOnce({ promise: Promise.resolve(P.fakePdf(1, SHORT_ITEMS)) });
      const ocrGate = new Promise<{ success: boolean; text: string }>(() => {}); // 응답 안 옴 — 취소만 관측
      const ocrPageMock = window.electronAPI.ai.ocrPage as unknown as ReturnType<typeof vi.fn>;
      ocrPageMock.mockImplementationOnce(() => ocrGate);
      const abortMock = window.electronAPI.ai.abort as unknown as ReturnType<typeof vi.fn>;

      openDocumentData(pdfBuf(), 'first.pdf', '/d/first.pdf');
      // 첫 호출이 ocrPage IPC 대기 지점까지 진행하도록 여러 틱 양보한다(본문 추출 배치 →
      // OCR 폴백 진입 → renderPageToImage → ocrPage 순으로 여러 await 를 거친다).
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r));
      expect(ocrPageMock).toHaveBeenCalled();
      expect(abortMock).not.toHaveBeenCalled();

      // 두 번째 파일이 abort-replace 로 첫 파싱을 밀어낸다 — `.abort()` 를 지우는 뮤테이션이면
      // 아래 단언이 실패한다(신호가 aborted 되지 않아 리스너가 발화하지 않는다).
      await openDocumentData(pdfBuf(), 'second.pdf', '/d/second.pdf');
      expect(abortMock).toHaveBeenCalled();
    } finally {
      g.OffscreenCanvas = origOC;
    }
  });

  // Task10 리뷰 라운드1(mutation 킬 — ownedProgress 소유권 체크, :146): OCR 폴백의 매 IPC 뒤에
  // throwIfAborted 가 있어서, abort() 가 **먼저** 일어나면 그 IPC 의 결과가 언제 오든 ABORTED 로
  // 삼켜져 onProgress 자체가 호출되지 않는다 — 그래서 "그냥 두 번째를 겹쳐 연다" 로는 이 체크에
  // 절대 도달하지 못한다(직접 확인함: 위 abort 테스트들의 타이밍으로는 이 뮤테이션이 하나도
  // 안 죽는다). 이 체크가 실제로 막는 경쟁은 훨씬 좁다 — "그 페이지의 throwIfAborted 는 이미
  // 통과했는데, batch 전체가 아직 안 끝난" 마이크로태스크 틈이다. queueMicrotask 로 그 틈에
  // 정확히 abort 를 끼워 넣어 재현한다.
  it('ownedProgress 소유권: throwIfAborted 통과 직후 ~ batch 완료 사이에 추월당하면 그 진행률을 반영하지 않는다', async () => {
    class FakeOffscreenCanvas {
      width: number; height: number;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return { async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer; } }; }
    }
    const g = globalThis as unknown as Record<string, unknown>;
    const origOC = g.OffscreenCanvas;
    g.OffscreenCanvas = FakeOffscreenCanvas;
    try {
      useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: true } });
      // 페이지 1장 · 단일 배치 — batch 안의 유일한 페이지라 그 페이지의 throwIfAborted 통과가
      // 곧 "배치 전체가 통과" 를 뜻한다(경쟁을 재현하기 가장 좁고 확실한 모양).
      P.getDocument.mockReturnValueOnce({ promise: Promise.resolve(P.fakePdf(1, SHORT_ITEMS)) });
      let resolveOcr!: (v: { success: boolean; text: string }) => void;
      const ocrGate = new Promise<{ success: boolean; text: string }>((resolve) => { resolveOcr = resolve; });
      const ocrPageMock = window.electronAPI.ai.ocrPage as unknown as ReturnType<typeof vi.fn>;
      ocrPageMock.mockImplementationOnce(() => ocrGate);

      const setOcrProgressSpy = vi.spyOn(useAppStore.getState(), 'setOcrProgress');
      const firstPromise = openDocumentData(pdfBuf(), 'first.pdf', '/d/first.pdf');
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r));
      expect(ocrPageMock).toHaveBeenCalled();

      // ocrPage 응답을 흘려보낸 것과 "같은 턴에" — 그러나 그 응답의 throwIfAborted 통과
      // 마이크로태스크보다는 뒤에, batch(Promise.all) 완료보다는 앞에 — 두 번째 파일을 큐잉한다.
      resolveOcr({ success: false, text: '' });
      queueMicrotask(() => { void openDocumentData(pdfBuf(), 'second.pdf', '/d/second.pdf'); });

      await firstPromise;
      await new Promise((r) => setTimeout(r));
      await new Promise((r) => setTimeout(r));

      // 두 번째(활성) 파싱은 OCR 을 쓰지 않으므로(GOOD_ITEMS, 기본 mock) 정당한 ocrProgress 값을
      // 절대 만들지 않는다 — {current:1,total:1} 이 **호출 이력에 단 한 번이라도** 보이면 그것은
      // 오직 추월당한 첫 파싱의 onProgress(1,1) 뿐이다(소유권 체크가 없으면 이 호출이 일어난다).
      // 최종 상태(store.ocrProgress)만 보면 second 의 null 호출이 나중에 덮어써 뮤테이션을
      // 가려버린다 — 반드시 호출 이력 전체를 봐야 한다.
      const calls = setOcrProgressSpy.mock.calls.map((c) => c[0]);
      expect(calls).not.toContainEqual({ current: 1, total: 1 });
    } finally {
      g.OffscreenCanvas = origOC;
    }
  });

  it('늦게 성공한 이전 파싱은 최신 문서를 덮어쓰지 않는다 (post-parse supersede)', async () => {
    // 주의: store 에 이미 문서가 있으면(예: 두 번째 호출이 먼저 완주해 문서를 세팅) 아래 flush
    // 재확인(post-flush recheck, :194)이 이 시나리오도 함께 방어해 버려 :188 하나만 지우는
    // 뮤테이션이 안 죽는다(직접 확인함). :188 을 단독으로 겨누려면 **아직 아무 문서도 없는
    // (store.document===null) 상태에서 첫 파싱이 성공**해야 한다 — 그래야 flush 분기 자체를
    // 타지 않고 :188 하나에만 의존한다. 그래서 두 번째 호출도 아직 진행 중(미완료)으로 둔다.
    useAppStore.setState({ document: null });
    let resolveGate!: (p: unknown) => void;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    P.getDocument.mockReturnValueOnce({ promise: Promise.resolve(slowPdf(2, gate)) });

    const firstPromise = openDocumentData(pdfBuf(), 'first.pdf', '/d/first.pdf');
    await new Promise((r) => setTimeout(r)); // 첫 호출이 getPage() 대기 지점까지 진행하도록 양보

    // 두 번째 파일이 abort-replace 로 첫 파싱을 밀어내지만, 아직 완주하지 않는다(별도 gate).
    let resolveGate2!: (p: unknown) => void;
    const gate2 = new Promise((resolve) => { resolveGate2 = resolve; });
    P.getDocument.mockReturnValueOnce({ promise: Promise.resolve(slowPdf(2, gate2)) });
    const secondPromise = openDocumentData(pdfBuf(), 'second.pdf', '/d/second.pdf');
    await new Promise((r) => setTimeout(r));

    // 첫 파싱을 뒤늦게 성공시킨다 — 이미 추월당했고, 아직 어떤 문서도 store 에 없으므로
    // flush 분기(:192)를 타지 않는다. :188 이 유일한 방어선이다.
    resolveGate(page(GOOD_ITEMS));
    await firstPromise;
    expect(useAppStore.getState().document).toBeNull(); // 아직 second 도 안 끝났다

    // 두 번째도 완주시켜 정리한다.
    resolveGate2(page(GOOD_ITEMS));
    await secondPromise;
    expect(useAppStore.getState().document?.fileName).toBe('second.pdf');
  });

  it('활성 문서 flush 대기 중 새 파싱이 승자가 되면, flush 가 끝난 이전 파싱이 그 문서를 덮어쓰지 않는다 (post-flush recheck)', async () => {
    useAppStore.setState({
      document: { id: 'old', fileName: 'old.pdf', filePath: '/d/old.pdf', pageCount: 1, extractedText: 'x', pageTexts: ['x'], chapters: [], images: [], createdAt: new Date() },
    });
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => { resolvePersist = resolve; });
    P.persist.mockReturnValueOnce(persistGate);

    // 첫 호출은 빠르게 파싱을 마치고, 기존 문서가 있어 persistCurrentSession() 대기에 들어간다.
    const firstPromise = openDocumentData(pdfBuf(), 'first.pdf', '/d/first.pdf');
    await new Promise((r) => setTimeout(r)); // 첫 호출이 flush 대기 지점까지 진행하도록 양보
    expect(P.persist).toHaveBeenCalledTimes(1);

    // 두 번째 파일이 abort-replace 로 첫 파싱을 밀어내고 즉시 완주한다.
    await openDocumentData(pdfBuf(), 'second.pdf', '/d/second.pdf');
    expect(useAppStore.getState().document?.fileName).toBe('second.pdf');

    // 첫 파싱의 flush 를 뒤늦게 끝낸다 — 이미 추월당했으므로 store 를 덮어써선 안 된다.
    resolvePersist();
    await firstPromise;
    expect(useAppStore.getState().document?.fileName).toBe('second.pdf');
  });

  it('추월당한 뒤 늦게 실패한 파싱은 에러 배너·isParsing 을 건드리지 않는다 (catch-block supersede + 조건부 finally)', async () => {
    // enableOcrFallback:false + 짧은 텍스트 → throwIfAborted 를 거치지 않는 PDF_NO_TEXT 로 실패한다
    // (OCR 경로였다면 매 IPC 뒤 throwIfAborted 가 먼저 ABORTED 로 삼켜 이 두 가드를 가리게 된다).
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableOcrFallback: false } });
    let resolveGate!: (p: unknown) => void;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    P.getDocument.mockReturnValueOnce({ promise: Promise.resolve(slowPdf(2, gate)) });

    const firstPromise = openDocumentData(pdfBuf(), 'first.pdf', '/d/first.pdf');
    await new Promise((r) => setTimeout(r));

    // 두 번째 파일이 abort-replace 로 첫 파싱을 밀어내지만, 아직 완주하지 않는다(별도 gate) —
    // "조건부 finally" 를 제거하는 뮤테이션은 이 시점에 활성(active) 상태를 건드려야 드러난다.
    let resolveGate2!: (p: unknown) => void;
    const gate2 = new Promise((resolve) => { resolveGate2 = resolve; });
    P.getDocument.mockReturnValueOnce({ promise: Promise.resolve(slowPdf(2, gate2)) });
    const secondPromise = openDocumentData(pdfBuf(), 'second.pdf', '/d/second.pdf');
    await new Promise((r) => setTimeout(r));
    expect(useAppStore.getState().isParsing).toBe(true); // 두 번째가 아직 진행 중

    // 첫 파싱을 뒤늦게 완주시킨다 — 짧은 텍스트라 PDF_NO_TEXT 로 실패한다(ABORTED 가 아니다).
    resolveGate(page(SHORT_ITEMS));
    await firstPromise;

    // 추월당한 실패이므로 에러 배너를 세우지 않고(catch-block supersede), 아직 진행 중인 두 번째의
    // isParsing/ocrProgress 도 건드리지 않는다(조건부 finally) — 제거 뮤테이션이면 여기서 false 가 된다.
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().isParsing).toBe(true);

    // 정리: 두 번째도 완주시켜 매달린 프로미스 없이 테스트를 마친다.
    resolveGate2(page(GOOD_ITEMS));
    await secondPromise;
    expect(useAppStore.getState().document?.fileName).toBe('second.pdf');
  });
});

// Task10 리뷰 라운드1(항목: pdfBytesCopy 의 try 배치 가드). 브리프가 명시적으로 지목한 자리 —
// setIsParsing(true) 이후 try 진입 전까지 무보호 구간에 이 할당을 두면, 경로 없는 드롭에서
// OOM(RangeError)이 나는 순간 finally 를 못 타 isParsing 이 영구 고착된다.
describe('openDocumentData — pdfBytesCopy 할당 실패 (Task10 리뷰 라운드1)', () => {
  it('원본 바이트 복사가 던져도(OOM 시뮬레이션) isParsing 이 고착되지 않고 PDF_PARSE_FAIL 로 복구한다', async () => {
    const data = pdfBuf();
    // 재읽기 불가 합성 경로에서만 복사가 발생하는 분기를 taps — slice 를 오버라이드해 실패를 흉내낸다.
    Object.defineProperty(data, 'slice', {
      value: () => { throw new RangeError('array buffer allocation failed'); },
    });
    await openDocumentData(data, 'synthetic.pdf', 'synthetic.pdf'); // 경로 구분자 없음 → 복사 분기
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('PDF_PARSE_FAIL');
    expect(s.isParsing).toBe(false); // try 안에 있어야 finally 가 반드시 돈다 — 고착되지 않는다
    expect(P.getDocument).not.toHaveBeenCalled(); // parsePdf 진입 전에 이미 실패했다
  });
});

describe('cancelDocumentParse', () => {
  it('진행 중 파싱이 없으면 안전하게 no-op', () => {
    expect(() => cancelDocumentParse()).not.toThrow();
  });
});

// Task10 리뷰 라운드2(항목2): "나열하면 형제가 빠진다"가 이 계획에서 세 번째로 재현됐다
// (round1 의 DOC_NO_TEXT/CORRUPT/TOO_LARGE, round2 의 PDF_TOO_MANY_PAGES). EXTRACTOR_ERROR_
// MESSAGE_KEYS 를 손으로 대조하는 대신, `extract/` 소스가 실제로 던지는 코드 집합을 **도출**해
// 대조한다 — 네 번째 형제가 생기면(새 extractFail 호출에 새 코드) 이 테스트가 즉시 빨개진다.
//
// 도출이 가능한 이유: docx.ts/xml.ts/zip.ts 가 각자 갖고 있던 로컬 `fail()` 을 이번 라운드에
// `extract/errors.ts` 의 단일 `extractFail(code, message, params?)` 로 걷어냈다 — 그래서 "이
// 디렉터리가 던질 수 있는 코드"가 전부 `extractFail('CODE', ...)` 호출의 첫 인자라는 정적
// 불변식이 성립한다. 이 불변식이 깨지면(새 로컬 fail 이 다시 생기면) 아래 개수 하한이 함께
// 무너지진 않지만, 새 코드가 통째로 스캔에서 빠지는 조용한 실패가 될 수 있다 — 그래서
// registry.test.ts 가 아니라 여기 file-count 하한으로 "extract/ 안의 .ts 파일을 전부 열어
// 봤다"는 것만 보장하고, 코드 도출 자체는 정규식 하나로 충분히 좁다(단일 헬퍼 = 단일 패턴).
describe('EXTRACTOR_ERROR_MESSAGE_KEYS — 추출기 코드 전수 도출 가드 (Task10 리뷰 라운드2)', () => {
  function extractorSourceFiles(): string[] {
    const dir = resolve('src/renderer/lib/extract');
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ts$/.test(e.name))
      .map((e) => join(dir, e.name));
  }

  it('extract/ 의 모든 .ts 파일을 스캔한다(스캔 범위 붕괴 방지)', () => {
    // docx/xml/zip/ooxml/table/paginate/types/registry/normalize/errors — 현재 10개.
    // __tests__ 하위는 readdirSync 가 디렉터리로 보고 isFile() 에서 자연히 제외된다.
    expect(extractorSourceFiles().length).toBeGreaterThan(5);
  });

  it('extractFail 로 던지는 모든 코드는 EXTRACTOR_ERROR_MESSAGE_KEYS 에 매핑이 있다(ABORTED 제외)', () => {
    const CODE_RE = /extractFail\(\s*['"]([A-Z_]+)['"]/g;
    const codes = new Set<string>();
    for (const file of extractorSourceFiles()) {
      const src = stripJsComments(readFileSync(file, 'utf-8'));
      for (const m of src.matchAll(CODE_RE)) codes.add(m[1]!);
    }
    // 최소한 지금 알려진 것만큼은 도출돼야 한다 — 정규식 자체가 깨져 0건이 되는 사고 방지.
    expect(codes.size).toBeGreaterThan(0);
    // ABORTED 는 취소 신호다 — document-open.ts 의 catch 가 `error.code === 'ABORTED'` 에서
    // 먼저 걸러 사용자 배너를 아예 띄우지 않는다(의도적 액션) — 번역 대상이 아니다.
    codes.delete('ABORTED');
    const unmapped = [...codes].filter((c) => !(c in EXTRACTOR_ERROR_MESSAGE_KEYS));
    expect(unmapped, `번역 매핑이 없는 추출기 코드: ${unmapped.join(', ')}`).toEqual([]);
  });
});
