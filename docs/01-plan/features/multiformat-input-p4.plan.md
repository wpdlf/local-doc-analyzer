# 다중 포맷 문서 입력 — P4a (PPTX · HWPX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PowerPoint(.pptx)와 한글(.hwpx) 파일을 열어 요약·Q&A·인용 점프까지 DOCX 와 똑같이 동작시키고, 슬라이드 문서의 인용·검색·목록 라벨이 "슬라이드 N" 으로 보이게 한다.

**Architecture:** P1~P3 가 세운 틀(추출기 → `ExtractedDoc` → `normalize.ts` → `PdfDocument`)에 추출기 둘을 끼운다. 그 전에 (1) 전역 검색·최근 문서·헤더가 `unitKind` 를 무시하고 `p.N`/`N페이지` 로 표시하는 배선을 닫고, (2) 두 포맷이 공유할 부품(네임스페이스 속성 읽기 · 격자 표 배치 · BMP 변환 · OCF 컨테이너 해석)을 먼저 만든다. PPTX 는 첫 **비-'page'** 포맷이라 QA34 가 세운 unitKind 가드들이 실제로 시험받는다.

**Tech Stack:** TypeScript 7 · React 19 · Vitest(happy-dom) · Playwright(Electron) · fflate · 렌더러 내장 DOMParser

**Spec:** `docs/02-design/features/multiformat-input.design.md` (§1 계약 · §2 포맷별 단위 · §3 HWPX · §5 표시 계층 · §8 테스트)

## 범위

| 단계 | 이 계획 | 비고 |
|---|---|---|
| 전역 검색·목록 라벨 unitKind 배선 | ✅ | P4 선행 조건(메모리 `project_multiformat_p1_docx_shipped` ⛔2) |
| PPTX 추출기 | ✅ | 실물 24개 조사 결과(아래 "실물 조사") 반영 |
| HWPX 추출기 | ✅ | 실물 2개 조사 + 설계 §3 |
| **EPUB** | ❌ | **실물 샘플이 이 기계에 없다.** 확인 안 된 구조로 테스트를 쓰면 확신에 찬 오답이 된다 — 샘플 확보 후 별도 계획(P4b). 이 계획이 만드는 `ocf.ts` 는 EPUB 이 그대로 재사용한다 |

완료 시점의 상태: **PDF · Word · PowerPoint · 한글(HWPX) 을 열 수 있다.** EPUB 은 여전히 `DOC_UNSUPPORTED`. PDF·DOCX 회귀 없음.

## 실물 조사 요약 (2026-09-28, 저장소가 담지 못하는 사실 — 태스크의 "배경" 근거)

**PPTX** (Downloads 24개 + Desktop/Documents 10개. Windows PowerPoint 16 한국어 · Mac · **Google Slides 내보내기 10개**)
- 슬라이드 순서는 `p:sldIdLst/p:sldId/@r:id` → `ppt/_rels/presentation.xml.rels`. rId 번호는 슬라이드 번호와 무관(PowerPoint rId2부터, Google rId6부터). `p14` 확장의 두 번째 sldIdLst 는 무시해야 한다(루트 직계만).
- **`p:sldId` 에는 `id` 와 `r:id` 가 함께 있다** — 현 `attr()` 는 로컬명만 보므로 어느 쪽을 줄지 보장이 없다(xml.ts 주석이 예고한 "충돌이 의미 있는 포맷").
- 텍스트는 `p:sp/p:txBody/a:p/a:r/a:t`. **그룹(`p:grpSp`) 안 텍스트가 흔하다**(한 덱은 27장 중 26장). 최상위 `p:sp` 만 읽으면 대부분 잃는다.
- `a:fld type="slidenum"` 이 모든 슬라이드의 `sldNum` 자리표시자에 있다 — PowerPoint 는 숫자, **Google 은 `‹#›`** 를 캐시한다. 거르지 않으면 모든 단위에 번호/`‹#›` 가 샌다.
- 제목 자리표시자(`title`/`ctrTitle`)는 24개 중 5개 덱에만 매 슬라이드에 있다. **약 70% 덱은 제목 자리표시자가 없다** — 추측하지 않는다.
- spTree 는 z-순서다. 기하 정렬은 다단 레이아웃을 망가뜨리므로 하지 않고, 제목만 앞으로 뺀다.
- 표 `a:tbl`: 병합 연속 셀은 `hMerge`/`vMerge` 속성. **Google 은 자기 닫힘 `<a:tc vMerge="1"/>`** 로 쓴다. 격자의 모든 칸이 `a:tc` 로 존재한다(HWPX 와 다름).
- 그림: `p:pic/p:blipFill/a:blip/@r:embed`. SVG 는 png 폴백 blip + `asvg:svgBlip` 확장 — 확장까지 세면 **이중 계산**. EMF 11종(F18) — Vision 불가. 같은 그림 재사용 흔함(한 그림이 25장). 배경·레이아웃 그림 0.
- 발표자 노트: 슬라이드 rels → `notesSlides/notesSlideN.xml` 의 `ph type="body"`. 실물 290개 노트는 전부 비어 있었다 → **비어 있지 않은 경우는 합성 픽스처로만** 검증.
- 레이아웃/마스터에는 "마스터 제목 스타일 편집" 같은 안내문이 있다 — **절대 읽지 않는다.** 템플릿에만 있는 문구(서식 양식)는 잃는다 — 알려진 한계로 둔다.
- 코퍼스에 없던 것(합성 픽스처 필수): 차트 · SmartArt · 숨김 슬라이드 · `mc:AlternateContent` · 비어 있지 않은 노트.

**HWPX** (서로 다른 실물 2개 — 한글 12.0, Windows/Linux 저장)
- `mimetype` = `application/hwp+zip`(첫 엔트리). container.xml 의 rootfile 이 **3개**(content.hpf · PrvText.txt · container.rdf) → media-type `application/hwpml-package+xml` 로 고른다.
- OPF manifest 의 href 는 **패키지 루트 기준**(`Contents/section0.xml`, `BinData/image1.bmp`) — OPF 규약(OPF 파일 기준 상대)과 다르다. 두 방식을 모두 받아야 한다.
- spine 에 header · 스크립트까지 섞인다 → `sectionN.xml` 이면서 루트 로컬명 `sec` 인 것만 본문.
- **표 병합: 가려진 칸은 XML 에 없다(HTML 방식).** `hp:cellAddr(colAddr,rowAddr)` + `hp:cellSpan` 으로 배치해야 한다 — 28개 표 전부 rowCnt×colCnt 격자를 빈틈없이 채웠다. `hp:subList` 가 `cellAddr` **앞**에 온다. 표 중첩 3단계.
- **글상자(`hp:rect > hp:drawText > hp:subList`)에 한 샘플 본문의 약 28%**(표 24개 중 9개)가 있다 — 건너뛰면 조용히 잃는다.
- `hp:t` 는 혼합 내용(텍스트 + `hp:lineBreak` + `hp:markpenBegin/End`). 공백만 있는 `hp:t` 도 실제 공백이다 — 런 단위 trim 금지.
- **`hp:shapeComment` 에 "그림입니다. 원본 그림의 이름: <파일명>…" 자동 문구** — 모든 텍스트 노드를 모으면 원본 파일명이 요약에 샌다. 텍스트는 `hp:t` 에서만.
- 쪽나눔은 `hp:p/@pageBreak === "1"` 뿐. `hp:tbl/@pageBreak="CELL"` 은 다른 뜻.
- 그림: `hp:pic > hc:img/@binaryItemIDRef` → manifest id → href. **본문 그림 4개 중 3개가 BMP** — 현 image-fit 은 PNG/JPEG 만 알아 전부 버린다. header.xml 의 글머리표 그림은 본문이 아니다.
- 개요 제목: **스타일 이름("개요 1")을 믿으면 틀린다.** `hp:p/@paraPrIDRef` → header.xml `hh:paraPr` → `hh:heading type="OUTLINE" level`(0-based). `hp:switch > hp:case / hp:default` 로 두 갈래가 있으면 **case 하나만**.
- 머리말/꼬리말(`hp:header`/`hp:footer`, `hp:ctrl` 안)과 쪽 번호 자동 문구는 본문이 아니다.
- 미확인(샘플 없음 — 합성 픽스처로): 여러 섹션 · 각주/미주 · 탭/특수 공백 · 본문에 실제로 쓰인 개요 제목 · 암호 파일 · 구버전 네임스페이스.

## Global Constraints

- 내부 인용 형식 `[p.N]` · `CITATION_REGEX` · `clampCitationPage` · `pageTexts` · 청크 메타 · 세션 스키마 · **프롬프트는 바꾸지 않는다.** 프롬프트로 나가는 라벨은 `formatPromptPageLabel` 만(`formatUnitLabel` 금지 — source-scan 가드가 막는다).
- `SESSION_SCHEMA_VERSION` 을 올리지 않는다. 새 필드는 선택 필드, 부재 = `'page'`.
- 포맷 id·확장자 리터럴(`'pptx'`, `'.hwpx'` 등)은 `src/shared/document-formats.ts` 에만 쓴다 — `SUPPORTED_FORMATS` 에 등록하는 순간 source-scan 가드가 그 밖의 리터럴을 잡는다(`extract/types.ts:61` 의 `'pptx'|'hwpx'` 포함).
- 이미지·단위 예산은 기존 상수를 재사용한다: `MAX_PAGE_COUNT`(500) · `MAX_TOTAL_IMAGES`(50) · `MAX_EXAMINED_IMAGES`(400) — `../pdf-parser` 에서 import. 새 예산 상수를 만들지 않는다. 표 폭 상한은 `MAX_TABLE_COLUMNS`(256).
- 텍스트는 **지정한 텍스트 요소에서만** 읽는다(PPTX `a:t`, HWPX `hp:t`). 패키지 전체의 텍스트 노드를 긁지 않는다(레이아웃 안내문·shapeComment·SmartArt 중복).
- 추출기는 i18n 을 모른다 — 코드 + params 만 던지고(`extractFail`), 번역은 `document-open.ts` 경계가 한다.
- 새 의존성 없음. 새 파일을 만들면 `extract/` 안에 둔다(지연 청크 — `document-open.ts` 가 동적 import).
- 소스 스캔 가드는 `stripJsComments` 를 거친다. 테스트의 `readFileSync` 는 주석 제거기/`JSON.parse` 로 감싼다.
- 주석·커밋은 한국어 평서체. UI 문자열은 ko/en 한 쌍으로(i18n.test 가 짝을 본다).
- 정규식·백슬래시가 든 편집은 Edit/Write 도구로(heredoc·sed 로 파일이 깨진 전례 3회). PowerShell `Set-Content` 금지(한글 파손).
- 매 커밋 전 `npx tsc --noEmit`. 태스크 끝에 `npx vitest run` 전체.
- **테스트와 구현이 서로 모순되면 어느 쪽도 맞추지 말고 멈춰 코디네이터에게 보고한다.** P1 의 계획 결함 3건(최악 = 프롬프트 계약을 표시 함수로 착각)이 전부 이 규칙으로 드러났다.
- **모든 새 테스트는 비공허 증명을 남긴다** — 가드하는 코드를 일부러 망가뜨려 실패 요약 줄을 붙이고 원복한다. 실행 기록 없는 뮤테이션 주장은 받지 않는다.
- "기존 문제" 라고 판단할 때는 **`main` 과 대조한다**(브랜치의 조상과 대조해 세 번 틀린 전례).

## File Structure

**새 파일**

| 파일 | 책임 |
|---|---|
| `src/renderer/lib/extract/ocf.ts` | OCF 컨테이너(`META-INF/container.xml` → OPF manifest·spine) 해석. HWPX 가 쓰고 EPUB(P4b)이 재사용 |
| `src/renderer/lib/extract/pptx-text.ts` | PPTX 문단 텍스트화 · 그래픽 텍스트화 계약(pptx.ts·pptx-graphics.ts 공용 — 순환 방지) |
| `src/renderer/lib/extract/pptx.ts` | PPTX 추출기 |
| `src/renderer/lib/extract/pptx-graphics.ts` | PPTX 의 표·차트·SmartArt 텍스트화(추출기 본체를 작게 유지) |
| `src/renderer/lib/extract/hwpx.ts` | HWPX 추출기 |
| `src/renderer/lib/extract/hwpx-header.ts` | header.xml 의 개요 수준 표(paraPr id → 제목 수준) |
| `src/renderer/lib/extract/__tests__/{ocf,pptx,pptx-graphics,hwpx,hwpx-header}.test.ts` | 합성 픽스처 테스트 |
| `e2e/fixtures/make-pptx.ts` · `e2e/fixtures/make-hwpx.ts` | E2E 합성 픽스처 |
| `e2e/office-open.spec.ts` | PPTX·HWPX 열기 → 인용 점프 → 슬라이드 라벨 |

**수정 파일**

| 파일 | 변경 |
|---|---|
| `src/shared/session-types.ts` · `src/main/session-search.ts` · `src/main/semantic-search.ts` · `src/main/index.ts` | 검색 결과에 `unitKind` |
| `src/renderer/lib/citation.ts` · `i18n.ts` | `formatUnitCount`, 단위 개수 키 |
| `GlobalSearch.tsx` · `RecentDocuments.tsx` · `App.tsx` · `SummaryViewer.tsx` · `TabBar.tsx` | 라벨을 단위 종류로 |
| `src/renderer/lib/extract/xml.ts` | `prefixedAttr` |
| `src/renderer/lib/extract/table.ts` | `placeGridCells` |
| `src/renderer/lib/extract/image-fit.ts` | BMP 수용(항상 재인코딩) |
| `src/shared/document-formats.ts` | pptx·hwpx 등록, `SUPPORTED_LABEL` |
| `src/renderer/lib/extract/types.ts` · `registry.ts` | id 도출, 추출기 등록 |
| `src/renderer/lib/document-open.ts` | 미디어 필터에 `BinData/` |
| `src/main/index.ts` · `i18n.ts` | "PDF · Word 파일만" 을 지원 목록 도출로 |

---

## Task 1: 전역 검색·최근 문서·헤더 라벨이 unitKind 를 따른다

**Files:**
- Modify: `src/shared/session-types.ts:65-73` (GlobalSearchResult)
- Modify: `src/main/session-search.ts:45-50, 111-119`
- Modify: `src/main/semantic-search.ts:~214-221`
- Modify: `src/main/index.ts:~1082` (session:search 핸들러가 meta 를 넘기는 자리)
- Modify: `src/renderer/lib/citation.ts` (formatUnitCount 추가, 295-304 주석 정정)
- Modify: `src/renderer/lib/i18n.ts` (`search.page` · `recent.pages` 제거, `unit.count.*` · `unit.countShort.*` 추가)
- Modify: `src/renderer/components/GlobalSearch.tsx:224-226`, `RecentDocuments.tsx:135`, `src/renderer/App.tsx:745`, `SummaryViewer.tsx:211`, `TabBar.tsx:60`, `CitationButton.tsx:108-109`
- Modify: `src/shared/__tests__/source-scan.test.ts` (개수 라벨 조립 가드)
- Test: `src/main/__tests__/session-search.test.ts`, `src/main/__tests__/semantic-search.test.ts`, `src/renderer/lib/__tests__/citation.test.ts`, `src/renderer/components/__tests__/{GlobalSearch,RecentDocuments,TabBar}.test.tsx`

**Interfaces:**
- Consumes: `SessionManifestEntry.unitKind?`(session-types.ts:40), `formatUnitLabel(page, unitKind)`(citation.ts:306), `openTabs[].unitKind`, `document.unitKind`
- Produces:
  - `GlobalSearchResult.unitKind?: 'page' | 'slide' | 'chapter'`
  - `formatUnitCount(count: number, unitKind?: UnitKind, style?: 'long' | 'short'): string` (citation.ts)
  - `formatUnitSpoken(page: number, unitKind?: UnitKind): string` (citation.ts) — 스크린리더·툴팁 문장용

**배경:** 전역 검색 결과 타입에 `unitKind` 가 없어 스니펫 라벨이 `t('search.page')` = `p.{page}` 로 고정된다(citation.ts:295-304 가 "알려진 우회, 보류" 로 적어 둔 자리). 최근 문서는 `recent.pages`(`{count}페이지`), 헤더·탭은 `(${pageCount}p)` 를 조립한다. 오늘은 DOCX 도 'page' 라 차이가 0 이지만 PPTX 가 들어오는 순간 "슬라이드 3" 이어야 할 곳 여섯 군데가 `p.3`/`12페이지` 가 된다. **'page' 와 출력이 같은 동안은 테스트가 구조적으로 못 잡는다**(QA34 교훈) — 모든 단언을 `'slide'` 로 한다.

- [ ] **Step 1: main 검색 결과에 unitKind 를 싣는 실패 테스트**

`src/main/__tests__/session-search.test.ts` 에 추가:

```ts
it('검색 결과가 manifest 의 unitKind 를 싣는다 — 슬라이드 문서의 스니펫 라벨이 p.N 이 되지 않게', () => {
  const r = searchPersistedSession(
    { docHash: 'h', fileName: 'deck.pptx', filePath: '/d/deck.pptx', pageCount: 3, unitKind: 'slide' },
    { pageTexts: ['alpha', 'beta keyword', 'gamma'] },
    'keyword',
  );
  expect(r?.unitKind).toBe('slide');
  expect(r?.snippets[0]?.page).toBe(2);
});

it('unitKind 가 없는 옛 manifest 항목은 필드를 싣지 않는다(부재 = page)', () => {
  const r = searchPersistedSession(
    { docHash: 'h', fileName: 'a.pdf', filePath: '/d/a.pdf', pageCount: 1 },
    { pageTexts: ['keyword'] },
    'keyword',
  );
  expect(r && 'unitKind' in r).toBe(false);
});
```

`src/main/__tests__/semantic-search.test.ts` 의 `describe('runSemanticSearch (main 코사인)')` 안에 추가(파일의 `entry`·`setIndex`·`store` 헬퍼를 그대로 쓴다):

```ts
  it('의미 검색 결과도 manifest 의 unitKind 를 싣는다 (P4)', async () => {
    store.listSessions.mockResolvedValue([entry({ fileName: 'deck.pptx', unitKind: 'slide' })]);
    setIndex({ vecs: [[1, 0]] });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results[0]!.unitKind).toBe('slide');
  });

  it('unitKind 없는 옛 항목은 필드를 싣지 않는다', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ vecs: [[1, 0]] });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect('unitKind' in out.results[0]!).toBe(false);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/__tests__/session-search.test.ts src/main/__tests__/semantic-search.test.ts`
Expected: FAIL — `expected undefined to be 'slide'` (그리고 SearchableMeta 에 unitKind 가 없어 tsc 오류)

- [ ] **Step 3: 구현 — 타입과 두 검색 경로**

`src/shared/session-types.ts` 의 `GlobalSearchResult` 에 추가:

```ts
  /**
   * 스니펫 페이지 번호를 어떤 단위로 읽을지(P4). manifest 의 unitKind 를 그대로 싣는다 —
   * 없으면(옛 항목·PDF) 'page'. 검색 스니펫 라벨이 이 값으로 formatUnitLabel 을 거친다.
   */
  unitKind?: 'page' | 'slide' | 'chapter';
```

`src/main/session-search.ts`:

```ts
interface SearchableMeta {
  docHash: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  unitKind?: 'page' | 'slide' | 'chapter';
}
```

반환부(111-119)를 다음으로 바꾼다:

```ts
  return {
    docHash: meta.docHash,
    fileName: meta.fileName,
    filePath: meta.filePath,
    pageCount: meta.pageCount,
    ...(meta.unitKind ? { unitKind: meta.unitKind } : {}),
    score,
    inSummary,
    snippets,
  };
```

`src/main/index.ts` 의 `session:search` 핸들러에서 `searchPersistedSession({ docHash, fileName, filePath, pageCount: e.pageCount }, …)` 를 호출하는 자리(현재 ~1082행)에 `unitKind: e.unitKind` 를 추가한다. `src/main/semantic-search.ts` 에서 결과 객체를 만드는 자리(`pageCount: e.pageCount,` — 217행)에 바로 다음 줄로 `...(e.unitKind ? { unitKind: e.unitKind } : {}),` 를 넣는다. `e.unitKind` 는 이미 `safeUnitKind` 로 걸러진 manifest 값이다(session-store.ts:126).

- [ ] **Step 4: main 테스트 통과 확인**

Run: `npx vitest run src/main/__tests__/session-search.test.ts src/main/__tests__/semantic-search.test.ts`
Expected: PASS

- [ ] **Step 5: 렌더러 — formatUnitCount 실패 테스트**

`src/renderer/lib/__tests__/citation.test.ts` 에 추가:

```ts
describe('formatUnitCount', () => {
  beforeEach(() => useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' } })));

  it('단위 종류별 개수 문구 — long', () => {
    expect(formatUnitCount(12, 'page')).toBe('12페이지');
    expect(formatUnitCount(12, 'slide')).toBe('슬라이드 12장');
    expect(formatUnitCount(3, 'chapter')).toBe('3개 장');
  });

  it('short 는 헤더·탭의 괄호 표기 — page 는 종전 "(2p)" 그대로', () => {
    expect(formatUnitCount(2, 'page', 'short')).toBe('2p');
    expect(formatUnitCount(12, 'slide', 'short')).toBe('12슬라이드');
  });

  it('unitKind 생략 = page (PDF·옛 세션)', () => {
    expect(formatUnitCount(5)).toBe('5페이지');
  });

  it('영어', () => {
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'en' } }));
    expect(formatUnitCount(12, 'slide')).toBe('12 slides');
    expect(formatUnitCount(2, 'page', 'short')).toBe('2p');
  });
});
```

(`useAppStore` 와 `beforeEach` import 는 파일에 이미 있는지 확인하고 없으면 추가한다.)

- [ ] **Step 6: 실패 확인**

Run: `npx vitest run src/renderer/lib/__tests__/citation.test.ts`
Expected: FAIL — `formatUnitCount is not exported`

- [ ] **Step 7: 구현 — i18n 키와 formatUnitCount**

`src/renderer/lib/i18n.ts` 에서 `'recent.pages'` 와 `'search.page'` 두 줄을 **지우고**, `citation.unit.chapter`(51행 부근) 바로 아래에 추가:

```ts
  // P4: 단위 **개수** 표기의 단일 출처(formatUnitCount). long = 최근 문서 목록, short = 헤더·탭 괄호.
  // page 의 short 는 종전 "(2p)" 표기를 그대로 둔다(E2E·사용자 익숙함).
  'unit.count.page': { ko: '{n}페이지', en: '{n} pages' },
  'unit.count.slide': { ko: '슬라이드 {n}장', en: '{n} slides' },
  'unit.count.chapter': { ko: '{n}개 장', en: '{n} chapters' },
  'unit.countShort.page': { ko: '{n}p', en: '{n}p' },
  'unit.countShort.slide': { ko: '{n}슬라이드', en: '{n} slides' },
  'unit.countShort.chapter': { ko: '{n}장', en: '{n} ch.' },
```

`src/renderer/lib/citation.ts` 의 `formatUnitLabel` 바로 아래에 추가:

```ts
/**
 * 단위 **개수** 의 표시용 단일 통로(P4) — "12페이지" / "슬라이드 12장" / "(2p)".
 *
 * 최근 문서 목록·헤더·탭이 각자 `${pageCount}p`·`recent.pages` 를 조립해 unitKind 를 몰랐다.
 * 여기를 거치지 않은 개수 조립은 source-scan 가드가 잡는다.
 */
export function formatUnitCount(count: number, unitKind: UnitKind = 'page', style: 'long' | 'short' = 'long'): string {
  const key = style === 'short' ? `unit.countShort.${unitKind}` : `unit.count.${unitKind}`;
  return t(key as TranslationKey, { n: String(count) });
}
```

같은 파일 295-304 주석의 "`t('search.page')` … 알려진 상태, … 보류" 문단을 다음으로 바꾼다:

```ts
 * 도출한다. **주의**: 그 가드는 소스 텍스트 패턴만 본다 — i18n 키 참조로 라벨을 내는 자리는
 * 코드에 'p.' 가 없으므로 못 잡는다. 그런 우회였던 `search.page`(GlobalSearch)·`recent.pages`
 * 는 P4 에서 지우고 이 함수·formatUnitCount 로 옮겼다(검색 결과가 unitKind 를 싣게 됐다).
```

- [ ] **Step 8: 통과 확인**

Run: `npx vitest run src/renderer/lib/__tests__/citation.test.ts`
Expected: PASS

- [ ] **Step 9: 표시 지점 다섯 곳 — 실패 테스트 먼저**

`GlobalSearch.test.tsx` 의 `describe('GlobalSearch')` 안에 추가(파일의 `result`·`M` 헬퍼 사용):

```tsx
  it('슬라이드 문서의 스니펫 라벨은 "슬라이드 N" 이다 — p.N 이 아니라 (P4)', async () => {
    M.search.mockResolvedValue([result({ fileName: 'deck.pptx', unitKind: 'slide', snippets: [{ page: 3, text: '…프로세스…' }] })]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText('슬라이드 3')).toBeTruthy());
    expect(screen.queryByText('p.3')).toBeNull();
  });

  it('unitKind 없는 결과(PDF·옛 세션)는 종전대로 p.N', async () => {
    M.search.mockResolvedValue([result({})]);
    const user = userEvent.setup();
    render(<GlobalSearch />);
    await user.type(screen.getByLabelText('문서 검색'), '프로세스');
    await user.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByText('p.2')).toBeTruthy());
  });
```

`RecentDocuments.test.tsx` 의 `describe('RecentDocuments')` 안에 추가(파일의 `entry`·`M` 사용):

```tsx
  it('슬라이드 문서는 "슬라이드 N장" 으로 센다 (P4)', async () => {
    M.list.mockResolvedValue([{ ...entry('h2', 'deck.pptx', 12), unitKind: 'slide' }]);
    render(<RecentDocuments />);
    await waitFor(() => expect(screen.getByText(/deck\.pptx/)).toBeTruthy());
    expect(screen.getByText(/슬라이드 12장/)).toBeTruthy();
    expect(screen.queryByText(/12페이지/)).toBeNull();
  });
```

`TabBar.test.tsx` 의 `describe('TabBar')` 안에 추가(파일의 `tab`·`setState` 사용):

```tsx
  it('탭 제목의 개수 표기가 unitKind 를 따른다 (P4)', () => {
    setState({ tabs: [{ ...tab('/d/deck.pptx'), pageCount: 12, unitKind: 'slide' }, tab('/d/a.pdf')], active: '/d/a.pdf' });
    render(<TabBar />);
    expect(screen.getByText(/deck\.pptx/).closest('button')!.getAttribute('title')).toBe('deck.pptx (12슬라이드)');
    expect(screen.getByText(/a\.pdf/).closest('button')!.getAttribute('title')).toBe('a.pdf (3p)');
  });
```

(`title` 이 버튼이 아니라 다른 요소에 달려 있으면 `TabBar.tsx:60` 의 실제 요소로 셀렉터를 맞춘다 — 단언 값은 바꾸지 않는다.)

Run: `npx vitest run src/renderer/components/__tests__/GlobalSearch.test.tsx src/renderer/components/__tests__/RecentDocuments.test.tsx src/renderer/components/__tests__/TabBar.test.tsx`
Expected: FAIL — `p.3` / `12페이지` / `(12p)` 가 보인다.

- [ ] **Step 10: 구현 — 다섯 곳**

`GlobalSearch.tsx:224-226`:

```tsx
                    const label = s.page > 0
                      ? formatUnitLabel(s.page, r.unitKind ?? 'page')
                      : (lastMode === 'keyword' ? tr('search.summaryLabel') : null);
```

(`import { formatUnitLabel } from '../lib/citation';` 추가. `tr` 의 반응형 재렌더는 `useT()` 가 이미 컴포넌트를 구독시키므로 유지된다.)

`RecentDocuments.tsx:135`: `{formatUnitCount(e.pageCount, e.unitKind ?? 'page')}` (import 추가).

`App.tsx:745`: `📎 {document.fileName} ({formatUnitCount(document.pageCount, document.unitKind ?? 'page', 'short')})`

`SummaryViewer.tsx:211`: `` `📎 ${document.fileName} (${formatUnitCount(document.pageCount, document.unitKind ?? 'page', 'short')})` ``

`TabBar.tsx:60`: `` title={`${tab.fileName} (${formatUnitCount(tab.pageCount, tab.unitKind ?? 'page', 'short')})`} ``

`openTabs` 항목 타입에 `unitKind` 가 이미 있는지 `src/renderer/types/index.ts` 에서 확인한다(P3 에서 넣었다 — 없으면 멈추고 보고).

- [ ] **Step 10b: 인용 버튼의 접근성 이름·툴팁도 단위를 따른다**

배경: `CitationButton.tsx:108-109` 의 `title`/`aria-label` 이 `citation.tooltip`/`citation.aria`(`'{page} 페이지 원문 열기'`)라, 슬라이드 덱에서 버튼에는 "[슬라이드 2]" 가 보이는데 **스크린리더는 "2 페이지 원문 열기"** 로 읽는다. 표시 라벨(formatUnitLabel)만 고치고 이 둘을 빠뜨리면 P3 의 형제 누락이 반복된다.

`CitationButton.test.tsx` 의 QA34 I3 테스트(`"활성 문서가 unitKind 'slide' 면 단일 문서 라벨이 슬라이드로 보인다"`, ~88행) 바로 뒤에 같은 시드 방식으로 추가:

```tsx
  it('슬라이드 문서의 인용 버튼은 접근성 이름·툴팁도 슬라이드로 말한다 (P4)', () => {
    useAppStore.setState((s) => ({
      settings: { ...s.settings, uiLanguage: 'ko' },
      document: { ...s.document!, fileName: 'deck.pptx', unitKind: 'slide' },
    }));
    render(<CitationButton page={3} />);
    const btn = screen.getByRole('button', { name: '슬라이드 3 원문 열기' });
    expect(btn.getAttribute('title')).toBe('클릭하여 슬라이드 3 원문 확인');
  });

  it('PDF(unitKind 없음)의 접근성 이름은 종전 문구 그대로', () => {
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' } }));
    render(<CitationButton page={2} />);
    expect(screen.getByRole('button', { name: '2 페이지 원문 열기' })).toBeTruthy();
  });
```

i18n 에 말하기용 단위 키를 추가하고 네 키를 `{unit}` 으로 바꾼다:

```ts
  // P4: 스크린리더·툴팁용 단위 표현("2 페이지" / "슬라이드 2" / "2장"). 버튼에 보이는 짧은 라벨
  // (citation.unit.*, "p.2")과 달리 문장 안에서 읽힌다.
  'unit.spoken.page': { ko: '{n} 페이지', en: 'page {n}' },
  'unit.spoken.slide': { ko: '슬라이드 {n}', en: 'slide {n}' },
  'unit.spoken.chapter': { ko: '{n}장', en: 'chapter {n}' },
  'citation.aria': { ko: '{unit} 원문 열기', en: 'Open source {unit}' },
  'citation.tooltip': { ko: '클릭하여 {unit} 원문 확인', en: 'Click to view source on {unit}' },
  'citation.crossTooltip': { ko: '클릭하여 {name} {unit} 열기', en: 'Click to open {name} on {unit}' },
  'citation.crossAria': { ko: '{name} {unit} 원문 열기', en: 'Open {name} {unit}' },
```

`citation.ts` 에 `formatUnitSpoken(page: number, unitKind: UnitKind = 'page'): string`(`t('unit.spoken.' + unitKind, { n })`)을 두고, `CitationButton.tsx:108-109` 가 `{ unit: formatUnitSpoken(validPage, <표시 라벨에 쓰는 것과 같은 unitKind 변수>) }` 를 넘기게 한다. **ko page 문구는 종전과 같다**("2 페이지 원문 열기") — `e2e/docx-open.spec.ts` 의 `/페이지 원문 열기$/` 는 그대로 통과해야 한다. 교차문서 문구는 "{name} 2페이지" → "{name} 2 페이지" 로 한 칸 바뀐다 — 이 문자열을 고정한 기존 테스트가 있으면 새 문구로 고친다(동작 변경이 아니라 띄어쓰기).

- [ ] **Step 11: 개수 조립 가드**

`src/shared/__tests__/source-scan.test.ts` 의 P_LABEL 가드(`"'p.' 템플릿 리터럴/문자열 조립이 단일 통로 밖에 없다"`, ~489행) 바로 뒤에, 같은 헬퍼(`walkSourceFiles`·`assertScanIsWide`·`isTestPath`·`stripJsComments`)로 추가한다:

```ts
  // P4: 단위 개수를 formatUnitCount 밖에서 조립하면 unitKind 를 모른다("(12p)" 가 슬라이드 덱에).
  // i18n 키 참조(recent.pages·search.page)로 우회하던 자리도 함께 막는다 — 키를 지웠으니 다시
  // 쓰면 tsc 가 먼저 잡지만, 같은 모양의 새 키를 만드는 우회까지는 못 막으므로 문자열로도 본다.
  const UNIT_COUNT_RE = /\}p\)|\{count\}페이지|['"`]recent\.pages['"`]|['"`]search\.page['"`]/;

  it('단위 개수·검색 페이지 라벨은 formatUnitCount/formatUnitLabel 밖에서 조립하지 않는다', () => {
    const scanned = walkSourceFiles('src', /\.tsx?$/);
    assertScanIsWide(scanned);
    const offenders: string[] = [];
    for (const file of scanned) {
      const norm = file.replace(/\\/g, '/');
      if (norm.endsWith('renderer/lib/i18n.ts') || isTestPath(file)) continue;
      const src = stripJsComments(readFileSync(file, 'utf-8'));
      for (const [i, line] of src.split('\n').entries()) {
        if (UNIT_COUNT_RE.test(line)) offenders.push(`${norm}:${i + 1}`);
      }
    }
    expect(offenders, '개수 표기는 formatUnitCount 를 거친다').toEqual([]);
  });

  it('개수 조립 가드의 양성 샘플', () => {
    expect(UNIT_COUNT_RE.test('title={`${tab.fileName} (${tab.pageCount}p)`}')).toBe(true);
    expect(UNIT_COUNT_RE.test("tr('recent.pages', { count })")).toBe(true);
    expect(UNIT_COUNT_RE.test("tr('search.page', { page })")).toBe(true);
    expect(UNIT_COUNT_RE.test("formatUnitCount(n, k, 'short')")).toBe(false);
  });
```

- [ ] **Step 12: 전체 확인 + 비공허 증명**

Run: `npx vitest run` → PASS. 이어서 뮤테이션 두 개를 적용·실행·원복하고 실패 요약 줄을 커밋 메시지 본문에 남긴다:
1. `GlobalSearch.tsx` 의 `r.unitKind ?? 'page'` → `'page'` → GlobalSearch 테스트 1 failed 여야 한다
2. `session-search.ts` 의 `...(meta.unitKind ? …)` 삭제 → session-search 테스트 1 failed

- [ ] **Step 13: 커밋**

```bash
npx tsc --noEmit
git add src/shared src/main src/renderer
git commit -m "fix(search): 전역 검색·최근 문서·헤더의 단위 라벨이 unitKind 를 따른다 (P4 선행)

검색 결과 타입에 unitKind 가 없어 스니펫 라벨이 search.page(p.N)로 고정됐고, 최근 문서·헤더·탭은
각자 '{count}페이지'·'(Np)' 를 조립했다. 오늘은 DOCX 도 page 라 차이가 0 이지만 PPTX 가 들어오면
여섯 곳이 틀린다. 검색 두 경로(키워드·의미)가 manifest 의 unitKind 를 싣고, 개수 표기는
formatUnitCount 단일 통로로 모으고, 그 밖의 조립을 소스 가드로 막는다.

<뮤테이션 실패 요약 두 줄>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 공용 부품 — 네임스페이스 속성 · 격자 표 배치 · BMP

**Files:**
- Modify: `src/renderer/lib/extract/xml.ts` (prefixedAttr)
- Modify: `src/renderer/lib/extract/table.ts` (placeGridCells)
- Modify: `src/renderer/lib/extract/image-fit.ts` (BMP)
- Test: `src/renderer/lib/extract/__tests__/{xml,table,image-fit}.test.ts`

**Interfaces:**
- Produces:
  - `prefixedAttr(el: Element, name: string): string | null` — 접두사가 **있는** 속성 중 로컬명이 일치하는 것
  - `interface GridCell { row: number; col: number; rowSpan: number; colSpan: number; text: string }`
  - `placeGridCells(cells: GridCell[], rowCount: number, colCount: number): string[][]`
  - `probeImage` 가 `{ mimeType: 'image/bmp', width, height }` 도 돌려준다(`ImageProbe.mimeType: SourceMime`)
  - `type SourceMime = FittedMime | 'image/bmp'`

**배경:** ① PPTX 의 `<p:sldId id="256" r:id="rId2"/>` 는 `id` 와 `r:id` 를 함께 가진다. `attr(el,'id')` 는 먼저 나오는 쪽을 준다(xml.ts:67-69 주석이 예고한 충돌). ② HWPX 는 병합으로 가려진 칸이 XML 에 **없어서** 셀을 `cellAddr` 좌표로 놓아야 한다. DOCX 의 격자 로직(`tableRows`)은 Word 전용 속성(gridSpan/vMerge)을 읽는 private 함수라 재사용할 수 없다 — 좌표 기반 배치를 `table.ts` 로 둔다. ③ HWPX 본문 그림 4개 중 3개가 BMP 인데 `probeImage` 는 PNG/JPEG 외에 null 이라 전부 조용히 버려진다. Claude·OpenAI Vision 은 BMP 를 받지 않으므로 **항상 재인코딩**한다.

- [ ] **Step 1: prefixedAttr 실패 테스트** (`xml.test.ts`)

```ts
describe('prefixedAttr', () => {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const el = (xml: string) => parseXml(xml).documentElement;

  it('id 와 r:id 가 함께 있으면 접두사 쪽을 준다 — 속성 순서와 무관하게', () => {
    expect(prefixedAttr(el(`<sldId xmlns:r="${R}" id="256" r:id="rId7"/>`), 'id')).toBe('rId7');
    expect(prefixedAttr(el(`<sldId xmlns:r="${R}" r:id="rId7" id="256"/>`), 'id')).toBe('rId7');
  });

  it('접두사 속성이 없으면 null (무접두 속성으로 폴백하지 않는다)', () => {
    expect(prefixedAttr(el('<sldId id="256"/>'), 'id')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/xml.test.ts` → FAIL `prefixedAttr is not exported`

- [ ] **Step 3: 구현** (`xml.ts` 끝에 추가)

```ts
/**
 * 접두사가 **붙은** 속성 중 로컬명이 일치하는 것. 무접두 동명 속성은 보지 않는다.
 *
 * attr() 는 로컬명만 보므로 같은 로컬명의 속성이 둘이면 먼저 나오는 쪽을 준다. PPTX 의
 * `<p:sldId id="256" r:id="rId2"/>` 가 그 경우다 — 슬라이드 순서를 정하는 값이 r:id 인데
 * id(숫자)를 받으면 rels 조회가 전부 실패해 슬라이드가 0장이 된다(조용히). 판정은 attr() 와
 * 같은 이유로 a.name 문자열로 한다(happy-dom 은 속성 네임스페이스를 분해하지 않는다).
 */
export function prefixedAttr(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) {
    const i = a.name.indexOf(':');
    if (i > 0 && a.name.slice(i + 1) === name && a.name.slice(0, i) !== 'xmlns') return a.value;
  }
  return null;
}
```

- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS

- [ ] **Step 5: placeGridCells 실패 테스트** (`table.test.ts`)

```ts
describe('placeGridCells — 좌표로 놓는 격자(HWPX: 가려진 칸이 XML 에 없다)', () => {
  const c = (row: number, col: number, text: string, rowSpan = 1, colSpan = 1) => ({ row, col, rowSpan, colSpan, text });

  it('가로 병합은 첫 칸에 텍스트, 나머지는 빈 칸', () => {
    expect(placeGridCells([c(0, 0, 'H', 1, 2), c(1, 0, 'a'), c(1, 1, 'b')], 2, 2))
      .toEqual([['H', ''], ['a', 'b']]);
  });

  it('세로 병합은 아래 칸에 텍스트를 복사한다(분류 열이 행마다 남게 — DOCX vMerge 와 같은 규칙)', () => {
    expect(placeGridCells([c(0, 0, '분류', 2), c(0, 1, 'x'), c(1, 1, 'y')], 2, 2))
      .toEqual([['분류', 'x'], ['분류', 'y']]);
  });

  it('입력 순서와 무관하게 좌표로 놓는다', () => {
    expect(placeGridCells([c(1, 1, 'd'), c(0, 0, 'a'), c(1, 0, 'c'), c(0, 1, 'b')], 2, 2))
      .toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('범위를 벗어난 좌표·스팬은 잘라내고, 겹치면 먼저 놓인 칸을 유지한다', () => {
    expect(placeGridCells([c(0, 0, 'a', 1, 99), c(0, 1, 'z'), c(5, 5, 'out')], 1, 2))
      .toEqual([['a', '']]);
  });

  it('비어 있는 칸은 빈 문자열, 행·열 수는 MAX_TABLE_COLUMNS 로 제한', () => {
    expect(placeGridCells([], 1, 3)).toEqual([['', '', '']]);
    expect(placeGridCells([], 1, 1e9)[0]!.length).toBe(256);
  });
});
```

- [ ] **Step 6: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/table.test.ts` → FAIL

- [ ] **Step 7: 구현** (`table.ts` 에 추가 — `MAX_TABLE_COLUMNS` 는 docx.ts 에서 import 하면 순환이 되므로 값을 옮기지 말고 `table.ts` 에 `export const MAX_GRID_CELLS_PER_AXIS = 256;` 을 두고, docx.ts 의 `MAX_TABLE_COLUMNS` 를 `export const MAX_TABLE_COLUMNS = MAX_GRID_CELLS_PER_AXIS;` 로 바꿔 한 출처로 만든다)

```ts
/** 격자 한 축의 칸 상한 — 파일이 주는 정수(rowCnt/colCnt/span)가 배열 길이가 되므로 병리 값을 자른다. */
export const MAX_GRID_CELLS_PER_AXIS = 256;

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
}

/**
 * 좌표·스팬이 명시된 셀들을 rowCount×colCount 격자에 놓는다(P4, HWPX).
 *
 * HWPX 는 병합으로 가려진 칸을 XML 에 **쓰지 않는다**(HTML 과 같다) — 셀을 나온 순서대로 늘어놓으면
 * 병합 뒤 칸이 전부 왼쪽으로 밀린다(DOCX 에서 QA34 High 였던 결함과 같은 모양). 실물 28개 표가
 * 전부 이 규칙으로 빈틈·겹침 없이 채워졌다.
 *
 * 규칙은 DOCX(docx.ts tableRows)와 같다: 가로 병합은 첫 칸에만 텍스트, 세로 병합은 아래 칸에 복사
 * (분류 열이 행마다 남아야 "어느 값이 무엇의 값인지" 가 GFM 표에서 유지된다). 겹치면 먼저 놓인
 * 칸이 이긴다 — 손상 파일에서 뒤 셀이 앞 셀을 덮어 내용이 사라지지 않게.
 */
export function placeGridCells(cells: GridCell[], rowCount: number, colCount: number): string[][] {
  const rows = Math.max(0, Math.min(Math.floor(rowCount) || 0, MAX_GRID_CELLS_PER_AXIS));
  const cols = Math.max(0, Math.min(Math.floor(colCount) || 0, MAX_GRID_CELLS_PER_AXIS));
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null));
  for (const cell of cells) {
    const r0 = Math.floor(cell.row);
    const c0 = Math.floor(cell.col);
    if (!(r0 >= 0 && r0 < rows && c0 >= 0 && c0 < cols)) continue;
    if (grid[r0]![c0] !== null) continue;
    const r1 = Math.min(rows, r0 + Math.max(1, Math.floor(cell.rowSpan) || 1));
    const c1 = Math.min(cols, c0 + Math.max(1, Math.floor(cell.colSpan) || 1));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (grid[r]![c] !== null) continue;
        grid[r]![c] = c === c0 ? cell.text : '';
      }
    }
  }
  return grid.map((row) => row.map((v) => v ?? ''));
}
```

- [ ] **Step 8: 통과 확인** — 같은 명령 → PASS. 이어서 `npx vitest run src/renderer/lib/extract/__tests__/docx.test.ts` → PASS(상수 출처 변경 회귀 없음)

- [ ] **Step 9: BMP 실패 테스트** (`image-fit.test.ts` — 파일의 기존 `stubCodec` 헬퍼 사용)

```ts
/** 최소 BMP 헤더: 'BM' + 파일 헤더 14바이트 + BITMAPINFOHEADER 의 너비(18)·높이(22) int32 LE. */
function bmpHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(54);
  b[0] = 0x42; b[1] = 0x4d;
  const v = new DataView(b.buffer);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);
  return b;
}

describe('BMP (P4 — HWPX 본문 그림의 다수)', () => {
  it('헤더에서 크기를 읽는다 — 높이가 음수(top-down)여도 절댓값', () => {
    expect(probeImage(bmpHeader(300, -200))).toEqual({ mimeType: 'image/bmp', width: 300, height: 200 });
  });

  it('작아서 줄일 필요가 없어도 **항상** PNG/JPEG 로 재인코딩한다 — Vision API 가 BMP 를 받지 않는다', async () => {
    const calls: unknown[] = [];
    const codec = { async reencode(_b: Uint8Array, mime: string, target: unknown) { calls.push([mime, target]); return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' as const }; } };
    const out = await createImageFitter(codec)(bmpHeader(300, 200));
    expect(calls).toEqual([['image/bmp', { width: 300, height: 200 }]]);
    expect(out?.mimeType).toBe('image/jpeg');
  });

  it('50px 미만 BMP 는 디코드 없이 건너뛴다', async () => {
    const codec = { reencode: vi.fn() };
    expect(await createImageFitter(codec)(bmpHeader(40, 40))).toBeNull();
    expect(codec.reencode).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/image-fit.test.ts` → FAIL (probe null)

- [ ] **Step 11: 구현** (`image-fit.ts`)

타입:

```ts
export type FittedMime = 'image/png' | 'image/jpeg';
/** 디코드는 되지만 Vision 으로 그대로 보낼 수 없는 원본 형식 — 항상 재인코딩한다. */
export type SourceMime = FittedMime | 'image/bmp';

export interface ImageProbe {
  mimeType: SourceMime;
  width: number;
  height: number;
}
```

`ImageCodec.reencode` 의 두 번째 매개변수 타입을 `mimeType: SourceMime` 으로 바꾼다. `probeImage` 의 JPEG 분기 뒤, `return null` 앞에 추가:

```ts
  // BMP: 'BM' + BITMAPFILEHEADER(14) 뒤 BITMAPINFOHEADER 의 너비·높이(int32 LE). 높이가 음수면
  // top-down 저장이라는 뜻일 뿐 크기는 절댓값이다. OS/2 식 12바이트 헤더(BITMAPCOREHEADER)는
  // 실물에 없고 드물어 받지 않는다(헤더 크기 40 이상만).
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getUint32(14, true) < 40) return null;
    return { mimeType: 'image/bmp', width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) };
  }
```

`createImageFitter` 의 재인코딩 호출을 다음으로 바꾼다:

```ts
    // BMP 는 줄일 필요가 없어도 제 크기로 재인코딩한다 — Vision API(Claude·OpenAI)가 받지 않는다.
    const target = downscaleTarget(width, height) ?? (mimeType === 'image/bmp' ? { width, height } : null);
    let out: Awaited<ReturnType<ImageCodec['reencode']>>;
    try {
      out = await codec.reencode(bytes, mimeType, target);
    } catch {
      out = null;
    }
```

`canvasCodec.reencode` 의 `if (!target) return { bytes, mimeType };` 는 그대로 둔다 — BMP 는 위에서 target 이 항상 있으므로 이 분기에 오지 않는다. 다만 타입이 `SourceMime` 이 됐으므로 그 줄을 `if (!target) return mimeType === 'image/bmp' ? null : { bytes, mimeType };` 로 바꿔 BMP 원본이 새어 나갈 경로를 타입과 함께 닫는다.

- [ ] **Step 12: 통과 확인 + 비공허 증명 + 커밋**

Run: `npx vitest run src/renderer/lib/extract` → PASS. 뮤테이션: ① `prefixedAttr` 의 `i > 0 &&` 삭제 ② `placeGridCells` 의 `if (grid[r0]![c0] !== null) continue;` 삭제 ③ BMP target 폴백(`?? (mimeType === 'image/bmp' …)`) 삭제 — 각각 실패 요약 줄을 기록하고 원복.

```bash
npx tsc --noEmit
git add src/renderer/lib/extract
git commit -m "feat(extract): 네임스페이스 속성 · 좌표 격자 표 · BMP 재인코딩 (P4 공용 부품)

<배경 3줄 요약 + 뮤테이션 실패 요약>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 지원 형식 문구를 목록에서 도출한다

**Files:**
- Modify: `src/shared/document-formats.ts` (`SUPPORTED_LABEL`)
- Modify: `src/renderer/lib/i18n.ts:142` (`uploader.notPdf`), `:523` (`mainerr.fileUnsupported`)
- Modify: `src/renderer/App.tsx:313, 343` (`uploader.notPdf` 호출부)
- Modify: `src/main/index.ts:1727, 1770` (fileUnsupported 반환)
- Modify: `src/renderer/lib/document-open.ts:17` (SUPPORTED_LABEL 을 shared 에서 import)
- Test: `src/shared/__tests__/document-formats.test.ts`, `src/renderer/__tests__/App.drop.test.tsx`, `src/renderer/lib/__tests__/i18n.test.ts`

**Interfaces:**
- Produces: `SUPPORTED_LABEL: string` (document-formats.ts) — 라벨을 `' · '` 로 이은 값. 예: `'PDF · Word'`

**배경:** "PDF · Word 파일만 지원됩니다" 가 i18n 두 키와 main 의 한국어 폴백 두 곳에 **하드코딩**돼 있다. Task 5·8 에서 포맷을 등록하는 순간 이 문구가 틀린다 — 형제 누락의 전형. 목록에서 도출해 포맷 등록만으로 따라오게 한다.

- [ ] **Step 1: 실패 테스트**

`document-formats.test.ts`:

```ts
it('SUPPORTED_LABEL 은 등록된 포맷 라벨을 순서대로 잇는다', () => {
  expect(SUPPORTED_LABEL).toBe(SUPPORTED_FORMATS.map((f) => f.label).join(' · '));
});
```

`App.drop.test.tsx` 의 xlsx 거부 테스트 단언을 `t('uploader.notPdf', { list: SUPPORTED_LABEL })` 로 바꾸고, 사전 값에 `{list}` 가 들어 있는지도 단언한다:

```ts
it('지원하지 않는 형식 안내는 지원 목록을 문구에 도출한다 (P4 — 포맷이 늘면 자동으로 따라옴)', async () => {
  const { _translations } = await import('../lib/i18n');
  const entry = (_translations as Record<string, { ko: string; en: string }>)['uploader.notPdf']!;
  expect(entry.ko).toContain('{list}');
  expect(entry.en).toContain('{list}');
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/shared/__tests__/document-formats.test.ts src/renderer/__tests__/App.drop.test.tsx` → FAIL

- [ ] **Step 3: 구현**

`document-formats.ts` 의 `SUPPORTED_EXTENSIONS` 아래에:

```ts
/**
 * 사용자 안내용 지원 형식 목록("PDF · Word"). i18n 문구가 `{list}` 로 받는다 — 문구에 형식을
 * 하드코딩하면 포맷을 등록할 때마다 틀려진다(P4 이전 네 곳이 "PDF · Word" 로 박혀 있었다).
 */
export const SUPPORTED_LABEL = SUPPORTED_FORMATS.map((f) => f.label).join(' · ');
```

`document-open.ts:17` 의 로컬 정의를 지우고 `import { …, SUPPORTED_LABEL } from '../../shared/document-formats';` 로 바꾼다.

`i18n.ts`:

```ts
  'uploader.notPdf': { ko: '{list} 파일만 지원됩니다.', en: 'Only these file types are supported: {list}.' },
```

```ts
  'mainerr.fileUnsupported': { ko: '{list} 파일만 열 수 있습니다.', en: 'Only these file types can be opened: {list}.' },
```

`App.tsx` 의 두 `t('uploader.notPdf')` 를 `t('uploader.notPdf', { list: SUPPORTED_LABEL })` 로. `src/main/index.ts` 의 두 반환을:

```ts
        return { error: `${SUPPORTED_LABEL} 파일만 열 수 있습니다.`, errorKey: 'fileUnsupported', errorParams: { list: SUPPORTED_LABEL } };
```

(`SUPPORTED_LABEL` import 추가. preload 타입(src/preload/index.ts:188-189)의 에러 객체에 `errorParams?: Record<string, string>` 를 추가. `translateMainError` 는 이미 errorParams 를 받는다.)

- [ ] **Step 4: 통과 확인 + i18n 계약 가드** — Run: `npx vitest run src/shared src/renderer/__tests__ src/renderer/lib/__tests__/i18n.test.ts src/main` → PASS

- [ ] **Step 5: 비공허 증명 + 커밋** — 뮤테이션: `uploader.notPdf` ko 를 `'PDF · Word 파일만 지원됩니다.'` 로 되돌림 → 실패 요약 기록 후 원복.

```bash
npx tsc --noEmit
git add src
git commit -m "refactor(i18n): 지원 형식 안내를 SUPPORTED_FORMATS 에서 도출한다 (P4 선행)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: PPTX 추출기 — 슬라이드 순서 · 텍스트 · 노트 · 그림

**Files:**
- Modify: `src/shared/document-formats.ts` (pptx 등록, `PPTX_FORMAT_ID`)
- Modify: `src/renderer/lib/extract/types.ts:61` (id 에서 `'pptx'` 리터럴 제거)
- Create: `src/renderer/lib/extract/pptx-text.ts` (문단 텍스트화 · 그래픽 텍스트화 계약 — pptx.ts 와 Task 5 의 pptx-graphics.ts 가 **둘 다** 여기서 import 해 순환을 피한다)
- Create: `src/renderer/lib/extract/pptx.ts`
- Modify: `src/renderer/lib/extract/registry.ts`
- Test: `src/renderer/lib/extract/__tests__/pptx.test.ts`, `registry.test.ts`, `src/shared/__tests__/document-formats.test.ts`

**Interfaces:**
- Consumes: `prefixedAttr`(Task 2), `readRels(zip, partPath): Map<string,string>`(ooxml.ts), `fitImage`/`ImageFitter`(image-fit.ts), `extractFail`, `MAX_PAGE_COUNT`/`MAX_TOTAL_IMAGES`/`MAX_EXAMINED_IMAGES`(pdf-parser.ts)
- Produces:
  - `PPTX_FORMAT_ID = 'pptx'` (document-formats.ts)
  - `textBodyText(txBody: Element): string`, `skipNonText(el: Element): boolean` (pptx-text.ts)
  - `interface PptxGraphicsText { table(tbl: Element): string; chart(frame: Element, slidePart: string, zip: ZipIndex): string; smartArt(frame: Element, slidePart: string, zip: ZipIndex): string }`, `basicGraphics: PptxGraphicsText` (pptx-text.ts) — Task 5 가 `pptxGraphics` 로 교체한다
  - `createPptxExtractor(deps?: { fitImage?: ImageFitter; graphics?: PptxGraphicsText }): Extractor`, `pptxExtractor: Extractor` (pptx.ts)

**배경:** 위 "실물 조사 — PPTX" 전부. 규칙 요약:
1. 순서 = `presentation.xml` 루트의 **직계** `sldIdLst` → `sldId` 의 `r:id`(**prefixedAttr**) → rels. 파일명·rId 정렬 금지.
2. 숨김 슬라이드(`p:sld/@show="0"`)도 **포함**한다 — 번호가 PowerPoint 의 슬라이드 번호와 맞아야 인용 "슬라이드 7" 이 사용자가 보는 7번과 같다.
3. spTree 를 깊이 우선으로(그룹 재귀) 돈다. `sldNum`/`dt`/`ftr`/`hdr` 자리표시자는 통째로 버린다. `a:fld` 중 `type` 이 `slidenum` 이거나 `datetime` 으로 시작하는 것도 버린다. `mc:AlternateContent` 는 `Choice` 만.
4. 제목(`title`/`ctrTitle` 자리표시자)을 단위 맨 앞에, 나머지는 spTree 순서. 제목이 있으면 `ExtractedHeading{level:1}`.
5. 문단(`a:p`)마다 한 줄, `a:br`→`\n`, `a:tab`→`\t`.
6. 노트: 슬라이드 rels 중 `notesSlides/notesSlideN.xml` 로 가는 것 → 그 안의 `ph type="body"` 텍스트만. 비었으면 생략. 단위 끝에 인용부(`> `)로 붙인다 — 뷰어에서 본문과 구분되고 모델도 "부가 설명" 으로 읽는다.
7. 레이아웃·마스터는 **읽지 않는다.**
8. 그림: `p:pic` 의 `a:blip/@r:embed` 만(확장 `svgBlip`·`wdp` 는 `a:extLst` 아래라 extLst 를 건너뛰면 자연히 빠진다). 경로로 중복 제거 — 같은 그림이 여러 장에 재사용되면 **처음 나온 슬라이드**에만. EMF/WMF 는 `fitImage` 가 null 을 돌려 건너뛴다.
9. 슬라이드 하나 = 단위 하나. **빈 슬라이드도 빈 단위로 둔다**(번호가 밀리면 모든 인용이 어긋난다). 전부 비면 `DOC_NO_TEXT`. 500 초과면 `PDF_TOO_MANY_PAGES`. `unitKind: 'slide'`.

- [ ] **Step 1: 포맷 등록 — 실패 테스트**

`document-formats.test.ts` 의 목록 고정 단언을 `['pdf','docx','pptx']` / `['.pdf','.docx','.pptx']` 로 바꾼다. `registry.test.ts` 의 `ZIP_EXTRACTORS` 단언을 `[docxExtractor, pptxExtractor]` 로 바꾸고 sniff 테스트를 추가한다:

```ts
it('ppt/presentation.xml 이 있으면 pptx 추출기를 고른다', () => {
  expect(resolveExtractor(zipIndexOf({ 'ppt/presentation.xml': '<p:presentation/>' }))?.id).toBe(PPTX_FORMAT_ID);
});
```

(`zipIndexOf` 는 registry.test.ts 의 기존 헬퍼가 ArrayBuffer 를 주므로 `openZip(zipOf(...))` 로 감싼다 — 파일의 기존 패턴을 따른다.)

- [ ] **Step 2: 추출기 동작 — 실패 테스트** (`pptx.test.ts`, 전체)

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { createPptxExtractor } from '../pptx';
import { createImageFitter, type ImageCodec } from '../image-fit';
import type { ZipIndex } from '../types';

const NS = 'xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r" xmlns:mc="urn:mc"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function zipOf(files: Record<string, string | Uint8Array>): ZipIndex {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? strToU8(v) : v;
  const u8 = zipSync(entries);
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}

/** 슬라이드 파일 이름 배열(표시 순서) → presentation.xml + rels. rId 는 순서와 무관하게 거꾸로 준다. */
function deck(slides: Record<string, string>, order: string[], extra: Record<string, string | Uint8Array> = {}) {
  const ids = order.map((_, i) => `rId${100 - i}`);
  const pres = `<p:presentation ${NS}><p:sldIdLst>${order.map((_, i) => `<p:sldId id="${256 + i}" r:id="${ids[i]}"/>`).join('')}</p:sldIdLst>`
    + `<p:extLst><p:ext><p14:sectionLst xmlns:p14="urn:p14"><p14:section><p14:sldIdLst><p14:sldId id="999"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>`;
  const rels = `<Relationships ${REL}>${order.map((f, i) => `<Relationship Id="${ids[i]}" Type="x/slide" Target="slides/${f}"/>`).join('')}</Relationships>`;
  const files: Record<string, string | Uint8Array> = { 'ppt/presentation.xml': pres, 'ppt/_rels/presentation.xml.rels': rels, ...extra };
  for (const [f, xml] of Object.entries(slides)) files[`ppt/slides/${f}`] = xml;
  return zipOf(files);
}

const sp = (text: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>`
  + `<p:txBody>${text.split('\n').map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
const slide = (inner: string, attrs = '') => `<p:sld ${NS} ${attrs}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;

const pptx = createPptxExtractor();
const run = (zip: ZipIndex) => pptx.extract(zip, { extractImages: false });

describe('pptx — 슬라이드 순서', () => {
  it('sldIdLst 순서를 따른다 — 파일 번호·rId 순서가 아니라', async () => {
    const zip = deck(
      { 'slide1.xml': slide(sp('첫 파일')), 'slide15.xml': slide(sp('열다섯째 파일')) },
      ['slide15.xml', 'slide1.xml'],
    );
    const doc = await run(zip);
    expect(doc.units).toEqual(['열다섯째 파일', '첫 파일']);
    expect(doc.unitKind).toBe('slide');
  });

  it('p14 확장의 두 번째 sldIdLst 는 무시한다', async () => {
    const doc = await run(deck({ 'slide1.xml': slide(sp('a')) }, ['slide1.xml']));
    expect(doc.units).toHaveLength(1);
  });

  it('숨김 슬라이드도 포함한다 — 번호가 PowerPoint 의 슬라이드 번호와 맞아야 한다', async () => {
    const doc = await run(deck(
      { 's1.xml': slide(sp('보임')), 's2.xml': slide(sp('숨김'), 'show="0"'), 's3.xml': slide(sp('셋째')) },
      ['s1.xml', 's2.xml', 's3.xml'],
    ));
    expect(doc.units).toEqual(['보임', '숨김', '셋째']);
  });

  it('빈 슬라이드는 빈 단위로 남는다 — 뒤 슬라이드 번호가 밀리지 않게', async () => {
    const doc = await run(deck(
      { 's1.xml': slide(sp('하나')), 's2.xml': slide(''), 's3.xml': slide(sp('셋')) },
      ['s1.xml', 's2.xml', 's3.xml'],
    ));
    expect(doc.units).toEqual(['하나', '', '셋']);
  });
});

describe('pptx — 텍스트', () => {
  it('그룹 안 텍스트를 깊이 우선으로 모은다', async () => {
    const grp = (inner: string) => `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr/>${inner}</p:grpSp>`;
    const doc = await run(deck({ 's.xml': slide(sp('밖') + grp(sp('안1') + grp(sp('안2')))) }, ['s.xml']));
    expect(doc.units[0]).toBe('밖\n\n안1\n\n안2');
  });

  it('제목 자리표시자를 맨 앞에 두고 제목으로 보고한다 — spTree 에서 뒤에 있어도', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('본문') + sp('슬라이드 제목', 'title')) }, ['s.xml']));
    expect(doc.units[0]).toBe('슬라이드 제목\n\n본문');
    expect(doc.headings).toEqual([{ level: 1, title: '슬라이드 제목', unitIndex: 0 }]);
  });

  it('제목 자리표시자가 없으면 제목을 추측하지 않는다', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('큰 글씨 텍스트 상자')) }, ['s.xml']));
    expect(doc.headings).toEqual([]);
  });

  it('슬라이드 번호·날짜·바닥글 자리표시자와 번호 필드는 버린다 — Google 의 ‹#› 포함', async () => {
    const fld = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>`
      + `<p:txBody><a:p><a:fld type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const inlineFld = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + `<p:txBody><a:p><a:r><a:t>본문 </a:t></a:r><a:fld type="datetime1"><a:t>2026-09-28</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(fld + inlineFld + sp('꼬리', 'ftr')) }, ['s.xml']));
    expect(doc.units[0]).toBe('본문');
  });

  it('a:br 은 줄바꿈, a:tab 은 탭, 엔티티는 풀린다', async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody>`
      + `<a:p><a:r><a:t>A&amp;B</a:t></a:r><a:br/><a:r><a:t>둘째</a:t></a:r><a:tab/><a:r><a:t>탭뒤</a:t></a:r></a:p><a:p><a:r><a:t/></a:r></a:p></p:txBody></p:sp>`;
    const doc = await run(deck({ 's.xml': slide(body) }, ['s.xml']));
    expect(doc.units[0]).toBe('A&B\n둘째\t탭뒤');
  });

  it('mc:AlternateContent 는 Choice 만 읽는다 — Fallback 까지 읽으면 두 번 들어간다', async () => {
    const alt = `<mc:AlternateContent><mc:Choice Requires="p14">${sp('한 번')}</mc:Choice><mc:Fallback>${sp('한 번')}</mc:Fallback></mc:AlternateContent>`;
    const doc = await run(deck({ 's.xml': slide(alt) }, ['s.xml']));
    expect(doc.units[0]).toBe('한 번');
  });

  it('레이아웃·마스터의 안내문은 읽지 않는다', async () => {
    const doc = await run(deck({ 's.xml': slide(sp('본문')) }, ['s.xml'], {
      'ppt/slideLayouts/slideLayout1.xml': slide(sp('마스터 제목 스타일 편집', 'title')),
    }));
    expect(doc.units[0]).toBe('본문');
  });
});

describe('pptx — 발표자 노트', () => {
  const notes = (body: string) => `<p:notes ${NS}><p:cSld><p:spTree>${sp('슬라이드 이미지', 'sldImg')}${sp(body, 'body')}${sp('3', 'sldNum')}</p:spTree></p:cSld></p:notes>`;
  const slideRels = `<Relationships ${REL}><Relationship Id="rId9" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`;

  it('노트 본문을 슬라이드 단위 끝에 인용부로 붙인다', async () => {
    const doc = await run(deck({ 's1.xml': slide(sp('본문')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': slideRels,
      'ppt/notesSlides/notesSlide1.xml': notes('근거 수치는 부록 참조\n둘째 줄'),
    }));
    expect(doc.units[0]).toBe('본문\n\n> 근거 수치는 부록 참조\n> 둘째 줄');
  });

  it('빈 노트는 붙이지 않는다', async () => {
    const doc = await run(deck({ 's1.xml': slide(sp('본문')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': slideRels,
      'ppt/notesSlides/notesSlide1.xml': notes(' '),
    }));
    expect(doc.units[0]).toBe('본문');
  });
});

describe('pptx — 그림', () => {
  function pngHeader(w: number, h: number): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  }
  const passThrough: ImageCodec = { async reencode(bytes, mimeType) { return { bytes, mimeType: mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' }; } };
  const pptxImg = createPptxExtractor({ fitImage: createImageFitter(passThrough) });
  const pic = (rid: string) => `<p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="${rid}"><a:extLst><a:ext><asvg:svgBlip xmlns:asvg="urn:asvg" r:embed="rIdSvg"/></a:ext></a:extLst></a:blip></p:blipFill></p:pic>`;
  const rels = (target: string) => `<Relationships ${REL}><Relationship Id="rIdP" Type="x/image" Target="${target}"/><Relationship Id="rIdSvg" Type="x/image" Target="../media/image9.svg"/></Relationships>`;

  it('slide 의 blip 을 그 슬라이드 단위에 매핑하고, svg 확장은 세지 않는다', async () => {
    const doc = await pptxImg.extract(deck(
      { 's1.xml': slide(sp('a')), 's2.xml': slide(sp('b') + pic('rIdP')) },
      ['s1.xml', 's2.xml'],
      { 'ppt/slides/_rels/s2.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': pngHeader(200, 100), 'ppt/media/image9.svg': '<svg/>' },
    ), { extractImages: true });
    expect(doc.images.map((i) => i.unitIndex)).toEqual([1]);
  });

  it('여러 슬라이드에 재사용된 그림은 처음 나온 슬라이드에만', async () => {
    const doc = await pptxImg.extract(deck(
      { 's1.xml': slide(pic('rIdP')), 's2.xml': slide(pic('rIdP')) },
      ['s1.xml', 's2.xml'],
      {
        'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'),
        'ppt/slides/_rels/s2.xml.rels': rels('../media/image1.png'),
        'ppt/media/image1.png': pngHeader(200, 100),
      },
    ), { extractImages: true });
    expect(doc.images.map((i) => i.unitIndex)).toEqual([0]);
  });

  it('extractImages=false 면 그림을 모으지 않는다', async () => {
    const doc = await pptxImg.extract(deck({ 's1.xml': slide(sp('a') + pic('rIdP')) }, ['s1.xml'], {
      'ppt/slides/_rels/s1.xml.rels': rels('../media/image1.png'), 'ppt/media/image1.png': pngHeader(200, 100),
    }), { extractImages: false });
    expect(doc.images).toEqual([]);
  });
});

describe('pptx — 실패 계약', () => {
  it('모든 슬라이드가 비면 DOC_NO_TEXT', async () => {
    await expect(run(deck({ 's.xml': slide('') }, ['s.xml']))).rejects.toMatchObject({ code: 'DOC_NO_TEXT' });
  });

  it('presentation.xml 이 깨지면 DOC_CORRUPT', async () => {
    await expect(run(zipOf({ 'ppt/presentation.xml': '<p:presentation' }))).rejects.toMatchObject({ code: 'DOC_CORRUPT' });
  });

  it('sldIdLst 가 가리키는 슬라이드가 없으면 그 자리를 빈 단위로 둔다(번호 유지)', async () => {
    const doc = await run(deck({ 's1.xml': slide(sp('있음')) }, ['s1.xml', 'missing.xml']));
    expect(doc.units).toEqual(['있음', '']);
  });

  it('501장이면 PDF_TOO_MANY_PAGES(pages/max 동봉)', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `s${i}.xml`);
    const slides = Object.fromEntries(names.map((n) => [n, slide(sp('x'))]));
    await expect(run(deck(slides, names))).rejects.toMatchObject({ code: 'PDF_TOO_MANY_PAGES', params: { pages: '501', max: '500' } });
  });

  it('중간에 취소하면 ABORTED', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `s${i}.xml`);
    const slides = Object.fromEntries(names.map((n) => [n, slide(sp('x'))]));
    const ac = new AbortController();
    const p = pptx.extract(deck(slides, names), { extractImages: false, signal: ac.signal, onProgress: () => ac.abort() });
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
```

- [ ] **Step 3: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/pptx.test.ts src/renderer/lib/extract/__tests__/registry.test.ts src/shared/__tests__/document-formats.test.ts` → FAIL `Failed to resolve import "../pptx"`

- [ ] **Step 4: 포맷 등록**

`document-formats.ts`:

```ts
export const SUPPORTED_FORMATS: readonly DocumentFormat[] = [
  { id: 'pdf', ext: '.pdf', label: 'PDF', container: 'pdf' },
  { id: 'docx', ext: '.docx', label: 'Word', container: 'zip' },
  { id: 'pptx', ext: '.pptx', label: 'PowerPoint', container: 'zip' },
] as const;
```

`DOCX_FORMAT_ID` 아래:

```ts
export const PPTX_FORMAT_ID = 'pptx' as const satisfies DocumentFormat['id'];
```

`extract/types.ts:61` 을 `id: NonPdfFormatId | 'hwpx' | 'epub';` 로 바꾸고 위 주석의 "pptx/hwpx/epub" 를 "hwpx/epub" 로 고친다.

- [ ] **Step 5: 텍스트 계약 구현** (`src/renderer/lib/extract/pptx-text.ts`, 전체)

```ts
import { walk, localName, attr, childrenNamed } from './xml';
import { toGfmTable } from './table';
import type { ZipIndex } from './types';

/**
 * PPTX 텍스트화 공용부 — 추출기(pptx.ts)와 그래픽 텍스트화(pptx-graphics.ts, Task 5)가 함께 쓴다.
 * 두 파일이 서로 import 하면 순환이 되므로 여기에 둔다.
 */

/** 텍스트 순회에서 통째로 건너뛰는 서브트리 — Fallback(Choice 와 중복), extLst(svgBlip·a14 확장), 번호·날짜 필드. */
export function skipNonText(el: Element): boolean {
  const name = localName(el);
  if (name === 'Fallback' || name === 'extLst') return true;
  if (name === 'fld') {
    const type = attr(el, 'type') ?? '';
    return type === 'slidenum' || type.startsWith('datetime');
  }
  return false;
}

/** `p:txBody`(또는 `a:txBody`) → 문단마다 한 줄. 빈 문단은 뺀다. */
export function textBodyText(txBody: Element): string {
  const lines: string[] = [];
  for (const p of childrenNamed(txBody, 'p')) {
    let line = '';
    for (const el of walk(p, (e) => e !== p && skipNonText(e))) {
      switch (localName(el)) {
        case 't': line += el.textContent ?? ''; break;
        case 'br': line += '\n'; break;
        case 'tab': line += '\t'; break;
      }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/** 표·차트·SmartArt 의 텍스트화 — Task 5 가 차트·SmartArt·병합 표를 채운다. */
export interface PptxGraphicsText {
  table(tbl: Element): string;
  chart(frame: Element, slidePart: string, zip: ZipIndex): string;
  smartArt(frame: Element, slidePart: string, zip: ZipIndex): string;
}

/** Task 4 기본값: 표는 행마다 셀(병합 미고려), 차트·SmartArt 는 빈 문자열. Task 5 가 교체한다. */
export const basicGraphics: PptxGraphicsText = {
  table(tbl) {
    const rows = childrenNamed(tbl, 'tr').map((tr) =>
      childrenNamed(tr, 'tc').map((tc) => {
        const body = childrenNamed(tc, 'txBody')[0];
        return body ? textBodyText(body) : '';
      }));
    return toGfmTable(rows);
  },
  chart: () => '',
  smartArt: () => '',
};
```

- [ ] **Step 6: 추출기 구현** (`src/renderer/lib/extract/pptx.ts`, 전체)

```ts
import { parseXml, walk, localName, attr, childrenNamed, prefixedAttr } from './xml';
import { readRels } from './ooxml';
import { textBodyText, skipNonText, basicGraphics, type PptxGraphicsText } from './pptx-text';
import { MAX_EXAMINED_IMAGES, MAX_PAGE_COUNT, MAX_TOTAL_IMAGES } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractedImage, ExtractOptions, ZipIndex } from './types';
import { PPTX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';

const PRESENTATION_PART = 'ppt/presentation.xml';

/** 그룹 중첩 상한 — 병리적 중첩에서 재귀가 스택을 넘기지 않게(실물 최대 2단계). */
const MAX_GROUP_DEPTH = 32;

/** 이만큼 슬라이드를 처리할 때마다 이벤트 루프에 양보한다(docx.ts YIELD_EVERY 와 같은 이유 — 취소가 닿게). */
const YIELD_EVERY_SLIDES = 20;

/**
 * 본문이 아닌 자리표시자. 슬라이드 번호(`sldNum`)는 PowerPoint 가 숫자, Google Slides 가 `‹#›` 를
 * 캐시해 두어, 거르지 않으면 **모든 단위**에 번호가 샌다(실물 24개 덱 전부에 있었다).
 */
const NON_BODY_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `mc:AlternateContent` 를 Choice 쪽 자식으로 푼 자식 목록(순서 보존). */
function expandAlternate(children: ArrayLike<Element>): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(children)) {
    if (localName(el) === 'AlternateContent') {
      const choice = childrenNamed(el, 'Choice')[0];
      if (choice) out.push(...expandAlternate(choice.children));
    } else out.push(el);
  }
  return out;
}

function placeholderType(shape: Element): string | null {
  for (const el of walk(shape)) {
    if (localName(el) === 'txBody') return null; // ph 는 nvSpPr 안 — 본문까지 내려가지 않는다
    if (localName(el) === 'ph') return attr(el, 'type') ?? 'body';
  }
  return null;
}

interface SlideParts {
  titles: string[];
  rest: string[];
  blipRelIds: string[];
}

function visitShapes(
  container: Element, out: SlideParts, depth: number,
  ctx: { graphics: PptxGraphicsText; slidePart: string; zip: ZipIndex },
): void {
  for (const el of expandAlternate(container.children)) {
    switch (localName(el)) {
      case 'grpSp':
        if (depth < MAX_GROUP_DEPTH) visitShapes(el, out, depth + 1, ctx);
        break;
      case 'sp':
      case 'cxnSp': {
        const ph = placeholderType(el);
        if (ph && NON_BODY_PLACEHOLDERS.has(ph)) break;
        const body = childrenNamed(el, 'txBody')[0];
        const text = body ? textBodyText(body) : '';
        if (!text) break;
        (ph && TITLE_PLACEHOLDERS.has(ph) ? out.titles : out.rest).push(text);
        break;
      }
      case 'graphicFrame': {
        const data = [...walk(el)].find((e) => localName(e) === 'graphicData');
        const uri = data ? attr(data, 'uri') ?? '' : '';
        let text = '';
        if (uri.endsWith('/table')) {
          const tbl = [...walk(data!)].find((e) => localName(e) === 'tbl');
          if (tbl) text = ctx.graphics.table(tbl);
        } else if (uri.endsWith('/chart')) text = ctx.graphics.chart(el, ctx.slidePart, ctx.zip);
        else if (uri.endsWith('/diagram')) text = ctx.graphics.smartArt(el, ctx.slidePart, ctx.zip);
        if (text) out.rest.push(text);
        break;
      }
      case 'pic':
        for (const e of walk(el, skipNonText)) {
          if (localName(e) !== 'blip') continue;
          const relId = prefixedAttr(e, 'embed');
          if (relId) out.blipRelIds.push(relId);
        }
        break;
    }
  }
}

function spTreeOf(root: Element): Element | null {
  return [...walk(root)].find((e) => localName(e) === 'spTree') ?? null;
}

/** 슬라이드 rels 에서 발표자 노트 파트 → body 자리표시자 텍스트. */
function notesText(zip: ZipIndex, rels: Map<string, string>): string {
  const notesPart = [...rels.values()].find((p) => /(^|\/)notesSlides\/[^/]+\.xml$/i.test(p));
  const xml = notesPart ? zip.text(notesPart) : null;
  if (!xml) return '';
  const tree = spTreeOf(parseXml(xml).documentElement);
  if (!tree) return '';
  const parts: string[] = [];
  for (const el of walk(tree)) {
    if (localName(el) !== 'sp' || placeholderType(el) !== 'body') continue;
    const body = childrenNamed(el, 'txBody')[0];
    const text = body ? textBodyText(body) : '';
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n');
}

export interface PptxExtractorDeps {
  fitImage?: ImageFitter;
  graphics?: PptxGraphicsText;
}

export function createPptxExtractor(deps: PptxExtractorDeps = {}): Extractor {
  const fit = deps.fitImage ?? fitImage;
  const graphics = deps.graphics ?? basicGraphics;
  return {
    id: PPTX_FORMAT_ID,

    sniff: (zip) => zip.has(PRESENTATION_PART),

    extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      const presXml = zip.text(PRESENTATION_PART) ?? extractFail('DOC_CORRUPT', 'presentation.xml missing');
      const presRoot = parseXml(presXml).documentElement;
      // 루트 직계 sldIdLst 만 — p14 확장(sectionLst) 안의 두 번째 sldIdLst 는 순서 정보가 아니다.
      const list = childrenNamed(presRoot, 'sldIdLst')[0];
      const presRels = readRels(zip, PRESENTATION_PART);
      const slideParts = list
        ? childrenNamed(list, 'sldId').map((s) => presRels.get(prefixedAttr(s, 'id') ?? '') ?? null)
        : [];
      if (slideParts.length > MAX_PAGE_COUNT) {
        extractFail('PDF_TOO_MANY_PAGES', `slide count ${slideParts.length} exceeds ${MAX_PAGE_COUNT}`,
          { pages: String(slideParts.length), max: String(MAX_PAGE_COUNT) });
      }

      const units: string[] = [];
      const headings: ExtractedHeading[] = [];
      const imageAt: { path: string; unitIndex: number }[] = [];

      for (const [index, part] of slideParts.entries()) {
        if (index > 0 && index % YIELD_EVERY_SLIDES === 0) {
          await yieldToEventLoop();
          opts.onProgress?.(index, slideParts.length);
        }
        throwIfAborted(opts.signal);
        const xml = part ? zip.text(part) : null;
        // 가리키는 슬라이드가 없어도 자리를 비워 둔다 — 뒤 슬라이드 번호가 밀리면 인용이 전부 어긋난다.
        if (!part || !xml) { units.push(''); continue; }
        const tree = spTreeOf(parseXml(xml).documentElement);
        const out: SlideParts = { titles: [], rest: [], blipRelIds: [] };
        if (tree) visitShapes(tree, out, 0, { graphics, slidePart: part, zip });

        const rels = readRels(zip, part);
        const notes = notesText(zip, rels);
        const blocks = [...out.titles, ...out.rest];
        if (notes) blocks.push(notes.split('\n').map((l) => `> ${l}`).join('\n'));
        units.push(blocks.join('\n\n'));

        const title = out.titles[0]?.split('\n')[0]?.trim();
        if (title) headings.push({ level: 1, title, unitIndex: index });
        for (const relId of out.blipRelIds) {
          const path = rels.get(relId);
          if (path) imageAt.push({ path, unitIndex: index });
        }
      }
      opts.onProgress?.(slideParts.length, slideParts.length);

      if (!units.some((u) => u.trim())) extractFail('DOC_NO_TEXT', 'no text in presentation');

      const images: ExtractedImage[] = [];
      let imageBudgetExceeded = false;
      if (opts.extractImages !== false) {
        const seen = new Set<string>();
        let examined = 0;
        for (const { path, unitIndex } of imageAt) {
          throwIfAborted(opts.signal);
          if (examined >= MAX_EXAMINED_IMAGES) break;
          examined += 1;
          if (seen.has(path)) continue;
          const bytes = zip.bytes(path);
          if (!bytes) continue;
          seen.add(path);
          if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
          const fitted = await fit(bytes);
          if (fitted) images.push({ unitIndex, ...fitted });
        }
      }

      return {
        units,
        images,
        headings,
        unitKind: 'slide',
        ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
      };
    },
  };
}

export const pptxExtractor: Extractor = createPptxExtractor();
```

`registry.ts`:

```ts
import { docxExtractor } from './docx';
import { pptxExtractor } from './pptx';
…
export const ZIP_EXTRACTORS: readonly Extractor[] = [docxExtractor, pptxExtractor];
```

> ⚠️ 구현자 확인 사항: `readRels` 가 `r:id` 가 아니라 `Id` 속성을 읽는지(ooxml.ts), 그리고 slide rels 경로(`ppt/slides/_rels/s1.xml.rels`)를 파트 경로에서 올바로 만드는지 테스트가 증명한다. 노트 테스트가 실패하면 `readRels` 의 경로 계산부터 본다 — **테스트를 고치지 말 것.**

- [ ] **Step 7: 통과 확인** — Run: `npx vitest run src/renderer/lib/extract src/shared` → PASS

- [ ] **Step 8: 전체 + 소스 가드** — Run: `npx vitest run` → PASS. 특히 `source-scan.test.ts` 가 `'pptx'`·`'.pptx'` 리터럴을 document-formats.ts 밖에서 잡지 않는지(types.ts 수정 확인), `unit-kind-drift.test.ts` 통과.

- [ ] **Step 9: 비공허 증명** — 뮤테이션 네 개(각각 실패 요약 기록 후 원복):
1. `prefixedAttr(s, 'id')` → `attr(s, 'id')` (id="256" 을 읽어 슬라이드 0장 → DOC_NO_TEXT 또는 순서 테스트 실패)
2. `NON_BODY_PLACEHOLDERS` 에서 `'sldNum'` 제거
3. `case 'grpSp':` 분기 삭제
4. `if (!part || !xml) { units.push(''); continue; }` → `continue;` (빈 자리 유지 삭제)

- [ ] **Step 10: 커밋**

```bash
npx tsc --noEmit
git add src/shared src/renderer/lib/extract
git commit -m "feat(extract): PPTX 추출기 — 슬라이드 순서·그룹·노트·그림 (P4)

실물 24개(PowerPoint·Mac·Google Slides) 조사 규칙: sldIdLst 의 r:id(동명 id 와 구분) → rels 순서,
그룹 재귀, 슬라이드 번호 자리표시자·필드 제거(Google 의 ‹#›), 제목 자리표시자만 제목, 노트는
body 자리표시자만, 레이아웃·마스터 미독, 빈 슬라이드도 빈 단위(번호 유지), svg 확장 이중계산 방지.

<뮤테이션 실패 요약 네 줄>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: PPTX 표 병합 · 차트 · SmartArt

**Files:**
- Create: `src/renderer/lib/extract/pptx-graphics.ts`
- Modify: `src/renderer/lib/extract/pptx.ts` (기본 graphics 를 `pptxGraphics` 로)
- Test: `src/renderer/lib/extract/__tests__/pptx-graphics.test.ts`

**Interfaces:**
- Consumes: `PptxGraphicsText`, `textBodyText`(Task 4, **pptx-text.ts**), `readRels`, `prefixedAttr`, `toGfmTable`, `MAX_GRID_CELLS_PER_AXIS`(Task 2)
- Produces: `pptxGraphics: PptxGraphicsText` (pptx-graphics.ts). `createPptxExtractor()` 의 기본 `graphics` 가 이것이 된다.

**배경:** ① 표: 격자의 모든 칸이 `a:tc` 로 존재하고 연속 칸은 `hMerge`/`vMerge` 속성(값 `1` 또는 `true`). **Google 은 `<a:tc vMerge="1"/>` 자기 닫힘** — txBody 가 없다. 규칙은 HWPX·DOCX 와 같다: 세로 연속 = 위 칸 텍스트 복사, 가로 연속 = 빈 칸. 행은 `a:tblGrid/a:gridCol` 수로 맞춘다. ② 차트·SmartArt 는 실물 코퍼스에 **없었다** — 사양(ECMA-376) 기반이며 합성 픽스처로만 검증한다. 차트는 `c:chart/@r:id` → 차트 파트의 **캐시 값**(`c:strCache`/`c:numCache`)을 GFM 표로(제목 한 줄 + 행=계열, 열=항목). 상한: 항목 50 · 계열 20. SmartArt 는 `dgm:relIds/@r:dm` → data 파트의 `dgm:pt` 중 `type` 이 없거나 `node`/`asst` 인 점의 `dgm:t` 텍스트만 — **drawing 파트(`dsp:`)는 같은 텍스트의 중복이라 읽지 않는다.**

- [ ] **Step 1: 실패 테스트** (`pptx-graphics.test.ts`)

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { parseXml } from '../xml';
import { pptxGraphics } from '../pptx-graphics';
import type { ZipIndex } from '../types';

const NS = 'xmlns:a="urn:a" xmlns:r="urn:r" xmlns:c="urn:c" xmlns:dgm="urn:dgm" xmlns:p="urn:p"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const el = (xml: string) => parseXml(xml).documentElement;
function zipOf(files: Record<string, string>): ZipIndex {
  const u8 = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}
const tc = (text: string, attrs = '') => `<a:tc ${attrs}><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;

describe('pptx 표', () => {
  it('세로 연속 칸은 위 칸 텍스트를 복사, 가로 연속 칸은 비운다 — Google 의 자기 닫힘 연속 칸 포함', () => {
    const tbl = el(`<a:tbl ${NS}><a:tblGrid><a:gridCol/><a:gridCol/><a:gridCol/></a:tblGrid>`
      + `<a:tr>${tc('분류', 'rowSpan="2"')}${tc('머리', 'gridSpan="2"')}${tc('', 'hMerge="1"')}</a:tr>`
      + `<a:tr><a:tc vMerge="1"/>${tc('x')}${tc('y')}</a:tr></a:tbl>`);
    expect(pptxGraphics.table(tbl)).toBe('| 분류 | 머리 |  |\n| --- | --- | --- |\n| 분류 | x | y |');
  });

  it('행이 격자보다 짧으면 빈 칸으로 채운다', () => {
    const tbl = el(`<a:tbl ${NS}><a:tblGrid><a:gridCol/><a:gridCol/></a:tblGrid><a:tr>${tc('a')}</a:tr><a:tr>${tc('b')}${tc('c')}</a:tr></a:tbl>`);
    expect(pptxGraphics.table(tbl)).toBe('| a |  |\n| --- | --- |\n| b | c |');
  });
});

describe('pptx 차트 (합성 — 실물 코퍼스에 없었다)', () => {
  const frame = el(`<p:graphicFrame ${NS}><a:graphic><a:graphicData uri="…/chart"><c:chart r:id="rIdC"/></a:graphicData></a:graphic></p:graphicFrame>`);
  const chartXml = `<c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>분기 매출</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart>`
    + `<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2025</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + `<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`
    + `</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
  const zip = zipOf({
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdC" Type="x/chart" Target="../charts/chart1.xml"/></Relationships>`,
    'ppt/charts/chart1.xml': chartXml,
  });

  it('제목 + 캐시 값 표(행=계열, 열=항목)', () => {
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zip)).toBe('분기 매출\n\n|  | Q1 | Q2 |\n| --- | --- | --- |\n| 2025 | 10 | 12 |');
  });

  it('차트 파트가 없으면 빈 문자열(문서 열기를 실패시키지 않는다)', () => {
    expect(pptxGraphics.chart(frame, 'ppt/slides/slide1.xml', zipOf({}))).toBe('');
  });
});

describe('pptx SmartArt (합성)', () => {
  const frame = el(`<p:graphicFrame ${NS}><a:graphic><a:graphicData uri="…/diagram"><dgm:relIds r:dm="rIdD" r:lo="x" r:qs="y" r:cs="z"/></a:graphicData></a:graphic></p:graphicFrame>`);
  const data = `<dgm:dataModel ${NS}><dgm:ptLst>`
    + `<dgm:pt modelId="0" type="doc"><dgm:t><a:p><a:r><a:t>루트</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `<dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>기획</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `<dgm:pt modelId="2" type="parTrans"><dgm:t><a:p><a:r><a:t>연결선</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `<dgm:pt modelId="3" type="node"><dgm:t><a:p><a:r><a:t>개발</a:t></a:r></a:p></dgm:t></dgm:pt>`
    + `</dgm:ptLst></dgm:dataModel>`;
  const zip = zipOf({
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${REL}><Relationship Id="rIdD" Type="x/diagramData" Target="../diagrams/data1.xml"/></Relationships>`,
    'ppt/diagrams/data1.xml': data,
    'ppt/diagrams/drawing1.xml': '<dsp:drawing xmlns:dsp="urn:dsp"><a:t xmlns:a="urn:a">기획</a:t></dsp:drawing>',
  });

  it('node 점의 텍스트만 목록으로 — 연결선·문서 루트·drawing 중복은 제외', () => {
    expect(pptxGraphics.smartArt(frame, 'ppt/slides/slide1.xml', zip)).toBe('- 기획\n- 개발');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/pptx-graphics.test.ts` → FAIL `Failed to resolve import "../pptx-graphics"`

- [ ] **Step 3: 구현** (`pptx-graphics.ts`, 전체)

```ts
import { parseXml, walk, localName, attr, childrenNamed, prefixedAttr } from './xml';
import { readRels } from './ooxml';
import { toGfmTable, MAX_GRID_CELLS_PER_AXIS } from './table';
import { textBodyText, type PptxGraphicsText } from './pptx-text';
import type { ZipIndex } from './types';

/** 차트 캐시를 표로 옮길 때의 상한 — 수백 항목 차트가 단위 하나를 표로 도배하지 않게. */
const MAX_CHART_CATEGORIES = 50;
const MAX_CHART_SERIES = 20;

function isOn(v: string | null): boolean {
  return v === '1' || v === 'true';
}

/**
 * `a:tbl` → GFM. 격자의 모든 칸이 a:tc 로 있고(HWPX 와 다르다) 연속 칸은 속성으로 표시된다.
 * Google Slides 는 연속 칸을 `<a:tc vMerge="1"/>` 로 txBody 없이 쓴다 — 정규식 파서가 여기서
 * 다음 칸을 삼켰던 것이 실물 조사에서 확인됐다. 실제 파서로 읽으면 문제없다.
 */
function table(tbl: Element): string {
  const gridCols = childrenNamed(childrenNamed(tbl, 'tblGrid')[0] ?? tbl, 'gridCol').length;
  const rows: string[][] = [];
  let above: string[] = [];
  for (const tr of childrenNamed(tbl, 'tr')) {
    const row: string[] = [];
    for (const tc of childrenNamed(tr, 'tc')) {
      if (row.length >= MAX_GRID_CELLS_PER_AXIS) break;
      if (isOn(attr(tc, 'vMerge'))) row.push(above[row.length] ?? '');
      else if (isOn(attr(tc, 'hMerge'))) row.push('');
      else {
        const body = childrenNamed(tc, 'txBody')[0];
        row.push(body ? textBodyText(body) : '');
      }
    }
    while (row.length < Math.min(gridCols, MAX_GRID_CELLS_PER_AXIS)) row.push('');
    rows.push(row);
    above = row;
  }
  return toGfmTable(rows);
}

/** 그래픽 프레임에서 관계 id(접두사 속성)를 가진 첫 요소의 대상 파트를 읽는다. */
function relatedPart(frame: Element, elName: string, attrName: string, slidePart: string, zip: ZipIndex): Element | null {
  const ref = [...walk(frame)].find((e) => localName(e) === elName);
  const relId = ref ? prefixedAttr(ref, attrName) : null;
  const path = relId ? readRels(zip, slidePart).get(relId) : undefined;
  const xml = path ? zip.text(path) : null;
  return xml ? parseXml(xml).documentElement : null;
}

/** `c:pt` 들 → idx 순서의 값 배열(캐시에 빠진 idx 는 빈 칸). */
function cachePoints(container: Element | undefined, limit: number): string[] {
  if (!container) return [];
  const out: string[] = [];
  for (const pt of walk(container)) {
    if (localName(pt) !== 'pt') continue;
    const idx = Number.parseInt(attr(pt, 'idx') ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= limit) continue;
    const v = childrenNamed(pt, 'v')[0];
    out[idx] = v?.textContent ?? '';
  }
  return Array.from(out, (v) => v ?? '');
}

function textOf(el: Element | undefined): string {
  if (!el) return '';
  let s = '';
  for (const e of walk(el)) if (localName(e) === 't') s += e.textContent ?? '';
  return s.trim();
}

/** 차트 → 제목 + 캐시 값 표. 원본 워크북(embeddings/)은 열지 않는다 — 캐시가 화면에 보이는 값이다. */
function chart(frame: Element, slidePart: string, zip: ZipIndex): string {
  const root = relatedPart(frame, 'chart', 'id', slidePart, zip);
  if (!root) return '';
  const title = textOf([...walk(root)].find((e) => localName(e) === 'title'));
  const series = [...walk(root)].filter((e) => localName(e) === 'ser').slice(0, MAX_CHART_SERIES);
  let categories: string[] = [];
  const rows: string[][] = [];
  for (const ser of series) {
    const cats = cachePoints(childrenNamed(ser, 'cat')[0], MAX_CHART_CATEGORIES);
    if (cats.length > categories.length) categories = cats;
    const name = cachePoints(childrenNamed(ser, 'tx')[0], 1)[0] ?? '';
    rows.push([name, ...cachePoints(childrenNamed(ser, 'val')[0], MAX_CHART_CATEGORIES)]);
  }
  const tableText = rows.length > 0 ? toGfmTable([['', ...categories], ...rows]) : '';
  return [title, tableText].filter(Boolean).join('\n\n');
}

/** SmartArt → 글머리 목록. data 파트만 읽는다(drawing 파트는 같은 텍스트의 렌더 사본). */
function smartArt(frame: Element, slidePart: string, zip: ZipIndex): string {
  const root = relatedPart(frame, 'relIds', 'dm', slidePart, zip);
  if (!root) return '';
  const lines: string[] = [];
  for (const pt of walk(root)) {
    if (localName(pt) !== 'pt') continue;
    const type = attr(pt, 'type');
    if (type !== null && type !== 'node' && type !== 'asst') continue;
    const text = textOf(childrenNamed(pt, 't')[0]);
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

export const pptxGraphics: PptxGraphicsText = { table, chart, smartArt };
```

`pptx.ts` 의 기본값을 바꾼다: `import { pptxGraphics } from './pptx-graphics';` 를 추가하고 `const graphics = deps.graphics ?? basicGraphics;` → `?? pptxGraphics`. import 에서 `basicGraphics` 를 뺀다(`pptx-text.ts` 의 `basicGraphics` 는 지운다 — 쓰는 곳이 없어진다). 의존 방향은 `pptx.ts → pptx-graphics.ts → pptx-text.ts`, `pptx.ts → pptx-text.ts` 로 순환이 없다.

Task 4 의 `pptx.test.ts` 에 병합 표가 실제 추출 경로에서 쓰이는지 배선 테스트 하나를 추가한다(순수 함수만 테스트하면 기본값 교체를 잊어도 초록 — QA33 교훈):

```ts
it('추출기가 병합 표를 pptxGraphics 로 텍스트화한다(기본값 배선)', async () => {
  const frame = `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>`
    + `<a:tblGrid><a:gridCol/><a:gridCol/></a:tblGrid>`
    + `<a:tr><a:tc rowSpan="2"><a:txBody><a:p><a:r><a:t>분류</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc></a:tr>`
    + `<a:tr><a:tc vMerge="1"/><a:tc><a:txBody><a:p><a:r><a:t>y</a:t></a:r></a:p></a:txBody></a:tc></a:tr>`
    + `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const doc = await run(deck({ 's.xml': slide(frame) }, ['s.xml']));
  expect(doc.units[0]).toBe('| 분류 | x |\n| --- | --- |\n| 분류 | y |');
});
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/renderer/lib/extract` → PASS (Task 4 테스트 포함)

- [ ] **Step 5: 비공허 증명 + 커밋** — 뮤테이션: ① `isOn(attr(tc, 'vMerge'))` 분기 삭제 ② smartArt 의 `type` 필터 삭제 ③ chart 의 `cachePoints` 한도 인자를 `Infinity` 로(상한 테스트가 없으면 **상한 테스트를 추가**하고 다시 뮤테이션) ④ `pptx.ts` 기본값을 `?? { ...pptxGraphics, table: () => '' }` 로(배선 테스트가 잡아야 한다). 실패 요약 기록.

```bash
npx tsc --noEmit
git add src/renderer/lib/extract
git commit -m "feat(extract): PPTX 표 병합·차트 캐시·SmartArt (P4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: OCF 컨테이너 해석 (`ocf.ts`)

**Files:**
- Create: `src/renderer/lib/extract/ocf.ts`
- Test: `src/renderer/lib/extract/__tests__/ocf.test.ts`

**Interfaces:**
- Consumes: `parseXml`, `walk`, `localName`, `attr`, `extractFail`, `resolveRelTarget(partPath, target)`(ooxml.ts)
- Produces:
  - `interface OcfItem { id: string; path: string; mediaType: string }`
  - `interface OcfPackage { opfPath: string; items: Map<string, OcfItem>; spine: OcfItem[] }`
  - `readOcfPackage(zip: ZipIndex, packageMediaType: string): OcfPackage`
  - `hasEncryptionData(zip: ZipIndex): boolean`

**배경:** HWPX 와 EPUB 은 같은 OCF 컨테이너다(설계 §3.1). 실물 HWPX 의 container.xml 은 rootfile 이 **3개** — media-type 으로 골라야 한다(EPUB 은 `application/oebps-package+xml`, HWPX 는 `application/hwpml-package+xml`). HWPX 의 manifest href 는 **패키지 루트 기준**(`Contents/section0.xml`)인데 OPF 규약은 OPF 파일 기준 상대다(EPUB). 둘 다 받는다: 루트 기준 경로가 zip 에 있으면 그것, 아니면 OPF 기준으로 푼다. 암호: OCF/ODF 의 `META-INF/manifest.xml` 에 `encryption-data` 가 있으면 본문이 암호화돼 있다(실물 샘플 없음 — 합성).

- [ ] **Step 1: 실패 테스트** (`ocf.test.ts`)

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { readOcfPackage, hasEncryptionData } from '../ocf';
import type { ZipIndex } from '../types';

function zipOf(files: Record<string, string>): ZipIndex {
  const u8 = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}
const HWPX_PKG = 'application/hwpml-package+xml';
const container = `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>`
  + `<rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>`
  + `<rootfile full-path="Contents/content.hpf" media-type="${HWPX_PKG}"/>`
  + `<rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></rootfiles></container>`;
const opf = (href: string) => `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>`
  + `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>`
  + `<opf:item id="section0" href="${href}" media-type="application/xml"/>`
  + `<opf:item id="image1" href="BinData/image1.bmp" media-type="image/bmp"/>`
  + `</opf:manifest><opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/><opf:itemref idref="nope"/></opf:spine></opf:package>`;

describe('readOcfPackage', () => {
  it('media-type 로 rootfile 을 고르고(3개 중), 루트 기준 href 를 그대로 받는다(HWPX)', () => {
    const pkg = readOcfPackage(zipOf({
      'META-INF/container.xml': container,
      'Contents/content.hpf': opf('Contents/section0.xml'),
      'Contents/section0.xml': '<hs:sec xmlns:hs="urn:hs"/>',
    }), HWPX_PKG);
    expect(pkg.opfPath).toBe('Contents/content.hpf');
    expect(pkg.spine.map((i) => i.path)).toEqual(['Contents/header.xml', 'Contents/section0.xml']);
    expect(pkg.items.get('image1')?.path).toBe('BinData/image1.bmp');
  });

  it('루트 기준 경로가 없으면 OPF 파일 기준 상대로 푼다(EPUB 규약)', () => {
    const pkg = readOcfPackage(zipOf({
      'META-INF/container.xml': container,
      'Contents/content.hpf': opf('section0.xml'),
      'Contents/section0.xml': '<x/>',
    }), HWPX_PKG);
    expect(pkg.items.get('section0')?.path).toBe('Contents/section0.xml');
  });

  it('spine 이 manifest 에 없는 id 를 가리키면 건너뛴다', () => {
    const pkg = readOcfPackage(zipOf({ 'META-INF/container.xml': container, 'Contents/content.hpf': opf('Contents/section0.xml') }), HWPX_PKG);
    expect(pkg.spine.some((i) => i.id === 'nope')).toBe(false);
  });

  it('container.xml 이나 맞는 rootfile 이 없으면 DOC_CORRUPT', () => {
    expect(() => readOcfPackage(zipOf({}), HWPX_PKG)).toThrow(expect.objectContaining({ code: 'DOC_CORRUPT' }));
    expect(() => readOcfPackage(zipOf({ 'META-INF/container.xml': container }), 'application/oebps-package+xml'))
      .toThrow(expect.objectContaining({ code: 'DOC_CORRUPT' }));
  });
});

describe('hasEncryptionData', () => {
  it('manifest.xml 의 encryption-data 를 찾는다', () => {
    const enc = '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><odf:file-entry odf:full-path="Contents/section0.xml"><odf:encryption-data/></odf:file-entry></odf:manifest>';
    expect(hasEncryptionData(zipOf({ 'META-INF/manifest.xml': enc }))).toBe(true);
    expect(hasEncryptionData(zipOf({ 'META-INF/manifest.xml': '<odf:manifest xmlns:odf="urn:x"/>' }))).toBe(false);
    expect(hasEncryptionData(zipOf({}))).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/ocf.test.ts` → FAIL

- [ ] **Step 3: 구현** (`ocf.ts`, 전체)

```ts
import { parseXml, walk, localName, attr } from './xml';
import { resolveRelTarget } from './ooxml';
import { extractFail } from './errors';
import type { ZipIndex } from './types';

/**
 * OCF(Open Container Format) 해석 — HWPX 와 EPUB 공용(설계 §3.1).
 *
 * `META-INF/container.xml` → rootfile(OPF) → manifest(id → 경로·media-type) + spine(순서).
 */

const CONTAINER_PART = 'META-INF/container.xml';
const MANIFEST_PART = 'META-INF/manifest.xml';

export interface OcfItem {
  id: string;
  /** zip 엔트리 경로(패키지 루트 기준) */
  path: string;
  mediaType: string;
}

export interface OcfPackage {
  opfPath: string;
  items: Map<string, OcfItem>;
  /** spine 순서의 항목 — manifest 에 없는 idref 는 뺀다 */
  spine: OcfItem[];
}

/**
 * manifest href → zip 경로. HWPX 는 href 를 **패키지 루트 기준**으로 쓰고(`Contents/section0.xml`),
 * EPUB(OPF 규약)은 OPF 파일 기준 상대로 쓴다. 루트 기준 경로가 실제로 있으면 그것을 믿고, 없으면
 * OPF 기준으로 푼다 — 둘 중 하나만 가정하면 한 포맷에서 모든 파트가 "없음" 이 된다(조용히 빈 문서).
 */
function resolveHref(zip: ZipIndex, opfPath: string, href: string): string {
  const decoded = decodeURIComponent(href);
  if (zip.has(decoded)) return decoded;
  return resolveRelTarget(opfPath, decoded);
}

export function readOcfPackage(zip: ZipIndex, packageMediaType: string): OcfPackage {
  const containerXml = zip.text(CONTAINER_PART) ?? extractFail('DOC_CORRUPT', 'container.xml missing');
  // rootfile 이 여럿이다(실물 HWPX: 패키지 · 미리보기 텍스트 · rdf) — 첫 항목을 믿지 않는다.
  const rootfile = [...walk(parseXml(containerXml).documentElement)].find(
    (e) => localName(e) === 'rootfile' && attr(e, 'media-type') === packageMediaType,
  );
  const opfPath = (rootfile && attr(rootfile, 'full-path')) || extractFail('DOC_CORRUPT', 'package rootfile missing');
  const opfXml = zip.text(opfPath) ?? extractFail('DOC_CORRUPT', 'package document missing');
  const root = parseXml(opfXml).documentElement;

  const items = new Map<string, OcfItem>();
  for (const el of walk(root)) {
    if (localName(el) !== 'item') continue;
    const id = attr(el, 'id');
    const href = attr(el, 'href');
    if (!id || !href) continue;
    items.set(id, { id, path: resolveHref(zip, opfPath, href), mediaType: attr(el, 'media-type') ?? '' });
  }
  const spine: OcfItem[] = [];
  for (const el of walk(root)) {
    if (localName(el) !== 'itemref') continue;
    const item = items.get(attr(el, 'idref') ?? '');
    if (item) spine.push(item);
  }
  return { opfPath, items, spine };
}

/**
 * 본문이 암호화된 패키지인가. ODF/OCF 는 암호화한 파트마다 `manifest.xml` 에 `encryption-data` 를
 * 둔다. 실물 샘플은 없다(설계 §11) — 판정을 여기 한 곳에 두어 샘플을 얻으면 이것만 고친다.
 */
export function hasEncryptionData(zip: ZipIndex): boolean {
  const xml = zip.text(MANIFEST_PART);
  if (!xml) return false;
  try {
    return [...walk(parseXml(xml).documentElement)].some((e) => localName(e) === 'encryption-data');
  } catch {
    return false;
  }
}
```

(`resolveRelTarget` 의 시그니처가 `(partPath, target)` 이고 `partPath` 의 디렉터리 기준으로 푸는지 ooxml.ts 에서 확인한다 — 다르면 멈추고 보고.)

- [ ] **Step 4: 통과 확인 + 비공허 증명 + 커밋** — 뮤테이션: ① rootfile 의 media-type 조건 삭제(첫 rootfile 사용) ② `if (zip.has(decoded)) return decoded;` 삭제. 실패 요약 기록.

```bash
npx tsc --noEmit
git add src/renderer/lib/extract
git commit -m "feat(extract): OCF 컨테이너 해석 — HWPX·EPUB 공용 (P4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: HWPX 추출기 — 섹션 · 문단 · 쪽나눔 · 개요 제목 · 글상자

**Files:**
- Modify: `src/shared/document-formats.ts` (hwpx 등록, `HWPX_FORMAT_ID`)
- Modify: `src/renderer/lib/extract/types.ts:61` (`'hwpx'` 리터럴 제거 → `NonPdfFormatId | 'epub'`)
- Create: `src/renderer/lib/extract/hwpx-header.ts`
- Create: `src/renderer/lib/extract/hwpx.ts`
- Modify: `src/renderer/lib/extract/registry.ts`
- Test: `src/renderer/lib/extract/__tests__/hwpx-header.test.ts`, `hwpx.test.ts`, `registry.test.ts`, `src/shared/__tests__/document-formats.test.ts`

**Interfaces:**
- Consumes: `readOcfPackage`/`hasEncryptionData`(Task 6), `paginate`/`Block`(paginate.ts), `toGfmTable`, `extractFail`, `MAX_PAGE_COUNT`
- Produces:
  - `HWPX_FORMAT_ID = 'hwpx'`
  - `readOutlineLevels(headerXml: string | null): Map<string, number>` (hwpx-header.ts) — paraPr id → 제목 수준(1-based)
  - `createHwpxExtractor(deps?: { fitImage?: ImageFitter }): Extractor`, `hwpxExtractor` (hwpx.ts)
  - hwpx.ts 내부에 표 자리는 `tableBlock(tbl, depth): string` 로 두고 Task 8 이 채운다(이 태스크에서는 셀 텍스트를 순서대로 잇는 임시 구현 — Task 8 테스트가 교체를 강제한다)

**배경:** 위 "실물 조사 — HWPX". 규칙:
1. sniff: `mimetype` 엔트리의 trim 값 === `application/hwp+zip`.
2. 암호: `hasEncryptionData` 면 `DOC_ENCRYPTED`. 본문 섹션이 XML 로 안 읽히면 `DOC_CORRUPT`(parseXml 이 던진다) — **빈 텍스트로 돌려주지 않는다.**
3. 본문 섹션 = spine 항목 중 경로가 `/(^|\/)section\d+\.xml$/i` 이고 루트 로컬명이 `sec` 인 것(spine 순서). spine 에서 하나도 못 찾으면 폴백: zip 엔트리 중 `Contents/section(\d+).xml` 을 번호순.
4. 텍스트는 **`hp:t` 에서만** — 혼합 내용이라 자식 노드를 돌며 텍스트 노드는 그대로, `lineBreak`→`\n`, `tab`→`\t`, `nbSpace`/`fwSpace`→공백, `hyphen`→`-`, 나머지(`markpenBegin/End` 등)는 무시. **런 단위 trim 금지.**
5. 건너뛰는 서브트리: `ctrl`(머리말·꼬리말·각주·쪽 번호 — 필드 결과 텍스트는 ctrl 밖 hp:t 에 있다), `secPr`, `linesegarray`, `shapeComment`, `hiddenComment`.
6. 최상위 문단(`hs:sec` 직계 `hp:p`)이 블록. 섹션의 첫 문단(두 번째 섹션부터) 또는 `pageBreak === "1"` 인 문단이 `breakBefore`. 문단 안 런을 순서대로 돌며 텍스트를 모으다 `hp:tbl` 을 만나면 **지금까지의 텍스트를 한 블록으로 끊고** 표 블록을 넣은 뒤 이어서 모은다(실물 런 패턴 `t,tbl,t`).
7. 글상자: `hp:drawText > hp:subList > hp:p` — 호스트 문단 **뒤에** 별도 블록(DOCX 글상자 규칙과 같다). 글상자 안 문단은 제목·쪽나눔을 만들지 않는다. 글상자 안의 표도 표 블록.
8. 개요 제목: `hp:p/@paraPrIDRef` → `readOutlineLevels` 가 준 수준. 스타일 이름을 보지 않는다.
9. `unitKind: 'page'`(가상 페이지 — 설계 §2). 단위 수 > 500 → `PDF_TOO_MANY_PAGES`, 전부 비면 `DOC_NO_TEXT`.
10. 200 요소마다 이벤트 루프 양보 + 취소 확인(docx.ts 와 같은 이유).

- [ ] **Step 1: 개요 수준 표 실패 테스트** (`hwpx-header.test.ts`)

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readOutlineLevels } from '../hwpx-header';

const H = 'xmlns:hh="urn:hh" xmlns:hp="urn:hp"';
const header = (paraPrs: string) => `<hh:head ${H}><hh:refList><hh:paraProperties>${paraPrs}</hh:paraProperties></hh:refList></hh:head>`;

describe('readOutlineLevels', () => {
  it('heading type=OUTLINE 의 0-based level 을 1-based 로', () => {
    const m = readOutlineLevels(header('<hh:paraPr id="3"><hh:heading type="OUTLINE" idRef="0" level="0"/></hh:paraPr><hh:paraPr id="4"><hh:heading type="OUTLINE" idRef="0" level="2"/></hh:paraPr>'));
    expect(m.get('3')).toBe(1);
    expect(m.get('4')).toBe(3);
  });

  it('BULLET·NONE 은 제목이 아니다', () => {
    const m = readOutlineLevels(header('<hh:paraPr id="1"><hh:heading type="BULLET" level="0"/></hh:paraPr><hh:paraPr id="2"><hh:heading type="NONE" level="0"/></hh:paraPr>'));
    expect(m.size).toBe(0);
  });

  it('hp:switch 가 있으면 case 한 갈래만 — default 의 NONE 과 섞지 않는다', () => {
    const m = readOutlineLevels(header('<hh:paraPr id="7"><hp:switch><hp:case hp:required-namespace="urn:2016"><hh:heading type="OUTLINE" level="1"/></hp:case><hp:default><hh:heading type="NONE" level="0"/></hp:default></hp:switch></hh:paraPr>'));
    expect(m.get('7')).toBe(2);
  });

  it('header 가 없거나 깨지면 빈 표(문서 열기를 실패시키지 않는다)', () => {
    expect(readOutlineLevels(null).size).toBe(0);
    expect(readOutlineLevels('<hh:head').size).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/hwpx-header.test.ts` → FAIL

- [ ] **Step 3: 구현** (`hwpx-header.ts`, 전체)

```ts
import { parseXml, walk, localName, attr, childrenNamed } from './xml';

/** OWPML 개요 수준은 0..9(10단계). 그 밖의 값은 손상으로 보고 제목으로 쓰지 않는다. */
const MAX_OUTLINE_LEVEL = 10;

/**
 * paraPr 의 제목 정의. `hp:switch` 가 있으면 case 쪽 하나만 본다 — 실물은 case 에 OUTLINE,
 * default 에 NONE 을 두는 식이라 "처음 만나는 heading" 을 쓰면 갈래가 섞인다.
 */
function headingOf(paraPr: Element): Element | undefined {
  const sw = childrenNamed(paraPr, 'switch')[0];
  if (sw) {
    const branch = childrenNamed(sw, 'case')[0] ?? childrenNamed(sw, 'default')[0];
    return branch ? childrenNamed(branch, 'heading')[0] : undefined;
  }
  return childrenNamed(paraPr, 'heading')[0];
}

/**
 * header.xml → paraPr id → 제목 수준(1-based).
 *
 * 스타일 이름("개요 1")을 보지 않는다 — 실물에서 스타일 이름과 그 스타일의 paraPr, 그리고 문단이
 * 실제로 참조하는 paraPr 가 서로 달랐다(스타일은 BULLET 인데 문단의 paraPr 는 NONE). 판정은 문단의
 * paraPrIDRef 가 가리키는 paraPr 하나로 한다.
 */
export function readOutlineLevels(headerXml: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!headerXml) return out;
  let root: Element;
  try {
    root = parseXml(headerXml).documentElement;
  } catch {
    return out;
  }
  for (const el of walk(root)) {
    if (localName(el) !== 'paraPr') continue;
    const id = attr(el, 'id');
    const heading = id ? headingOf(el) : undefined;
    if (!heading || attr(heading, 'type') !== 'OUTLINE') continue;
    const level = Number.parseInt(attr(heading, 'level') ?? '', 10);
    if (Number.isInteger(level) && level >= 0 && level < MAX_OUTLINE_LEVEL) out.set(id!, level + 1);
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS

- [ ] **Step 5: 추출기 실패 테스트** (`hwpx.test.ts`)

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { createHwpxExtractor } from '../hwpx';
import type { ZipIndex } from '../types';

const NS = 'xmlns:hs="urn:hs" xmlns:hp="urn:hp" xmlns:hc="urn:hc" xmlns:hh="urn:hh"';
const PKG = 'application/hwpml-package+xml';

function zipOf(files: Record<string, string | Uint8Array>): ZipIndex {
  const e: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) e[k] = typeof v === 'string' ? strToU8(v) : v;
  const u8 = zipSync(e);
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}

/** 섹션 XML 배열 → 최소 HWPX 패키지. spine 에 header 와 스크립트를 섞어 실물처럼 만든다. */
export function hwpx(sections: string[], opts: { header?: string; extra?: Record<string, string | Uint8Array>; manifestItems?: string } = {}) {
  const items = sections.map((_, i) => `<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`).join('');
  const spine = sections.map((_, i) => `<opf:itemref idref="section${i}"/>`).join('');
  const files: Record<string, string | Uint8Array> = {
    mimetype: 'application/hwp+zip',
    'META-INF/container.xml': `<container><rootfiles><rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><rootfile full-path="Contents/content.hpf" media-type="${PKG}"/></rootfiles></container>`,
    'Contents/content.hpf': `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${items}<opf:item id="script" href="Scripts/headerScripts" media-type="application/x-javascript"/>${opts.manifestItems ?? ''}</opf:manifest><opf:spine><opf:itemref idref="header"/>${spine}<opf:itemref idref="script"/></opf:spine></opf:package>`,
    'Contents/header.xml': opts.header ?? `<hh:head ${NS}/>`,
    'Preview/PrvText.txt': '잘린 미리보기',
    ...opts.extra,
  };
  sections.forEach((s, i) => { files[`Contents/section${i}.xml`] = s; });
  return zipOf(files);
}

export const sec = (paras: string) => `<hs:sec ${NS}>${paras}</hs:sec>`;
export const p = (inner: string, attrs = '') => `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" ${attrs}>${inner}</hp:p>`;
export const run = (inner: string) => `<hp:run charPrIDRef="0">${inner}</hp:run>`;
export const t = (text: string) => `<hp:t>${text}</hp:t>`;

const x = createHwpxExtractor();
const extract = (zip: ZipIndex) => x.extract(zip, { extractImages: false });

describe('hwpx — 판별·섹션', () => {
  it('mimetype 으로 판별한다', () => {
    expect(x.sniff(hwpx([sec(p(run(t('a'))))]))).toBe(true);
    expect(x.sniff(zipOf({ mimetype: 'application/epub+zip' }))).toBe(false);
  });

  it('spine 의 header·스크립트는 본문이 아니다', async () => {
    const doc = await extract(hwpx([sec(p(run(t('본문'))))]));
    expect(doc.units).toEqual(['본문']);
    expect(doc.unitKind).toBe('page');
  });

  it('두 번째 섹션은 새 쪽에서 시작한다', async () => {
    const doc = await extract(hwpx([sec(p(run(t('일')))), sec(p(run(t('이'))))]));
    expect(doc.units).toEqual(['일', '이']);
  });

  it('Preview/PrvText.txt 를 쓰지 않는다', async () => {
    const doc = await extract(hwpx([sec(p(run(t('진짜 본문'))))]));
    expect(doc.units.join('')).not.toContain('잘린 미리보기');
  });
});

describe('hwpx — 문단 텍스트', () => {
  it('hp:p/@pageBreak="1" 만 쪽나눔 — 표의 pageBreak="CELL" 은 아니다', async () => {
    const tbl = `<hp:tbl rowCnt="1" colCnt="1" pageBreak="CELL"><hp:tr><hp:tc><hp:subList>${p(run(t('셀')))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
    const doc = await extract(hwpx([sec(p(run(t('앞'))) + p(run(tbl)) + p(run(t('뒤')), 'pageBreak="1"'))]));
    expect(doc.units).toHaveLength(2);
    expect(doc.units[1]).toBe('뒤');
  });

  it('hp:t 의 혼합 내용: lineBreak·tab·특수 공백, markpen 무시, 공백만 있는 런을 지우지 않는다', async () => {
    const body = run(`<hp:t>가<hp:lineBreak/>나<hp:markpenBegin/>다<hp:markpenEnd/><hp:tab/>라<hp:nbSpace/>마<hp:hyphen/>바</hp:t>`) + run(t(' ')) + run(t('사'));
    const doc = await extract(hwpx([sec(p(body))]));
    expect(doc.units[0]).toBe('가\n나다\t라 마-바 사');
  });

  it('shapeComment·머리말·꼬리말·쪽 번호는 본문이 아니다', async () => {
    const noise = run(`<hp:ctrl><hp:footer><hp:subList>${p(run('<hp:ctrl><hp:autoNum numType="PAGE"/></hp:ctrl>' + t('- 꼬리 -')))}</hp:subList></hp:footer></hp:ctrl>`)
      + run(`<hp:rect><hp:shapeComment>사각형입니다.</hp:shapeComment></hp:rect>`)
      + run(`<hp:pic><hp:shapeComment>그림입니다. 원본 그림의 이름: secret.png</hp:shapeComment><hc:img binaryItemIDRef="image1"/></hp:pic>`);
    const doc = await extract(hwpx([sec(p(run(t('본문')) + noise))]));
    expect(doc.units[0]).toBe('본문');
  });

  it('표가 런 사이에 끼면 앞 텍스트·표·뒤 텍스트가 순서대로 블록이 된다', async () => {
    const tbl = `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>${p(run(t('셀')))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
    const doc = await extract(hwpx([sec(p(run(t('앞') + tbl + t('뒤'))))]));
    expect(doc.units[0]!.indexOf('앞')).toBeLessThan(doc.units[0]!.indexOf('셀'));
    expect(doc.units[0]!.indexOf('셀')).toBeLessThan(doc.units[0]!.indexOf('뒤'));
  });

  it('글상자(drawText) 텍스트를 잃지 않고 호스트 문단 뒤에 둔다', async () => {
    const box = run(`<hp:rect><hp:drawText><hp:subList>${p(run(t('상자 제목')))}</hp:subList></hp:drawText></hp:rect>`);
    const doc = await extract(hwpx([sec(p(run(t('호스트')) + box) + p(run(t('다음'))))]));
    expect(doc.units[0]).toBe('호스트\n\n상자 제목\n\n다음');
  });
});

describe('hwpx — 제목·실패 계약', () => {
  const header = `<hh:head ${NS}><hh:paraPr id="5"><hh:heading type="OUTLINE" level="0"/></hh:paraPr></hh:head>`;

  it('paraPrIDRef 가 개요 paraPr 를 가리키면 제목', async () => {
    const doc = await extract(hwpx([sec(p(run(t('1. 개요')), 'paraPrIDRef="5"') + p(run(t('본문'))))], { header }));
    expect(doc.headings).toEqual([{ level: 1, title: '1. 개요', unitIndex: 0 }]);
  });

  it('글상자 안 문단은 제목이 되지 않는다', async () => {
    const box = run(`<hp:rect><hp:drawText><hp:subList>${p(run(t('상자')), 'paraPrIDRef="5"')}</hp:subList></hp:drawText></hp:rect>`);
    const doc = await extract(hwpx([sec(p(run(t('호스트')) + box))], { header }));
    expect(doc.headings).toEqual([]);
  });

  it('manifest 에 encryption-data 가 있으면 DOC_ENCRYPTED', async () => {
    const enc = '<odf:manifest xmlns:odf="urn:odf"><odf:file-entry><odf:encryption-data/></odf:file-entry></odf:manifest>';
    await expect(extract(hwpx([sec(p(run(t('a'))))], { extra: { 'META-INF/manifest.xml': enc } }))).rejects.toMatchObject({ code: 'DOC_ENCRYPTED' });
  });

  it('섹션이 XML 이 아니면 DOC_CORRUPT — 빈 문서로 돌려주지 않는다', async () => {
    await expect(extract(hwpx(['\u0000binary']))).rejects.toMatchObject({ code: 'DOC_CORRUPT' });
  });

  it('본문이 전부 비면 DOC_NO_TEXT', async () => {
    await expect(extract(hwpx([sec(p(run(t(''))))]))).rejects.toMatchObject({ code: 'DOC_NO_TEXT' });
  });

  it('spine 에서 섹션을 못 찾으면 Contents/sectionN.xml 을 번호순으로', async () => {
    const zip = zipOf({
      mimetype: 'application/hwp+zip',
      'META-INF/container.xml': `<container><rootfiles><rootfile full-path="Contents/content.hpf" media-type="${PKG}"/></rootfiles></container>`,
      'Contents/content.hpf': '<opf:package xmlns:opf="urn:opf"><opf:manifest/><opf:spine/></opf:package>',
      'Contents/section10.xml': sec(p(run(t('열')))),
      'Contents/section2.xml': sec(p(run(t('둘')))),
    });
    expect((await extract(zip)).units).toEqual(['둘', '열']);
  });
});
```

(Task 8·9 의 테스트는 **같은 파일**에 describe 를 추가하므로 이 조립기(`hwpx`/`sec`/`p`/`run`/`t`/`NS`/`zipOf`)를 그대로 쓴다. `export` 는 붙이지 않아도 된다.)

- [ ] **Step 6: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/hwpx.test.ts` → FAIL

- [ ] **Step 7: 포맷 등록** — `document-formats.ts` 의 `SUPPORTED_FORMATS` 끝에 `{ id: 'hwpx', ext: '.hwpx', label: 'HWPX', container: 'zip' },`, 상수 `export const HWPX_FORMAT_ID = 'hwpx' as const satisfies DocumentFormat['id'];`. `types.ts:61` → `id: NonPdfFormatId | 'epub';`. `document-formats.test.ts`·`registry.test.ts` 의 목록 단언 갱신.

- [ ] **Step 8: 추출기 구현** (`hwpx.ts`, 전체 — 표는 Task 8 이 교체할 임시 구현)

```ts
import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { paginate, type Block } from './paginate';
import { toGfmTable } from './table';
import { readOcfPackage, hasEncryptionData, type OcfPackage } from './ocf';
import { readOutlineLevels } from './hwpx-header';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractOptions, ZipIndex } from './types';
import { HWPX_FORMAT_ID } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';

const HWPX_MIMETYPE = 'application/hwp+zip';
const HWPX_PACKAGE = 'application/hwpml-package+xml';
const SECTION_PATH = /(^|\/)section(\d+)\.xml$/i;
const MAX_NEST_DEPTH = 16;
const YIELD_EVERY = 200;

/**
 * 본문 텍스트가 아닌 서브트리. `ctrl` 은 머리말·꼬리말·각주·쪽 번호·단 정의를 담는다 — 필드의
 * **결과** 텍스트는 ctrl 밖 hp:t 에 있으므로 ctrl 을 통째로 건너뛰어도 잃지 않는다.
 * `shapeComment` 는 "그림입니다. 원본 그림의 이름: <파일명>" 자동 문구라 요약에 파일명이 샜다.
 */
const SKIPPED = new Set(['ctrl', 'secPr', 'linesegarray', 'shapeComment', 'hiddenComment']);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) extractFail('ABORTED', 'aborted');
}

/** hp:t 의 혼합 내용 → 텍스트. 런 단위로 trim 하지 않는다(공백만 있는 런이 실제 단어 사이 공백이다). */
function tText(t: Element): string {
  let s = '';
  for (const node of Array.from(t.childNodes)) {
    if (node.nodeType === 3) { s += node.nodeValue ?? ''; continue; }
    if (node.nodeType !== 1) continue;
    switch (localName(node as Element)) {
      case 'lineBreak': s += '\n'; break;
      case 'tab': s += '\t'; break;
      case 'nbSpace':
      case 'fwSpace': s += ' '; break;
      case 'hyphen': s += '-'; break;
      // markpenBegin/End(형광펜) 등 서식 표식은 글자가 아니다.
    }
  }
  return s;
}

/** 문단 하나를 읽은 결과 — 런 사이에 표가 끼면 텍스트가 여러 조각으로 갈린다. */
interface ParaOut {
  /** 순서대로의 블록 텍스트(텍스트 조각 · 표) */
  parts: string[];
  /** 떠 있는 글상자의 subList — 호스트 문단 뒤에 처리 */
  boxes: Element[];
  /** 그림의 binaryItemIDRef 와, 그 그림이 속한 parts 인덱스 */
  pics: { ref: string; part: number }[];
}

function readParagraph(p: Element, depth: number, tableText: (tbl: Element, depth: number) => string): ParaOut {
  const out: ParaOut = { parts: [], boxes: [], pics: [] };
  let buf = '';
  const flush = () => { if (buf.trim()) out.parts.push(buf); buf = ''; };
  const skip = (el: Element): boolean => {
    if (el === p) return false;
    const name = localName(el);
    if (SKIPPED.has(name)) return true;
    // 표·글상자·그림은 여기서 따로 처리하고 서브트리는 건너뛴다(셀 문단을 본문 문단으로 다시 읽지 않게).
    if (name === 'tbl') { flush(); const tb = tableText(el, depth + 1); if (tb) out.parts.push(tb); return true; }
    if (name === 'drawText') { for (const sl of childrenNamed(el, 'subList')) out.boxes.push(sl); return true; }
    if (name === 'pic') {
      const img = [...walk(el)].find((e) => localName(e) === 'img');
      const ref = img ? attr(img, 'binaryItemIDRef') : null;
      if (ref) out.pics.push({ ref, part: out.parts.length });
      return true;
    }
    return false;
  };
  for (const el of walk(p, skip)) {
    if (localName(el) === 't') buf += tText(el);
  }
  flush();
  return out;
}

/** 셀·글상자의 subList → 한 덩어리 텍스트(문단은 줄바꿈). Task 8 이 표 배치를 교체한다. */
function containerText(subList: Element, depth: number, tableText: (tbl: Element, depth: number) => string): string {
  if (depth > MAX_NEST_DEPTH) {
    let s = '';
    for (const e of walk(subList, (x) => SKIPPED.has(localName(x)))) if (localName(e) === 't') s += tText(e);
    return s;
  }
  const lines: string[] = [];
  for (const para of childrenNamed(subList, 'p')) {
    const r = readParagraph(para, depth, tableText);
    lines.push(...r.parts);
    for (const box of r.boxes) lines.push(containerText(box, depth + 1, tableText));
  }
  return lines.join('\n');
}

/** Task 7 임시: 셀 텍스트를 나온 순서대로 행에 담는다(병합 좌표 무시). Task 8 이 placeGridCells 로 교체한다. */
function naiveTableText(tbl: Element, depth: number): string {
  const rows = childrenNamed(tbl, 'tr').map((tr) =>
    childrenNamed(tr, 'tc').map((tc) => {
      const sl = childrenNamed(tc, 'subList')[0];
      return sl ? containerText(sl, depth, naiveTableText) : '';
    }));
  return toGfmTable(rows);
}

function bodySections(zip: ZipIndex, pkg: OcfPackage | null): string[] {
  const fromSpine = (pkg?.spine ?? []).map((i) => i.path).filter((path) => SECTION_PATH.test(path));
  if (fromSpine.length > 0) return fromSpine;
  // 폴백: spine 이 비었거나 섹션을 못 가리킬 때 — 번호순(사전순이면 section10 이 section2 앞에 온다).
  return zip.names()
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(SECTION_PATH.exec(a)![2]) - Number(SECTION_PATH.exec(b)![2]));
}

export interface HwpxExtractorDeps {
  fitImage?: ImageFitter;
  /** Task 8: 표 텍스트화 교체 지점 */
  tableText?: (tbl: Element, depth: number) => string;
}

export function createHwpxExtractor(deps: HwpxExtractorDeps = {}): Extractor {
  const tableText = deps.tableText ?? naiveTableText;
  void (deps.fitImage ?? fitImage); // Task 9 에서 사용
  return {
    id: HWPX_FORMAT_ID,

    sniff: (zip) => zip.text('mimetype')?.trim() === HWPX_MIMETYPE,

    extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      if (hasEncryptionData(zip)) extractFail('DOC_ENCRYPTED', 'encrypted hwpx');

      let pkg: OcfPackage | null = null;
      try { pkg = readOcfPackage(zip, HWPX_PACKAGE); } catch { pkg = null; }
      const headerPath = pkg ? [...pkg.items.values()].find((i) => /(^|\/)header\.xml$/i.test(i.path))?.path : 'Contents/header.xml';
      const outline = readOutlineLevels(headerPath ? zip.text(headerPath) : null);

      const sections = bodySections(zip, pkg);
      if (sections.length === 0) extractFail('DOC_CORRUPT', 'no body section');

      const blocks: Block[] = [];
      const headingAt: { level: number; title: string; blockIndex: number }[] = [];
      let processed = 0;

      for (const [si, path] of sections.entries()) {
        const xml = zip.text(path) ?? extractFail('DOC_CORRUPT', `${path} missing`);
        const root = parseXml(xml).documentElement;
        if (localName(root) !== 'sec') extractFail('DOC_CORRUPT', `${path} is not a section`);

        let firstInSection = si > 0;
        // 최상위 문단 + 그 문단의 글상자(뒤에 이어서)를 명시적 큐로 — 글상자 중첩이 깊어도 스택 안전.
        for (const para of childrenNamed(root, 'p')) {
          processed += 1;
          if (processed % YIELD_EVERY === 0) {
            await new Promise((r) => setTimeout(r, 0));
            opts.onProgress?.(si, sections.length);
          }
          throwIfAborted(opts.signal);

          const r = readParagraph(para, 0, tableText);
          const breakBefore = firstInSection || attr(para, 'pageBreak') === '1';
          firstInSection = false;
          const level = outline.get(attr(para, 'paraPrIDRef') ?? '');
          if (r.parts.length === 0) {
            // 빈 문단도 쪽나눔은 전한다(paginate 가 빈 breakBefore 블록을 flush 로 처리한다).
            if (breakBefore) blocks.push({ text: '', breakBefore: true });
          }
          for (const [i, text] of r.parts.entries()) {
            if (i === 0 && level !== undefined && text.trim()) headingAt.push({ level, title: text.trim().split('\n')[0]!, blockIndex: blocks.length });
            blocks.push({ text, breakBefore: i === 0 && breakBefore });
          }
          // 글상자는 떠 있는 개체 — 쪽나눔·제목을 만들지 않는다.
          for (const box of r.boxes) {
            const text = containerText(box, 1, tableText);
            if (text.trim()) blocks.push({ text, breakBefore: false });
          }
        }
      }
      opts.onProgress?.(sections.length, sections.length);

      const { units, unitOfBlock } = paginate(blocks);
      if (units.length === 0 || !units.some((u) => u.trim())) extractFail('DOC_NO_TEXT', 'no text in document');
      if (units.length > MAX_PAGE_COUNT) {
        extractFail('PDF_TOO_MANY_PAGES', `unit count ${units.length} exceeds ${MAX_PAGE_COUNT}`,
          { pages: String(units.length), max: String(MAX_PAGE_COUNT) });
      }
      const headings: ExtractedHeading[] = headingAt.map((h) => ({ level: h.level, title: h.title, unitIndex: unitOfBlock[h.blockIndex] ?? 0 }));
      return { units, images: [], headings, unitKind: 'page' };
    },
  };
}

export const hwpxExtractor: Extractor = createHwpxExtractor();
```

`registry.ts`: `ZIP_EXTRACTORS = [docxExtractor, pptxExtractor, hwpxExtractor]`.

> ⚠️ 구현자 확인 사항: `paginate` 가 빈 `breakBefore` 블록을 flush 로 처리한다는 전제(QA34 에 고정된 동작 — paginate.test.ts)를 확인한다. 두 번째 섹션 테스트가 실패하면 paginate 를 고치지 말고 멈춰서 보고한다.

- [ ] **Step 9: 통과 확인** — Run: `npx vitest run src/renderer/lib/extract src/shared` → PASS

- [ ] **Step 10: 비공허 증명 + 커밋** — 뮤테이션: ① `SKIPPED` 에서 `'shapeComment'` 제거 ② `attr(para, 'pageBreak') === '1'` → `!!attr(para, 'pageBreak')`(표의 CELL 과 문단의 "0" 도 쪽나눔으로 — 테스트가 잡아야 한다) ③ `drawText` 분기 삭제 ④ `firstInSection = si > 0` → `false` ⑤ `headingOf` 의 switch 분기 삭제. 실패 요약 기록.

```bash
npx tsc --noEmit
git add src/shared src/renderer/lib/extract
git commit -m "feat(extract): HWPX 추출기 — 섹션·문단·쪽나눔·개요 제목·글상자 (P4)

<실물 규칙 요약 + 뮤테이션 실패 요약>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: HWPX 표 — cellAddr 좌표 배치 · 중첩

**Files:**
- Modify: `src/renderer/lib/extract/hwpx.ts` (naiveTableText → gridTableText, 기본값 교체)
- Test: `src/renderer/lib/extract/__tests__/hwpx.test.ts`

**Interfaces:**
- Consumes: `placeGridCells`/`GridCell`(Task 2), `containerText`(Task 7, hwpx.ts 내부), `toGfmTable`
- Produces: hwpx.ts 내부 `gridTableText(tbl: Element, depth: number): string`, `flattenGrid(rows: string[][]): string`

**배경:** 가려진 칸이 XML 에 없다. `hp:tbl/@rowCnt·@colCnt` 격자에 `hp:tc > hp:cellAddr(@colAddr,@rowAddr)` + `hp:cellSpan(@colSpan,@rowSpan)` 으로 놓는다. `hp:subList` 가 `cellAddr` 앞에 온다(자식 순서에 기대지 않는다). 좌표가 없는 셀(손상)은 그 행에서 비어 있는 다음 칸에 놓는다. 중첩 표(셀 안 표)는 GFM 이 셀 안 표를 담을 수 없어 **평탄화**(행 `; `, 칸 ` / ` — DOCX flattenTable 과 같은 규칙).

- [ ] **Step 1: 실패 테스트** (`hwpx.test.ts` 에 추가)

```ts
describe('hwpx 표 (실물: 가려진 칸은 XML 에 없다)', () => {
  const tc = (row: number, col: number, text: string, rowSpan = 1, colSpan = 1) =>
    `<hp:tc><hp:subList>${p(run(t(text)))}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/><hp:cellSz width="1" height="1"/></hp:tc>`;
  const tbl = (rows: number, cols: number, trs: string[]) => `<hp:tbl rowCnt="${rows}" colCnt="${cols}" pageBreak="CELL">${trs.map((r) => `<hp:tr>${r}</hp:tr>`).join('')}</hp:tbl>`;

  it('세로 병합으로 가려진 칸이 없어도 열이 밀리지 않는다 — 분류 텍스트는 아래 행에 복사', async () => {
    const table = tbl(2, 3, [tc(0, 0, '분류', 2) + tc(0, 1, '항목') + tc(0, 2, '값'), tc(1, 1, '달성률') + tc(1, 2, '100%')]);
    const doc = await extract(hwpx([sec(p(run(table)))]));
    expect(doc.units[0]).toBe('| 분류 | 항목 | 값 |\n| --- | --- | --- |\n| 분류 | 달성률 | 100% |');
  });

  it('가로 병합은 첫 칸에만 텍스트', async () => {
    const table = tbl(2, 2, [tc(0, 0, '머리', 1, 2), tc(1, 0, 'a') + tc(1, 1, 'b')]);
    const doc = await extract(hwpx([sec(p(run(table)))]));
    expect(doc.units[0]).toBe('| 머리 |  |\n| --- | --- |\n| a | b |');
  });

  it('셀 안의 표는 평탄화한다(행 "; ", 칸 " / ")', async () => {
    const inner = tbl(2, 2, [tc(0, 0, 'i1') + tc(0, 1, 'i2'), tc(1, 0, 'i3') + tc(1, 1, 'i4')]);
    const outer = tbl(1, 1, [`<hp:tc><hp:subList>${p(run(t('밖') + inner))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`]);
    const doc = await extract(hwpx([sec(p(run(outer)))]));
    expect(doc.units[0]).toContain('밖');
    expect(doc.units[0]).toContain('i1 / i2; i3 / i4');
  });

  it('rowCnt/colCnt 가 병리 값이어도 256 으로 자른다', async () => {
    const doc = await extract(hwpx([sec(p(run(tbl(1, 1e9, [tc(0, 0, 'a')]))))]));
    expect(doc.units[0]!.split('\n')[0]!.split('|').length - 2).toBe(256);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/hwpx.test.ts` → FAIL (naive 배치가 열을 밀고, 셀 안 표 텍스트가 GFM 표로 섞인다)

- [ ] **Step 3: 구현** (`hwpx.ts` — `naiveTableText` 를 지우고 아래로 교체, `createHwpxExtractor` 의 기본값을 `gridTableText` 로)

```ts
import { toGfmTable, placeGridCells, type GridCell } from './table';

function intAttr(el: Element | undefined, name: string, fallback: number): number {
  const n = el ? Number.parseInt(attr(el, name) ?? '', 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 표 → 직사각형 행렬. 셀은 cellAddr 좌표로 놓는다(가려진 칸이 XML 에 없다 — 실물 28개 표 전부). */
function tableGrid(tbl: Element, depth: number): string[][] {
  const trs = childrenNamed(tbl, 'tr');
  const cells: GridCell[] = [];
  let maxCol = 0;
  for (const [ri, tr] of trs.entries()) {
    let nextCol = 0;
    for (const tc of childrenNamed(tr, 'tc')) {
      const addr = childrenNamed(tc, 'cellAddr')[0];
      const span = childrenNamed(tc, 'cellSpan')[0];
      const row = intAttr(addr, 'rowAddr', ri);
      const col = intAttr(addr, 'colAddr', nextCol);
      const colSpan = Math.max(1, intAttr(span, 'colSpan', 1));
      const sl = childrenNamed(tc, 'subList')[0];
      // 셀 안의 표는 GFM 셀에 담을 수 없어 평탄화한다.
      const text = sl ? containerText(sl, depth, flattenTableText) : '';
      cells.push({ row, col, rowSpan: Math.max(1, intAttr(span, 'rowSpan', 1)), colSpan, text });
      nextCol = col + colSpan;
      maxCol = Math.max(maxCol, nextCol);
    }
  }
  return placeGridCells(cells, intAttr(tbl, 'rowCnt', trs.length), intAttr(tbl, 'colCnt', maxCol));
}

function flattenTableText(tbl: Element, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return '';
  return tableGrid(tbl, depth)
    .map((row) => row.map((c) => c.replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some((c) => c !== ''))
    .map((row) => row.join(' / '))
    .join('; ');
}

/** 최상위(본문·글상자)의 표 → GFM 표. */
function gridTableText(tbl: Element, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return flattenTableText(tbl, depth);
  return toGfmTable(tableGrid(tbl, depth));
}
```

`createHwpxExtractor` 의 `const tableText = deps.tableText ?? naiveTableText;` → `?? gridTableText`. `tableGrid` 의 `intAttr(addr, 'colAddr', nextCol)` 폴백은 "좌표 없는 셀은 행에서 다음 칸" 규칙이고, `placeGridCells` 의 "먼저 놓인 칸이 이긴다" 가 겹침을 막는다.

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/hwpx.test.ts` → PASS (Task 7 테스트 포함)

- [ ] **Step 5: 비공허 증명 + 커밋** — 뮤테이션: ① `intAttr(addr, 'colAddr', nextCol)` → `nextCol`(좌표 무시) ② `containerText(sl, depth, flattenTableText)` → `containerText(sl, depth, gridTableText)`(중첩 표가 GFM 로 섞임). 실패 요약 기록.

```bash
npx tsc --noEmit
git add src/renderer/lib/extract
git commit -m "feat(extract): HWPX 표를 cellAddr 좌표로 격자에 놓는다 (P4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: HWPX 그림 + 이미지 분석 OFF 필터

**Files:**
- Modify: `src/renderer/lib/extract/hwpx.ts` (그림 수집)
- Modify: `src/renderer/lib/document-open.ts:69` (`isNotMediaPart` 에 `BinData/`)
- Test: `src/renderer/lib/extract/__tests__/hwpx.test.ts`, `src/renderer/lib/__tests__/document-open-unitkind.test.ts`

**Interfaces:**
- Consumes: `ParaOut.pics`(Task 7), `OcfPackage.items`(Task 6), `ImageFitter`(BMP 수용 — Task 2), `MAX_TOTAL_IMAGES`/`MAX_EXAMINED_IMAGES`
- Produces: `isNotMediaPart` 가 `BinData/…` 도 거른다

**배경:** `hp:pic > hc:img/@binaryItemIDRef` → manifest `item id` → 경로(`BinData/imageN.bmp`). 실물 그림은 전부 **표 셀 안**이었다(인라인) — 셀 안 그림은 그 표가 속한 최상위 문단의 블록에 붙인다. **header.xml 의 글머리표 그림(`hh:bullet > hc:img`)은 본문이 아니다** — 섹션의 `hp:pic` 에서만 모은다(manifest·BinData 를 열거하지 않는다). 이미지 분석 OFF 에서 `word/media`·`ppt/media` 는 해제를 건너뛰는데(QA34) `BinData/` 는 빠져 있다.

- [ ] **Step 1: 실패 테스트**

`hwpx.test.ts`:

```ts
describe('hwpx 그림', () => {
  function bmp(w: number, h: number): Uint8Array {
    const b = new Uint8Array(54); b[0] = 0x42; b[1] = 0x4d;
    const v = new DataView(b.buffer); v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
    return b;
  }
  const codec = { async reencode() { return { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' as const }; } };
  const xi = createHwpxExtractor({ fitImage: createImageFitter(codec) });
  const pic = (ref: string) => `<hp:pic><hp:shapeComment>그림입니다.</hp:shapeComment><hc:img binaryItemIDRef="${ref}"/></hp:pic>`;
  const items = '<opf:item id="image1" href="BinData/image1.bmp" media-type="image/bmp"/><opf:item id="image2" href="BinData/image2.png" media-type="image/png"/>';

  it('섹션의 hp:pic 을 그 문단의 단위에 매핑한다 — 셀 안 그림 포함, BMP 는 재인코딩', async () => {
    const cellPic = `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>${p(run(pic('image1')))}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
    const doc = await xi.extract(hwpx(
      [sec(p(run(t('첫 쪽'))) + p(run(t('둘째 쪽') + cellPic), 'pageBreak="1"'))],
      { manifestItems: items, extra: { 'BinData/image1.bmp': bmp(200, 100) } },
    ), { extractImages: true });
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0]).toMatchObject({ unitIndex: 1, mimeType: 'image/jpeg', width: 200, height: 100 });
  });

  it('header.xml 의 글머리표 그림은 본문 그림이 아니다', async () => {
    const header = `<hh:head ${NS}><hh:bullet useImage="1">${'<hc:img binaryItemIDRef="image2"/>'}</hh:bullet></hh:head>`;
    const doc = await xi.extract(hwpx([sec(p(run(t('본문'))))], { header, manifestItems: items, extra: { 'BinData/image2.png': bmp(200, 100) } }), { extractImages: true });
    expect(doc.images).toEqual([]);
  });

  it('extractImages=false 면 그림을 모으지 않는다', async () => {
    const doc = await xi.extract(hwpx([sec(p(run(t('a') + pic('image1'))))], { manifestItems: items, extra: { 'BinData/image1.bmp': bmp(200, 100) } }), { extractImages: false });
    expect(doc.images).toEqual([]);
  });
});
```

(`createImageFitter` import 를 파일 상단에 추가한다.)

`document-open-unitkind.test.ts` 의 기존 필터 테스트(`이미지 분석 OFF 면 그림 파트를 풀지 않는 필터를…`)에 한 줄 추가: `expect(filter!('BinData/image1.bmp')).toBe(false);` 와 `expect(filter!('Contents/section0.xml')).toBe(true);`.

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/lib/extract/__tests__/hwpx.test.ts src/renderer/lib/__tests__/document-open-unitkind.test.ts` → FAIL

- [ ] **Step 3: 구현**

`document-open.ts:69-71`:

```ts
/**
 * 그림 파트 — 이미지 분석 OFF 면 풀지 않는다. OOXML 은 `<파트>/media/`(word/media · ppt/media),
 * HWPX 는 `BinData/` 에 둔다. 본문 XML·rels 는 절대 여기 들어오지 않는다.
 */
export function isNotMediaPart(name: string): boolean {
  return !/^(?:[^/]+\/media|BinData)\//i.test(name);
}
```

`hwpx.ts` — `createHwpxExtractor` 에서 `void (deps.fitImage ?? fitImage);` 를 `const fit = deps.fitImage ?? fitImage;` 로 바꾸고, 블록을 쌓는 루프에서 그림 위치를 기록한다. `readParagraph` 의 `pics[].part` 는 그 문단의 `parts` 인덱스이므로, 블록 인덱스로 옮긴다:

```ts
      const imageAt: { ref: string; blockIndex: number }[] = [];
      …
          const firstBlock = blocks.length;
          for (const [i, text] of r.parts.entries()) { … blocks.push(…) }
          // 그림이 속한 조각의 블록. 조각이 없는 문단(그림만 있는 문단)은 직전 블록(없으면 0)에 붙인다.
          for (const pic of r.pics) {
            const blockIndex = r.parts.length === 0 ? Math.max(0, blocks.length - 1) : firstBlock + Math.min(pic.part, r.parts.length - 1);
            imageAt.push({ ref: pic.ref, blockIndex });
          }
```

셀 안 그림: `readParagraph` 는 `tbl` 서브트리를 건너뛰므로 셀 안의 `hp:pic` 을 보지 못한다. 표를 만난 자리에서 표 안의 그림도 기록한다 — `skip` 의 `tbl` 분기를 다음으로 바꾼다:

```ts
    if (name === 'tbl') {
      flush();
      // 셀 안 그림 — 셀 경계는 단위 경계가 아니므로 표 블록에 붙인다(실물 그림 4개가 전부 셀 안이었다).
      for (const e of walk(el, (x) => SKIPPED.has(localName(x)))) {
        if (localName(e) !== 'img') continue;
        const ref = attr(e, 'binaryItemIDRef');
        if (ref) out.pics.push({ ref, part: out.parts.length });
      }
      const tb = tableText(el, depth + 1);
      if (tb) out.parts.push(tb);
      return true;
    }
```

(`SKIPPED` 에 `shapeComment` 가 있지만 `hc:img` 는 `hp:pic` 의 직계 자식이라 건너뛰지 않는다.)

반환 직전에 그림을 모은다:

```ts
      const images: ExtractedImage[] = [];
      let imageBudgetExceeded = false;
      if (opts.extractImages !== false && imageAt.length > 0 && pkg) {
        const seen = new Set<string>();
        let examined = 0;
        for (const { ref, blockIndex } of imageAt) {
          throwIfAborted(opts.signal);
          if (examined >= MAX_EXAMINED_IMAGES) break;
          examined += 1;
          const path = pkg.items.get(ref)?.path;
          if (!path || seen.has(path)) continue;
          const bytes = zip.bytes(path);
          if (!bytes) continue;
          seen.add(path);
          if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
          const fitted = await fit(bytes);
          if (fitted) images.push({ unitIndex: unitOfBlock[blockIndex] ?? 0, ...fitted });
        }
      }
      return { units, images, headings, unitKind: 'page', ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}) };
```

(`MAX_EXAMINED_IMAGES`·`MAX_TOTAL_IMAGES`·`ExtractedImage` import 추가.)

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/renderer/lib` → PASS

- [ ] **Step 5: 비공허 증명 + 커밋** — 뮤테이션: ① `tbl` 분기의 그림 기록 루프 삭제 ② `isNotMediaPart` 에서 `|BinData` 삭제 ③ 그림 조회를 `pkg.items` 대신 `zip.names().filter(n => n.startsWith('BinData/'))` 열거로(글머리표 테스트가 잡아야 한다). 실패 요약 기록.

```bash
npx tsc --noEmit
git add src/renderer/lib
git commit -m "feat(extract): HWPX 그림(BMP 포함) · 이미지 분석 OFF 에서 BinData 미해제 (P4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: E2E — PPTX·HWPX 열기 → 인용 점프 → 슬라이드 라벨

**Files:**
- Create: `e2e/fixtures/make-pptx.ts`, `e2e/fixtures/make-hwpx.ts`
- Create: `e2e/office-open.spec.ts`

**Interfaces:**
- Consumes: `launchElectron`, `sendDropPath`, `cleanupDir`(e2e/helpers.ts), docx-open.spec.ts 의 세션 주입 절차(1차 기동 → flush 문서 드롭 → manifest 에서 docHash → session.json 에 `[p.2]` 요약 주입 → 2차 기동)
- Produces: `writeSamplePptx(path)`, `writeSampleHwpx(path)`

**배경:** 유닛 테스트는 추출기를 증명하지만 **배선**(document-formats 등록 → 게이트 → 지연 로드된 레지스트리 → normalize → 뷰어·라벨)은 실앱에서만 끝까지 증명된다. DOCX 에서 유닛 2697건이 초록인데 확대·축소가 완전히 죽어 있던 전례(P1). 특히 PPTX 는 첫 'slide' 문서라 **라벨이 실제로 "슬라이드 2" 로 보이는지**가 핵심 단언이다. 드롭 경로는 IPC(`sendDropPath`)라 DOM 드롭 게이트는 App.drop.test 가 맡는다.

- [ ] **Step 1: PPTX 픽스처 빌더** (`e2e/fixtures/make-pptx.ts`, 전체)

```ts
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 합성 PPTX 픽스처(실물은 개인정보가 있어 커밋하지 않는다). 실물 조사에서 조용히 틀리던 자리를
 * 일부러 담는다: rels 의 rId 를 슬라이드 순서와 반대로(파일명·rId 정렬 금지), 모든 슬라이드에
 * Google 식 `‹#›` 슬라이드 번호, 둘째 슬라이드에 제목 자리표시자·자기 닫힘 병합 표·발표자 노트.
 */
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const sp = (text: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>`
  + `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slideNum = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>`
  + `<p:txBody><a:bodyPr/><a:p><a:fld id="{0}" type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`;
const slide = (inner: string) => `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${inner}${slideNum}</p:spTree></p:cSld></p:sld>`;
const tc = (text: string) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const table = `<p:graphicFrame><p:nvGraphicFramePr/><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>`
  + `<a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>`
  + `<a:tr h="1">${tc('항목').replace('<a:tc>', '<a:tc rowSpan="2">')}${tc('매출')}</a:tr>`
  + `<a:tr h="1"><a:tc vMerge="1"/>${tc('영업이익')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const notes = `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sp('', 'sldImg')}${sp('근거 수치는 부록 참조', 'body')}</p:spTree></p:cSld></p:notes>`;

export function writeSamplePptx(path: string): void {
  const ids = ['rId9', 'rId8', 'rId7']; // 슬라이드 1·2·3 — rId 가 역순
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8(`<Relationships ${REL}><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${ids.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join('')}</p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<Relationships ${REL}>${ids.map((id, i) => `<Relationship Id="${id}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`),
    'ppt/slides/slide1.xml': strToU8(slide(sp('첫 슬라이드 본문'))),
    'ppt/slides/slide2.xml': strToU8(slide(sp('분기 실적 요약') + sp('둘째 슬라이드', 'title') + table)),
    'ppt/slides/_rels/slide2.xml.rels': strToU8(`<Relationships ${REL}><Relationship Id="rId2" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`),
    'ppt/notesSlides/notesSlide1.xml': strToU8(notes),
    'ppt/slides/slide3.xml': strToU8(slide(sp('셋째 슬라이드 본문'))),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zipSync(files));
}
```

- [ ] **Step 2: HWPX 픽스처 빌더** (`e2e/fixtures/make-hwpx.ts`, 전체)

```ts
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 합성 HWPX 픽스처(실물은 개인정보가 있어 커밋하지 않는다 — 설계 §11 A1). 실물 조사의 함정을
 * 담는다: rootfile 3개, spine 에 header, 표의 pageBreak="CELL", 세로 병합으로 **가려진 칸 생략**,
 * subList 가 cellAddr 보다 앞, 글상자(drawText) 안의 본문, shapeComment 자동 문구, 잘린 PrvText.
 */
const NS = 'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"';
const p = (inner: string, attrs = '') => `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0" ${attrs}>${inner}</hp:p>`;
const run = (inner: string) => `<hp:run charPrIDRef="0">${inner}</hp:run>`;
const t = (s: string) => `<hp:t>${s}</hp:t>`;
const tc = (row: number, col: number, text: string, rowSpan = 1) =>
  `<hp:tc><hp:subList>${p(run(t(text)))}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="${rowSpan}"/><hp:cellSz width="1" height="1"/></hp:tc>`;
const table = `<hp:tbl rowCnt="2" colCnt="3" pageBreak="CELL">`
  + `<hp:tr>${tc(0, 0, '분류', 2)}${tc(0, 1, '항목')}${tc(0, 2, '달성률')}</hp:tr>`
  + `<hp:tr>${tc(1, 1, '기능 개발')}${tc(1, 2, '100%')}</hp:tr></hp:tbl>`;
const box = `<hp:rect><hp:shapeComment>사각형입니다.</hp:shapeComment><hp:drawText><hp:subList>${p(run(t('상자 안 제목')))}</hp:subList></hp:drawText></hp:rect>`;
const section = `<?xml version="1.0"?><hs:sec ${NS}>`
  + p(run(t('첫 쪽의 내용입니다')))
  + p(run(t('둘째 쪽의 내용입니다') + box), 'pageBreak="1"')
  + p(run(table))
  + `</hs:sec>`;

export function writeSampleHwpx(path: string): void {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/hwp+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles>'
      + '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>'
      + '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>'),
    'Contents/content.hpf': strToU8('<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>'
      + '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>'
      + '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>'
      + '</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'),
    'Contents/header.xml': strToU8('<?xml version="1.0"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"/>'),
    'Contents/section0.xml': strToU8(section),
    'Preview/PrvText.txt': strToU8('첫 쪽의 내'),
  };
  mkdirSync(dirname(path), { recursive: true });
  // mimetype 은 첫 엔트리·무압축(OCF 규약, 실물도 그렇다).
  writeFileSync(path, zipSync(files, { level: 0 }));
}
```

- [ ] **Step 3: 스펙 작성** (`e2e/office-open.spec.ts`, 전체) — `docx-open.spec.ts` 의 세션 주입 절차를 공용 함수로 쓴다. 포맷마다 test 하나(실패 시 어느 포맷인지 바로 보이게).

```ts
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchElectron, sendDropPath, cleanupDir } from './helpers';
import { writeSamplePptx } from './fixtures/make-pptx';
import { writeSampleHwpx } from './fixtures/make-hwpx';

/**
 * E2E — PPTX·HWPX 열기 → 인용 점프 → 단위 라벨(P4).
 *
 * 유닛 테스트는 추출기를 증명하지만 배선(document-formats 등록 → 게이트 → 지연 로드된 레지스트리 →
 * normalize → 뷰어·라벨)은 실앱에서만 끝까지 증명된다. 인용 버튼은 docx-open.spec.ts 와 같은 실제
 * 경로로 만든다: 한 번 열어 세션을 만들고 → 다른 문서로 flush → session.json 에 `[p.2]` 요약을
 * 심고 → 다시 열어 docHash 일치로 복원.
 */
const SEED = { provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light', persistSessions: true };

async function makeFlushPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('flush-only document', { x: 50, y: 780, size: 12, font });
  return Buffer.from(await doc.save());
}

interface ManifestEntry { docHash: string; fileName: string; unitKind?: string }

/** 1차 기동으로 세션을 만들고 flush 한 뒤, 그 세션에 `[p.2]` 인용 요약을 심는다. manifest 항목을 돌려준다. */
async function seedSessionWithCitation(userDataDir: string, docsDir: string, fixture: string, header: string): Promise<ManifestEntry> {
  const buf = readFileSync(fixture);
  const r1 = await launchElectron(userDataDir, SEED);
  try {
    await expect(r1.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    await sendDropPath(r1.app, fixture, buf.toString('base64'));
    await expect(r1.page.getByText(header)).toBeVisible({ timeout: 60000 });
    await r1.page.waitForTimeout(2000);
    const flushPath = join(docsDir, 'flush.pdf');
    const flushBuf = await makeFlushPdf();
    writeFileSync(flushPath, flushBuf);
    await sendDropPath(r1.app, flushPath, flushBuf.toString('base64'));
    await expect(r1.page.getByText('flush.pdf (1p)')).toBeVisible({ timeout: 30000 });
    await r1.page.waitForTimeout(500);
    expect(r1.pageErrors.map((e) => e.message), '1차 렌더러 에러').toEqual([]);
  } finally {
    await r1.app.close().catch(() => { /* 이미 종료 */ });
  }
  const manifest = JSON.parse(readFileSync(join(userDataDir, 'sessions', 'manifest.json'), 'utf-8')) as { entries: ManifestEntry[] };
  const name = fixture.split(/[\\/]/).pop()!;
  const entry = manifest.entries.find((e) => e.fileName === name);
  if (!entry) throw new Error(`${name} 세션이 flush 되지 않았다`);
  const sessionPath = join(userDataDir, 'sessions', entry.docHash, 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as { summaries: Record<string, unknown>; summaryType: string };
  session.summaries.full = { content: '요약입니다. 근거는 [p.2] 를 보세요.', model: 'e2e-fixture', provider: 'claude' };
  session.summaryType = 'full';
  writeFileSync(sessionPath, JSON.stringify(session), 'utf-8');
  return entry;
}

async function openCitation(page: Page, name: RegExp) {
  const cite = page.getByRole('button', { name }).first();
  await expect(cite).toBeVisible({ timeout: 30000 });
  await cite.click();
  await expect(page.locator('#unit-2')).toBeVisible({ timeout: 15000 });
  return page.locator('[data-testid="doc-text-viewer"]');
}

test('PPTX — 슬라이드 순서·라벨·표·노트, 번호 필드 미유입, 전역 검색 라벨', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-pptx-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-pptx-docs-'));
  try {
    const fixture = join(docsDir, 'sample.pptx');
    writeSamplePptx(fixture);
    const entry = await seedSessionWithCitation(userDataDir, docsDir, fixture, 'sample.pptx (3슬라이드)');
    expect(entry.unitKind, 'manifest 가 unitKind 를 싣는다').toBe('slide');

    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      // 전역 검색(Task 1 실앱 증명) — 표 안 단어가 2번 슬라이드에서 "슬라이드 2" 로 표시된다.
      await r2.page.getByLabel('문서 검색').fill('영업이익');
      await r2.page.getByRole('button', { name: '검색' }).click();
      await expect(r2.page.getByText('슬라이드 2', { exact: true })).toBeVisible({ timeout: 15000 });

      await sendDropPath(r2.app, fixture, readFileSync(fixture).toString('base64'));
      await expect(r2.page.getByText('sample.pptx (3슬라이드)')).toBeVisible({ timeout: 60000 });

      const viewer = await openCitation(r2.page, /슬라이드 2 원문 열기$/);
      await expect(r2.page.locator('#unit-2')).toHaveAttribute('aria-label', '슬라이드 2');
      // 제목 자리표시자가 본문보다 앞(spTree 에서는 뒤에 있다), 노트는 인용부.
      const unit2 = await r2.page.locator('#unit-2').innerText();
      expect(unit2.indexOf('둘째 슬라이드')).toBeLessThan(unit2.indexOf('분기 실적 요약'));
      await expect(r2.page.locator('#unit-2 blockquote')).toContainText('근거 수치는 부록 참조');
      // 자기 닫힘 병합 칸(Google 형식)이 위 칸 텍스트를 이어받아 열이 밀리지 않는다.
      await expect(r2.page.locator('#unit-2 table tbody tr').first().locator('td').first()).toHaveText('항목');
      // 슬라이드 번호 필드(‹#›)가 어느 단위에도 들어가지 않는다.
      await expect(viewer).not.toContainText('‹#›');

      expect(r2.pageErrors.map((e) => e.message), '2차 렌더러 에러').toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});

test('HWPX — 쪽나눔·좌표 격자 표·글상자, shapeComment·미리보기 미유입', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwpx-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwpx-docs-'));
  try {
    const fixture = join(docsDir, 'sample.hwpx');
    writeSampleHwpx(fixture);
    await seedSessionWithCitation(userDataDir, docsDir, fixture, 'sample.hwpx (2p)');

    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
      await sendDropPath(r2.app, fixture, readFileSync(fixture).toString('base64'));
      await expect(r2.page.getByText('sample.hwpx (2p)')).toBeVisible({ timeout: 60000 });

      const viewer = await openCitation(r2.page, /2 페이지 원문 열기$/);
      await expect(r2.page.locator('#unit-2')).toContainText('상자 안 제목');
      // 세로 병합으로 가려진 칸이 XML 에 없어도 둘째 행이 [분류 | 기능 개발 | 100%] 로 맞게 놓인다.
      const row = r2.page.locator('#unit-2 table tbody tr').first().locator('td');
      await expect(row).toHaveText(['분류', '기능 개발', '100%']);
      await expect(viewer).not.toContainText('사각형입니다');

      expect(r2.pageErrors.map((e) => e.message), '2차 렌더러 에러').toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});
```

(주: HWPX 픽스처는 "첫 쪽" 문단 뒤에 `pageBreak="1"` 문단이 와서 2단위다 — 표와 글상자는 2번 단위에 들어간다. PPTX 의 `(3슬라이드)` 는 Task 1 의 `unit.countShort.slide` 문구다 — 그 문구를 바꾸면 이 단언도 함께 바꾼다.)

- [ ] **Step 4: 실행** — Run: `npx tsc -p tsconfig.e2e.json --noEmit` 후 `npm run build && npx playwright test e2e/office-open.spec.ts` → PASS

- [ ] **Step 5: 비공허 증명** — 뮤테이션 두 개를 빌드에 걸고 스펙을 돌린다(각각 `npm run build` 필요): ① `registry.ts` 에서 `pptxExtractor` 제거 → PPTX 테스트 실패(DOC_UNSUPPORTED 배너) ② `GlobalSearch.tsx` 의 `r.unitKind ?? 'page'` → `'page'` → 검색 단언 실패. 실패 줄 기록 후 원복·재빌드.

- [ ] **Step 6: 스크린샷 확인** — 임시 스펙(커밋하지 않음)으로 PPTX 원문 패널과 HWPX 표를 스크린샷 찍어 **눈으로 본다**. 테스트는 색·간격·겹침을 보지 못한다 — QA34 에서 표 셀 간격이 없던 결함이 이 단계에서만 잡혔다. 이상이 있으면 수정 태스크를 추가하고 멈춰 보고한다.

- [ ] **Step 7: 커밋**

```bash
npx tsc -p tsconfig.e2e.json --noEmit
git add e2e
git commit -m "test(e2e): PPTX·HWPX 열기 → 인용 점프 → 슬라이드 라벨·검색 라벨 (P4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 실물 스모크(로컬 전용) · 문서 · 릴리즈 준비

**Files:**
- Modify: `docs/02-design/features/multiformat-input.design.md` (검증 상태 표, §11 A2/A3)
- Modify: `README.md`, `README.ko.md` (지원 형식 문구 · 설치/사용 · 알려진 한계)
- Modify: `CLAUDE.md` (입력 포맷 줄)
- (커밋하지 않음) 실물 스모크 스크립트 — scratchpad

**배경:** 합성 픽스처는 실물의 기벽을 못 밟는다(설계 §8.1). 실물은 개인정보가 있어 커밋할 수 없으므로 **로컬에서 한 번 돌려 결과만 기록**한다. 대조 기준은 "우리 추출 결과 ↔ XML 을 직접 읽은 값"이지 "초록" 이 아니다.

- [ ] **Step 1: 실물 스모크** — scratchpad 에 vitest 스크립트를 두고(저장소 밖) `~/Downloads` 의 `.pptx` 전부와 `.hwpx` 전부를 `pptxExtractor`/`hwpxExtractor` 로 추출한다. 파일마다 기록: 단위 수 = 슬라이드 수(sldIdLst 길이) · 비어 있지 않은 단위 비율 · `‹#›` 포함 단위 수(0 이어야) · 제목 수 · 그림 수(BMP 포함 HWPX 는 >0) · 표 수 · **HWPX 표의 GFM 행 폭이 모두 colCnt 와 같은지** · shapeComment 문구("그림입니다") 포함 여부(0). 결과표(파일명 대신 F1…Fn)를 PR 본문에 붙인다. 기대와 다르면 **테스트를 추가해 재현한 뒤** 고친다.

- [ ] **Step 2: 설계 문서 갱신** — "검증 상태" 표의 `HWPX 이미지(BinData/)` → ✅(BMP 포함, 셀 안 인라인), `DOCX / PPTX / EPUB 세부 구조` 에서 PPTX → ✅(실물 34개). §11 A2 · A3(PPTX 부분) 처리 완료로. 새 발견(OPF href 루트 기준 · shapeComment · Google 자기 닫힘 셀)을 §3 에 한 단락씩.

- [ ] **Step 3: README · CLAUDE.md** — 지원 형식을 "PDF · Word · PowerPoint · 한글(HWPX)" 로(EPUB 예정). 알려진 한계 한 줄씩: PPTX 레이아웃·마스터에만 있는 문구는 읽지 않음, EMF/WMF 그림은 Vision 대상이 아님, HWPX 각주·미주는 본문에 넣지 않음. ko/en 동시.

- [ ] **Step 4: 전체 검증** — `npx tsc --noEmit` · `npx tsc -p tsconfig.e2e.json --noEmit` · `npx vitest run`(테스트 수가 기준선 2873 에서 늘었는지 **실제로 세서** 기록) · `npm run test:coverage`(드리프트 가드가 발화하면 게이트 상향 커밋) · `npm run build`(eager 청크 경계 ok — pptx/hwpx 가 지연 청크에 있는지 `out/renderer/assets/index-*.js` 에 `hwpml`·`presentationml` 문자열이 없는지 grep) · `npx playwright test`.

- [ ] **Step 5: 커밋**

```bash
git add docs README.md README.ko.md CLAUDE.md
git commit -m "docs: PPTX·HWPX 지원 반영 — 설계 검증 상태 · README(한/영) · CLAUDE.md (P4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

릴리즈는 이 계획 밖이다(사용자 요청 시 CLAUDE.md 절차). 판정은 **minor(v1.9.0)** — "이제 PowerPoint·한글 파일을 열 수 있습니다".

---

## 완료 기준

- [ ] `npx vitest run` 전체 통과, 테스트 수가 2873 보다 늘었다(실제로 센 값을 기록)
- [ ] `npx tsc --noEmit` · `npx tsc -p tsconfig.e2e.json --noEmit` 오류 0
- [ ] `npm run build` 성공, eager 청크 경계 ok, 추출기가 지연 청크에 있다
- [ ] `npx playwright test` — 새 스펙 3건 포함 통과
- [ ] 소스 가드: 포맷 리터럴·`p.` 라벨·개수 라벨·프롬프트 라벨 가드 전부 통과(양성 샘플 포함)
- [ ] 커버리지 드리프트 가드 통과(발화 시 게이트 상향)
- [ ] 각 태스크의 뮤테이션 실패 요약이 커밋 본문에 있다
- [ ] 실물 스모크 결과표(Task 11 Step 1)가 기대와 일치
- [ ] 스크린샷으로 PPTX 원문 패널·HWPX 표를 눈으로 확인했다
- [ ] PDF · DOCX 회귀 없음(기존 E2E·유닛 전부 통과)

## 이 계획 다음에 오는 것

- **P4b — EPUB**: 실물 샘플 확보가 선행(공개 도메인 전자책 — 예: Project Gutenberg 의 EPUB3 한 권 + 국내 전자책 서점 DRM 없는 샘플 한 권). `ocf.ts`(이 계획 Task 6)를 그대로 쓰고, `unitKind: 'chapter'` 와 "한 항목 20,000자 초과 시 문서 전체 page 강등"(설계 §1.3·§2) 이 핵심. 매니페스트의 `package` media-type 은 `application/oebps-package+xml`.
- HWPX 각주·미주를 본문에 넣을지(현재 제외) — 실물 샘플이 생기면 판단.
- PPTX 레이아웃에만 있는 서식 문구(양식 템플릿) — 필요 사례가 나오면 "슬라이드가 쓰는 레이아웃의 비-자리표시자 텍스트" 만 선택적으로.
