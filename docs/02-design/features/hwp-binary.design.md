---
template: design
version: 1.0
feature: hwp-binary
date: 2026-10-06
author: jjw
project: local-doc-analyzer
version_project: 1.12.0
---

# 한글 바이너리(.hwp, HWP 5.x) 입력 Design Document

> **Summary**: 입력에 **`.hwp`(HWP 5.x 바이너리)** 를 더한다. `.hwpx` 와 **같은 수준**(본문 · 표 · 그림 Vision ·
> 수식 · 개요 제목 장 분할)으로 읽는다. 컨테이너(CFB)와 레코드 파서는 **새 의존성 없이 직접 구현**하고,
> 압축 해제는 이미 쓰는 `fflate` 를 쓴다. 추출기는 기존 계약대로 `ExtractedDoc` 만 내놓으며 `normalize` 이후
> 흐름(요약 · Vision · RAG · 전역검색 · 세션)은 **바꾸지 않는다**.
>
> **Version**: 1.12.0 (minor — 기능 추가)
> **Status**: Designed (구현 전)
> **Depends on**: [multiformat-input.design.md](multiformat-input.design.md) 의 추출기 계약 · `table.ts` · `normalize.ts`(QA35 장 폭증 가드)

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 국내 공공·업무 자료는 아직 `.hwp` 가 다수다. 지금은 CFB 매직이면 무조건 "암호 걸린 Office 문서" 로 거절해 **원인조차 틀리게 안내**한다. |
| **WHO** | 공공기관 공문 · 기술문서 · 서식을 다루는 사용자. `.hwpx` 사용자의 자연 확장. |
| **RISK** | ① 신뢰할 수 없는 **바이너리** 파싱 — 모든 오프셋·길이가 공격 표면 ② 합성 입력만으로 검증하면 실물에서 조용히 틀린다(DIFAT · 미니 스트림 · PUA) ③ 배선 무보호(QA33~35 반복) ④ 암호 걸린 OOXML 거절 경로의 회귀 |
| **SCOPE** | HWP **5.x** 만. 3.x 이하 · 배포용 · 암호 문서는 전용 안내로 거절. 변경 추적 · 메모 · 머리말/꼬리말 · 각주는 HWPX 와 같은 정책으로 제외. |

---

## §0. 확정된 결정 (브레인스토밍 2026-10-02 ~ 10-06)

| # | 결정 | 근거 |
|---|---|---|
| H1 | 범위 = **A(HWPX 와 같은 수준)**: 텍스트 · 표 · 그림 · 수식 · 제목 장 분할 | 확장자에 따라 품질이 갈리면 안 된다. B/C 로 냈다가 끌어올리는 비용이 더 크다 |
| H2 | **CFB 리더 + 레코드 파서 직접 구현**, 새 의존성 0 | 상한·실패 처리를 우리가 쥐어야 한다. 후보(`cfb` 2022 정지 · `hwp.js` 0.0.3 정지 · `@ohah/hwpjs` rc+네이티브)는 배포 경로에 들일 수 없다 |
| H3 | 배포용 문서는 **전용 코드 `DOC_DISTRIBUTION`** | 공공 자료에 흔하다. "손상"/"암호" 로 안내하면 사용자가 원인을 모른다 |
| H4 | 본문 구역 하나라도 깨지면 **문서 전체 `DOC_CORRUPT`** · 그림 하나 실패는 그 그림만 건너뜀 | 일부가 조용히 빠지는 "조용한 오답" 이 QA 최다 클래스 |
| H5 | PUA 문자 제거 | 한글 전용 글머리 기호. AI 입력에 깨진 글자로 들어간다 |
| H6 | 수식은 HWPX 와 같은 `[수식: <한글 수식 스크립트>]` | 같은 수식 문법이라 출력 형식을 맞춘다(v1.11.0 결정 승계) |
| H7 | 단위 = 가상 페이지(`page`), 명시적 쪽 나눔 우선 + 분량 보조 | multiformat D5 와 동일 |

### 실물 분석 (2026-10-02, 스크래치에서만)
다운로드 4 + 업무 폴더 1(개인정보 서식 — **구조 확인만, 픽스처·대조 금지**).
전부 HWP 5.1.x · 압축(raw deflate) · 암호/배포용 없음 · `BodyText/Section0` 하나 · 표 5~11개(1×1 ~ 31×6) ·
기술문서 3개에 내장 JPG 1개씩(`gso`) · **수식 0 · 개요 문단 0** · 쪽 나눔 1개(1개 파일) · `PrvText` 는 앞 2KB 뿐.
→ 수식·개요 제목·암호·배포용 경로는 **합성 입력으로만 검증** 된다(§5 에 명시 기록).

---

## §1. 모듈 구조

```
src/shared/document-formats.ts   'hwp' 등록 { id:'hwp', ext:'.hwp', label:'HWP', container:'cfb' }
src/renderer/lib/extract/
  cfb.ts          CFB 리더(읽기 전용, 상한 내장) → ContainerIndex
  hwp.ts          추출기 진입: FileHeader 판정 → DocInfo → BodyText → ExtractedDoc
  hwp-records.ts  레코드 헤더 분해 · PARA_TEXT 제어문자 · PUA 제거 · 스트리밍 inflate(누적 상한) — 순수 함수
  hwp-docinfo.ts  PARA_SHAPE(개요 수준) · BIN_DATA 목록
  hwp-table.ts    표 컨트롤 → GridCell[] → table.ts(placeGridCells/toGfmTable) 재사용
e2e/fixtures/make-hwp.ts   합성 .hwp 생성기(유닛·E2E 공용)
```

### 1.1 추출기 계약을 컨테이너 중립으로
- `ZipIndex` 를 `ContainerIndex`(같은 `names/has/text/bytes`)로 일반화한다. `ZipIndex` 는 호환 별칭으로 남겨
  기존 추출기·테스트 시그니처를 깨지 않는다. `Extractor.sniff/extract` 는 `ContainerIndex` 를 받는다.
- `cfb.ts` 의 이름은 CFB 경로를 `/` 로 이은 것(`FileHeader`, `DocInfo`, `BodyText/Section0`, `BinData/BIN0001.jpg`).
  `bytes()` 는 **원본 스트림 바이트**(압축된 채)를 돌려준다. 압축 해제는 `hwp.ts` 가 누적 예산으로 한다(§3).
- `registry.ts`: `ZIP_EXTRACTORS` 옆에 `CFB_EXTRACTORS = [hwpExtractor]`. 컨테이너 종류별로 후보를 고른다.
- `hwpExtractor.sniff`: `FileHeader` 스트림이 있고 앞 32바이트가 `"HWP Document File"` 서명일 때만 참.

### 1.2 판별 분기 (`document-open.ts`)
- 지금은 `hasCfbMagic` 이면 **try 밖에서 즉시** `DOC_ENCRYPTED`. → 선검사는 CFB 를 **통과**시키고,
  `openZipDocument` 를 `openContainerDocument` 로 넓혀 try 안에서 zip/CFB 를 연다.
  CFB 인데 맞는 추출기가 없으면(= 암호 걸린 docx·pptx) **기존과 같은** `DOC_ENCRYPTED` + `doc.encrypted` 문구.
- 부수효과(의도): CFB 거절도 진행 중 파싱을 abort-replace 한다 — QA34 에서 손상 zip 을 try 안으로 옮긴 것과 같다.
- 확장자는 믿지 않는다. 진입 게이트 5곳(main 대화상자 필터 · file-gates · App 드롭 · 최근 문서 · 전역검색)은
  `document-formats.ts` 단일 출처에서 파생되므로 등록만으로 따라온다 — 테스트로 확인(§4.3).

### 1.3 번들
- `cfb.ts`/`hwp*.ts` 는 비-PDF 분기의 동적 import 체인에만 든다. 시작 번들 증가 0(기존 eager 가드로 확인).

---

## §2. 파싱 흐름

```
FileHeader ─ 서명 · 버전(5.x 만) · 플래그(bit0 압축 · bit1 암호 · bit2 배포용)
   ▼
DocInfo ─ (압축 시 inflate) PARA_SHAPE[] → 개요 수준 · BIN_DATA[] → id → 스트림 이름·확장자·종류(링크/내장)
   ▼
BodyText/Section0..N ─ inflate → 레코드 트리(tag, level, size)
   ├─ PARA_HEADER + PARA_TEXT → 텍스트(쪽 나눔 비트 · paraShape id → 개요 수준)
   ├─ CTRL_HEADER
   │    'tbl ' → 표          'gso ' → 그림 / 글상자 텍스트       'eqed' → 수식
   │    'secd' 'cold' 각주 미주 머리말 꼬리말 메모 등 → 건너뜀(HWPX 와 같은 정책)
   ▼
ExtractedDoc { units, images, headings, unitKind:'page' } → normalize(기존)
```

**텍스트** — `PARA_TEXT` 는 UTF-16LE. 제어문자(0~31) 중 확장·인라인 컨트롤 문자는 **8 wchar 를 통째로 건너뛴다**
(컨트롤 문자 1 + 정보 6 + 같은 문자 1). 문단 끝(13)은 줄바꿈, 탭(9)은 탭, 강제 줄바꿈(10)은 줄바꿈.
PUA(U+E000–F8FF, U+F0000 이상 — 서로게이트 쌍 포함) 제거.

**표** — 셀(`LIST_HEADER`)의 **행·열 주소와 병합 범위**로 `GridCell[]` 을 만든다. `TABLE` 레코드의 선언 행·열 수는
참고만 한다: 격자 크기는 HWPX 의 `gridExtent` 규칙(R18)을 그대로 쓴다 — **셀 원점은 선언값을 넘어도 항상 포함,
span 끝은 선언값 안에서만 믿음**(병리적 rowSpan 하나가 빈 행 수천 개를 만들지 않게). 형제 분기를 막기 위해
`gridExtent` 를 `hwpx.ts` 에서 `table.ts` 로 옮겨 두 추출기가 공유한다. 행 축 상한은 걸지 않는다(QA35 — `MAX_GRID_CELLS` 만).
셀 안 표는 재귀(깊이 상한 32, 넘으면 평문 — HWPX `flattenTableText` 와 같은 정책). **1×1 표**는 HWPX 와 같이
특별 취급하지 않는다(한 칸 GFM 표). 풀어 쓰기가 필요하면 포맷 공통 변경으로 따로 다룬다.

**그림** — `gso` 의 그림 개체에서 BinData id → 내장 스트림 inflate → Vision 대상. 형식 정책은 기존과 같다
(JPG·PNG·BMP·GIF 첫 프레임 분석, EMF·WMF·TIFF 건너뜀). 링크형은 건너뜀. 글상자 텍스트는 본문에 포함.

**수식** — `eqed` 의 스크립트 문자열 → `[수식: …]`.

**제목** — 문단의 paraShape 에 개요 수준이 있으면 heading(level 동반). 장 분할 판단은 `normalize`(QA35 가드)가 한다.

**쪽 나눔** — `PARA_HEADER` 의 쪽 나눔 비트를 HWPX 명시적 쪽 나눔과 같게 취급.

---

## §3. 오류 처리와 입력 경계

원칙: **모든 오프셋과 길이를 믿지 않는다.**

### 3.1 거절 안내

| 상황 | 코드 | 안내 |
|---|---|---|
| 암호(bit1) | `DOC_ENCRYPTED` (기존) | 기존 문구 |
| **배포용(bit2)** | **`DOC_DISTRIBUTION` (신규)** | ko: "배포용 문서는 내용이 암호화돼 있어 열 수 없습니다. 한글에서 일반 문서로 저장한 뒤 다시 시도해주세요." / en: 동등 문구 |
| 5.x 가 아닌 버전 | `DOC_UNSUPPORTED` (기존) | 지원 형식 안내 |
| 구조 깨짐 · inflate 실패 · 레코드 범위 초과 · 본문 구역 손상 | `DOC_CORRUPT` (기존) | 손상 안내 |
| 상한 초과 | `DOC_TOO_LARGE` (기존) | 크기 초과 안내 |
| CFB 인데 HWP 아님(암호 OOXML) | `DOC_ENCRYPTED` (기존) | **현행과 동일** |

`DOC_DISTRIBUTION` 은 QA34 의 오류 코드 표에 등록해 i18n · 통과 처리를 따라오게 한다.

### 3.2 상한

| 대상 | 상한 | 근거 |
|---|---|---|
| 파일 크기 | 100MB | 기존 main 게이트 |
| CFB 섹터 체인(FAT·미니 FAT·DIFAT) | **방문 집합으로 순환 감지** + 길이 ≤ 파일 섹터 수 · 범위 밖 섹터 번호 = 손상 | 순환 FAT 무한 루프 |
| 디렉터리 항목 수 | 10,000 | `MAX_ZIP_ENTRIES` |
| 디렉터리 트리 순회 | 순환 감지 + 깊이 상한 | 형제/자식 링크 순환 |
| 압축 해제 총량 | **300MB 누적**(문서 전체 합계) | `MAX_UNZIPPED_BYTES` |
| 레코드 크기 | 남은 바이트 초과 = `DOC_CORRUPT` | 길이 위조 |
| 표 | `MAX_GRID_CELLS_PER_AXIS`(열) · `MAX_GRID_CELLS`(총) — 기존 값 | QA35 |
| 중첩 표 깊이 | 32 | PPTX 그룹 깊이와 같은 값 |

inflate 는 fflate **스트리밍**(`Inflate` 의 `ondata` 에서 누적 계수)으로 하고 상한을 넘는 순간 멈춘다.

### 3.3 취소 · 진행률
- 구역마다 + 일정 레코드 수마다 `signal.aborted` 확인(QA35 HWPX 취소 형제 비대칭 재발 방지).
- 진행률은 구역 단위 `onProgress(n, total)` — v1.10.0 진행률 표시 재사용.

### 3.4 실패의 범위
- 그림 하나 실패(inflate · 디코드 · 미지원 형식) → 그 그림만 건너뜀.
- 본문 구역 하나 실패 → 문서 전체 `DOC_CORRUPT`.

---

## §4. 테스트와 검증

### 4.1 합성 픽스처 `e2e/fixtures/make-hwp.ts`
CFB(헤더 · FAT · 미니 FAT · DIFAT · 디렉터리) + HWP 레코드를 코드로 만든다. raw deflate 는 fflate.
실물에 없는 경로(수식 · 개요 제목 · 암호/배포용 · 중첩 표 · 256행 초과 표 · 공격 입력)는 전부 여기서 만든다.

### 4.2 유닛

| 모듈 | 정상 | 경계 · 공격 |
|---|---|---|
| `cfb.ts` | 스트림 읽기 · **미니 스트림**(4KB 미만) | **DIFAT**(FAT 섹터 109개 초과) · FAT 순환 · 디렉터리 링크 순환 · 범위 밖 섹터 · 항목 10,000 초과 · 스트림 크기 > 체인 |
| `hwp-records.ts` | 헤더 분해 | 확장 크기(0xFFF) · 길이 위조 · 8 wchar 건너뛰기 · 서로게이트 PUA · 누적 inflate 상한 |
| `hwp-docinfo.ts` | 개요 수준 · BinData 목록 | 없는 id 참조 |
| `hwp-table.ts` | 병합 격자 | 선언 행 수 불일치 · 병리적 rowSpan · **256행 초과** · 중첩 32 · 1×1 |
| `table.ts` | `gridExtent` 이전 후 HWPX 기존 테스트 그대로 초록 | — |
| `hwp.ts` | 텍스트 · 표 · 그림 · 수식 · 제목 · 쪽 나눔 | 암호 · 배포용 · 비 5.x · 300MB 누적 · 구역 손상 → 전체 거절 · 그림 실패 → 그것만 · 구역별 취소 · 진행률 |

### 4.3 배선
- `document-open`: CFB+HWP → hwp 추출기 / **CFB 비HWP(암호 docx) → `DOC_ENCRYPTED` 회귀 방지**.
- 지금 `.hwp` 거절을 단언하는 테스트를 뒤집는다: `file-gates.test.ts`(`a.hwp`) · `document-formats.test.ts`
  (`SUPPORTED_EXTENSIONS`) · main 열기 대화상자 필터 · `App.drop`.
- `DOC_DISTRIBUTION` 오류 코드 표 등록 + ko/en 키 존재.
- `unitKind` 추출 → 세션 저장 → 복원(`reconcileSessions` 포함) → 전역검색 전달.
- 소스 스캔: `cfb.ts` 가 CFB 매직 바이트 리터럴을 쓰지 않고 `hasCfbMagic()` 을 쓴다(기존 가드).
- 번들: hwp 청크가 시작 번들 밖.
- **뮤테이션 라운드**: CFB 분기 · 플래그 판정 · 8 wchar · PUA · 누적 상한 · 취소 확인 · 격자 크기(`gridExtent`) 배선.

### 4.4 실물 검증 (스크래치에서만, 저장소에 넣지 않음)
- **`PrvText` 를 정답지로**: 한글이 저장한 본문 앞 ~2KB 와 우리 추출 앞부분을 공백·PUA 정규화 후 대조 — 실물 4개.
- 표 수 · 그림 수 · 쪽 나눔 1개를 사전 분석값과 대조.
- 개인정보 서식은 구조 확인만.
- 수식 `.hwp` 는 사용자가 만들어 주면 실물 검증, 없으면 "합성 입력으로만 검증" 으로 기록.
- dev 앱에서 실물 `.hwp` 를 열어 화면 확인.

### 4.5 게이트 · 출시
`npx tsc --noEmit` · 커버리지 게이트 · E2E(`office-open.spec.ts` 에 HWP 케이스) · 테스트 수 증가 확인(기준 3118).
새 의존성 0 → audit · 배포 분류 불변. **v1.12.0(minor)**, README 한/영 지원 포맷 갱신, 릴리즈 노트 영/한.

---

## §5. 알려진 한계 (출시 시 기록)
- 수식 · 개요 제목 · 암호 · 배포용 경로는 실물 없이 합성 입력으로만 검증(실물 확보 시 보강).
- HWP 3.x 이하 미지원. 배포용 문서는 열지 않는다(복호화하지 않음).
- EMF · WMF · TIFF 그림은 Vision 대상에서 제외(기존 정책).
