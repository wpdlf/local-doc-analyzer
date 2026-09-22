---
template: design
version: 1.0
feature: multiformat-input
date: 2026-09-22
author: jjw
project: local-doc-analyzer (개명 전 local-pdf-analyzer / summary-lecture-material)
version_project: 1.8.0
---

# 다중 포맷 문서 입력 (HWPX · DOCX · PPTX · EPUB) Design Document

> **Summary**: 입력을 PDF 하나에서 **HWPX · DOCX · PPTX · EPUB** 넷으로 넓힌다. 네 포맷 모두
> zip + XML 이므로 추출은 `fflate`(unzip) 하나와 렌더러의 내장 `DOMParser` 로 끝난다. 핵심 전략은
> **"포맷별 추출기 → 중간 표현 `ExtractedDoc` → 정규화 → 기존 `PdfDocument`"** 로, 요약 · Vision ·
> RAG · 전역검색 · 컬렉션 · 세션 영속화는 **한 줄도 바꾸지 않는다**.
>
> **Project**: local-doc-analyzer (이 릴리즈에서 local-pdf-analyzer 에서 개명 — §7)
> **Version**: 1.8.0 (minor — 기능 추가)
> **Author**: jjw
> **Date**: 2026-09-22
> **Status**: Designed (구현 전)
> **Depends on**: citation(`[p.N]`) 계약, session-persistence(PersistedSession), multi-doc 탭/컬렉션

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | `src/main/index.ts` 의 파일 필터가 `extensions: ['pdf']` 하나뿐이라 입력이 닫혀 있다. **HWPX 는 국내 자료의 상당수인데 아예 넣을 수 없다.** 마인드맵(v0.31.26) 이후 제품이 커진 것은 수식 렌더링 · 세로 분할 · 뷰어 줌뿐이고 나머지는 QA·수정이었다 — 제품을 키우는 축이 여기다. |
| **WHO** | 회의록 · 주간보고 · 제안서(HWPX/DOCX), 발표자료(PPTX), 전자책(EPUB) 을 다루는 사용자. 기존 PDF 사용자의 자연 확장. |
| **RISK** | ① 확장자 게이트가 5곳에 흩어져 있어 "한 곳만 안 따라감" 이 거의 확실하다 ② 표를 평문화하면 한국 사무 문서(표 중심)의 요약이 껍데기가 된다 ③ 페이지가 없는 포맷에서 `[p.N]` 인용이 앱의 척추인데 매핑이 미정이었다 ④ zip 폭탄 — 신뢰할 수 없는 파일을 파싱하는 앱이다 ⑤ 전면 개명이 자동 업데이트 체인을 새로 시작시킨다(끊길 기존 설치가 없음을 실측 확인 — §7.0). |
| **SCOPE** | 문서 4종 입력 + 텍스트 뷰어 + 표시 라벨 + 제품명 변경. **URL(웹페이지) 입력은 범위 밖** — 네트워크 페치 · HTML 정제 · 재읽기 불가 · 영속화가 이질적이라 별도 라운드. |

---

## §0. 확정된 결정 (브레인스토밍 2026-09-22)

| # | 결정 | 근거 |
|---|---|---|
| D1 | 1차 범위 = HWPX · DOCX · PPTX · EPUB. URL 은 후속 | 넷은 전부 zip+XML 이라 추출기 구조가 동일하고 "파일 경로 + 재읽기" 모델이 그대로 성립 |
| D2 | **인용은 내부적으로 `[p.N]` 을 유지**하고 표시 라벨만 포맷별 | `CITATION_REGEX` · `clampCitationPage` · `pageTexts` · RAG · 세션이 전부 "정수 N 하나" 위에 서 있다. 계약을 건드리지 않고도 사용자는 "슬라이드 3" 을 본다 |
| D3 | 원문 패널 = **텍스트 뷰어 신설** | 인용 클릭 → 근거 확인이 이 앱의 핵심 동작이다. 패널을 없애면 포맷마다 동작이 달라진다 |
| D4 | **이미지·Vision 포함** (단위 매핑까지) | PPTX 는 내용의 상당수가 차트·도표 이미지다. 빼면 빈 요약이 나온다 |
| D5 | DOCX·HWPX 가상 페이지 = **명시적 쪽나눠 우선 + 분량 보조** (한국어 A4 한 쪽 기준 1,800자, 문단 경계를 넘지 않음) | 작성자가 넣은 쪽나눠는 사용자가 보는 경계와 일치한다. 없는 구간만 분량으로 끊는다 |
| D6 | 추출기 구조 = **공통 인터페이스 + 포맷별 모듈** | `pdf-parser.ts` 가 이미 1,303줄이고 QA 에서 반복해 결함이 나온 파일이다. 같은 형태를 하나 더 만들지 않는다 |
| D7 | **표는 GFM 마크다운 표로 직렬화** | §3.1 의 실물 분석 결과. 평문화하면 열 대응이 사라진다 |
| D8 | 제품명 `PDF 자료 분석기` → **`로컬 문서 분석기`**(en: Local Doc Analyzer). `name` · `appId` · 저장소 이름까지 **전면 개명** | 이름이 내용과 어긋난다. 끊길 기존 설치가 없음을 실측으로 확인했으므로 반쪽 개명을 안고 갈 이유가 없다 — §7.0 |

---

## §1. 문서 모델과 추출기 계약

추출기는 `PdfDocument` 를 **직접 만들지 않는다.** 중간 표현 `ExtractedDoc` 을 내놓고, 정규화 함수
하나가 그것을 `PdfDocument` 로 옮긴다. 추출기가 직접 조립하면 QA 이력에 반복해 나온 **형제 누락**
(한 포맷만 새 필드를 안 채움 — QA26/QA27/QA32/QA33)이 그대로 재현된다.

```
src/renderer/lib/extract/
  types.ts       공통 계약 (ExtractedDoc · Extractor · ExtractOptions)
  zip.ts         fflate 래퍼 — 엔트리 목록/바이트 읽기 + 해제 총량·엔트리 수 상한
  ocf.ts         OCF/OPF 컨테이너 해석 (EPUB · HWPX 공용 — §3.1 참조)
  ooxml.ts       OOXML 공용 (rels 해석 · 표 직렬화 · 텍스트 수집)
  table.ts       표 → GFM 마크다운 표 직렬화 (전 포맷 공용)
  paginate.ts    명시적 쪽나눠 + 분량 보조 분할
  docx.ts  pptx.ts  hwpx.ts  epub.ts
  registry.ts    sniff → 추출기 선택
  normalize.ts   ExtractedDoc → PdfDocument
```

### 1.1 계약

```ts
export interface ExtractedDoc {
  units: string[];                 // 단위별 본문 → pageTexts
  images: ExtractedImage[];        // unitIndex(0-based) 를 가진 이미지
  headings: ExtractedHeading[];    // { level, title, unitIndex } — 포맷이 알려준 진짜 제목
  unitKind: 'page' | 'slide' | 'chapter';
  imageBudgetExceeded?: boolean;
}

export interface Extractor {
  id: 'docx' | 'pptx' | 'hwpx' | 'epub';
  extensions: readonly string[];
  sniff(zip: ZipIndex): boolean;
  extract(zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc>;
}
```

`ExtractOptions` 는 기존 `ParsePdfOptions` 와 같은 모양이다 — `extractImages` · `signal` ·
`onProgress`. 취소와 이미지 스킵 설정이 PDF 와 **같은 계약으로 흐르게** 해서 `use-summarize` 쪽
분기가 늘지 않도록 한다.

### 1.2 정규화 (`normalize.ts`)

| ExtractedDoc | → | PdfDocument |
|---|---|---|
| `units` | | `pageTexts`, `pageCount = units.length`, `extractedText = units.join('\n\n')` |
| `images[].unitIndex` | | `images[].pageIndex` (`PageImage` 그대로) |
| `headings` | | `chapters` — 포맷이 제목을 주므로 `detectChapters` 휴리스틱을 건너뛴다. 제목이 하나도 없으면 기존 `detectChapters(pageTexts)` 로 폴백 |
| `unitKind` | | `PdfDocument.unitKind` (신규 선택 필드, 없으면 `'page'`) |
| — | | `hadImages` · `imagesSkipped` · `imageBudgetExceeded` 마커를 **여기 한 곳에서** 채운다 |

### 1.3 `unitKind` 는 문서에 하나

단위마다 라벨을 싣는 방법(`"3장 (2/3)"` 이 가능해진다)도 있으나, 인용 · 세션 · 교차문서 라우팅이
전부 "정수 N 하나" 가정 위에 있어 배열을 끼우면 표시 계층만으로 끝나지 않고 계약이 번진다.
대신 **분할이 한 번이라도 일어나면 문서 전체를 `'page'` 로 강등**해 한 문서 안에서 라벨이 항상
일관되게 한다.

---

## §2. 포맷별 단위 · 이미지

| 포맷 | 단위 | `unitKind` | 분할 |
|---|---|---|---|
| PPTX | 슬라이드 (`p:sldIdLst` 순서) | `slide` | **하지 않음** |
| EPUB | spine 항목 (장) | `chapter` | 한 항목이 20,000자 초과 시에만 → 문서 전체 `page` 강등 |
| DOCX | 가상 페이지 | `page` | 명시적 쪽나눠 우선 + 1,800자 보조 |
| HWPX | 가상 페이지 | `page` | 위와 동일 |

**PPTX** — 텍스트는 슬라이드의 `a:t` 전부 + **발표자 노트**(`ppt/notesSlides/`)를 함께 담는다
(노트에 근거가 들어 있는 자료가 많다). 제목은 `type="title"` placeholder. 이미지는 슬라이드별
rels 의 image 관계라 매핑이 1:1로 떨어진다. 슬라이드는 슬라이드이므로 분할하지 않고, 분량 문제는
기존 `chunker.ts` 가 요약 단계에서 처리한다.

**DOCX** — `word/document.xml` 의 `w:body` 를 순회하며 `w:p`(문단) · `w:tbl`(§3.1 의 표 직렬화)을
텍스트화한다. 명시적 쪽나눠는 `w:br[w:type=page]` 와 `w:pPr/w:pageBreakBefore` 둘 다 본다. 제목은
`w:pStyle` 의 `Heading1~9`. 이미지는 `a:blip/@r:embed` → `word/_rels/document.xml.rels` →
`word/media/*` 를 따라가고, 그 `w:drawing` 이 속한 문단 위치로 `unitIndex` 를 정한다.

**EPUB** — `META-INF/container.xml` → OPF → `<spine>` 순서가 단위다. 각 XHTML 을 `DOMParser` 로
파싱해 `script`/`style`/`nav` 를 제거한 뒤 텍스트화한다. 제목은 OPF 의 `toc` 또는 nav 문서.

**HWPX** — §3 참조 (실물 확인 완료).

**공통 예산** — 이미지는 기존 `MAX_TOTAL_IMAGES`(50) · `MAX_EXAMINED_IMAGES`(400) 과 중복 제거
시그니처(`imageSignature`)를 **그대로 재사용**한다. 단위 수 상한은 기존 `MAX_PAGE_COUNT`(500) 을
이름만 일반화해 재사용한다.

---

## §3. HWPX — 실물 분석 결과

샘플: `주간업무보고_샘플.hwpx` (141KB, 한글 2023-12 저장본). **아래는 추측이 아니라 실물에서 확인한
사실이다.**

### 3.1 구조

```
mimetype                 application/hwp+zip
META-INF/container.xml   OCF 컨테이너 → rootfile: Contents/content.hpf
Contents/content.hpf     OPF 패키지 (opf:manifest + opf:spine)
Contents/header.xml      스타일 정의
Contents/section0.xml    본문 (섹션 단위로 section0, section1, ...)
Preview/PrvText.txt      평문 미리보기 — 사용하지 않는다 (아래 참조)
Preview/PrvImage.png     썸네일
```

**HWPX 는 EPUB 과 같은 OCF/OPF 컨테이너다.** `META-INF/container.xml` → OPF → spine 경로가
동일하므로 **`ocf.ts` 를 EPUB 과 공유한다.** (다만 spine 항목의 *의미* 는 다르다 — EPUB 은 장,
HWPX 는 본문 섹션 + 스타일/스크립트가 섞여 있어 `media-type` 으로 본문만 골라야 한다.)

본문 구조는 `hs:sec` → `hp:p`(문단) → `hp:run` → `hp:t`(텍스트).
표는 `hp:tbl` → `hp:tr` → `hp:tc` → **`hp:subList` → `hp:p`** 로 **중첩**된다.

### 3.2 쪽나눠 — 확인됨

명시적 쪽나눠는 **`hp:p` 의 속성**이다:

```xml
<hp:p id="0" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
```

샘플의 180개 문단은 전부 `pageBreak="0"`(쪽나눠 없음)이며, 표현 방식이 이것으로 확정됐다.

> ⚠️ **함정**: `hp:tbl` 에도 `pageBreak` 속성이 있는데 **의미가 전혀 다르다**
> (`pageBreak="CELL"` — 표가 페이지 경계에서 쪼개지는 방식). 문자열로 `pageBreak` 를 찾으면
> 샘플의 표 4개를 전부 쪽나눠로 오인한다. **반드시 `hp:p` 요소에 한정**해야 한다.

### 3.3 표를 살리지 않으면 이 포맷은 의미가 없다 (D7 의 근거)

샘플은 **문단 180개 중 표 셀이 91개**다(표 4개 · 행 18개). 그리고 이것이 한국 사무 문서의 전형이다.
`hp:t` 를 문서 순서대로 이어 붙이면 이렇게 된다:

```
구분 세부 추진 사항 기간 달성률(%) 대분류 중분류 상세 내용 전주 실천 사항 신규 개발
M400 S/W (기능 개발) 상품 페이지 데이터 CRUD 기능 개발 ... 12/04~08 100%
```

**어느 값이 어느 열인지 사라진다.** "100%" 가 무엇의 달성률인지 모델이 알 수 없고, 요약은 열 제목만
나열한 껍데기가 된다.

→ 표는 **GFM 마크다운 표**로 직렬화한다(`table.ts`, 전 포맷 공용). `remark-gfm` 이 이미
`shippedDevDependencies` 에 있어 추가 비용이 없고, §5 의 텍스트 뷰어를 기존 `markdown-renderer.tsx`
로 렌더하면 표가 표로 보인다. PDF 는 canvas 뷰어를 쓰므로 텍스트 뷰어에 들어오는 것은 언제나
추출기 출력뿐이라 이 가정이 안전하다.

### 3.4 `Preview/PrvText.txt` 는 쓰지 않는다

평문 미리보기가 들어 있어 지름길처럼 보이지만, 79KB 본문에 대해 **1.8KB 짜리이고 실제로 중간에
잘려 있다**(마지막 글자가 깨진 채 끝난다). 요약 근거로 쓰면 조용한 절단이 된다 — `num_ctx` 무음
절단(Ollama `num_ctx` 미전송으로 프롬프트 앞부분이 조용히 잘리던 건, v1.4.0)과 같은 클래스다.

---

## §4. 진입 경로와 게이트 단일화

### 4.1 현재 `.pdf` 를 아는 곳 — 5군데

| 위치 | 검사 |
|---|---|
| `src/main/index.ts:286` | 드롭된 `file://` URL 이 `.pdf` 로 끝나는가 |
| `src/main/index.ts:1588` | 다이얼로그 필터 `extensions: ['pdf']` |
| `src/main/index.ts:1714` | `file:open-path` 재읽기 확장자 검사 |
| `src/renderer/App.tsx:306` | DOM 드롭 `file.type === 'application/pdf'` |
| `src/renderer/lib/pdf-parser.ts:1150~` | `%PDF-` 매직바이트 스캔 |

포맷을 넷 더 붙이면서 이대로 두면 **한 곳만 안 따라가는 결함**이 거의 확실히 난다 — 이 저장소에서
가장 자주 반복된 형태다(QA32 형제 누락, QA33 H6 `use-summarize` 리터럴 잔존).

### 4.2 `src/shared/document-formats.ts` — 단일 출처

`constants.ts` 와 같은 규칙(순수 값/타입만, 런타임 API 참조 금지)으로 main·renderer 가 공유한다.
위 5곳이 전부 여기서 확장자 목록과 판별 규칙을 가져간다.

**판별은 확장자가 아니라 내용으로 한다.** 네 포맷 모두 zip(`PK\x03\x04`)이라 매직만으로는 구분되지
않으므로 2단이다:

1. zip 매직 확인
2. zip 엔트리 목록으로 sniff — `word/document.xml`(docx) / `ppt/presentation.xml`(pptx) /
   `mimetype == application/epub+zip`(epub) / `mimetype == application/hwp+zip`(hwpx)

확장자는 다이얼로그 필터와 초기 힌트로만 쓰고 신뢰하지 않는다.

### 4.3 상한

**파일 크기 캡(100MB)은 zip 에서 무의미하다** — 100MB zip 이 수 GB 로 풀릴 수 있다. 파일 크기 캡은
그대로 두되 **해제 누적 바이트 상한과 엔트리 수 상한**을 `zip.ts` 안에 둔다. 상한 초과는
`DOC_CORRUPT` 가 아니라 전용 코드로 구분해 "파일이 너무 큽니다" 안내를 준다.

### 4.4 `handlePdfData` → `document-open.ts`

이 함수는 QA 라운드마다 가드가 하나씩 붙어온 자리다 — 생성 중 차단 · Q&A 중 차단 · 컬렉션 busy ·
컬렉션 열기 중 · 파기 확인 · 크기 · abort-replace · 소유권 재검사 · flush · `isParsing` 고착 방지.
**로직은 한 줄도 바꾸지 않고 이동만** 하고, 매직 검사 자리만 registry sniff 로, `parsePdf` 호출
자리만 추출기 분기로 교체한다. **이동 전에 현재 동작을 고정하는 테스트를 먼저 붙인다.**

### 4.5 에러 코드

기존 집합(`PDF_PARSE_FAIL` · `PDF_NO_TEXT` · `PDF_TOO_MANY_PAGES` · `PDF_ENCRYPTED` · `OCR_FAIL`)에
셋을 더한다:

- `DOC_UNSUPPORTED` — sniff 실패. 지원 형식 목록을 문구에 포함
- `DOC_CORRUPT` — zip 손상 / 필수 엔트리 부재
- `DOC_ENCRYPTED` — **암호가 걸린 OOXML 은 zip 이 아니라 CFB 컨테이너**라 sniff 단계에서 바로
  구분된다. PDF 의 `PDF_ENCRYPTED` 와 같은 안내를 주면 "왜 안 열리는지 모르겠는 파일" 이 하나 준다

---

## §5. 표시 계층

### 5.1 프롬프트는 건드리지 않는다

모델에게는 계속 `[p.N]` 으로 인용하라고 시킨다. 포맷별로 프롬프트를 바꾸면 프롬프트 표면이 4배가
되고, 모델이 `[슬라이드 3]` 을 출력하는 순간 `CITATION_REGEX`(`citation.ts:28`)가 못 잡아 인용이
통째로 평문으로 떨어진다. D2 가 여기서 값을 한다.

### 5.2 라벨

`citation.ts` 의 **기존 `formatPageLabel`(269행)** 이 `unitKind` 를 받게 하고, i18n 키 세 쌍을 더한다:

| 키 | ko | en |
|---|---|---|
| `citation.unit.page` | `p.{n}` | `p.{n}` |
| `citation.unit.slide` | `슬라이드 {n}` | `Slide {n}` |
| `citation.unit.chapter` | `{n}장` | `Ch. {n}` |

교차문서 인용(`[문서명 p.N]`)은 **대상 탭의 `unitKind`** 를 써야 맞다 — PPTX 를 인용하는데 활성
문서가 PDF 라고 `p.3` 이 되면 안 된다. `openTabs` 가 이미 `pageCount` 를 싣고 있으니 `unitKind` 를
그 형제로 추가한다.

표시 지점은 인용 버튼 외에도 검색 스니펫 · 마인드맵 · StatusBar 등에 흩어져 있으나 **열거하지
않는다.** QA33 I3 의 a11y 가드가 "App 한 파일만 보고 그 사각에 실제 위반" 이었던 것이 열거의
결과다. 대신 `formatPageLabel` 을 단일 통로로 만들고, **그 밖에서 `p.` 라벨을 조립하면 실패하는
가드**로 지점이 도출되게 한다.

### 5.3 텍스트 뷰어 (`DocTextViewer.tsx`)

`SummaryViewer.tsx:369` 의 `<PdfViewerPanel />` 자리에서 문서 종류에 따라 분기한다. 새로 만드는
것은 "단위 헤더 + 본문 블록" 렌더뿐이고 나머지는 기존 자산을 그대로 쓴다:

- `citationTarget` 스크롤 계약 — `id={'unit-' + n}` 으로 `PdfViewer` 의 `scrollToPage` 와 동일하게
- `ResizeHandle` 가로·세로 분할(v1.5.0 · DR-01) — 그대로
- `viewer-zoom.ts`(v1.6.0, 50~300%) — canvas 배율 대신 **글꼴 크기**로 매핑. Ctrl+휠 · Ctrl+키
  조작감이 PDF 와 같아진다. 면적 상한(`maxUsableZoom`)은 텍스트에 불필요하므로 자연히 빠진다
- `citation-focus.ts` 포커스 복귀 — 그대로
- 본문은 `markdown-renderer.tsx` 로 렌더 (§3.3 의 표를 표로 보이게)

가상화는 넣지 않는다(500단위 × 1,800자 ≈ DOM 노드 500개). 단 이것은 **단정하지 않고 실측 항목으로
남긴다** — 느리면 그때 넣는다.

---

## §6. 영속화와 호환성

### 6.1 `SESSION_SCHEMA_VERSION` 을 올리지 않는다

추가되는 것은 선택 필드 `unitKind?` 하나뿐이고 없으면 `'page'` 로 읽힌다. 기존 PDF 세션은 정의상
전부 `'page'` 이므로 **필드가 없는 상태가 곧 올바른 값**이다. 버전을 올리면 `use-session.ts:77` 의
`schemaMismatch` 가 참이 되면서 기존 사용자 전원의 인덱스가 재빌드되는데(비-PDF 와 무관한 비용)
얻는 것이 없다.

### 6.2 형제 셋

`PersistedSession` · `SessionManifestEntry` · `openTabs` 세 곳에 같은 필드를 넣는다. 매니페스트까지
넣는 이유는 최근 문서 목록과 전역 검색 결과가 `pageCount` 로 "N쪽" 을 표시하기 때문이다 — 빠지면
PPTX 가 목록에서만 "12쪽" 이 된다.

단, `session-store.ts:133` 의 강등 규칙상 **구버전 앱이 매니페스트를 다시 쓰면 이 필드가 사라진다.**
그때는 `'page'` 로 폴백되므로 표시만 되돌아가고 데이터는 멀쩡하다 — 허용 가능한 열화로 판단한다.

### 6.3 비-PDF 는 원본 바이트를 붙들지 않는다

`pdfBytes` 상주와 `file:open-path` 재읽기는 `PdfViewer` 가 pdfjs 로 원본을 다시 그리기 위한
장치다. 텍스트 뷰어는 `pageTexts` 만 있으면 되고 그것은 세션에 이미 들어 있다. 비-PDF 경로에서는
`pdfBytes` 를 명시적으로 `null` 로 두고 "PDF 에만 해당" 주석을 남긴다.

### 6.4 이미지 마커

PDF 와 동일하게 **세션에 저장하지 않고** `hadImages` / `imagesSkipped` 마커만 싣는다. QA6-D ·
QA26 · QA27 이 세 라운드에 걸쳐 만든 마커 체계를 그대로 물려받는다는 뜻이고, 여기서 형제를
빠뜨리면 "복원된 PPTX 를 재요약하면 이미지 없이 요약되는데 안내도 안 뜸" 이 재현된다. §1.2 의
정규화 한 곳에서 채워 포맷별로 빠질 자리를 없앤다.

### 6.5 손대지 않는 것

RAG · 전역검색 · 컬렉션 · 마인드맵 · 내보내기는 **변경 없음**. 청크 메타가 페이지 번호를 정수로
들고 `pageTexts` 위에서 도는 구조라 그대로 동작한다.

---

## §7. 제품명 변경

`PDF 자료 분석기` → **`로컬 문서 분석기`** (en: Local Doc Analyzer)

### 7.0 전면 개명으로 정한 근거 (2026-09-22)

식별자(`name` · `appId` · `publish` repo)는 원래 **기존 설치본을 끊지 않기 위해** 유지 대상이었다.
그런데 실측 결과 그 전제가 성립하지 않는다:

- 개발 기계의 언인스톨 레지스트리에 **설치 흔적이 없다**(개발 실행만)
- `%APPDATA%\summary-lecture-material\` 의 실데이터는 **세션 7개 + `settings.json` 349바이트 +
  빈 `collections.json`** 이 전부다(나머지 130MB 는 Chromium 캐시)
- 배포된 설치본을 쓰는 외부 사용자가 없다

즉 "끊길 기존 설치" 자체가 없으므로, **반쪽짜리 개명(보이는 이름만 바꾸고 식별자는 옛 이름)을
영구히 안고 가는 비용** 쪽이 더 크다. 전면 개명한다. 지금이 가장 싼 시점이다.

### 7.1 변경 대상 — 전부

| 항목 | 현재 값 | 변경 후 |
|---|---|---|
| `package.json` `name` | `summary-lecture-material` | `local-doc-analyzer` |
| `build.appId` | `com.jjw.summary-lecture-material` | `com.jjw.local-doc-analyzer` |
| `build.publish` owner/repo | `wpdlf/local-pdf-analyzer` | `wpdlf/local-doc-analyzer` (§7.4) |
| git remote origin | `.../local-pdf-analyzer` | `.../local-doc-analyzer` (§7.4) |
| `build.productName` | `PDF 자료 분석기` | `로컬 문서 분석기` |
| `build.nsis.shortcutName` | `PDF 자료 분석기` | `로컬 문서 분석기` |
| `build.win.artifactName` | `Local-PDF-Analyzer-Setup-${version}.${ext}` | `Local-Doc-Analyzer-Setup-${version}.${ext}` — **`Setup` 문자열 유지 필수(§7.2)** |
| `build.mac.artifactName` | `Local-PDF-Analyzer-${version}.${ext}` | `Local-Doc-Analyzer-${version}.${ext}` |
| userData 폴더 | `%APPDATA%\summary-lecture-material` | `%APPDATA%\local-doc-analyzer` (§7.3) |
| UI 문구 · README(ko/en) · CLAUDE.md · 릴리즈 노트 | | 변경 |

`updaterCacheDirName`(현재 `summary-lecture-material-updater`)은 electron-builder 가 자동으로
파생하므로 별도 수정 대상이 아니다.

### 7.2 `Setup` 문자열이 필수인 이유

`.github/workflows/release.yml` 이 자산을 **글로브로 잡는다**:

```
dist/*Setup*.exe              # 릴리즈 첨부
dist/*Setup*.exe.blockmap     # 자동 업데이트 델타
dist/latest.yml               # 업데이트 피드
subject-path: dist/*Setup*.exe  # Sigstore provenance attest
```

`Setup` 이 빠지면 **업로드가 조용히 비고**, QA33 I5 가 지적한 "latest.yml 이 빠지면 전 사용자
자동 업데이트가 조용히 정지" 와 같은 결과가 된다.

### 7.3 userData 이전

`name` 이 바뀌면 앱이 `%APPDATA%\local-doc-analyzer` 를 보게 되어 기존 세션 7개가 앱에서 사라진다
(디스크에서 지워지는 것은 아니다). **폴더를 한 번 옮기면 그대로 따라온다:**

```
%APPDATA%\summary-lecture-material  →  %APPDATA%\local-doc-analyzer
```

앱 안에 마이그레이션 코드를 넣지 않는다 — 옮길 대상이 개발자 기계 하나뿐인데 영구 코드를 남기면
그쪽이 더 비싸다. P5 체크리스트의 수동 단계로 둔다.

### 7.4 저장소 이름 변경

`wpdlf/local-pdf-analyzer` → `wpdlf/local-doc-analyzer`. GitHub 쪽 작업이므로 **사람이 실행한다**
(`gh repo rename`). 함께 갱신할 것:

- `package.json` `build.publish.repo`
- git remote origin URL
- README · CLAUDE.md · 문서의 저장소 링크

GitHub 이 옛 저장소 URL 을 리다이렉트하므로 **이미 배포된 v1.7.1 설치본의 업데이트 확인도 계속
동작한다.** 다만 리다이렉트에 기대지 않도록 `publish.repo` 는 즉시 새 이름으로 맞춘다.

### 7.5 실기기 확인

설치 폴더가 `C:\Program Files\로컬 문서 분석기` 로 달라지고 `appId` 도 바뀌므로, v1.8.0 은 기존
설치를 인식하지 못하는 **신규 설치**가 된다. 이것은 의도한 결과다(§7.0 — 끊길 설치가 없다).

확인 항목: ① 신규 설치 후 정상 실행 ② `%APPDATA%\local-doc-analyzer` 의 세션 7개가 보이는가
(§7.3 이전 후) ③ 바로가기·시작 메뉴 항목이 새 이름으로 하나만 생기는가 ④ **v1.8.0 → v1.8.1
자동 업데이트가 새 `appId`·새 저장소 이름으로 동작하는가** — 자동 업데이트 경로는 이 프로젝트에서
"앱이 조용히 꺼진다" 클래스가 나왔던 자리다(자동 업데이트 v0.31.30~, 실패 경로 실기기 검증
2026-09-02 완료). 식별자를 통째로 바꾸는 릴리즈이므로 ④ 는 생략할 수 없다.

---

## §8. 테스트 전략과 게이트

### 8.1 픽스처 — 합성과 실물 둘 다

테스트 안에서 `fflate` 로 zip 을 조립하는 **합성 픽스처**는 빠르고 저장소를 가볍게 유지하지만
**진짜 워드·한글·파워포인트가 내놓는 파일의 기벽을 못 밟는다.** 이 저장소가 정확히 그 지점에서
반복해 물렸다 — QA33 H3 은 "테스트의 가짜 레이아웃이 브라우저가 주지 않는 좌표계를 못박고"
있었고, QA33 H4 초판은 "mock 렌더가 즉시 resolve 라 재현이 안 됐다".

→ 합성 픽스처로 단위 테스트를 촘촘히 깔되, **각 포맷당 실제 프로그램이 저장한 최소 문서 1개**를
커밋해 스모크로 통과시킨다.

> ⚠️ **미해결**: 제공받은 `주간업무보고_샘플.hwpx` 에는 사람 이름과 업무 내용이 들어 있고 저장소는
> 공개다. **그대로 커밋하지 않는다.** 스파이크에는 로컬로 쓰고, 커밋용 픽스처는 한글로 새로 만든
> 최소 문서(쪽나눠 1회 + 표 1개 + 그림 1개)로 대체한다. — §11 A1

### 8.2 뮤테이션을 배선에 건다

QA33 의 주제가 "순수 함수는 촘촘한데 배선이 무보호"(뮤테이션 89종 중 17 생존)였다. 추출기 순수
함수만 테스트하면 같은 결과가 나온다. 검증 대상 셋:

1. **정규화** — 단위·이미지 매핑, 마커(`hadImages`/`imagesSkipped`/`imageBudgetExceeded`) 채움
2. **`openDocumentData` 게이트 순서** — 가드를 하나씩 제거해도 초록이면 그 가드는 무보호
3. **라벨 표시 경로** — `unitKind` 를 고정 상수로 바꿔도 초록이면 배선이 안 된 것

### 8.3 게이트 추가분

| 게이트 | 내용 |
|---|---|
| `source-scan.test.ts` | 확장자 리터럴이 `document-formats.ts` 밖에 생기면 실패 (**주석 제거 후** 매칭 — QA24/QA31 에서 가드가 자기 주석에 매칭돼 통과한 전례) |
| `source-scan.test.ts` | `p.` 라벨 조립이 `formatPageLabel` 밖에 생기면 실패 |
| `audit-shipped.test.ts` | `fflate` 를 `shippedDevDependencies` 로 분류 (누락 시 여기서 실패) |
| `i18n.test.ts` | 신규 키 ko/en 짝 검사 |
| E2E 신규 1건 | DOCX 열기 → 요약 → 인용 클릭 → 텍스트 뷰어 스크롤. 기존 `packaged-smoke` 는 라틴 PDF 만 밟는다 |
| `coverage-drift.test.ts` | 기능 커밋 뒤 재확인 (v1.5.0 에서 드리프트 가드가 발화했던 자리) |

### 8.4 릴리즈

**minor — `v1.8.0`.** CLAUDE.md 판정 기준("이제 ~할 수 있습니다" = minor)에 정면으로 해당한다.
버전 범프 시 `package.json` + `package-lock.json`(2곳) 동기화, 커밋 전 `npx tsc --noEmit`.
README 는 ko/en 양쪽 + 4개 표면(제목·기능 목록·스크린샷 설명·지원 형식) 동기화.

### 8.5 구현 순서

범위가 한 번에 검증하기엔 크므로 **DOCX 한 포맷을 끝까지 관통시켜 설계 가정을 먼저 증명**하고,
나머지 셋은 검증된 틀에 끼운다.

| Phase | 내용 | 끝났을 때 확인되는 것 |
|---|---|---|
| **P1** | 기반 — `types` · `zip` · `ocf` · `ooxml` · `table` · `paginate` · `normalize` · `registry` + DOCX 추출기 | 추출기가 순수 함수로 동작 (테스트만, UI 경로 없음) |
| **P2** | `document-formats.ts` 단일 출처 + 게이트 5곳 교체 + `handlePdfData` → `document-open.ts` 이동 | **DOCX 를 실제로 열어 요약할 수 있다.** PDF 회귀 없음 |
| **P3** | 텍스트 뷰어 + 라벨(`formatPageLabel` · `unitKind` 전파) | **인용 클릭 → 근거로 점프**가 동작 (앱의 척추가 비-PDF 에서 성립) |
| **P4** | HWPX · PPTX · EPUB 추출기 | 네 포맷 전부 |
| **P5** | 전면 개명(`name` · `appId` · 저장소 · productName) + userData 폴더 이전 + README(ko/en) · CLAUDE.md + 릴리즈 v1.8.0 + **실기기 확인** | §7 |

P2 가 가장 위험하다 — 기존 PDF 경로를 건드리는 유일한 구간이다. **이동 전에 현재 동작을 고정하는
테스트를 먼저 붙인다**(§4.4).

---

## §9. 리스크

| # | 리스크 | 완화 |
|---|---|---|
| R1 | 게이트 5곳 중 일부가 안 따라감 | `document-formats.ts` 단일 출처 + 소스 스캔 가드 (§4.2, §8.3) |
| R2 | 표 평문화로 한국 사무 문서 요약이 껍데기 | GFM 표 직렬화 + 실물 HWPX 스모크 (§3.3) |
| R3 | zip 폭탄 / 악성 파일 | 해제 총량·엔트리 수 상한, 내용 기반 sniff, 경로는 읽기만(디스크 추출 없음) (§4.3) |
| R4 | 전면 개명이 자동 업데이트를 끊음 | 끊길 기존 설치가 없음을 실측 확인(§7.0) + `Setup` 글로브 유지(§7.2) + userData 폴더 이전(§7.3) + **신규 `appId`·저장소로 v1.8.0→v1.8.1 자동 업데이트 실기기 확인**(§7.5 ④) |
| R5 | 추출기가 `PdfDocument` 필드를 포맷별로 빠뜨림 | 조립을 `normalize.ts` 한 곳으로 강제 + 뮤테이션 검증 (§1.1, §8.2) |
| R6 | 텍스트 뷰어 500 블록 렌더 성능 | 실측 항목으로 남김. 느리면 가상화 (§5.3) |
| R7 | DOCX/PPTX/EPUB 세부 구조가 문서 지식 기반(실물 미확인) | 구현 1단계에서 각 포맷 실물 1개씩으로 확인 후 진행 (§11) |

---

## §10. 범위 밖

- **URL(웹페이지) 입력** — 네트워크 페치 · HTML 정제 · 재읽기 불가 · 영속화 · CSP 가 문서 포맷과
  이질적이다. 이 설계가 서고 난 뒤 별도 라운드.
- **HWP(구 바이너리 포맷)** — HWPX 와 달리 zip+XML 이 아니다. 별도 판단.
- **쓰기/편집** — 이 앱은 읽기 전용 분석기다.
- **DOCX 내보내기** — 이미 won't-do 확정(2026-06). **DOCX 입력과는 별개다.**

---

## §11 미해결 항목 (구현 착수 시 처리)

| # | 항목 | 처리 |
|---|---|---|
| A1 | 제공받은 HWPX 샘플에 개인정보성 내용 — 공개 저장소에 커밋 불가 | 커밋용 최소 픽스처를 새로 작성 (§8.1) |
| A2 | HWPX 이미지(`BinData/`) 구조 미확인 — 샘플에 그림이 없었다 | 그림이 든 HWPX 로 확인 후 `hwpx.ts` 이미지 경로 확정 |
| A3 | DOCX · PPTX · EPUB 세부 구조는 문서 지식 기반, 실물 미확인 | 구현 1단계에서 각 포맷 실물 1개씩 확인 |
| A4 | `fflate` 버전 핀 · 번들 증가량 | 설치 후 실측, `audit-shipped` 분류 |
| A5 | 텍스트 뷰어 렌더 성능 | 500 단위 문서로 실측 (§5.3) |

---

## 검증 상태

| 항목 | 상태 |
|---|---|
| HWPX 컨테이너 구조 (OCF/OPF) | ✅ 실물 확인 (2026-09-22) |
| HWPX 쪽나눠 = `hp:p/@pageBreak` | ✅ 실물 확인 |
| HWPX `hp:tbl/@pageBreak` 의미 충돌 | ✅ 실물 확인 |
| HWPX 표 중첩 (`hp:tbl>hp:tr>hp:tc>hp:subList>hp:p`) | ✅ 실물 확인 |
| HWPX 이미지(`BinData/`) | ❌ 미확인 — 샘플에 그림 없음 (A2) |
| 게이트 5곳 위치 | ✅ 소스 확인 |
| userData = `%APPDATA%\summary-lecture-material` (세션 7 · settings 349B · collections 빈 값) | ✅ 디스크 확인 |
| 이 기계에 설치본 없음 (언인스톨 레지스트리 무항목) | ✅ 확인 — §7.0 의 근거 |
| 릴리즈 워크플로 글로브 (`*Setup*`) | ✅ 소스 확인 |
| 세션 스키마 불일치 처리 (read-old/write-new) | ✅ 소스 확인 |
| `remark-gfm` 번들 포함 | ✅ `shippedDevDependencies` 확인 |
| DOCX / PPTX / EPUB 세부 구조 | ❌ 문서 지식 기반, 실물 미확인 (A3) |
| `fflate` API·크기 | ❌ 미확인 (A4) |
