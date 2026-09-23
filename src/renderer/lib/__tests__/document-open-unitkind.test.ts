import { describe, it, expect, vi, beforeEach } from 'vitest';
import { zipSync } from 'fflate';
import type { Extractor, ExtractedDoc } from '../extract/types';

/**
 * Task 11 fix round 2 (코디네이터 지적): `document-open.ts` 의 `upsertOpenTab` 호출은
 * "최초 오픈 시점의 탭 등록"이라, 저장→복원 왕복 테스트(unit-kind-roundtrip.test.ts)의 범위
 * 밖이다 — 복원이 그 자리의 값을 늘 다시 덮어써 왕복만으로는 여기의 하드코딩을 잡을 수 없다
 * (Task 11 fix round 1 리포트 참조). 이 파일은 그 seam(추출기 → doc → 탭)을 직접 겨눈다.
 *
 * 실 DOCX 픽스처는 `unitKind:'page'` 만 만들어내는데(하드코딩된 뮤턴트 값과 같아 죽이지 못한다),
 * 이 플랜엔 `'slide'` 를 실제로 만드는 추출기가 아직 없다(PPTX 미구현). 그래서 `resolveExtractor`
 * 를 스텁해 `'slide'` 를 보고하는 가짜 추출기로 바꾼다 — zip 컨테이너 파싱(fflate `openZip`) 은
 * 실물 그대로 태운다. 대체하는 것은 "포맷이 무엇을 보고하는가" 뿐이고, 그 값이 문서·탭까지
 * 전달되는 배선은 real `document-open.ts`·`extract/normalize.ts` 코드로 검증한다.
 */

vi.mock('../extract/registry', () => ({
  resolveExtractor: vi.fn(),
}));

const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
vi.stubGlobal('window', {});

import { useAppStore } from '../store';
import { openDocumentData } from '../document-open';
import { resolveExtractor } from '../extract/registry';

/** unitKind:'slide' 를 내놓는 가짜 추출기 — 실 슬라이드 추출기가 아직 없어 seam 을 대신 채운다. */
const slideExtractor: Extractor = {
  id: 'pptx',
  sniff: () => true,
  extract: async (): Promise<ExtractedDoc> => ({
    units: ['슬라이드 1 본문'],
    images: [],
    headings: [],
    unitKind: 'slide',
  }),
};

/** hasZipMagic 을 통과하는 최소 유효 zip — 컨테이너 파싱(openZip/fflate)은 실물 그대로 태운다. */
function makeZipBytes(): ArrayBuffer {
  const zipped = zipSync({ 'placeholder.txt': new TextEncoder().encode('x') });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveExtractor as ReturnType<typeof vi.fn>).mockReturnValue(slideExtractor);
  useAppStore.setState({
    document: null, openTabs: [], isGenerating: false, isQaGenerating: false,
    isParsing: false, isCollectionBusy: false, collectionOpenInFlight: false, error: null,
    // persistSessions:false — 이 테스트의 관심사는 오픈 시점 배선뿐이라 세션 모듈(IPC)을
    // 아예 타지 않게 한다(restoreSessionForDocument 는 이 값이 false 면 즉시 게이트만 내리고 반환).
    settings: { ...useAppStore.getState().settings, persistSessions: false, enableImageAnalysis: true },
  });
});

describe('document-open.ts — 추출기 → doc → 탭 seam (real dispatch, 가짜 추출기)', () => {
  it("'slide' 를 보고하는 추출기로 열면 문서와 탭 모두 unitKind:'slide' 를 싣는다", async () => {
    await openDocumentData(makeZipBytes(), 'deck.pptx', '/x/deck.pptx');

    const s = useAppStore.getState();
    expect(s.error, `에러 배너: ${JSON.stringify(s.error)}`).toBeNull();
    expect(s.document?.unitKind).toBe('slide');
    expect(s.openTabs[0]?.unitKind).toBe('slide');
  });
});
