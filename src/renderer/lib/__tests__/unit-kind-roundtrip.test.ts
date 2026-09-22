import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PdfDocument, PersistedSession } from '../../types';

/**
 * Task 11 fix round 1 (코디네이터 지적): unitKind 가 형제 셋에 "배선"은 됐지만, 저장→복원
 * 왕복을 실제로 증명한 테스트가 없었다. use-session.test.ts 는 저장만 보고, tabs.test.ts 는
 * `../use-session` 을 통째로 mock 해 복원만 본다 — 둘을 잇는 테스트가 존재하지 않았고, 그래서
 * document-open.ts 의 `unitKind: doc.unitKind` 를 `'page'` 로 하드코딩해도 전체 스위트가
 * 그린이었다(Task 11 report 의 뮤테이션 확인).
 *
 * 이 파일은 real `use-session.ts`(저장) 와 real `tabs.ts`(복원) 를 `window.electronAPI.session`
 * 목 하나로 이어 실제 코드 경로로 왕복시킨다. 저장된 세션은 손으로 만든 `PersistedSession` 이
 * 아니라 `persistCurrentSession` 이 **실제로** `api.session.save` 에 넘긴 페이로드를 그대로
 * `api.session.load` 가 돌려주게 한다 — main(session-store.ts)의 opaque JSON 통과는 이미
 * 별도로(그 파일의 유닛 테스트로) 검증돼 있으므로 여기서는 renderer 양단만 잇는다.
 */

const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
const api = {
  session: {
    load: vi.fn(),
    loadMeta: vi.fn(),
    save: vi.fn((_payload: unknown): Promise<{ ok: boolean }> => Promise.resolve({ ok: true })),
    savePartial: vi.fn((_payload: unknown) => Promise.resolve({ ok: true })),
  },
  ai: {
    checkEmbedModel: vi.fn(() => Promise.resolve({ available: true, model: 'nomic-embed-text' })),
    abort: vi.fn(() => Promise.resolve()),
  },
  settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
};
vi.stubGlobal('window', { electronAPI: api });
const realSubtle = globalThis.crypto.subtle;
vi.stubGlobal('crypto', { subtle: realSubtle, randomUUID: () => 'test-uuid' });

import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';
import { persistCurrentSession, __resetSessionModuleStateForTest } from '../use-session';
import { openFromSessionOnly } from '../tabs';
import { hashDocumentText } from '../session-hash';

function makeDoc(id: string, unitKind?: 'page' | 'slide' | 'chapter'): PdfDocument {
  return {
    id,
    fileName: 'deck.pptx',
    filePath: '/x/' + id + '.pptx',
    pageCount: 4,
    extractedText: '왕복 테스트 본문 ' + id,
    pageTexts: ['s1', 's2'],
    chapters: [],
    images: [],
    createdAt: new Date(),
    ...(unitKind !== undefined ? { unitKind } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionModuleStateForTest();
  api.session.save.mockResolvedValue({ ok: true });
  api.session.savePartial.mockResolvedValue({ ok: true });
  api.session.loadMeta.mockResolvedValue(null);
  api.ai.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
  useAppStore.setState({
    document: null, summary: null, summaryStream: '', qaMessages: [], openTabs: [],
    summaryStreamComplete: false, summaryStreamType: null, summaryType: 'full',
    isCollectionBusy: false, isGenerating: false, isQaGenerating: false, isParsing: false,
    isTabSwitching: false, collectionOpenInFlight: false,
    sessionRestorePending: false, sessionRestoreFailed: false,
    restoredSession: null, ragIndex: new VectorStore(),
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
    settings: { ...useAppStore.getState().settings, persistSessions: true, provider: 'ollama', customSummaryTemplates: [] },
  });
});

/**
 * 저장(real persistCurrentSession) → 복원(real openFromSessionOnly → tabs.ts 의
 * restoreTabFromSession) 을 한 번의 실제 왕복으로 잇는다.
 */
async function roundTrip(doc: PdfDocument): Promise<{ restoredDoc: PdfDocument | null; restoredTabUnitKind: 'page' | 'slide' | 'chapter' | undefined }> {
  useAppStore.setState({ document: doc });
  await persistCurrentSession();
  expect(api.session.save).toHaveBeenCalledTimes(1);
  const savedPayload = api.session.save.mock.calls[0]![0] as { session: PersistedSession };
  const savedSession = savedPayload.session;

  const docHash = await hashDocumentText(doc.extractedText);
  expect(savedSession.docHash).toBe(docHash);

  // main 이 저장한 그대로 돌려준다고 가정 — session-store.ts 의 본문 왕복(opaque JSON)은
  // 그 파일의 유닛 테스트가 이미 검증한다. 여기서는 renderer 양단(저장 코드 ↔ 복원 코드)만 잇는다.
  api.session.load.mockResolvedValue({ session: savedSession, blob: null });

  // "앱 재시작 후 최근 문서에서 다시 연다" 상태로 리셋 — openFromSessionOnly 가 실제로 쓰는
  // 세션-only 복원 경로(tabs.ts).
  useAppStore.setState({ document: null, openTabs: [] });

  const ok = await openFromSessionOnly({
    docHash, fileName: doc.fileName, filePath: doc.filePath, pageCount: doc.pageCount,
  });
  expect(ok, '세션 복원이 실패했다 — 왕복 전제 자체가 깨졌다').toBe(true);

  const s = useAppStore.getState();
  return { restoredDoc: s.document, restoredTabUnitKind: s.openTabs[0]?.unitKind };
}

describe('unitKind 저장→복원 왕복 (real use-session.ts 저장 → real tabs.ts 복원)', () => {
  it("unitKind:'slide' 문서가 저장→복원을 왕복해도 유지된다", async () => {
    const doc = makeDoc('rt-slide-doc', 'slide');
    const { restoredDoc, restoredTabUnitKind } = await roundTrip(doc);
    expect(restoredDoc?.unitKind).toBe('slide');
    expect(restoredTabUnitKind).toBe('slide');
  });

  it('unitKind 가 없는 기존 세션은 부재로 복원된다 (하위호환 — 소비 측에서 page 로 취급됨)', async () => {
    const doc = makeDoc('rt-legacy-doc'); // unitKind 미설정 — 기존 PDF 세션과 동형
    const { restoredDoc, restoredTabUnitKind } = await roundTrip(doc);
    expect(restoredDoc?.unitKind).toBeUndefined();
    expect(restoredTabUnitKind).toBeUndefined();
  });
});
