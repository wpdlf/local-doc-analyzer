import type { AppError } from '../types';
import { useAppStore } from './store';
import { t } from './i18n';
import { restoreSessionForDocument, persistCurrentSession } from './use-session';
import { confirmDiscardIfNotPersisted } from './discard-policy';
import { MAX_PDF_SIZE_BYTES } from '../../shared/constants';
import { hasPdfMagic, hasZipMagic, hasCfbMagic, SUPPORTED_FORMATS } from '../../shared/document-formats';
// QA34(bundle): 추출기 체인(extract/zip = fflate, extract/registry = docx…, extract/normalize)은
// 비-PDF 분기에서만 동적 import 한다(loadExtractChain). App.tsx 가 이 모듈을 정적으로 import
// 하므로, 여기서 정적으로 끌면 PDF 만 여는 사용자도 fflate·추출기를 eager 진입 청크로 받는다.
// ⚠️ 이 셋을 다시 정적 import 로 되돌리지 말 것 — 타입은 `import type` 만 허용.
import type { PdfDocument } from '../types';
import type { Extractor } from './extract/types';
import { parsePdf, isReReadablePath, MAX_TOTAL_IMAGES } from './pdf-parser';
import type { TranslationKey } from './i18n';

const SUPPORTED_LABEL = SUPPORTED_FORMATS.map((f) => f.label).join(' · ');

/**
 * 추출기(docx.ts/zip.ts/xml.ts)·파서(pdf-parser.ts) 가 던지는 코드 중, 화면에 보이기 전에
 * 이 경계에서 번역해야 하는 것들의 단일 출처.
 *
 * Task10 fix round2: `PDF_TOO_MANY_PAGES` 는 두 갈래로 던져진다 — PDF 경로(parsePdf)는 이미
 * t('uploader.tooManyPages', {...}) 로 번역된 문자열을 `message` 에 직접 담아 던지고
 * (`error.params` 없음), DOCX 경로(docx.ts, extractFail 경유)는 코드 + params 만 던진다
 * (번역하지 않는다 — 추출기는 i18n 을 모른다). 그래서 이 표의 존재만으로 번역 여부를 정하면
 * 안 되고, **`error.params` 가 실려 있을 때만** 이 표로 t() 를 호출한다(catch 참조) — 그래야
 * 이미 번역된 PDF 경로의 메시지를 다시 건드리지 않는다(무조건 덮어쓰면 파라미터가 없어
 * `{pages}p` 미해석 placeholder 로 회귀한다).
 *
 * export 하는 이유: 이 표에 코드가 빠지면(형제 누락) 영어가 그대로 노출된다 — 그 결함이 세
 * 번째로 반복됐다(round1 의 DOC_NO_TEXT/CORRUPT/TOO_LARGE, round2 의 PDF_TOO_MANY_PAGES).
 * `document-open-error-i18n.test.ts` 가 `extract/` 소스를 스캔해 이 표와 대조한다 —
 * 나열이 아니라 도출로 넷을 세운다.
 */
export const EXTRACTOR_ERROR_MESSAGE_KEYS: Partial<Record<string, TranslationKey>> = {
  DOC_NO_TEXT: 'doc.noText',
  DOC_CORRUPT: 'doc.corrupt',
  DOC_TOO_LARGE: 'doc.tooLarge',
  PDF_TOO_MANY_PAGES: 'uploader.tooManyPages',
  // QA34: DOC_UNSUPPORTED 는 이 파일이 비-PDF 분기에서 직접 던진다(extractFail 경유, params 동봉).
  // DOC_ENCRYPTED 는 지금은 컨테이너 매직(CFB) 선검사가 try 밖에서 바로 배너를 올려 catch 에
  // 닿지 않지만, P4 의 EPUB(META-INF/encryption.xml)처럼 **zip 을 연 뒤에야** 암호/DRM 을 알 수
  // 있는 포맷의 추출기가 던질 자리다 — 표에 두면 그때 번역·통과 코드(OPEN_ERROR_CODES)가 자동으로
  // 따라온다. 종전 validCodes 에만 있던 DOC_ENCRYPTED 는 번역 키가 없어 영어 원문을 노출했을 것이다.
  DOC_UNSUPPORTED: 'doc.unsupported',
  DOC_ENCRYPTED: 'doc.encrypted',
};

/**
 * catch 가 그대로 통과시키는(PDF_PARSE_FAIL 로 뭉개지 않는) 에러 코드.
 *
 * QA34(P4 전제): 종전엔 이 집합(validCodes)을 EXTRACTOR_ERROR_MESSAGE_KEYS 와 **따로 나열**해
 * "표의 모든 코드가 여기 있다"는 부분집합 관계가 증명되지 않았다 — 표에만 코드를 추가하면
 * 번역 키가 있는데도 PDF_PARSE_FAIL 로 뭉개지고, 뭉개진 코드로는 표 조회도 실패해 영어 원문이
 * 노출된다. 나열 대신 표에서 **도출**한다. PDF 쪽 코드는 parsePdf 가 이미 번역된 메시지로 던지는
 * 것들이다(params 없음 — catch 가 message 를 그대로 쓴다).
 */
const PDF_PARSER_ERROR_CODES = ['PDF_PARSE_FAIL', 'PDF_NO_TEXT', 'PDF_TOO_MANY_PAGES', 'PDF_ENCRYPTED', 'OCR_FAIL'] as const;
export const OPEN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...PDF_PARSER_ERROR_CODES,
  ...Object.keys(EXTRACTOR_ERROR_MESSAGE_KEYS),
]);

/** 추출기 체인 lazy 로드 — import 절 주석 참조. */
async function loadExtractChain() {
  const [zip, registry, normalize, errors] = await Promise.all([
    import('./extract/zip'),
    import('./extract/registry'),
    import('./extract/normalize'),
    import('./extract/errors'),
  ]);
  return {
    openZip: zip.openZip,
    resolveExtractor: registry.resolveExtractor,
    toPdfDocument: normalize.toPdfDocument,
    extractFail: errors.extractFail,
  };
}

/**
 * QA34(Low): isParsing=true 가 **그려질** 기회를 준다. 뒤따르는 zip 해제(fflate unzipSync,
 * 최대 300MB)는 동기라 이 양보 없이 들어가면 스피너·취소 버튼이 한 프레임도 그려지지 않는다.
 * rAF→setTimeout 은 "다음 프레임이 그려진 뒤"를 보장하고, 창이 가려져 rAF 가 멈춘 경우(IPC 로
 * 들어온 파일 열기 — 최소화 상태에서도 온다)를 위해 짧은 타이머로 상한을 둔다.
 */
function yieldForPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 50);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
}

/**
 * 비-PDF(zip 컨테이너) 문서 열기: 해제 → 포맷 판별 → 추출 → PdfDocument 정규화.
 *
 * QA34(Low 8): 이 구간의 예외 중 **코드 없는 것**(btoa/spread 의 RangeError, DOMParser 의
 * TypeError, fflate 내부 오류…)은 바깥 catch 에서 PDF_PARSE_FAIL + 영어 원문 그대로 노출됐다.
 * 여기서 DOC_CORRUPT(params 동봉 → 경계에서 t('doc.corrupt'))로 바꾸고 원문은 details 로 남긴다.
 * 표에 있는 코드와 ABORTED 는 그대로 통과시킨다.
 */
async function openZipDocument(
  data: ArrayBuffer,
  meta: { fileName: string; filePath: string },
  opts: { extractImages: boolean; signal: AbortSignal },
): Promise<PdfDocument> {
  // 청크 로드 실패는 "파일 손상"이 아니다 — 아래 매핑 try 밖에 둬서 종전 PDF_PARSE_FAIL 로 간다.
  const chain = await loadExtractChain();
  try {
    await yieldForPaint();
    throwIfAborted(opts.signal);
    // zip.ts 소유 에이전트에 요청: 이미지 분석 OFF 면 word/media/ 를 풀 필요가 없다 — openZip 에
    // 엔트리 filter 옵션이 생기면 여기서 넘긴다(현재 OpenZipOptions 는 maxUnzippedBytes 뿐).
    const zip = chain.openZip(data);
    throwIfAborted(opts.signal);
    const extractor: Extractor | null = chain.resolveExtractor(zip);
    if (!extractor) {
      return chain.extractFail('DOC_UNSUPPORTED', 'no extractor matched', { list: SUPPORTED_LABEL });
    }
    const extracted = await extractor.extract(zip, {
      extractImages: opts.extractImages,
      signal: opts.signal,
    });
    return chain.toPdfDocument(extracted, meta);
  } catch (err) {
    const e = err as { code?: unknown; params?: Record<string, string>; message?: unknown } | null;
    if (e?.code === 'ABORTED') throw err;
    if (typeof e?.code === 'string' && e.code in EXTRACTOR_ERROR_MESSAGE_KEYS) {
      // 표에 있는 코드는 번역 대상 — params 가 빠진 채 던져졌어도 번역 경로를 타게 한다.
      if (!e.params) e.params = {};
      throw err;
    }
    const detail = typeof e?.message === 'string' ? e.message : String(err);
    throw Object.assign(new Error(detail), { code: 'DOC_CORRUPT', params: {} });
  }
}

// ─── 공용 문서 열기 함수 (PdfUploader + App file drop + 탭 전환 + 최근 문서 + 전역 검색 공통) ───
//
// 이 함수는 Task10 이전 `pdf-parser.ts` 의 `handlePdfData` 를 그대로 옮긴 것이다. QA 라운드마다
// 가드가 하나씩 붙어온 자리라 로직은 바꾸지 않았다 — 매직 검사가 포맷 dispatch 로, parsePdf
// 호출이 분기로 바뀐 두 곳과, 그에 따라 필요해진 validCodes 확장·pdfBytesCopy 게이트 조건
// 추가만 손댔다.

const MAX_FILE_SIZE = MAX_PDF_SIZE_BYTES;

// 현재 진행 중인 문서 파싱의 AbortController. 사용자 취소 버튼 또는 다른 파일 드롭 시 abort.
// 동시에 하나의 파싱만 실행되므로 단일 모듈 레벨 참조로 충분.
let activeParseController: AbortController | null = null;

/** 진행 중인 문서 파싱을 취소. 다음 배치/OCR 페이지 진입 직전에 ABORTED 에러로 조기 종료됨. */
export function cancelDocumentParse(): void {
  activeParseController?.abort();
}

export async function openDocumentData(
  data: ArrayBuffer,
  name: string,
  filePath: string,
  opts: {
    /**
     * QA24(A-I1): 파기 확인을 건너뛴다. 탭 전환·탭 닫기 경로는 진입부에서 이미 물었고,
     * 그쪽의 파일 재파싱 fallback 이 이 함수를 호출하므로 여기서 또 물으면 이중 질문이 된다.
     */
    skipDiscardConfirm?: boolean;
  } = {},
): Promise<void> {
  const store = useAppStore.getState();
  if (store.isGenerating) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyGenerating'),
    } as AppError);
    return;
  }
  if (store.isQaGenerating) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyQa'),
    } as AppError);
    return;
  }
  // QA post-v0.31.15: 컬렉션 교차 요약 gather 단계(isCollectionBusy=true, isQaGenerating 아직
  // false)에도 새 파일 열기를 차단 — isTabSwitchBlocked 가 이미 isCollectionBusy 를 포함하는 것과
  // 대칭. 누락 시 드롭이 게이트를 통과해 in-flight 멤버 요약(클라우드)이 끊기지 않고 백그라운드
  // 완주하며 토큰을 낭비했다(탭 전환 경로 tabs.ts:32-35 가 이미 닫은 것과 동일 결함 클래스).
  if (store.isCollectionBusy) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyCollection'),
    } as AppError);
    return;
  }
  // QA24(A-I1): 영속화 OFF 면 새 문서 로드가 현재 요약·Q&A 를 되돌릴 수 없이 파기한다.
  // 드롭·Ctrl+O·최근 문서·전역 검색이 전부 이 함수로 직행하므로 여기가 그 경로들의 단일
  // 게이트다. **파싱 전에** 묻는다 — 수십 초 파싱이 끝난 뒤 묻는 확인은 의미가 없다.
  if (!opts.skipDiscardConfirm && useAppStore.getState().document && !confirmDiscardIfNotPersisted()) {
    return;
  }
  // C5-M4(QA cycle5): openCollection(탭 세트 재구성) 진행 중에도 새 파일 열기 차단. 드롭/최근
  // 문서/전역검색/Ctrl+O 는 isTabSwitchBlocked 를 거치지 않고 본 함수로 직행하므로, 누락 시
  // 컬렉션 멤버 upsert·첫 멤버 활성화 루프와 인터리브돼 탭 세트가 뒤섞이고(멤버+낙오 문서 혼재)
  // 활성 문서가 경쟁 패자의 것으로 남았다.
  if (store.collectionOpenInFlight) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('pdf.busyCollectionOpen'),
    } as AppError);
    return;
  }
  if (data.byteLength > MAX_FILE_SIZE) {
    store.setError({
      code: 'PDF_PARSE_FAIL',
      message: t('uploader.fileTooLarge', { size: String(Math.round(data.byteLength / 1024 / 1024)) }),
    } as AppError);
    return;
  }
  // 내용 기반 판별 — 확장자를 믿지 않는다. 위장 바이너리를 파서 진입 전에 거부한다.
  const head = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
  const isPdf = hasPdfMagic(head);

  if (!isPdf) {
    // 암호가 걸린 OOXML 은 zip 이 아니라 CFB 컨테이너다 — 여기서 전용 안내로 갈라낸다.
    // Task10 fix round1(Important 4): 인라인 바이트 배열 대신 document-formats.ts 의 단일 출처
    // 함수를 쓴다 — hasPdfMagic/hasZipMagic 과 같은 파일에 두지 않으면 source-scan 가드가
    // 놓치는 사각(형제 누락)이 재현된다.
    if (hasCfbMagic(head)) {
      store.setError({ code: 'DOC_ENCRYPTED', message: t('doc.encrypted') } as AppError);
      return;
    }
    if (!hasZipMagic(head)) {
      // 여기 도달했다는 것은 **확장자는 지원 포맷인데 내용이 아니라는** 뜻이다 — 진입 게이트
      // 5곳이 확장자를 앞에서 거르므로 이 지점의 확장자는 항상 지원 목록 안이다.
      // 그러므로 "지원하지 않는 형식"이 아니라 손상/불일치로 안내해야 정확하다.
      // (`fake.pdf` 에 쓰레기를 넣고 "지원 형식: PDF" 라고 답하면 사용자는 "내 건 .pdf 인데?" 가 된다.)
      store.setError({ code: 'DOC_CORRUPT', message: t('doc.corrupt') } as AppError);
      return;
    }
    // QA34(Low): zip 해제·포맷 판별은 여기(isParsing 이전)가 아니라 try 안의 openZipDocument 로
    // 옮겼다. 종전엔 최대 300MB 동기 해제가 스피너도 없이 UI 를 얼리고 취소도 불가능했다.
    // 부수효과: 손상 zip 드롭도 이제 진행 중 파싱을 abort-replace 한다 — 손상 PDF 드롭과 같다.
  }
  // 이미 파싱 진행 중이면 abort 후 새 파일로 교체.
  // 기존 가드는 "진행 중이면 무시" 였으나, 사용자가 다른 PDF를 드롭/Ctrl+O 했을 때
  // 아무 반응이 없어 UX가 혼란스러움. abort-replace 패턴으로 새 파일이 우선권을 가짐.
  if (activeParseController) {
    activeParseController.abort();
  }
  const controller = new AbortController();
  activeParseController = controller;

  store.setIsParsing(true);
  // onProgress 콜백도 ownership 체크 — 이전 파싱의 OCR 진행률이 새 파싱의 진행률을
  // 덮어쓰는 경쟁 방지. parsePdf 는 abort 이후에도 in-flight 페이지의 콜백을 흘릴 수 있음.
  const ownedProgress = (current: number, total: number) => {
    if (activeParseController !== controller) return;
    store.setOcrProgress({ current, total });
  };
  // page-citation-viewer: PdfViewer lazy 마운트를 위해 원본 바이트를 별도 보관.
  // parsePdf 가 내부적으로 pdfjs.getDocument({ data }) 를 호출할 때 ArrayBuffer 가 transfer 될 수
  // 있으므로, 파싱 전에 복사본을 만들어 두어 detached 상태를 피한다.
  // C5-R1(QA cycle5): 복사는 상주가 실제로 필요한 경우(재읽기 불가 합성경로 드롭)에만 수행.
  // 게이트 조건(isReReadablePath, doc.filePath === 본 filePath 인자)은 파싱 전에 이미 알 수
  // 있는데도 무조건 복사해, 모든 정상 경로에서 최대 100MB 사장 힙이 파싱(OCR 스캔 PDF 면
  // 분 단위) 내내 클로저에 붙들려 있었다 — v0.31.10 pdfBytes 비상주(M1)의 잔여분.
  // QA21(A-LOW): 이 할당은 반드시 try **안**에 있어야 한다. setIsParsing(true) 이후 try 진입
  // 전까지가 유일한 무보호 구간인데, 경로 없는 드롭(합성 File)에서 최대 100MB 복사가
  // RangeError(OOM)로 실패하면 finally 를 타지 못해 **isParsing 이 true 로 고착**한다.
  // 그러면 요약(QA20 이 요약 버튼을 isParsing 에 묶었다)·⚙️·탭 전환·업로더가 전부 영구 비활성
  // 되고, 복구 수단은 드래그드롭 재열기(abort-replace 로 새 파싱이 소유권을 가져감)뿐이다.
  let pdfBytesCopy: Uint8Array | null = null;
  try {
    // 원본 바이트는 PdfViewer 가 pdfjs 로 다시 그릴 때만 쓴다. 비-PDF 는 텍스트 뷰어가
    // pageTexts 로 렌더하므로 붙들 이유가 없다.
    pdfBytesCopy = !isPdf || isReReadablePath(filePath) ? null : new Uint8Array(data.slice(0));
    // 이미지 분석이 꺼져 있으면 이미지 추출 스킵(파싱 시간↓ — 이미지 많은 PDF에서 큰 폭).
    // QA6-D: 스킵 여부를 doc 에 마커로 남긴다 — 이후 설정을 ON 으로 바꿔 재요약하면 images=[]
    // 라 Vision 이 무음 no-op 이었는데, 텍스트-only PDF 의 정당한 0장과 구분할 수 없었다.
    // use-summarize 가 이 마커로 "재오픈 필요" 안내를 띄운다.
    const extractImagesEnabled = store.settings.enableImageAnalysis;
    const doc = !isPdf
      ? await openZipDocument(
          data,
          { fileName: name, filePath },
          { extractImages: extractImagesEnabled, signal: controller.signal },
        )
      : await parsePdf(data, name, filePath, {
          enableOcrFallback: store.settings.enableOcrFallback,
          extractImages: extractImagesEnabled,
          onOcrProgress: ownedProgress,
          signal: controller.signal,
        });
    if (!extractImagesEnabled) doc.imagesSkipped = true;
    // abort-replace 로 우리가 초과(supersede)된 경우, 성공한 파싱 결과를 store 에 반영하지 않는다.
    // 그렇지 않으면 오래된 문서가 새 문서를 덮어쓰는 경쟁 조건이 발생.
    if (activeParseController !== controller) return;
    // multi-doc Phase 1: 새 문서로 교체하기 전에 이전 문서의 미저장 tail 을 flush.
    // 자동 영속화는 1.5s 디바운스라, 로드 직후 다른 문서로 갈아타면(연속 드롭/빠른 탭 작업)
    // 이전 세션이 디스크에 없어 탭 전환 fallback·최근 문서 복원이 실패했다.
    if (useAppStore.getState().document) {
      try { await persistCurrentSession(); } catch { /* best-effort */ }
      if (activeParseController !== controller) return; // flush 중 supersede 재확인
    }
    // 새 문서로 교체되므로 이전 문서의 요약/Q&A/진행률 상태를 모두 초기화
    // (드롭/Ctrl+O로 덮어쓸 때 이전 문서의 summaryStream·qaMessages가 새 문서의 헤더와
    // 섞여 표시되는 버그 방지)
    store.clearStream();
    store.setSummary(null);
    store.setProgress(0);
    store.setProgressInfo(null);
    store.clearQa();
    store.setDocument(doc);
    // pdfBytes 비상주(메모리 M1): 원본 바이트(최대 100MB)는 인용 클릭 시 PdfViewer 만 쓴다.
    // 재읽기 가능한 실경로 문서는 상주시키지 않고(=null), PdfViewerPanel 이 인용 클릭 시 디스크에서
    // 1회 lazy 로드한다. 경로 없는 합성 드롭 문서만 재읽기 불가라 fallback 으로 상주 유지.
    // (C5-R1: 복사 자체를 위 게이트로 옮겨 null 이면 애초에 할당되지 않음)
    store.setPdfBytes(pdfBytesCopy);
    // multi-doc Phase 1: 모든 성공 로드 경로(드롭/다이얼로그/IPC/최근 문서/탭 전환)가 본
    // 함수를 경유하므로 여기가 탭 등록의 단일 지점 — filePath 중복은 메타 갱신(중복 탭 없음).
    store.upsertOpenTab({
      filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount, unitKind: doc.unitKind,
    });
    // session-persistence(module-3): setDocument 직후 복원 게이트 ON → useRagBuilder 자동
    // 재임베딩을 보류시키고, 콘텐츠 해시로 세션 복원을 시도한다. hit 시 재요약·재임베딩 0,
    // miss 시 게이트 해제 후 정상 빌드. (setDocument→resetSummaryState 가 게이트를 false 로
    // 초기화하므로 반드시 그 "이후"에 true 로 설정해야 함)
    store.setSessionRestorePending(true);
    void restoreSessionForDocument(doc);
    store.setError(null);
    // v0.18.7 D5 fix: notice 채널도 함께 정리. v0.18.6 D1 에서 notice 를 추가했지만
    // 새 PDF 로드 성공 시 stale notice (예: 직전 multi-file 드롭 경고) 를 정리하지 않아
    // 다른 단일 파일을 열어도 이전 경고가 잔존하던 lifecycle 갭 해소.
    store.setNotice(null);
    // QA28: Vision 예산 소진 고지(QA22 문구의 배선) — 위 setNotice(null) **뒤**에 둬야 남는다.
    if (doc.imageBudgetExceeded) {
      store.setNotice({ message: t('pdf.imageBudgetNotice', { max: String(MAX_TOTAL_IMAGES) }) });
    }
  } catch (err) {
    const error = err as Error & { code?: string; params?: Record<string, string> };
    // 사용자 취소는 에러 배너로 표시하지 않음 (의도적 액션)
    if (error.code === 'ABORTED') {
      return;
    }
    // abort-replace 로 우리를 덮어쓴 새 파싱이 있는 경우, 에러 배너도 띄우지 않음.
    if (activeParseController !== controller) return;
    const code = (error.code && OPEN_ERROR_CODES.has(error.code) ? error.code : 'PDF_PARSE_FAIL') as AppError['code'];
    // Task10 fix round1(Important 3) + round2: docx.ts/zip.ts/xml.ts 는 개발자용 영어 메시지로
    // throw 한다(예: 'word/document.xml missing', 'unit count 501 exceeds 500') —
    // `error.message ||`가 그걸 먼저 집어 한국어 UI 에도 원문 영어가 그대로 노출됐다(AI 에러가
    // i18n 을 우회했던 과거 결함과 같은 클래스). `error.params` 가 실려 있으면(추출기가
    // extractFail 로 던졌다는 뜻 — 빈 객체 포함) 이 경계에서 t(key, params) 로 번역한다.
    // params 가 없으면(예: parsePdf 가 던지는 PDF_TOO_MANY_PAGES 는 이미 t() 로 번역된
    // 문자열을 message 에 직접 담아 온다) 손대지 않고 error.message 를 그대로 쓴다 — 그렇지
    // 않으면 이미 번역된 PDF 경로 메시지가 파라미터 없이 다시 t() 를 타 {pages}p 미해석
    // placeholder 로 회귀한다.
    const overrideKey = error.params ? EXTRACTOR_ERROR_MESSAGE_KEYS[code] : undefined;
    store.setError({
      code,
      message: overrideKey ? t(overrideKey, error.params) : (error.message || t('uploader.cannotRead')),
      ...(overrideKey && error.message ? { details: error.message } : {}),
    });
  } finally {
    // 새 파싱이 abort-replace 로 우리를 덮어쓴 경우, 전역 상태(isParsing, ocrProgress)를
    // 건드리지 않음 — 새 파싱이 자신의 라이프사이클로 관리한다.
    if (activeParseController === controller) {
      activeParseController = null;
      store.setIsParsing(false);
      store.setOcrProgress(null);
    }
  }
}
