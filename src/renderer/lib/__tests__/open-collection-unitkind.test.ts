import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PersistedSession } from '../../types';

/**
 * Task 11 fix round 3 (코디네이터 지적): `unitKind` 를 전달하는 세 곳 중 마지막 하나 —
 * `openCollection`(tabs.ts) 이 세션에서 **직접** 탭을 조립하는 자리(`tab: OpenTab` 리터럴,
 * `unitKind: session.unitKind`). round 1(`openFromSessionOnly`→`restoreTabFromSession`) 과
 * round 2(`openDocumentData`) 는 이 자리를 지나지 않는다.
 *
 * 왜 새 테스트가 필요한가: 컬렉션의 **첫 유효 멤버만** `restoreTabFromSession` 으로 활성화되고,
 * 그 함수가 자신의 `upsertOpenTab` 으로 값을 다시(정확하게) 덮어쓴다 — round 1 리포트가 지적한
 * "복원이 자리를 다시 덮어써 왕복만으로는 못 잡는다" 는 패턴과 동형이다. **활성화되지 않는**
 * 나머지 멤버는 `openCollection` 의 이 upsert 가 유일한 등록이라, 그 값이 살아남는지는 이
 * 자리를 직접 겨눠야만 검증된다.
 */

const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});

const sessionLoad = vi.fn();
vi.stubGlobal('window', { electronAPI: { session: { load: sessionLoad } } });

import { useAppStore } from '../store';
import { openCollection } from '../tabs';

function fixtureSession(
  docHash: string, fileName: string, unitKind?: 'page' | 'slide' | 'chapter',
): PersistedSession {
  return {
    schemaVersion: 1,
    docHash,
    fileName,
    filePath: '/x/' + fileName,
    pageCount: 2,
    extractedText: '본문 ' + fileName,
    pageTexts: ['p1', 'p2'],
    chapters: [],
    summaries: {},
    summaryType: 'full',
    qaMessages: [],
    embedModel: null,
    embedDim: null,
    chunkMeta: [],
    ...(unitKind !== undefined ? { unitKind } : {}),
  };
}

const HASH_A = 'a'.repeat(64); // 활성화되는 첫 멤버 — restoreTabFromSession 이 다시 덮어씀(대조군)
const HASH_B = 'b'.repeat(64); // 비활성 멤버 — unitKind:'slide' — 이 seam 이 유일한 등록
const HASH_C = 'c'.repeat(64); // 비활성 멤버 — unitKind 부재 — 기본값으로 채우면 안 됨

beforeEach(() => {
  vi.clearAllMocks();
  const sessions: Record<string, PersistedSession> = {
    [HASH_A]: fixtureSession(HASH_A, 'active.pptx', 'slide'),
    [HASH_B]: fixtureSession(HASH_B, 'member-b.pptx', 'slide'),
    [HASH_C]: fixtureSession(HASH_C, 'member-c.pdf'), // unitKind 미설정
  };
  sessionLoad.mockImplementation((docHash: string) =>
    Promise.resolve(sessions[docHash] ? { session: sessions[docHash] } : null));

  // openCollection 은 업로드 화면(document=null)에서만 호출된다.
  useAppStore.setState({
    document: null, openTabs: [], collection: { enabled: false, memberHashes: [] },
    isGenerating: false, isQaGenerating: false, isParsing: false, isTabSwitching: false,
    isCollectionBusy: false, collectionOpenInFlight: false, sessionRestorePending: false,
    error: null,
    // persistSessions:false — restoreTabFromSession 내부의 fire-and-forget
    // restoreSessionForDocument 가 게이트만 내리고 즉시 반환하게 해, 이 seam 과 무관한 세션
    // IPC 경로(요약/Q&A/인덱스 복원)를 추가로 스텁할 필요가 없게 한다.
    settings: { ...useAppStore.getState().settings, persistSessions: false },
  });
});

describe('openCollection — 비활성 멤버 탭 조립의 unitKind seam', () => {
  it('활성화되지 않는 멤버의 탭은 세션의 unitKind 를 그대로 싣는다(부재는 부재로)', async () => {
    const result = await openCollection([HASH_A, HASH_B, HASH_C]);
    expect(result).toEqual({ opened: 3, total: 3 });

    const tabs = useAppStore.getState().openTabs;
    const tabB = tabs.find((t) => t.docHash === HASH_B);
    const tabC = tabs.find((t) => t.docHash === HASH_C);
    expect(tabB?.unitKind, '비활성 멤버 B — 세션의 slide 를 그대로 실어야 한다').toBe('slide');
    expect(tabC?.unitKind, '비활성 멤버 C — 부재는 부재로 남아야 한다(기본값으로 채우면 안 됨)')
      .toBeUndefined();

    // 대조군: 활성화된 첫 멤버는 restoreTabFromSession 의 별도 upsert 가 다시 덮어써서
    // 이 자리(openCollection 자체의 upsert)의 뮤테이션에 영향받지 않는다 — round 1 이 지적한
    // 마스킹과 동일한 이유이고, 정상 동작이다(참고용 — 이 파일이 겨누는 자리는 아니다).
    const tabA = tabs.find((t) => t.docHash === HASH_A);
    expect(tabA?.unitKind).toBe('slide');
  });
});
