import type { AppError } from '../types';
import { useAppStore } from './store';
import { t } from './i18n';
import { restoreSessionForDocument, persistCurrentSession } from './use-session';
import { confirmDiscardIfNotPersisted } from './discard-policy';
import { MAX_PDF_SIZE_BYTES } from '../../shared/constants';
import { hasPdfMagic, hasZipMagic, hasCfbMagic, SUPPORTED_FORMATS } from '../../shared/document-formats';
import { openZip } from './extract/zip';
import { resolveExtractor } from './extract/registry';
import { toPdfDocument } from './extract/normalize';
import type { Extractor, ZipIndex } from './extract/types';
import { parsePdf, isReReadablePath, MAX_TOTAL_IMAGES } from './pdf-parser';
import type { TranslationKey } from './i18n';

const SUPPORTED_LABEL = SUPPORTED_FORMATS.map((f) => f.label).join(' · ');

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
  let extractor: Extractor | null = null;
  let zip: ZipIndex | null = null;

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
    try {
      zip = openZip(data);
    } catch (err) {
      const code = (err as { code?: string }).code === 'DOC_TOO_LARGE' ? 'DOC_TOO_LARGE' : 'DOC_CORRUPT';
      store.setError({ code, message: t(code === 'DOC_TOO_LARGE' ? 'doc.tooLarge' : 'doc.corrupt') } as AppError);
      return;
    }
    extractor = resolveExtractor(zip);
    if (!extractor) {
      store.setError({ code: 'DOC_UNSUPPORTED', message: t('doc.unsupported', { list: SUPPORTED_LABEL }) } as AppError);
      return;
    }
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
    const doc = extractor && zip
      ? toPdfDocument(
          await extractor.extract(zip, {
            extractImages: extractImagesEnabled,
            signal: controller.signal,
          }),
          { fileName: name, filePath },
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
    store.upsertOpenTab({ filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount });
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
    const error = err as Error & { code?: string };
    // 사용자 취소는 에러 배너로 표시하지 않음 (의도적 액션)
    if (error.code === 'ABORTED') {
      return;
    }
    // abort-replace 로 우리를 덮어쓴 새 파싱이 있는 경우, 에러 배너도 띄우지 않음.
    if (activeParseController !== controller) return;
    const validCodes = new Set([
      'PDF_PARSE_FAIL', 'PDF_NO_TEXT', 'PDF_TOO_MANY_PAGES', 'PDF_ENCRYPTED', 'OCR_FAIL',
      'DOC_UNSUPPORTED', 'DOC_CORRUPT', 'DOC_ENCRYPTED', 'DOC_TOO_LARGE', 'DOC_NO_TEXT',
    ]);
    const code = (error.code && validCodes.has(error.code) ? error.code : 'PDF_PARSE_FAIL') as AppError['code'];
    // Task10 fix round1(Important 3): docx.ts/zip.ts 는 개발자용 영어 메시지로 throw 한다
    // (예: 'word/document.xml missing', 'unzipped size exceeded') — `error.message ||`가
    // 그걸 먼저 집어 한국어 UI 에도 원문 영어가 그대로 노출됐다(AI 에러가 i18n 을 우회했던
    // 과거 결함과 같은 클래스). 알려진 DOC_* 코드는 전용 i18n 문구로 덮어쓰고, 원문은
    // details 에만 남겨 화면에는 노출하지 않는다.
    const DOC_ERROR_MESSAGE_KEYS: Partial<Record<string, TranslationKey>> = {
      DOC_NO_TEXT: 'doc.noText',
      DOC_CORRUPT: 'doc.corrupt',
      DOC_TOO_LARGE: 'doc.tooLarge',
    };
    const overrideKey = DOC_ERROR_MESSAGE_KEYS[code];
    store.setError({
      code,
      message: overrideKey ? t(overrideKey) : (error.message || t('uploader.cannotRead')),
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
