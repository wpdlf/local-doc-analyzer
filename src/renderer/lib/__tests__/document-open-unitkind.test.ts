import { describe, it, expect, vi, beforeEach } from 'vitest';
import { zipSync } from 'fflate';
import type { Extractor, ExtractedDoc, ExtractOptions } from '../extract/types';

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

// QA34: openZip 호출 시점(isParsing 상태)·취소 타이밍을 보기 위해 실물을 감싼 spy 로 바꾼다 —
// 기본 동작은 실물 그대로(fflate 해제)다.
vi.mock('../extract/zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extract/zip')>();
  return { ...actual, openZip: vi.fn(actual.openZip) };
});

const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
vi.stubGlobal('window', {});

import { useAppStore } from '../store';
import { openDocumentData, cancelDocumentParse, EXTRACTOR_ERROR_MESSAGE_KEYS, OPEN_ERROR_CODES } from '../document-open';
import { t } from '../i18n';
import { resolveExtractor } from '../extract/registry';
import { openZip } from '../extract/zip';

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
    summary: null, summaryStream: '', qaMessages: [],
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

/**
 * QA34: 같은 seam 에서 **살아남던 뮤턴트** 셋(filePath·imagesSkipped·추출기 옵션)을 죽인다.
 * 셋 다 기존 스위트 전체가 초록인 채 삭제·하드코딩이 가능했다.
 */
describe('document-open.ts — 비-PDF 경로 배선 (QA34)', () => {
  /** 호출 인자를 기록하는 가짜 추출기 — extract 는 spy 다. */
  function spyExtractor() {
    return {
      id: 'docx' as const,
      sniff: () => true,
      extract: vi.fn(async (_zip: unknown, _opts?: ExtractOptions): Promise<ExtractedDoc> => ({
        units: ['본문 1'], images: [], headings: [], unitKind: 'page',
      })),
    };
  }

  // QA34(High test gap): `{ fileName: name, filePath }` → `filePath: ''` 가 살아남았다.
  // 빈 경로면 탭 전환 재읽기·최근 문서 재오픈이 원본을 못 찾는다.
  it('문서와 탭이 인자로 받은 filePath 를 싣는다', async () => {
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/dir/a.docx');
    const s = useAppStore.getState();
    expect(s.error).toBeNull();
    expect(s.document?.filePath).toBe('/x/dir/a.docx');
    expect(s.openTabs[0]?.filePath).toBe('/x/dir/a.docx');
  });

  // QA34(Important): QA6-D 마커(imagesSkipped)를 지워도 살아남았다. 마커가 없으면 설정을 켠 뒤
  // 재요약이 Vision 없이 조용히 진행된다(텍스트-only 문서의 정당한 0장과 구분 불가).
  it('이미지 분석 OFF 로 열면 imagesSkipped 마커가 선다', async () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, enableImageAnalysis: false } });
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    expect(useAppStore.getState().document?.imagesSkipped).toBe(true);
  });

  it('이미지 분석 ON 이면 imagesSkipped 마커가 서지 않는다', async () => {
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    expect(useAppStore.getState().document).not.toBeNull();
    expect(useAppStore.getState().document?.imagesSkipped).not.toBe(true);
  });

  // QA34(Medium): `extractImages: true` 하드코딩·signal 누락이 살아남았다 — 전자는 OFF 설정에서도
  // 이미지를 전부 풀어 base64 로 인코딩하고, 후자는 취소가 추출기 루프에 닿지 않는다.
  it('추출기에 설정의 extractImages 와 이번 파싱의 AbortSignal 을 넘긴다', async () => {
    const ex = spyExtractor();
    (resolveExtractor as ReturnType<typeof vi.fn>).mockReturnValue(ex);
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, enableImageAnalysis: false } });
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    expect(ex.extract).toHaveBeenCalledTimes(1);
    const opts = ex.extract.mock.calls[0]?.[1];
    expect(opts?.extractImages).toBe(false);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);

    useAppStore.setState({ settings: { ...useAppStore.getState().settings, enableImageAnalysis: true } });
    await openDocumentData(makeZipBytes(), 'b.docx', '/x/b.docx');
    expect(ex.extract.mock.calls[1]?.[1]?.extractImages).toBe(true);
  });

  it('cancelDocumentParse 가 추출기에 넘긴 signal 을 실제로 abort 한다', async () => {
    let seen: AbortSignal | undefined;
    const ex: Extractor = {
      id: 'docx',
      sniff: () => true,
      extract: async (_z, opts) => {
        seen = opts?.signal;
        cancelDocumentParse();
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
      },
    };
    (resolveExtractor as ReturnType<typeof vi.fn>).mockReturnValue(ex);
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    expect(seen?.aborted).toBe(true);
    const s = useAppStore.getState();
    expect(s.error).toBeNull(); // 사용자 취소는 배너 없음
    expect(s.isParsing).toBe(false);
  });
});

/**
 * QA34(Low): 큰 DOCX 의 zip 해제(fflate unzipSync, 최대 300MB)가 `setIsParsing(true)` **이전**에
 * 동기로 돌아 스피너도 없이 UI 가 얼고 취소도 불가능했다. 해제는 isParsing 이 선 뒤, 페인트
 * 기회를 준 다음에 돌아야 하고, 그 사이 취소가 들어오면 해제 자체를 건너뛰어야 한다.
 */
describe('document-open.ts — zip 해제 순서·취소 (QA34)', () => {
  const openZipMock = openZip as unknown as ReturnType<typeof vi.fn>;

  it('openZip 은 isParsing=true 가 선 뒤에 호출된다', async () => {
    let parsingAtUnzip: boolean | null = null;
    const real = openZipMock.getMockImplementation() as (d: ArrayBuffer) => unknown;
    openZipMock.mockImplementationOnce((data: ArrayBuffer) => {
      parsingAtUnzip = useAppStore.getState().isParsing;
      return real(data);
    });
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    expect(parsingAtUnzip).toBe(true);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('해제 전 양보 구간에 취소되면 해제·추출 없이 조용히 끝난다', async () => {
    const p = openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    // 첫 await(페인트 양보) 전까지는 동기로 진행된다 — 여기서 isParsing 이 서 있어야 스피너·취소
    // 버튼이 보인다(종전엔 이 시점에 이미 동기 해제가 끝나 있었다).
    expect(useAppStore.getState().isParsing).toBe(true);
    cancelDocumentParse();
    await p;
    expect(openZipMock).not.toHaveBeenCalled();
    const s = useAppStore.getState();
    expect(s.document).toBeNull();
    expect(s.error).toBeNull();
    expect(s.isParsing).toBe(false);
  });

  it('이미지 분석 OFF 면 그림 파트를 풀지 않는 필터를 넘기고, ON 이면 넘기지 않는다', async () => {
    const setImages = (on: boolean) =>
      useAppStore.setState((s) => ({ settings: { ...s.settings, enableImageAnalysis: on } }));

    setImages(false);
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    const filter = (openZipMock.mock.calls.at(-1)?.[1] as { filter?: (n: string) => boolean } | undefined)?.filter;
    expect(filter, 'OFF 인데 필터가 없다').toBeTypeOf('function');
    expect(filter!('word/media/image1.png')).toBe(false);
    expect(filter!('ppt/media/image2.jpeg')).toBe(false);
    expect(filter!('word/document.xml')).toBe(true);
    expect(filter!('word/_rels/document.xml.rels')).toBe(true);
    expect(filter!('BinData/image1.bmp')).toBe(false);
    expect(filter!('Contents/section0.xml')).toBe(true);

    setImages(true);
    await openDocumentData(makeZipBytes(), 'b.docx', '/x/b.docx');
    expect(openZipMock.mock.calls.at(-1)?.[1]?.filter, 'ON 이면 그림을 풀어야 한다').toBeUndefined();
  });

  it('해제 도중 취소되면 추출기를 부르지 않는다', async () => {
    const real = openZipMock.getMockImplementation() as (d: ArrayBuffer) => unknown;
    openZipMock.mockImplementationOnce((data: ArrayBuffer) => {
      cancelDocumentParse();
      return real(data);
    });
    const ex = { id: 'docx', sniff: () => true, extract: vi.fn() } as unknown as Extractor;
    (resolveExtractor as ReturnType<typeof vi.fn>).mockReturnValue(ex);
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    expect(ex.extract).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBeNull();
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().isParsing).toBe(false);
  });
});

/**
 * QA34(Low 8 + P4 전제 9): 추출기가 던지는 에러가 화면에 닿는 모양.
 *  - 코드 없는 예외(btoa/spread 의 RangeError, DOMParser 의 TypeError…)가 영어 원문 그대로
 *    배너에 떴다 → DOC_CORRUPT 로 번역하고 원문은 details 로만 남긴다.
 *  - EXTRACTOR_ERROR_MESSAGE_KEYS 의 코드가 validCodes 에 없으면 PDF_PARSE_FAIL 로 뭉개지고
 *    번역도 건너뛴다. 두 목록이 따로 나열돼 있어 부분집합 관계가 증명되지 않았다 — 표의 **모든**
 *    코드를 실제로 던져 번역된 메시지로 착지하는지 본다(나열이 아니라 표에서 도출).
 */
describe('document-open.ts — 추출기 에러의 화면 착지 (QA34)', () => {
  function throwingExtractor(err: unknown): Extractor {
    return { id: 'docx', sniff: () => true, extract: async () => { throw err; } };
  }

  it.each([
    ['RangeError', new RangeError('Invalid array length')],
    ['TypeError', new TypeError("Cannot read properties of null (reading 'documentElement')")],
  ])('코드 없는 %s 는 DOC_CORRUPT + 번역 메시지, 원문은 details', async (_n, err) => {
    (resolveExtractor as ReturnType<typeof vi.fn>).mockReturnValue(throwingExtractor(err));
    await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_CORRUPT');
    expect(s.error?.message).toBe(t('doc.corrupt'));
    expect(s.error?.details).toBe(err.message);
  });

  it('EXTRACTOR_ERROR_MESSAGE_KEYS 의 모든 코드는 그 코드 그대로, 번역된 메시지로 착지한다', async () => {
    const entries = Object.entries(EXTRACTOR_ERROR_MESSAGE_KEYS);
    expect(entries.length).toBeGreaterThanOrEqual(4); // 표 붕괴 시 공허 통과 방지
    const params = { pages: '9', max: '5', list: 'PDF · Word' };
    for (const [code, key] of entries) {
      (resolveExtractor as ReturnType<typeof vi.fn>).mockReturnValue(
        throwingExtractor(Object.assign(new Error(`dev english for ${code}`), { code, params })),
      );
      useAppStore.setState({ error: null });
      await openDocumentData(makeZipBytes(), 'a.docx', '/x/a.docx');
      const e = useAppStore.getState().error;
      expect(e?.code, code).toBe(code);
      expect(e?.message, code).toBe(t(key!, params));
      expect(e?.message, code).not.toMatch(/dev english/);
    }
  });

  it('OPEN_ERROR_CODES 는 EXTRACTOR_ERROR_MESSAGE_KEYS 의 상위집합이다', () => {
    const missing = Object.keys(EXTRACTOR_ERROR_MESSAGE_KEYS).filter((c) => !OPEN_ERROR_CODES.has(c));
    expect(missing).toEqual([]);
  });
});
