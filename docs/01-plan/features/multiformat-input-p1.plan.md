# 다중 포맷 문서 입력 — P1~P3 (DOCX 수직 관통) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DOCX 파일을 열어 요약하고, 요약 안의 인용을 클릭하면 원문 텍스트 뷰어의 해당 위치로 점프하는 것까지 한 줄로 동작시킨다.

**Architecture:** 포맷별 추출기는 `ArrayBuffer → ExtractedDoc` 순수 함수다. 정규화 함수 하나가 `ExtractedDoc` 을 기존 `PdfDocument` 로 옮기므로 요약·Vision·RAG·전역검색·컬렉션·세션은 변경되지 않는다. 진입 게이트는 `document-formats.ts` 단일 출처로 모으고, `handlePdfData` 를 `document-open.ts` 로 옮겨 포맷 분기의 단일 지점으로 삼는다.

**Tech Stack:** TypeScript · React 19 · Vitest 4 · `fflate` 0.8.3(신규, unzip) · 렌더러 내장 `DOMParser`(XML — 신규 의존성 없음)

**Spec:** `docs/02-design/features/multiformat-input.design.md`

## 범위

이 계획은 스펙 §8.5 의 **P1·P2·P3 만** 담는다.

| 단계 | 이 계획 | 비고 |
|---|---|---|
| P1 기반 + DOCX 추출기 | ✅ Task 1~6 | |
| P2 게이트 단일화 + `document-open` 이동 | ✅ Task 7~10 | |
| P3 텍스트 뷰어 + 라벨 | ✅ Task 11~14 | |
| P4 HWPX·PPTX·EPUB | ❌ 별도 계획 | **EPUB 실물 미확보** — 구조 미확인 상태로 테스트를 적지 않는다 |
| P5 개명 잔여 + README + 릴리즈 | ❌ 별도 계획 | 식별자 개명은 2026-09-22 완료, README 와 `artifactName` 공개만 남음 |

완료 시점의 상태: **DOCX 는 완전히 동작하고, 나머지 3포맷은 아직 열리지 않는다**(sniff 실패 → `DOC_UNSUPPORTED` 안내). PDF 는 회귀 없음.

## Global Constraints

- **새 의존성은 반드시 분류한다** — `package.json` 의 `shippedDevDependencies` / `shippedRuntimeBinaries` / 테스트의 `BUILD_ONLY` 중 하나. 누락 시 `src/shared/__tests__/audit-shipped.test.ts` 가 실패한다. `fflate` 는 vite 번들에 들어가므로 **`shippedDevDependencies`**.
- **커밋 전 `npx tsc --noEmit`** — 테스트 파일까지 타입 검사된다. `npm run build` 만으로는 CI 타입 게이트를 통과하지 못한다.
- **인용의 내부 표현은 `[p.N]` 으로 불변** — `CITATION_REGEX`(`src/renderer/lib/citation.ts:28`) · `clampCitationPage` · `pageTexts` · RAG 청크 메타 · 세션 스키마를 건드리지 않는다. AI 프롬프트도 바꾸지 않는다.
- **`SESSION_SCHEMA_VERSION` 을 올리지 않는다**(현재 `1`). 추가 필드는 선택(optional)이며 부재 시 `'page'` 로 읽힌다.
- **소스 스캔 가드는 `stripJsComments` 를 반드시 통과시킨다** — 주석에 매칭돼 거짓 통과한 전례가 4회 있다(QA24·QA31·QA33).
- **테스트에서 `readFileSync` 로 소스를 읽으면 주석 제거기나 `JSON.parse` 로 감싼다** — 저장소 가드가 생 `readFileSync` 를 잡는다. 파일 복사는 `copyFileSync` 로 회피한다.
- **기존 예산 상수를 재사용한다** — `MAX_PAGE_COUNT`(500) · `MAX_TOTAL_IMAGES`(50) · `MAX_EXAMINED_IMAGES`(400) · `imageSignature`(중복 제거). 새 상수를 만들지 않는다.
- **주석·커밋 메시지는 한국어 평서체.** UI 문구는 ko/en 양쪽을 동시에 추가한다(`src/renderer/lib/__tests__/i18n.test.ts` 가 짝을 검사).
- **정규식·이스케이프가 든 편집은 Edit/Write 툴로 한다** — heredoc 의 `\n` 이 실제 개행으로 치환돼 파일이 깨진 사고가 3회 있었다.

## File Structure

**신규 (`src/renderer/lib/extract/`)**

| 파일 | 책임 |
|---|---|
| `types.ts` | `ZipIndex` · `ExtractedDoc` · `Extractor` · `ExtractOptions` 계약. 런타임 코드 없음 |
| `zip.ts` | `fflate` 위의 얇은 래퍼. 엔트리 목록/바이트/텍스트 + zip 폭탄 상한 |
| `xml.ts` | `DOMParser` 래퍼와 네임스페이스 프리픽스에 의존하지 않는 트리 순회 |
| `ooxml.ts` | OOXML 공용 — rels 해석(`Id → Target`) |
| `table.ts` | 셀 행렬 → GFM 마크다운 표 (전 포맷 공용) |
| `paginate.ts` | 블록 목록 → 단위. 명시적 쪽나눠 우선 + 분량 보조 |
| `docx.ts` | DOCX 추출기 |
| `registry.ts` | sniff → 추출기 선택 |
| `normalize.ts` | `ExtractedDoc` → `PdfDocument` |

**신규 (기타)**

| 파일 | 책임 |
|---|---|
| `src/shared/document-formats.ts` | 지원 포맷·확장자·매직의 **단일 출처**. main·renderer 공용, 순수 값만 |
| `src/renderer/lib/document-open.ts` | 모든 진입 경로의 단일 게이트. `handlePdfData` 가 여기로 이동 |
| `src/renderer/components/DocTextViewer.tsx` | 비-PDF 원문 텍스트 뷰어 |

**수정**

| 파일 | 내용 |
|---|---|
| `src/renderer/types/index.ts` | `PdfDocument.unitKind?` · `PersistedSession.unitKind?` |
| `src/shared/session-types.ts` | `SessionManifestEntry.unitKind?` |
| `src/renderer/lib/citation.ts:269` | `formatPageLabel` 이 `unitKind` 를 받는다 |
| `src/renderer/lib/store.ts` | `openTabs` 항목에 `unitKind` |
| `src/renderer/lib/pdf-parser.ts` | `handlePdfData` 제거(이동), `parsePdf` 는 그대로 |
| `src/main/index.ts` | 게이트 3곳이 `document-formats.ts` 참조 |
| `src/renderer/App.tsx:306` | DOM 드롭 게이트 |
| `src/renderer/components/SummaryViewer.tsx:369` | 뷰어 분기 |
| `src/renderer/components/CitationButton.tsx` | 라벨 |
| `src/renderer/lib/i18n.ts` | 신규 키 |

---

## Task 1: zip 읽기 (`fflate` 도입 + 폭탄 상한)

**Files:**
- Create: `src/renderer/lib/extract/types.ts`
- Create: `src/renderer/lib/extract/zip.ts`
- Create: `src/renderer/lib/extract/__tests__/zip.test.ts`
- Modify: `package.json` (devDependencies + `shippedDevDependencies`)

**Interfaces:**
- Consumes: 없음
- Produces: `ZipIndex` 인터페이스, `openZip(data: ArrayBuffer): ZipIndex`, 상수 `MAX_UNZIPPED_BYTES` · `MAX_ZIP_ENTRIES`

**배경:** `fflate.unzipSync(data, { filter })` 의 `filter` 는 **압축 해제 전에** 호출되고 `UnzipFileInfo { name, size, originalSize }` 를 받는다(실물 타이핑 확인, fflate 0.8.3). 그래서 `originalSize` 를 누적해 상한을 넘으면 **풀기 전에** 거부할 수 있다. 파일 크기 캡(100MB)은 zip 에서 무의미하므로 이 상한이 실질 게이트다.

- [ ] **Step 1: 의존성 설치와 분류**

```bash
npm i -D fflate@0.8.3
```

`package.json` 의 `shippedDevDependencies` 배열에 `"fflate"` 를 추가한다(알파벳 순 무관, 기존 배열 끝에 추가).

- [ ] **Step 2: 분류 게이트가 통과하는지 확인**

Run: `npx vitest run src/shared/__tests__/audit-shipped.test.ts`
Expected: PASS (분류를 빠뜨리면 여기서 실패한다)

- [ ] **Step 3: 계약 파일 작성**

`src/renderer/lib/extract/types.ts`:

```ts
/**
 * 포맷별 추출기의 공통 계약.
 *
 * 추출기는 PdfDocument 를 직접 만들지 않는다. 중간 표현 ExtractedDoc 만 내놓고, normalize.ts
 * 한 곳이 PdfDocument 로 옮긴다. 추출기가 직접 조립하면 포맷이 늘 때마다 "한 포맷만 새 필드를
 * 안 채움"(형제 누락)이 재현된다 — QA26/QA27/QA32/QA33 에서 반복된 형태다.
 */

/** 단위의 성격. 표시 라벨만 갈리고 내부 표현(정수 N)은 동일하다. */
export type UnitKind = 'page' | 'slide' | 'chapter';

/** zip 아카이브의 읽기 전용 색인. 디스크에 풀지 않는다. */
export interface ZipIndex {
  /** 아카이브에 든 엔트리 이름 전부 */
  names(): string[];
  has(name: string): boolean;
  /** UTF-8 로 디코드한 텍스트. 없으면 null */
  text(name: string): string | null;
  /** 원본 바이트. 없으면 null */
  bytes(name: string): Uint8Array | null;
}

export interface ExtractedImage {
  /** units 배열의 0-based 인덱스 */
  unitIndex: number;
  base64: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface ExtractedHeading {
  /** 1 = 최상위 */
  level: number;
  title: string;
  unitIndex: number;
}

export interface ExtractedDoc {
  units: string[];
  images: ExtractedImage[];
  headings: ExtractedHeading[];
  unitKind: UnitKind;
  imageBudgetExceeded?: boolean;
}

export interface ExtractOptions {
  /** 기본 true. false 면 이미지 수집을 통째로 건너뛴다(ParsePdfOptions 와 같은 계약). */
  extractImages?: boolean;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

export interface Extractor {
  id: 'docx' | 'pptx' | 'hwpx' | 'epub';
  /** 다이얼로그 필터용 힌트. 판별의 근거로 쓰지 않는다(위장 파일). */
  extensions: readonly string[];
  /** zip 내부 엔트리로 판별한다. 확장자를 믿지 않는다. */
  sniff(zip: ZipIndex): boolean;
  extract(zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc>;
}
```

- [ ] **Step 4: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/zip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip, MAX_ZIP_ENTRIES, MAX_UNZIPPED_BYTES } from '../zip';

function makeZip(files: Record<string, string>): ArrayBuffer {
  const input: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) input[name] = strToU8(body);
  const out = zipSync(input);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

describe('openZip', () => {
  it('엔트리 이름과 텍스트를 읽는다', () => {
    const zip = openZip(makeZip({ 'a/b.xml': '<r>안녕</r>', 'c.txt': 'hi' }));
    expect(zip.names().sort()).toEqual(['a/b.xml', 'c.txt']);
    expect(zip.has('a/b.xml')).toBe(true);
    expect(zip.text('a/b.xml')).toBe('<r>안녕</r>');
  });

  it('없는 엔트리는 null 을 준다 (throw 하지 않는다)', () => {
    const zip = openZip(makeZip({ 'a.txt': 'x' }));
    expect(zip.text('없음.xml')).toBeNull();
    expect(zip.bytes('없음.xml')).toBeNull();
    expect(zip.has('없음.xml')).toBe(false);
  });

  it('zip 이 아니면 DOC_CORRUPT 로 거부한다', () => {
    const notZip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    expect(() => openZip(notZip)).toThrowError(
      expect.objectContaining({ code: 'DOC_CORRUPT' }),
    );
  });

  it('해제 총량 상한을 넘으면 풀기 전에 거부한다', () => {
    // originalSize 가 상한을 넘도록 만든 단일 엔트리. 압축률이 높아 파일 자체는 작다.
    const big = 'A'.repeat(MAX_UNZIPPED_BYTES + 1);
    expect(() => openZip(makeZip({ 'big.txt': big }))).toThrowError(
      expect.objectContaining({ code: 'DOC_TOO_LARGE' }),
    );
  });

  it('엔트리 수 상한을 넘으면 거부한다', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) files[`f${i}.txt`] = 'x';
    expect(() => openZip(makeZip(files))).toThrowError(
      expect.objectContaining({ code: 'DOC_TOO_LARGE' }),
    );
  });
});
```

- [ ] **Step 5: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/zip.test.ts`
Expected: FAIL — `Failed to resolve import "../zip"`

- [ ] **Step 6: 구현**

`src/renderer/lib/extract/zip.ts`:

```ts
import { unzipSync, type UnzipFileInfo } from 'fflate';
import type { ZipIndex } from './types';

/**
 * 압축 해제 누적 바이트 상한.
 *
 * 파일 크기 캡(MAX_PDF_SIZE_BYTES, 100MB)은 zip 에서 실질 방어가 못 된다 — 100MB zip 이 수 GB 로
 * 풀릴 수 있다. fflate 의 filter 는 **해제 전에** originalSize 를 주므로 여기서 누적해 막는다.
 */
export const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;

/** 엔트리 수 상한 — 수십만 개의 빈 엔트리로 메모리를 밀어내는 형태를 막는다. */
export const MAX_ZIP_ENTRIES = 2000;

function fail(code: 'DOC_CORRUPT' | 'DOC_TOO_LARGE', message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function openZip(data: ArrayBuffer): ZipIndex {
  const bytes = new Uint8Array(data);
  let unzipped: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file: UnzipFileInfo): boolean => {
        count += 1;
        if (count > MAX_ZIP_ENTRIES) fail('DOC_TOO_LARGE', 'zip entry count exceeded');
        total += file.originalSize;
        if (total > MAX_UNZIPPED_BYTES) fail('DOC_TOO_LARGE', 'unzipped size exceeded');
        // 디렉터리 엔트리는 담지 않는다.
        return !file.name.endsWith('/');
      },
    });
  } catch (err) {
    // 상한 위반은 우리가 던진 것이므로 그대로 올린다. 그 외는 손상으로 본다.
    if ((err as { code?: string }).code === 'DOC_TOO_LARGE') throw err;
    fail('DOC_CORRUPT', 'not a readable zip archive');
  }

  const decoder = new TextDecoder('utf-8');
  return {
    names: () => Object.keys(unzipped),
    has: (name) => Object.prototype.hasOwnProperty.call(unzipped, name),
    bytes: (name) => unzipped[name] ?? null,
    text: (name) => {
      const b = unzipped[name];
      return b ? decoder.decode(b) : null;
    },
  };
}
```

- [ ] **Step 7: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/zip.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 8: 타입 검사와 커밋**

```bash
npx tsc --noEmit
git add package.json package-lock.json src/renderer/lib/extract/
git commit -m "feat(extract): zip 읽기 계층 — 해제 전 폭탄 상한

fflate 의 filter 는 압축 해제 전에 originalSize 를 주므로, 누적 총량과
엔트리 수를 거기서 막는다. 파일 크기 캡은 zip 에서 실질 방어가 못 된다."
```

---

## Task 2: 프리픽스에 의존하지 않는 XML 순회

**Files:**
- Create: `src/renderer/lib/extract/xml.ts`
- Create: `src/renderer/lib/extract/__tests__/xml.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `parseXml(text: string): Document` · `localName(el: Element): string` · `walk(el: Element): Generator<Element>` · `childrenNamed(el: Element, name: string): Element[]` · `firstNamed(el: Element, name: string): Element | null` · `attr(el: Element, name: string): string | null`

**배경:** 네 포맷의 네임스페이스 프리픽스가 다르다(OOXML `w:`/`a:`/`p:`, HWPX `hp:`, EPUB 무프리픽스). `getElementsByTagName('w:t')` 는 프리픽스가 바뀌면 조용히 0건을 준다. **로컬명 기준**으로 다닌다. 속성도 마찬가지라 `attr` 은 프리픽스를 무시하고 로컬명으로 찾는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/xml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, localName, walk, childrenNamed, firstNamed, attr } from '../xml';

const DOC = `<?xml version="1.0"?>
<w:body xmlns:w="urn:w" xmlns:a="urn:a">
  <w:p w:pageBreakBefore="1"><w:r><w:t>첫째</w:t></w:r></w:p>
  <w:p><w:r><w:t>둘째</w:t><a:t>다른ns</a:t></w:r></w:p>
</w:body>`;

describe('xml 순회 — 프리픽스에 의존하지 않는다', () => {
  it('parseXml 은 루트를 준다', () => {
    const root = parseXml(DOC).documentElement;
    expect(localName(root)).toBe('body');
  });

  it('잘못된 XML 은 DOC_CORRUPT 로 거부한다', () => {
    expect(() => parseXml('<a><b></a>')).toThrowError(
      expect.objectContaining({ code: 'DOC_CORRUPT' }),
    );
  });

  it('childrenNamed 는 직계 자식만, 로컬명으로 찾는다', () => {
    const root = parseXml(DOC).documentElement;
    expect(childrenNamed(root, 'p')).toHaveLength(2);
    // r 은 손자이므로 직계에서는 안 잡힌다
    expect(childrenNamed(root, 'r')).toHaveLength(0);
  });

  it('walk 는 프리픽스가 달라도 같은 로컬명을 모두 훑는다', () => {
    const root = parseXml(DOC).documentElement;
    const texts = [...walk(root)].filter((e) => localName(e) === 't').map((e) => e.textContent);
    expect(texts).toEqual(['첫째', '둘째', '다른ns']);
  });

  it('attr 은 프리픽스를 무시하고 로컬명으로 읽는다', () => {
    const root = parseXml(DOC).documentElement;
    const first = childrenNamed(root, 'p')[0]!;
    expect(attr(first, 'pageBreakBefore')).toBe('1');
    expect(attr(first, '없는속성')).toBeNull();
  });

  it('firstNamed 는 없으면 null 이다', () => {
    const root = parseXml(DOC).documentElement;
    expect(firstNamed(root, 'p')).not.toBeNull();
    expect(firstNamed(root, 'tbl')).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/xml.test.ts`
Expected: FAIL — `Failed to resolve import "../xml"`

- [ ] **Step 3: 구현**

`src/renderer/lib/extract/xml.ts`:

```ts
/**
 * 네임스페이스 프리픽스에 의존하지 않는 XML 순회.
 *
 * 네 포맷의 프리픽스가 전부 다르다(OOXML w:/a:/p:, HWPX hp:, EPUB 무프리픽스).
 * getElementsByTagName('w:t') 는 프리픽스가 달라지면 **조용히 0건**을 주므로 쓰지 않는다.
 */

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'DOC_CORRUPT' });
}

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // DOMParser 는 throw 하지 않고 parsererror 요소를 심는다.
  if (doc.getElementsByTagName('parsererror').length > 0) fail('malformed xml');
  if (!doc.documentElement) fail('empty xml');
  return doc;
}

export function localName(el: Element): string {
  return el.localName || el.nodeName.replace(/^[^:]*:/, '');
}

/** 자기 자신을 포함한 깊이 우선 순회. */
export function* walk(el: Element): Generator<Element> {
  yield el;
  for (const child of Array.from(el.children)) yield* walk(child);
}

export function childrenNamed(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => localName(c) === name);
}

/** 자손 전체에서 로컬명이 일치하는 첫 요소. */
export function firstNamed(el: Element, name: string): Element | null {
  for (const e of walk(el)) {
    if (e !== el && localName(e) === name) return e;
  }
  return null;
}

/** 프리픽스를 무시하고 로컬명으로 속성을 읽는다. */
export function attr(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) {
    const ln = a.localName || a.name.replace(/^[^:]*:/, '');
    if (ln === name) return a.value;
  }
  return null;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/xml.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/renderer/lib/extract/xml.ts src/renderer/lib/extract/__tests__/xml.test.ts
git commit -m "feat(extract): 프리픽스에 의존하지 않는 XML 순회

네 포맷의 네임스페이스 프리픽스가 전부 다르다. getElementsByTagName 은
프리픽스가 달라지면 조용히 0건을 주므로 로컬명 기준으로 다닌다."
```

---

## Task 3: 표 → GFM 마크다운 직렬화

**Files:**
- Create: `src/renderer/lib/extract/table.ts`
- Create: `src/renderer/lib/extract/__tests__/table.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `toGfmTable(rows: string[][]): string`

**배경:** 실물 HWPX(주간업무보고)는 문단 180개 중 표 셀이 91개였다. 표를 평문으로 이으면 `구분 세부 추진 사항 기간 달성률(%) ... 100%` 가 되어 **어느 값이 어느 열인지 사라지고** 요약이 열 제목 나열이 된다. `remark-gfm` 이 이미 번들에 있으므로 GFM 표로 직렬화하면 모델도 뷰어도 구조를 본다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/table.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toGfmTable } from '../table';

describe('toGfmTable', () => {
  it('첫 행을 머리글로 삼아 GFM 표를 만든다', () => {
    const out = toGfmTable([
      ['대분류', '중분류', '달성률'],
      ['신규 개발', 'M400 S/W', '100%'],
    ]);
    expect(out).toBe(
      '| 대분류 | 중분류 | 달성률 |\n| --- | --- | --- |\n| 신규 개발 | M400 S/W | 100% |',
    );
  });

  it('한 행짜리 표도 머리글+구분선을 갖춘다 (GFM 은 구분선이 없으면 표로 안 읽는다)', () => {
    expect(toGfmTable([['A', 'B']])).toBe('| A | B |\n| --- | --- |');
  });

  it('셀 안의 파이프를 이스케이프한다 (열이 밀리면 대응이 깨진다)', () => {
    const out = toGfmTable([['a|b', 'c']]);
    expect(out.split('\n')[0]).toBe('| a\\|b | c |');
  });

  it('셀 안의 줄바꿈을 공백으로 접는다 (표 한 줄 = 한 행이어야 한다)', () => {
    const out = toGfmTable([['첫 줄\n둘째 줄', 'x']]);
    expect(out.split('\n')[0]).toBe('| 첫 줄 둘째 줄 | x |');
  });

  it('행마다 열 수가 다르면 가장 넓은 행에 맞춰 빈 칸을 채운다', () => {
    const out = toGfmTable([['A'], ['x', 'y']]);
    expect(out).toBe('| A |  |\n| --- | --- |\n| x | y |');
  });

  it('빈 표는 빈 문자열이다 (빈 구분선만 남기지 않는다)', () => {
    expect(toGfmTable([])).toBe('');
    expect(toGfmTable([[]])).toBe('');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/table.test.ts`
Expected: FAIL — `Failed to resolve import "../table"`

- [ ] **Step 3: 구현**

`src/renderer/lib/extract/table.ts`:

```ts
/**
 * 셀 행렬 → GFM 마크다운 표.
 *
 * 평문화하면 열 대응이 사라진다(실물 HWPX 주간업무보고: 문단 180 중 표 셀 91).
 * remark-gfm 이 이미 번들에 있어 요약 뷰어·텍스트 뷰어가 표로 렌더한다.
 */

function cell(text: string): string {
  // 표 한 줄이 한 행이어야 하므로 줄바꿈을 접고, 파이프는 열 경계를 깨므로 이스케이프한다.
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

export function toGfmTable(rows: string[][]): string {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (rows.length === 0 || width === 0) return '';

  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cell(cells[i] ?? '')).join(' | ')} |`;

  const header = line(rows[0] ?? []);
  const divider = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  const body = rows.slice(1).map(line);
  return [header, divider, ...body].join('\n');
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/table.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/renderer/lib/extract/table.ts src/renderer/lib/extract/__tests__/table.test.ts
git commit -m "feat(extract): 표를 GFM 마크다운으로 직렬화

평문화하면 어느 값이 어느 열인지 사라져 요약이 열 제목 나열이 된다.
실물 HWPX 주간업무보고에서 문단 180개 중 91개가 표 셀이었다."
```

---

## Task 4: 단위 분할 (`paginate`)

**Files:**
- Create: `src/renderer/lib/extract/paginate.ts`
- Create: `src/renderer/lib/extract/__tests__/paginate.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `interface Block { text: string; breakBefore: boolean }` · `interface PaginateResult { units: string[]; unitOfBlock: number[] }` · `paginate(blocks: Block[], maxChars?: number): PaginateResult` · `DEFAULT_UNIT_CHARS`

**배경:** DOCX·HWPX 는 물리적 페이지가 파일에 없다. 작성자가 넣은 쪽나눠가 있으면 그게 사용자가 보는 경계이므로 우선하고, 없는 구간만 분량으로 끊는다. **문단 경계를 넘지 않는다**(문장이 잘리면 인용이 무의미해진다). `unitOfBlock` 은 이미지·제목을 단위에 매핑하는 데 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/paginate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { paginate, DEFAULT_UNIT_CHARS, type Block } from '../paginate';

const b = (text: string, breakBefore = false): Block => ({ text, breakBefore });

describe('paginate', () => {
  it('명시적 쪽나눠에서 끊는다', () => {
    const r = paginate([b('표지'), b('요약', true), b('본문', true)], 10000);
    expect(r.units).toEqual(['표지', '요약', '본문']);
    expect(r.unitOfBlock).toEqual([0, 1, 2]);
  });

  it('첫 블록의 breakBefore 는 빈 단위를 만들지 않는다', () => {
    const r = paginate([b('첫', true), b('둘', true)], 10000);
    expect(r.units).toEqual(['첫', '둘']);
  });

  it('쪽나눠가 없으면 분량으로 끊되 문단 경계를 넘지 않는다', () => {
    const r = paginate([b('가'.repeat(60)), b('나'.repeat(60)), b('다'.repeat(60))], 100);
    // 60+60 이 100 을 넘으므로 첫 단위는 첫 블록만
    expect(r.units).toHaveLength(3);
    expect(r.unitOfBlock).toEqual([0, 1, 2]);
  });

  it('상한 안이면 여러 블록을 한 단위에 담고 빈 줄로 잇는다', () => {
    const r = paginate([b('가'), b('나'), b('다')], 100);
    expect(r.units).toEqual(['가\n\n나\n\n다']);
    expect(r.unitOfBlock).toEqual([0, 0, 0]);
  });

  it('단일 블록이 상한을 넘어도 쪼개지 않는다 (문장이 잘리면 인용이 무의미해진다)', () => {
    const long = '가'.repeat(500);
    const r = paginate([b(long)], 100);
    expect(r.units).toEqual([long]);
  });

  it('빈 블록은 단위를 만들지 않는다', () => {
    const r = paginate([b(''), b('   '), b('내용')], 100);
    expect(r.units).toEqual(['내용']);
  });

  it('블록이 없으면 빈 결과다', () => {
    expect(paginate([], 100)).toEqual({ units: [], unitOfBlock: [] });
  });

  it('기본 분량은 한국어 A4 한 쪽 기준이다', () => {
    expect(DEFAULT_UNIT_CHARS).toBe(1800);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/paginate.test.ts`
Expected: FAIL — `Failed to resolve import "../paginate"`

- [ ] **Step 3: 구현**

`src/renderer/lib/extract/paginate.ts`:

```ts
/**
 * 블록 목록 → 단위(가상 페이지).
 *
 * DOCX·HWPX 는 물리적 페이지가 파일에 없다(레이아웃 엔진이 폰트·여백으로 계산하는 결과물).
 * 작성자가 넣은 쪽나눠가 있으면 그것이 사용자가 보는 경계이므로 우선하고, 없는 구간만 분량으로
 * 끊는다. 문단 경계는 넘지 않는다 — 문장이 잘리면 그 자리를 가리키는 인용이 의미를 잃는다.
 */

export interface Block {
  text: string;
  /** 이 블록 앞에서 쪽을 나눈다(명시적 쪽나눠). */
  breakBefore: boolean;
}

export interface PaginateResult {
  units: string[];
  /** blocks[i] 가 속한 단위의 0-based 인덱스. 빈 블록은 직전 단위를 가리킨다. */
  unitOfBlock: number[];
}

/** 한국어 A4 한 쪽 분량의 근사값. */
export const DEFAULT_UNIT_CHARS = 1800;

export function paginate(blocks: Block[], maxChars: number = DEFAULT_UNIT_CHARS): PaginateResult {
  const units: string[] = [];
  const unitOfBlock: number[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length > 0) {
      units.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
  };

  for (const block of blocks) {
    const text = block.text.trim();
    if (text === '') {
      // 빈 블록은 단위를 만들지 않는다. 매핑은 직전 단위(없으면 0)로 둔다.
      unitOfBlock.push(units.length > 0 || current.length > 0 ? units.length : 0);
      continue;
    }
    const tooLong = currentLen > 0 && currentLen + text.length > maxChars;
    if (block.breakBefore || tooLong) flush();
    unitOfBlock.push(units.length);
    current.push(text);
    currentLen += text.length;
  }
  flush();

  return { units, unitOfBlock };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/paginate.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/renderer/lib/extract/paginate.ts src/renderer/lib/extract/__tests__/paginate.test.ts
git commit -m "feat(extract): 명시적 쪽나눠 우선 + 분량 보조 단위 분할

문단 경계는 넘지 않는다 — 문장이 잘리면 그 자리를 가리키는 인용이
의미를 잃는다. unitOfBlock 으로 이미지·제목을 단위에 매핑한다."
```

---

## Task 5: OOXML 관계(rels) 해석

**Files:**
- Create: `src/renderer/lib/extract/ooxml.ts`
- Create: `src/renderer/lib/extract/__tests__/ooxml.test.ts`

**Interfaces:**
- Consumes: Task 1 `ZipIndex`, Task 2 `parseXml`/`walk`/`localName`/`attr`
- Produces: `readRels(zip: ZipIndex, partPath: string): Map<string, string>` · `resolveRelTarget(partPath: string, target: string): string`

**배경:** 실물 DOCX 에서 `<a:blip r:embed="rId6"/>` → `word/_rels/document.xml.rels` 의 `rId6` → `media/image1.png` → 실제 엔트리 `word/media/image1.png` 임을 확인했다. **Target 은 파트 기준 상대 경로**라 파트 디렉터리를 붙여야 한다. PPTX 는 `ppt/slides/_rels/slide1.xml.rels` 의 Target 이 `../media/imageN.png` 여서 `..` 해석도 필요하다(P4 에서 쓰지만 여기서 함께 맞춘다).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/ooxml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { readRels, resolveRelTarget } from '../ooxml';

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>
</Relationships>`;

function zipOf(files: Record<string, string>): ReturnType<typeof openZip> {
  const input: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) input[k] = strToU8(v);
  const out = zipSync(input);
  return openZip(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
}

describe('resolveRelTarget — Target 은 파트 기준 상대 경로다', () => {
  it('같은 디렉터리 기준으로 푼다', () => {
    expect(resolveRelTarget('word/document.xml', 'media/image1.png')).toBe('word/media/image1.png');
  });

  it('상위 이동(..)을 푼다 — PPTX 슬라이드 rels 가 이 형태다', () => {
    expect(resolveRelTarget('ppt/slides/slide1.xml', '../media/image2.png')).toBe('ppt/media/image2.png');
  });

  it('절대(/로 시작) Target 은 루트 기준이다', () => {
    expect(resolveRelTarget('word/document.xml', '/word/media/x.png')).toBe('word/media/x.png');
  });
});

describe('readRels', () => {
  it('Id → 해석된 엔트리 경로를 준다', () => {
    const zip = zipOf({ 'word/document.xml': '<x/>', 'word/_rels/document.xml.rels': RELS });
    const rels = readRels(zip, 'word/document.xml');
    expect(rels.get('rId6')).toBe('word/media/image1.png');
    expect(rels.get('rId7')).toBe('media/image2.png');
  });

  it('rels 파일이 없으면 빈 Map 이다 (throw 하지 않는다)', () => {
    const zip = zipOf({ 'word/document.xml': '<x/>' });
    expect(readRels(zip, 'word/document.xml').size).toBe(0);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/ooxml.test.ts`
Expected: FAIL — `Failed to resolve import "../ooxml"`

- [ ] **Step 3: 구현**

`src/renderer/lib/extract/ooxml.ts`:

```ts
import { parseXml, walk, localName, attr } from './xml';
import type { ZipIndex } from './types';

/**
 * OOXML 의 관계(rels) 해석.
 *
 * 관계 Target 은 **파트 기준 상대 경로**다. DOCX 는 `media/image1.png`(같은 디렉터리),
 * PPTX 슬라이드는 `../media/image2.png`(상위 이동) 형태라 둘 다 풀어야 한다.
 */

/** `word/document.xml` + `media/x.png` → `word/media/x.png` */
export function resolveRelTarget(partPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseParts = partPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') baseParts.pop();
    else baseParts.push(seg);
  }
  return baseParts.join('/');
}

/** 파트의 `_rels/<이름>.rels` 를 읽어 `Id → 해석된 엔트리 경로` 로 만든다. */
export function readRels(zip: ZipIndex, partPath: string): Map<string, string> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const file = partPath.split('/').slice(-1)[0] ?? '';
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${file}.rels`;
  const xml = zip.text(relsPath);
  const out = new Map<string, string>();
  if (!xml) return out;

  for (const el of walk(parseXml(xml).documentElement)) {
    if (localName(el) !== 'Relationship') continue;
    const id = attr(el, 'Id');
    const target = attr(el, 'Target');
    // 외부 링크(TargetMode="External")는 아카이브 안에 없으므로 담지 않는다.
    if (!id || !target || attr(el, 'TargetMode') === 'External') continue;
    out.set(id, resolveRelTarget(partPath, target));
  }
  return out;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/ooxml.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/renderer/lib/extract/ooxml.ts src/renderer/lib/extract/__tests__/ooxml.test.ts
git commit -m "feat(extract): OOXML 관계(rels) 해석

Target 은 파트 기준 상대 경로다. DOCX 는 media/x.png, PPTX 슬라이드는
../media/x.png 형태라 상위 이동까지 푼다."
```

---

## Task 6: DOCX 추출기

**Files:**
- Create: `src/renderer/lib/extract/docx.ts`
- Create: `src/renderer/lib/extract/__tests__/docx.test.ts`

**Interfaces:**
- Consumes: Task 1~5 전부
- Produces: `docxExtractor: Extractor`

**배경 (실물 DOCX 확인 결과):**
- 엔트리: `word/document.xml` · `word/_rels/document.xml.rels` · `word/media/image1.png`
- 그림: `<w:drawing>` 안의 `<a:blip r:embed="rId6"/>`
- **`w:br` 은 대부분 쪽나눠가 아니다** — 실물에 있던 2개가 전부 `w:type="textWrapping"`(줄바꿈)이었다. `w:br` 을 세면 문단이 엉뚱하게 쪼개진다. **`w:type="page"` 인 것만** 쪽나눠다.
- 실물에 `w:pStyle` 이 없었다(제목 스타일 미사용) → 제목이 0건인 문서가 흔하므로 `detectChapters` 폴백이 실제로 쓰인다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/docx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { docxExtractor } from '../docx';

const W = 'xmlns:w="urn:w" xmlns:a="urn:a" xmlns:r="urn:r"';

function doc(body: string): string {
  return `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
}

function para(text: string, opts: { breakBefore?: boolean; style?: string } = {}): string {
  const pPr = `<w:pPr>${opts.breakBefore ? '<w:pageBreakBefore/>' : ''}${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}</w:pPr>`;
  return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function zipOf(files: Record<string, string | Uint8Array>) {
  const input: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) input[k] = typeof v === 'string' ? strToU8(v) : v;
  const out = zipSync(input);
  return openZip(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
}

// 1x1 PNG
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe('docxExtractor.sniff', () => {
  it('word/document.xml 이 있으면 참이다', () => {
    expect(docxExtractor.sniff(zipOf({ 'word/document.xml': doc('') }))).toBe(true);
  });

  it('없으면 거짓이다 — 확장자를 믿지 않는다', () => {
    expect(docxExtractor.sniff(zipOf({ 'ppt/presentation.xml': '<x/>' }))).toBe(false);
  });
});

describe('docxExtractor.extract', () => {
  it('문단을 순서대로 담고 unitKind 는 page 다', async () => {
    const zip = zipOf({ 'word/document.xml': doc(para('첫째') + para('둘째')) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.unitKind).toBe('page');
    expect(ex.units).toEqual(['첫째\n\n둘째']);
  });

  it('pageBreakBefore 에서 단위를 나눈다', async () => {
    const zip = zipOf({
      'word/document.xml': doc(para('표지') + para('본문', { breakBefore: true })),
    });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['표지', '본문']);
  });

  it('w:br type=page 는 쪽나눠지만 textWrapping 은 줄바꿈이다', async () => {
    const body =
      `<w:p><w:r><w:t>앞</w:t><w:br w:type="textWrapping"/><w:t>같은쪽</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>전</w:t><w:br w:type="page"/><w:t>후</w:t></w:r></w:p>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units).toEqual(['앞\n같은쪽\n\n전', '후']);
  });

  it('표를 GFM 으로 직렬화한다', async () => {
    const body =
      `<w:tbl>` +
      `<w:tr><w:tc>${para('대분류')}</w:tc><w:tc>${para('달성률')}</w:tc></w:tr>` +
      `<w:tr><w:tc>${para('신규')}</w:tc><w:tc>${para('100%')}</w:tc></w:tr>` +
      `</w:tbl>`;
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.units[0]).toBe('| 대분류 | 달성률 |\n| --- | --- |\n| 신규 | 100% |');
  });

  it('Heading 스타일을 제목으로 잡는다 (한국어 스타일명도)', async () => {
    const body = para('1장', { style: 'Heading1' }) + para('본문') + para('가', { style: '제목 2' });
    const zip = zipOf({ 'word/document.xml': doc(body) });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.headings).toEqual([
      { level: 1, title: '1장', unitIndex: 0 },
      { level: 2, title: '가', unitIndex: 0 },
    ]);
  });

  it('그림을 rels 로 따라가 속한 단위에 매핑한다', async () => {
    const body =
      para('앞') +
      `<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>` +
      para('뒤', { breakBefore: true });
    const zip = zipOf({
      'word/document.xml': doc(body),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, {});
    expect(ex.images).toHaveLength(1);
    expect(ex.images[0]!.unitIndex).toBe(0);
    expect(ex.images[0]!.mimeType).toBe('image/png');
    expect(ex.images[0]!.base64.length).toBeGreaterThan(0);
  });

  it('extractImages:false 면 그림을 수집하지 않는다', async () => {
    const zip = zipOf({
      'word/document.xml': doc(`<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>`),
      'word/_rels/document.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="urn:rel"><Relationship Id="rId6" Type="urn:x/image" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': PNG,
    });
    const ex = await docxExtractor.extract(zip, { extractImages: false });
    expect(ex.images).toEqual([]);
  });

  it('document.xml 이 없으면 DOC_CORRUPT 다', async () => {
    const zip = zipOf({ 'word/styles.xml': '<x/>' });
    await expect(docxExtractor.extract(zip, {})).rejects.toThrowError(
      expect.objectContaining({ code: 'DOC_CORRUPT' }),
    );
  });

  it('본문에 텍스트가 없으면 DOC_NO_TEXT 다', async () => {
    const zip = zipOf({ 'word/document.xml': doc('') });
    await expect(docxExtractor.extract(zip, {})).rejects.toThrowError(
      expect.objectContaining({ code: 'DOC_NO_TEXT' }),
    );
  });

  it('signal 이 이미 abort 면 ABORTED 로 조기 종료한다', async () => {
    const zip = zipOf({ 'word/document.xml': doc(para('x')) });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(docxExtractor.extract(zip, { signal: ctrl.signal })).rejects.toThrowError(
      expect.objectContaining({ code: 'ABORTED' }),
    );
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/docx.test.ts`
Expected: FAIL — `Failed to resolve import "../docx"`

- [ ] **Step 3: 구현**

`src/renderer/lib/extract/docx.ts`:

```ts
import { parseXml, walk, localName, attr, childrenNamed } from './xml';
import { readRels } from './ooxml';
import { toGfmTable } from './table';
import { paginate, type Block } from './paginate';
import { MAX_EXAMINED_IMAGES, MAX_PAGE_COUNT, MAX_TOTAL_IMAGES } from '../pdf-parser';
import type { Extractor, ExtractedDoc, ExtractedHeading, ExtractedImage, ExtractOptions, ZipIndex } from './types';

const DOCUMENT_PART = 'word/document.xml';

/** 제목 스타일 — 워드가 붙이는 스타일 ID 는 보통 영문이지만 한국어 스타일명도 들어온다. */
const HEADING_STYLE_RE = /^(?:Heading|제목)\s*([1-9])$/i;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('ABORTED', 'aborted');
}

function mimeOf(path: string): 'image/png' | 'image/jpeg' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 문단 하나를 텍스트 조각으로. `w:br type=page` 에서 조각이 끊긴다. */
function paragraphPieces(p: Element): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (const el of walk(p)) {
    const name = localName(el);
    if (name === 't') buf += el.textContent ?? '';
    else if (name === 'tab') buf += '\t';
    else if (name === 'br') {
      // 실물 DOCX 의 w:br 은 대부분 textWrapping(줄바꿈)이다. page 인 것만 쪽나눠다.
      if (attr(el, 'type') === 'page') { pieces.push(buf); buf = ''; }
      else buf += '\n';
    }
  }
  pieces.push(buf);
  return pieces;
}

function headingLevel(p: Element): number | null {
  for (const el of walk(p)) {
    if (localName(el) !== 'pStyle') continue;
    const m = HEADING_STYLE_RE.exec((attr(el, 'val') ?? '').trim());
    if (m) return Number(m[1]);
  }
  return null;
}

function hasPageBreakBefore(p: Element): boolean {
  for (const el of walk(p)) {
    if (localName(el) === 'pageBreakBefore') return attr(el, 'val') !== '0';
  }
  return false;
}

/** 표 → 행렬. 셀 안의 문단을 줄바꿈으로 이어 한 셀로 만든다. */
function tableRows(tbl: Element): string[][] {
  return childrenNamed(tbl, 'tr').map((tr) =>
    childrenNamed(tr, 'tc').map((tc) =>
      childrenNamed(tc, 'p').map((p) => paragraphPieces(p).join('\n')).join('\n'),
    ),
  );
}

export const docxExtractor: Extractor = {
  id: 'docx',
  extensions: ['.docx'],

  sniff: (zip: ZipIndex): boolean => zip.has(DOCUMENT_PART),

  extract: async (zip: ZipIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
    throwIfAborted(opts.signal);

    const xml = zip.text(DOCUMENT_PART);
    if (!xml) fail('DOC_CORRUPT', 'word/document.xml missing');

    // walk 는 제너레이터라 .find 가 없다. 펼쳐서 찾는다.
    const body = [...walk(parseXml(xml).documentElement)].find((el) => localName(el) === 'body')
      ?? fail('DOC_CORRUPT', 'w:body missing');

    const blocks: Block[] = [];
    const headingAt: { level: number; title: string; blockIndex: number }[] = [];
    const imageAt: { relId: string; blockIndex: number }[] = [];

    for (const child of Array.from(body.children)) {
      throwIfAborted(opts.signal);
      const name = localName(child);

      if (name === 'tbl') {
        blocks.push({ text: toGfmTable(tableRows(child)), breakBefore: false });
        continue;
      }
      if (name !== 'p') continue;

      const pieces = paragraphPieces(child);
      const level = headingLevel(child);
      let breakBefore = hasPageBreakBefore(child);

      for (const [i, piece] of pieces.entries()) {
        const blockIndex = blocks.length;
        blocks.push({ text: piece, breakBefore: breakBefore || i > 0 });
        breakBefore = false;
        if (i === 0) {
          if (level !== null && piece.trim()) {
            headingAt.push({ level, title: piece.trim(), blockIndex });
          }
          for (const el of walk(child)) {
            if (localName(el) !== 'blip') continue;
            const relId = attr(el, 'embed');
            if (relId) imageAt.push({ relId, blockIndex });
          }
        }
      }
    }

    const { units, unitOfBlock } = paginate(blocks);
    if (units.length === 0) fail('DOC_NO_TEXT', 'no text in document');
    // 단위 수 상한은 PDF 와 같은 예산을 쓴다 — 요약·임베딩이 단위 수에 선형으로 확장된다.
    if (units.length > MAX_PAGE_COUNT) {
      fail('PDF_TOO_MANY_PAGES', `unit count ${units.length} exceeds ${MAX_PAGE_COUNT}`);
    }

    const headings: ExtractedHeading[] = headingAt.map((h) => ({
      level: h.level,
      title: h.title,
      unitIndex: unitOfBlock[h.blockIndex] ?? 0,
    }));

    const images: ExtractedImage[] = [];
    let imageBudgetExceeded = false;
    if (opts.extractImages !== false && imageAt.length > 0) {
      const rels = readRels(zip, DOCUMENT_PART);
      const seen = new Set<string>();
      let examined = 0;
      for (const { relId, blockIndex } of imageAt) {
        throwIfAborted(opts.signal);
        if (examined >= MAX_EXAMINED_IMAGES) break;
        examined += 1;
        const path = rels.get(relId);
        if (!path || seen.has(path)) continue;
        const mimeType = mimeOf(path);
        const bytes = zip.bytes(path);
        if (!mimeType || !bytes) continue;
        seen.add(path);
        if (images.length >= MAX_TOTAL_IMAGES) { imageBudgetExceeded = true; continue; }
        images.push({
          unitIndex: unitOfBlock[blockIndex] ?? 0,
          base64: toBase64(bytes),
          // 원본 픽셀 크기는 디코드해야 알 수 있는데 Vision 경로가 쓰지 않는다. 0 으로 둔다.
          width: 0,
          height: 0,
          mimeType,
        });
      }
    }

    return {
      units,
      images,
      headings,
      unitKind: 'page',
      ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
    };
  },
};
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/docx.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/renderer/lib/extract/docx.ts src/renderer/lib/extract/__tests__/docx.test.ts
git commit -m "feat(extract): DOCX 추출기

실물 DOCX 로 확인한 것 둘을 반영한다 — w:br 은 대부분 textWrapping
(줄바꿈)이라 type=page 인 것만 쪽나눠로 센다. 그림은 a:blip/@r:embed 를
rels 로 따라가 속한 문단의 단위에 매핑한다."
```

---

## Task 7: `ExtractedDoc` → `PdfDocument` 정규화

**Files:**
- Create: `src/renderer/lib/extract/normalize.ts`
- Create: `src/renderer/lib/extract/__tests__/normalize.test.ts`
- Modify: `src/renderer/types/index.ts` (`PdfDocument.unitKind?`)

**Interfaces:**
- Consumes: Task 6 `ExtractedDoc`
- Produces: `toPdfDocument(ex: ExtractedDoc, meta: { fileName: string; filePath: string }): PdfDocument`

**배경:** 마커(`imagesSkipped`)는 **호출자가** 채운다 — `handlePdfData` 가 지금 `if (!extractImagesEnabled) doc.imagesSkipped = true` 로 하는 것과 동일하게 둔다. `hadImages` 는 영속화 시점에 `use-session.ts:500` 이 파생하므로 여기서 건드리지 않는다. PDF 경로와 **비대칭이 생기면 그 자체가 결함**이다.

- [ ] **Step 1: `PdfDocument` 에 필드 추가**

`src/renderer/types/index.ts` 의 `PdfDocument` 인터페이스 안, `imageBudgetExceeded` 바로 뒤에 추가한다:

```ts
  /**
   * 단위의 성격. 표시 라벨만 갈린다(`[p.3]` / `[슬라이드 3]` / `[3장]`).
   *
   * 내부 표현은 언제나 정수 N 이다 — CITATION_REGEX·clampCitationPage·pageTexts·RAG 청크 메타가
   * 전부 그 위에 서 있어서, 여기에 배열이나 문자열을 끼우면 계약이 번진다. 부재는 'page' 다
   * (기존 PDF 문서·구버전 세션이 곧 그 값이므로 마이그레이션이 필요 없다).
   */
  unitKind?: UnitKind;
```

같은 파일 상단에 타입을 재수출한다(`extract/types.ts` 가 단일 출처):

```ts
export type { UnitKind } from '../lib/extract/types';
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/renderer/lib/extract/__tests__/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toPdfDocument } from '../normalize';
import type { ExtractedDoc } from '../types';

const base: ExtractedDoc = { units: ['가', '나'], images: [], headings: [], unitKind: 'page' };
const meta = { fileName: 'a.docx', filePath: 'C:/x/a.docx' };

describe('toPdfDocument', () => {
  it('units 를 pageTexts·pageCount·extractedText 로 옮긴다', () => {
    const doc = toPdfDocument(base, meta);
    expect(doc.pageTexts).toEqual(['가', '나']);
    expect(doc.pageCount).toBe(2);
    expect(doc.extractedText).toBe('가\n\n나');
  });

  it('unitKind 와 파일 메타를 싣는다', () => {
    const doc = toPdfDocument({ ...base, unitKind: 'slide' }, meta);
    expect(doc.unitKind).toBe('slide');
    expect(doc.fileName).toBe('a.docx');
    expect(doc.filePath).toBe('C:/x/a.docx');
    expect(doc.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('ExtractedImage.unitIndex 를 PageImage.pageIndex 로 옮긴다', () => {
    const doc = toPdfDocument(
      { ...base, images: [{ unitIndex: 1, base64: 'x', width: 0, height: 0, mimeType: 'image/png' }] },
      meta,
    );
    expect(doc.images).toEqual([
      { pageIndex: 1, imageIndex: 0, base64: 'x', width: 0, height: 0, mimeType: 'image/png' },
    ]);
  });

  it('제목이 있으면 그것으로 챕터를 만든다 (휴리스틱을 건너뛴다)', () => {
    const doc = toPdfDocument(
      {
        ...base,
        units: ['1장 본문', '2장 본문'],
        headings: [
          { level: 1, title: '1장', unitIndex: 0 },
          { level: 1, title: '2장', unitIndex: 1 },
        ],
      },
      meta,
    );
    expect(doc.chapters.map((c) => [c.title, c.startPage, c.endPage])).toEqual([
      ['1장', 1, 2],
      ['2장', 2, 3],
    ]);
  });

  it('제목이 없으면 detectChapters 폴백을 쓴다', () => {
    const doc = toPdfDocument({ ...base, headings: [] }, meta);
    expect(doc.chapters.length).toBeGreaterThan(0);
  });

  it('imagesSkipped·hadImages 를 설정하지 않는다 (호출자·영속화의 책임)', () => {
    const doc = toPdfDocument(base, meta);
    expect(doc.imagesSkipped).toBeUndefined();
    expect(doc.hadImages).toBeUndefined();
  });

  it('imageBudgetExceeded 는 있을 때만 싣는다', () => {
    expect(toPdfDocument(base, meta).imageBudgetExceeded).toBeUndefined();
    expect(toPdfDocument({ ...base, imageBudgetExceeded: true }, meta).imageBudgetExceeded).toBe(true);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/normalize.test.ts`
Expected: FAIL — `Failed to resolve import "../normalize"`

- [ ] **Step 4: 구현**

`src/renderer/lib/extract/normalize.ts`:

```ts
import type { Chapter, PageImage, PdfDocument } from '../../types';
import { detectChapters } from '../pdf-parser';
import type { ExtractedDoc } from './types';

/**
 * ExtractedDoc → PdfDocument.
 *
 * 추출기가 PdfDocument 를 직접 조립하지 않는 이유가 여기다 — 필드를 채우는 자리가 한 곳이어야
 * 포맷이 늘 때 "한 포맷만 새 필드를 안 채움"이 생기지 않는다.
 *
 * imagesSkipped 는 **호출자**가 설정한다(설정 OFF 여부는 여기서 모른다). hadImages 는 영속화
 * 시점에 use-session 이 파생한다. PDF 경로(parsePdf)와 대칭을 유지한다 — 비대칭 자체가 결함이다.
 */
export function toPdfDocument(
  ex: ExtractedDoc,
  meta: { fileName: string; filePath: string },
): PdfDocument {
  const pageTexts = [...ex.units];

  const images: PageImage[] = ex.images.map((img, i) => ({
    pageIndex: img.unitIndex,
    imageIndex: i,
    base64: img.base64,
    width: img.width,
    height: img.height,
    mimeType: img.mimeType,
  }));

  // 포맷이 제목을 알려주면 detectChapters 의 휴리스틱(본문 첫 줄 패턴 매칭)을 건너뛴다.
  // 제목이 하나도 없는 문서가 실제로 흔하므로(실물 DOCX 에 pStyle 이 없었다) 폴백을 유지한다.
  const chapters: Chapter[] =
    ex.headings.length > 0
      ? ex.headings.map((h, i) => {
          // startPage 는 1-based inclusive, endPage 는 slice 용 exclusive 경계다
          // (types/index.ts 의 Chapter 주석). 마지막 챕터는 pageTexts.length + 1 이다.
          const startPage = h.unitIndex + 1;
          const next = ex.headings[i + 1];
          const endPage = next ? next.unitIndex + 1 : pageTexts.length + 1;
          return {
            index: i,
            title: h.title,
            startPage,
            endPage,
            text: pageTexts.slice(startPage - 1, endPage - 1).join('\n\n'),
          };
        })
      : detectChapters(pageTexts);

  return {
    id: crypto.randomUUID(),
    fileName: meta.fileName,
    filePath: meta.filePath,
    pageCount: pageTexts.length,
    extractedText: pageTexts.join('\n\n'),
    pageTexts,
    chapters,
    images,
    createdAt: new Date(),
    unitKind: ex.unitKind,
    ...(ex.imageBudgetExceeded ? { imageBudgetExceeded: true } : {}),
  };
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/normalize.test.ts`
Expected: PASS (7 tests). 챕터 경계 테스트가 실패하면 `endPage` 계산을 테스트의 기대값(마지막 챕터는 `pageTexts.length + 1`)에 맞춘다 — `Chapter.endPage` 는 slice 용 exclusive 경계다(`src/renderer/types/index.ts:66` 주석).

- [ ] **Step 6: 커밋**

```bash
npx tsc --noEmit
git add src/renderer/types/index.ts src/renderer/lib/extract/normalize.ts src/renderer/lib/extract/__tests__/normalize.test.ts
git commit -m "feat(extract): ExtractedDoc → PdfDocument 정규화

필드를 채우는 자리를 한 곳으로 모아 포맷이 늘 때 형제 누락이 생기지
않게 한다. imagesSkipped 는 호출자, hadImages 는 영속화가 채우는 것을
PDF 경로와 동일하게 유지한다."
```

---

## Task 8: 지원 포맷 단일 출처 + 소스 스캔 가드

**Files:**
- Create: `src/shared/document-formats.ts`
- Create: `src/shared/__tests__/document-formats.test.ts`
- Modify: `src/shared/__tests__/source-scan.test.ts` (가드 추가)

**Interfaces:**
- Consumes: 없음 (순수 값)
- Produces: `SUPPORTED_FORMATS` · `SUPPORTED_EXTENSIONS` · `DIALOG_FILTERS` · `isSupportedExtension(path: string): boolean` · `hasZipMagic(head: Uint8Array): boolean` · `hasPdfMagic(head: Uint8Array): boolean`

**배경:** 현재 `.pdf` 를 아는 곳이 5군데다(`main/index.ts:286` 드롭 URL · `:1588` 다이얼로그 필터 · `:1714` 재읽기 · `App.tsx:306` DOM 드롭 · `pdf-parser.ts` 매직). 포맷을 더 붙이면서 그대로 두면 "한 곳만 안 따라감"이 난다 — 이 저장소에서 가장 자주 반복된 형태다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/__tests__/document-formats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_FORMATS, SUPPORTED_EXTENSIONS, DIALOG_FILTERS,
  isSupportedExtension, hasZipMagic, hasPdfMagic,
} from '../document-formats';

describe('document-formats — 지원 포맷 단일 출처', () => {
  it('P1 시점의 지원 목록은 pdf 와 docx 다', () => {
    expect(SUPPORTED_FORMATS.map((f) => f.id)).toEqual(['pdf', 'docx']);
    expect(SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.docx']);
  });

  it('확장자 검사는 대소문자를 가리지 않는다', () => {
    expect(isSupportedExtension('C:/x/A.PDF')).toBe(true);
    expect(isSupportedExtension('/tmp/보고서.DocX')).toBe(true);
    expect(isSupportedExtension('/tmp/a.exe')).toBe(false);
    expect(isSupportedExtension('/tmp/확장자없음')).toBe(false);
  });

  it('다이얼로그 필터는 "모든 지원 문서" 를 먼저 둔다', () => {
    expect(DIALOG_FILTERS[0]?.extensions).toEqual(['pdf', 'docx']);
    // 필터의 extensions 는 점 없는 형태여야 한다 (Electron 규약)
    for (const f of DIALOG_FILTERS) {
      for (const e of f.extensions) expect(e.startsWith('.')).toBe(false);
    }
  });

  it('PDF 매직은 선행 바이트를 허용한다 (pdfjs 와 관용도를 맞춘다)', () => {
    const enc = new TextEncoder();
    expect(hasPdfMagic(enc.encode('%PDF-1.7'))).toBe(true);
    expect(hasPdfMagic(enc.encode('\uFEFF  %PDF-1.4'))).toBe(true);
    expect(hasPdfMagic(enc.encode('not a pdf'))).toBe(false);
  });

  it('zip 매직은 오프셋 0 정확 매칭이다', () => {
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    // 암호가 걸린 OOXML 은 CFB 컨테이너라 zip 이 아니다 — 여기서 갈린다
    expect(hasZipMagic(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
    expect(hasZipMagic(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/shared/__tests__/document-formats.test.ts`
Expected: FAIL — `Failed to resolve import "../document-formats"`

- [ ] **Step 3: 구현**

`src/shared/document-formats.ts`:

```ts
/**
 * 지원 입력 포맷의 단일 출처 — Main/Renderer 공용.
 *
 * constants.ts 와 같은 규칙으로 순수 값/타입만 둔다(런타임 API 참조 금지).
 * 확장자를 아는 자리가 흩어져 있으면 포맷이 늘 때 한 곳이 안 따라간다 — 이 저장소에서 가장
 * 자주 반복된 형태라(QA32 형제 누락, QA33 H6) 진입 게이트 전부가 여기를 참조한다.
 *
 * ⚠️ 판별은 확장자가 아니라 **내용**으로 한다. 확장자는 다이얼로그 필터와 초기 힌트일 뿐이다.
 */

export interface DocumentFormat {
  id: 'pdf' | 'docx' | 'pptx' | 'hwpx' | 'epub';
  /** 소문자, 점 포함 */
  ext: string;
  /** 다이얼로그에 보일 이름 */
  label: string;
  /** zip 컨테이너 기반 포맷인가 (아니면 PDF 처럼 고유 매직) */
  container: 'zip' | 'pdf';
}

export const SUPPORTED_FORMATS: readonly DocumentFormat[] = [
  { id: 'pdf', ext: '.pdf', label: 'PDF', container: 'pdf' },
  { id: 'docx', ext: '.docx', label: 'Word', container: 'zip' },
] as const;

export const SUPPORTED_EXTENSIONS: readonly string[] = SUPPORTED_FORMATS.map((f) => f.ext);

/** Electron dialog 의 filters — extensions 는 점 없는 형태여야 한다. */
export const DIALOG_FILTERS: readonly { name: string; extensions: string[] }[] = [
  { name: '문서', extensions: SUPPORTED_FORMATS.map((f) => f.ext.slice(1)) },
  ...SUPPORTED_FORMATS.map((f) => ({ name: f.label, extensions: [f.ext.slice(1)] })),
];

export function isSupportedExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** zip 로컬 파일 헤더 `PK\x03\x04`. 암호가 걸린 OOXML 은 CFB 라 여기서 갈린다. */
export function hasZipMagic(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * `%PDF-` 시그니처. pdfjs 는 앞에 붙은 BOM·공백·잘못 덧붙은 헤더를 허용하므로 앞쪽 1KB 창에서
 * 스캔해 파서와 관용도를 맞춘다(QA13 C-LOW: 오프셋 0 정확 매칭이 유효 PDF 를 조기 오거부했다).
 */
export function hasPdfMagic(head: Uint8Array): boolean {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const limit = Math.min(head.length, 1024);
  for (let i = 0; i + sig.length <= limit; i++) {
    if (sig.every((b, j) => head[i + j] === b)) return true;
  }
  return false;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/shared/__tests__/document-formats.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 소스 스캔 가드 추가**

`src/shared/__tests__/source-scan.test.ts` 끝에 추가한다:

```ts
describe('확장자 리터럴은 document-formats.ts 밖에 두지 않는다', () => {
  /**
   * 진입 게이트가 흩어져 있으면 포맷이 늘 때 한 곳이 안 따라간다. 새 게이트가 생기는 순간
   * 여기서 실패하게 만들어 지점을 **도출**한다(열거하면 사각이 생긴다 — QA33 I3).
   */
  const ALLOWED = new Set([
    'src/shared/document-formats.ts',
    'src/shared/__tests__/document-formats.test.ts',
    'src/shared/__tests__/source-scan.test.ts',
  ]);
  // 내보내기 저장 다이얼로그(file:save / file:export-pdf)는 **출력** 확장자라 이 가드의 대상이 아니다.
  const OUTPUT_ONLY = /export-pdf|showSaveDialog|MAX_EXPORT_SIZE/;

  it("'.pdf'/'.docx' 리터럴이 단일 출처 밖에 없다", () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles('src')) {
      if (ALLOWED.has(file.replace(/\\/g, '/'))) continue;
      const src = stripJsComments(readFileSync(file, 'utf-8'));
      for (const [i, line] of src.split('\n').entries()) {
        if (OUTPUT_ONLY.test(line)) continue;
        if (/['"`]\.?(pdf|docx)['"`]/i.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders, '확장자는 document-formats.ts 에서만 안다').toEqual([]);
  });
});
```

`walkSourceFiles` 가 이 파일에 아직 없으면 상단에 추가한다:

```ts
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(dir), { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}
```

- [ ] **Step 6: 가드가 현재 위반을 잡는지 확인**

Run: `npx vitest run src/shared/__tests__/source-scan.test.ts`
Expected: **FAIL** — `main/index.ts` · `App.tsx` · `pdf-parser.ts` 의 확장자 리터럴이 offenders 로 잡힌다. **이것이 Task 9 의 작업 목록이다.** 실패 목록을 복사해 둔다.

- [ ] **Step 7: 커밋 (가드는 아직 실패 상태이므로 skip 표시)**

가드 테스트에 `.skip` 을 붙여 커밋하고, Task 9 마지막에 해제한다:

```ts
describe.skip('확장자 리터럴은 document-formats.ts 밖에 두지 않는다', () => {
```

```bash
npx tsc --noEmit
git add src/shared/document-formats.ts src/shared/__tests__/
git commit -m "feat(shared): 지원 포맷 단일 출처 + 확장자 가드(아직 skip)

진입 게이트가 5곳에 흩어져 있어 포맷이 늘면 한 곳이 안 따라간다.
가드는 위반 지점을 도출하는 용도이며 Task 9 에서 게이트를 옮긴 뒤 켠다."
```

---

## Task 9: 진입 게이트 5곳을 단일 출처로 교체

**Files:**
- Modify: `src/main/index.ts:286` (드롭 `file://` URL), `:1588` (다이얼로그 필터), `:1714` (`file:open-path`)
- Modify: `src/renderer/App.tsx:306` (DOM 드롭)
- Modify: `src/shared/__tests__/source-scan.test.ts` (`.skip` 해제)
- Test: `src/main/__tests__/file-gates.test.ts` (신규)

**Interfaces:**
- Consumes: Task 8 `isSupportedExtension` · `DIALOG_FILTERS`
- Produces: 없음 (기존 동작 유지)

- [ ] **Step 1: 게이트 동작을 고정하는 테스트 작성**

`src/main/__tests__/file-gates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isSupportedExtension, DIALOG_FILTERS } from '../../shared/document-formats';

describe('진입 게이트가 받아들이는 것 / 막는 것', () => {
  it('PDF 는 계속 통과한다 (회귀 방지)', () => {
    expect(isSupportedExtension('C:/x/a.pdf')).toBe(true);
    expect(isSupportedExtension('file:///C:/x/a.PDF')).toBe(true);
  });

  it('DOCX 가 통과한다', () => {
    expect(isSupportedExtension('C:/x/보고서.docx')).toBe(true);
  });

  it('아직 지원하지 않는 포맷은 막는다 (P4 에서 열린다)', () => {
    for (const p of ['a.pptx', 'a.hwpx', 'a.epub', 'a.hwp']) {
      expect(isSupportedExtension(p), p).toBe(false);
    }
  });

  it('실행 파일·스크립트는 막는다', () => {
    for (const p of ['a.exe', 'a.bat', 'a.js', 'a.pdf.exe']) {
      expect(isSupportedExtension(p), p).toBe(false);
    }
  });

  it('다이얼로그 필터가 비어 있지 않다 (빈 필터는 모든 파일을 고르게 한다)', () => {
    expect(DIALOG_FILTERS.length).toBeGreaterThan(0);
    expect(DIALOG_FILTERS[0]!.extensions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 테스트 실행 — 여기서는 통과한다**

Run: `npx vitest run src/main/__tests__/file-gates.test.ts`
Expected: PASS (5 tests). 이 테스트는 게이트 교체 **전후로 모두 통과**해야 한다 — 교체가 동작을 바꾸지 않았다는 증거다.

- [ ] **Step 3: `main/index.ts` 의 드롭 URL 게이트 교체**

`src/main/index.ts:286` 부근:

```ts
// 변경 전
if (url.startsWith('file://') && url.toLowerCase().endsWith('.pdf')) {

// 변경 후
if (url.startsWith('file://') && isSupportedExtension(decodeURIComponent(url))) {
```

파일 상단에 `import { isSupportedExtension, DIALOG_FILTERS } from '../shared/document-formats';` 를 추가한다.

> `decodeURIComponent` 를 씌우는 이유: 드롭 URL 은 한글 파일명이 퍼센트 인코딩돼 오는데, 확장자 자체는 ASCII 라 기존 코드가 우연히 동작했다. 포맷이 늘어도 같은 우연에 기대지 않도록 명시적으로 푼다.

- [ ] **Step 4: 다이얼로그 필터와 재읽기 게이트 교체**

`src/main/index.ts:1588` 부근 (`file:open-pdf` 핸들러):

```ts
// 변경 전
filters: [{ name: 'PDF', extensions: ['pdf'] }],

// 변경 후
filters: [...DIALOG_FILTERS],
```

`src/main/index.ts:1714` 부근 (`file:open-path` 핸들러):

```ts
// 변경 전
if (path.extname(targetPath).toLowerCase() !== '.pdf') {

// 변경 후
if (!isSupportedExtension(targetPath)) {
```

- [ ] **Step 5: `App.tsx` 의 DOM 드롭 게이트 교체**

`src/renderer/App.tsx:306` 부근:

```ts
// 변경 전
const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

// 변경 후
const isSupported = isSupportedExtension(file.name);
```

이후 `isPdf` 를 쓰는 자리를 `isSupported` 로 바꾼다. 파일 상단에 import 를 추가한다.

> MIME 타입 검사를 뺀 이유: 드롭된 DOCX 의 `file.type` 은 브라우저·OS 에 따라 빈 문자열이 되기도 한다. 어차피 §Task 10 의 sniff 가 내용으로 판별하므로 여기서는 확장자만 본다.

- [ ] **Step 6: 가드 `.skip` 해제**

`src/shared/__tests__/source-scan.test.ts` 의 `describe.skip(` → `describe(`.

- [ ] **Step 7: 전체 테스트**

Run: `npx vitest run`
Expected: PASS. 확장자 가드가 남은 위반을 가리키면 그 자리도 `isSupportedExtension` 으로 바꾼다. `pdf-parser.ts` 의 `%PDF-` 매직 스캔은 Task 10 에서 옮기므로, 그때까지 `ALLOWED` 에 `src/renderer/lib/pdf-parser.ts` 를 한시적으로 넣고 **Task 10 Step 6 에서 반드시 뺀다**.

- [ ] **Step 8: 커밋**

```bash
npx tsc --noEmit
git add src/main/index.ts src/renderer/App.tsx src/shared/__tests__/source-scan.test.ts src/main/__tests__/file-gates.test.ts
git commit -m "refactor: 진입 게이트 4곳을 document-formats 단일 출처로

드롭 URL·다이얼로그 필터·재읽기·DOM 드롭이 각자 '.pdf' 를 알고 있었다.
동작은 그대로 두고 출처만 모은다 — file-gates.test.ts 가 교체 전후로
같은 결과를 요구한다."
```

---

## Task 10: `handlePdfData` → `document-open.ts` 이동 + DOCX 개통

**Files:**
- Create: `src/renderer/lib/document-open.ts`
- Create: `src/renderer/lib/extract/registry.ts`
- Create: `src/renderer/lib/__tests__/document-open.test.ts`
- Modify: `src/renderer/lib/pdf-parser.ts` (`handlePdfData` 제거)
- Modify: `src/renderer/components/PdfUploader.tsx` · `src/renderer/App.tsx` · `src/renderer/lib/tabs.ts` 등 `handlePdfData` 호출부

**Interfaces:**
- Consumes: Task 6 `docxExtractor`, Task 7 `toPdfDocument`, Task 8 `hasPdfMagic`/`hasZipMagic`, Task 1 `openZip`
- Produces: `openDocumentData(data: ArrayBuffer, name: string, filePath: string, opts?: { skipDiscardConfirm?: boolean }): Promise<void>` · `cancelDocumentParse(): void` · `resolveExtractor(zip: ZipIndex): Extractor | null`

**⚠️ 가장 위험한 작업이다.** `handlePdfData` 는 QA 라운드마다 가드가 하나씩 붙어온 자리다 — 생성 중 차단 · Q&A 중 차단 · 컬렉션 busy · 컬렉션 열기 중 · 파기 확인 · 크기 캡 · abort-replace · 소유권 재검사 · 이전 세션 flush · `isParsing` 고착 방지. **로직을 바꾸지 않고 옮긴다.**

- [ ] **Step 1: 이동 전 동작을 고정하는 characterization 테스트 작성**

`src/renderer/lib/__tests__/document-open.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../store';

vi.mock('../pdf-parser', async (orig) => {
  const actual = await orig<typeof import('../pdf-parser')>();
  return { ...actual, parsePdf: vi.fn() };
});

const PDF_BYTES = (): ArrayBuffer => new TextEncoder().encode('%PDF-1.7\n...').buffer as ArrayBuffer;

async function open(data: ArrayBuffer = PDF_BYTES()): Promise<void> {
  const { openDocumentData } = await import('../document-open');
  await openDocumentData(data, 'a.pdf', 'C:/x/a.pdf');
}

describe('openDocumentData — 진입 가드 (이동 전 동작 고정)', () => {
  beforeEach(() => {
    useAppStore.setState({
      isGenerating: false, isQaGenerating: false, isCollectionBusy: false,
      collectionOpenInFlight: false, document: null, error: null,
    });
  });

  it('요약 생성 중이면 열지 않고 에러를 띄운다', async () => {
    useAppStore.setState({ isGenerating: true });
    await open();
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(useAppStore.getState().document).toBeNull();
  });

  it('Q&A 생성 중이면 열지 않는다', async () => {
    useAppStore.setState({ isQaGenerating: true });
    await open();
    expect(useAppStore.getState().error).not.toBeNull();
  });

  it('컬렉션 작업 중이면 열지 않는다', async () => {
    useAppStore.setState({ isCollectionBusy: true });
    await open();
    expect(useAppStore.getState().error).not.toBeNull();
  });

  it('컬렉션 열기 중이면 열지 않는다', async () => {
    useAppStore.setState({ collectionOpenInFlight: true });
    await open();
    expect(useAppStore.getState().error).not.toBeNull();
  });

  it('지원하지 않는 내용이면 DOC_UNSUPPORTED 다', async () => {
    await open(new TextEncoder().encode('이건 아무것도 아님').buffer as ArrayBuffer);
    expect(useAppStore.getState().error?.code).toBe('DOC_UNSUPPORTED');
  });

  it('zip 이지만 아는 포맷이 아니면 DOC_UNSUPPORTED 다', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const out = zipSync({ 'random/thing.txt': strToU8('x') });
    await open(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
    expect(useAppStore.getState().error?.code).toBe('DOC_UNSUPPORTED');
  });

  it('암호가 걸린 OOXML(CFB 컨테이너)은 DOC_ENCRYPTED 다', async () => {
    // CFB 매직 D0 CF 11 E0 A1 B1 1A E1
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await open(cfb.buffer as ArrayBuffer);
    expect(useAppStore.getState().error?.code).toBe('DOC_ENCRYPTED');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/__tests__/document-open.test.ts`
Expected: FAIL — `Failed to resolve import "../document-open"`

- [ ] **Step 3: registry 작성**

`src/renderer/lib/extract/registry.ts`:

```ts
import { docxExtractor } from './docx';
import type { Extractor, ZipIndex } from './types';

/**
 * zip 컨테이너 포맷의 판별.
 *
 * 네 포맷 전부 zip 이라 매직만으로는 구분되지 않는다. 엔트리 목록으로 sniff 한다 —
 * 확장자는 힌트일 뿐 신뢰하지 않는다(위장 파일).
 */
export const ZIP_EXTRACTORS: readonly Extractor[] = [docxExtractor];

export function resolveExtractor(zip: ZipIndex): Extractor | null {
  return ZIP_EXTRACTORS.find((e) => e.sniff(zip)) ?? null;
}
```

- [ ] **Step 4: `document-open.ts` 작성 — 기존 본문을 그대로 옮기고 분기만 교체**

`src/renderer/lib/pdf-parser.ts` 의 `handlePdfData` 본문 전체를 `src/renderer/lib/document-open.ts` 로 **그대로 복사**한 뒤, 아래 세 지점만 바꾼다.

① 매직 검사 블록(`const PDF_SIG = ...` 부터 `if (!isPdfMagic) { ... return; }` 까지)을 다음으로 교체:

```ts
  // 내용 기반 판별 — 확장자를 믿지 않는다. 위장 바이너리를 파서 진입 전에 거부한다.
  const head = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
  const isPdf = hasPdfMagic(head);
  let extractor: Extractor | null = null;
  let zip: ZipIndex | null = null;

  if (!isPdf) {
    // 암호가 걸린 OOXML 은 zip 이 아니라 CFB 컨테이너다 — 여기서 전용 안내로 갈라낸다.
    const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (CFB.every((b, i) => head[i] === b)) {
      store.setError({ code: 'DOC_ENCRYPTED', message: t('doc.encrypted') } as AppError);
      return;
    }
    if (!hasZipMagic(head)) {
      store.setError({ code: 'DOC_UNSUPPORTED', message: t('doc.unsupported', { list: SUPPORTED_LABEL }) } as AppError);
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
```

② 파싱 호출부(`const doc = await parsePdf(...)`)를 교체:

```ts
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
```

③ `validCodes` 집합에 신규 코드를 더한다:

```ts
    const validCodes = new Set([
      'PDF_PARSE_FAIL', 'PDF_NO_TEXT', 'PDF_TOO_MANY_PAGES', 'PDF_ENCRYPTED', 'OCR_FAIL',
      'DOC_UNSUPPORTED', 'DOC_CORRUPT', 'DOC_ENCRYPTED', 'DOC_TOO_LARGE', 'DOC_NO_TEXT',
    ]);
```

④ `pdfBytesCopy` 게이트에 포맷 조건을 더한다 — 비-PDF 는 원본 바이트가 필요 없다:

```ts
    // 원본 바이트는 PdfViewer 가 pdfjs 로 다시 그릴 때만 쓴다. 비-PDF 는 텍스트 뷰어가
    // pageTexts 로 렌더하므로 붙들 이유가 없다.
    pdfBytesCopy = !isPdf || isReReadablePath(filePath) ? null : new Uint8Array(data.slice(0));
```

파일 상단 import:

```ts
import { hasPdfMagic, hasZipMagic, SUPPORTED_FORMATS } from '../../shared/document-formats';
import { openZip } from './extract/zip';
import { resolveExtractor } from './extract/registry';
import { toPdfDocument } from './extract/normalize';
import type { Extractor, ZipIndex } from './extract/types';

const SUPPORTED_LABEL = SUPPORTED_FORMATS.map((f) => f.label).join(' · ');
```

함수 이름을 `openDocumentData` 로, 취소 함수를 `cancelDocumentParse` 로 바꾼다.

- [ ] **Step 5: `pdf-parser.ts` 정리와 호출부 교체**

`pdf-parser.ts` 에서 `handlePdfData` · `cancelPdfParse` · `activeParseController` · `MAX_FILE_SIZE` 를 제거한다(`parsePdf` · `detectChapters` · 상수들은 그대로 둔다). 호출부를 전부 바꾼다:

```bash
git grep -ln "handlePdfData\|cancelPdfParse" -- src
```

각 파일에서 `handlePdfData` → `openDocumentData`, `cancelPdfParse` → `cancelDocumentParse`, import 경로를 `'../lib/document-open'`(컴포넌트) 또는 `'./document-open'`(lib) 으로 바꾼다.

- [ ] **Step 6: 확장자 가드의 한시 허용 제거**

Task 9 Step 7 에서 `ALLOWED` 에 넣은 `src/renderer/lib/pdf-parser.ts` 를 **뺀다.**

- [ ] **Step 7: 전체 테스트**

Run: `npx vitest run`
Expected: PASS. 기존 `pdf-parser` 테스트가 `handlePdfData` 를 참조하면 import 를 `document-open` 으로 옮긴다(테스트 내용은 바꾸지 않는다 — 동작이 같아야 한다).

- [ ] **Step 8: 실제 DOCX 로 수동 확인**

```bash
npm run dev
```

DOCX 파일을 드롭해 파싱이 끝나고 요약 버튼이 활성화되는지, PDF 도 여전히 열리는지 확인한다.

- [ ] **Step 9: 커밋**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat: DOCX 개통 — handlePdfData 를 document-open 으로 이동

이 함수는 QA 라운드마다 가드가 하나씩 붙어온 자리라 로직은 그대로 옮기고
매직 검사와 파싱 호출 두 지점만 교체했다. 비-PDF 는 원본 바이트를 붙들지
않는다 — 텍스트 뷰어가 pageTexts 로 렌더하므로 필요가 없다."
```

---

## Task 11: `unitKind` 전파 (세션·매니페스트·탭)

**Files:**
- Modify: `src/renderer/types/index.ts` (`PersistedSession.unitKind?`)
- Modify: `src/shared/session-types.ts` (`SessionManifestEntry.unitKind?`)
- Modify: `src/renderer/lib/store.ts` (`openTabs` 항목)
- Modify: `src/renderer/lib/use-session.ts` (저장·복원)
- Modify: `src/renderer/lib/tabs.ts` (복원 경로)
- Test: `src/renderer/lib/__tests__/unit-kind-propagation.test.ts` (신규)

**Interfaces:**
- Consumes: Task 7 `PdfDocument.unitKind`
- Produces: 없음 (필드 전파)

**배경:** 형제 셋이 같이 가야 한다. 매니페스트까지 넣는 이유는 최근 문서 목록과 전역 검색이 `pageCount` 로 "N쪽"을 표시하기 때문이다 — 빠지면 PPTX 가 목록에서만 "12쪽"이 된다. `SESSION_SCHEMA_VERSION` 은 **올리지 않는다**(부재 = `'page'` 가 옳은 값).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/__tests__/unit-kind-propagation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SESSION_SCHEMA_VERSION } from '../../../shared/session-types';
import { useAppStore } from '../store';

describe('unitKind 전파', () => {
  it('스키마 버전을 올리지 않는다 (부재가 곧 page 이므로 마이그레이션이 불필요하다)', () => {
    expect(SESSION_SCHEMA_VERSION).toBe(1);
  });

  it('openTabs 항목이 unitKind 를 싣는다', () => {
    useAppStore.setState({ openTabs: [] });
    useAppStore.getState().upsertOpenTab({
      filePath: 'C:/x/a.docx', fileName: 'a.docx', pageCount: 3, unitKind: 'page',
    });
    expect(useAppStore.getState().openTabs[0]?.unitKind).toBe('page');
  });

  it('unitKind 없는 기존 탭도 허용된다 (선택 필드)', () => {
    useAppStore.setState({ openTabs: [] });
    useAppStore.getState().upsertOpenTab({
      filePath: 'C:/x/a.pdf', fileName: 'a.pdf', pageCount: 3,
    });
    expect(useAppStore.getState().openTabs[0]?.unitKind).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/__tests__/unit-kind-propagation.test.ts`
Expected: FAIL — `upsertOpenTab` 의 인자 타입에 `unitKind` 가 없어 tsc/런타임에서 걸린다

- [ ] **Step 3: 타입 세 곳에 필드 추가**

`src/renderer/types/index.ts` 의 `PersistedSession` 안, `imagesSkipped` 앞에:

```ts
  /** 단위의 성격. 부재는 'page' — 기존 PDF 세션이 곧 그 값이라 마이그레이션이 필요 없다. */
  unitKind?: UnitKind;
```

`src/shared/session-types.ts` 의 `SessionManifestEntry` 안, `byteSize` 앞에:

```ts
  /**
   * 단위의 성격. 최근 문서 목록·전역 검색이 pageCount 로 "N쪽" 을 표시하므로 여기도 필요하다.
   * 구버전 앱이 매니페스트를 다시 쓰면 사라지는데(session-store 의 강등 규칙), 그때는 'page' 로
   * 폴백되어 표시만 되돌아가고 데이터는 멀쩡하다 — 허용 가능한 열화로 판단했다.
   */
  unitKind?: 'page' | 'slide' | 'chapter';
```

`src/renderer/lib/store.ts` 의 `openTabs` 항목 타입과 `upsertOpenTab` 인자에 `unitKind?: UnitKind` 를 더한다.

- [ ] **Step 4: 싣는 자리 셋을 배선**

`src/renderer/lib/document-open.ts` 의 `upsertOpenTab` 호출:

```ts
    store.upsertOpenTab({
      filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount, unitKind: doc.unitKind,
    });
```

`src/renderer/lib/use-session.ts` 의 세션 저장 객체(`schemaVersion: SESSION_SCHEMA_VERSION` 이 있는 자리, 484행 부근)에 `unitKind: doc.unitKind,` 를 추가하고, 매니페스트 저장 메타에도 같은 필드를 넘긴다.

`src/renderer/lib/tabs.ts:154` 부근의 세션 복원 객체에 `unitKind: session.unitKind,` 를 추가한다(`hadImages` 바로 아래 — 형제다).

- [ ] **Step 5: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/lib/__tests__/unit-kind-propagation.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: 뮤테이션으로 배선을 확인**

`document-open.ts` 의 `unitKind: doc.unitKind` 를 `unitKind: 'page'` 로 **일시 변경**하고 전체 테스트를 돌린다.

Run: `npx vitest run`
Expected: **FAIL** — 실패하지 않으면 그 배선은 무보호다. Task 12 의 라벨 테스트가 잡아야 하므로, 여기서 통과하면 Task 12 완료 후 다시 확인한다. 확인 뒤 변경을 되돌린다.

- [ ] **Step 7: 커밋**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat: unitKind 를 세션·매니페스트·탭 형제 셋에 전파

스키마 버전은 올리지 않는다 — 부재가 곧 'page' 이고 기존 PDF 세션이
정확히 그 값이라 마이그레이션이 불필요하다. 매니페스트까지 넣는 이유는
최근 목록과 전역 검색이 pageCount 로 'N쪽' 을 표시하기 때문이다."
```

---

## Task 12: 인용 라벨 (`formatPageLabel` + i18n + `CitationButton`)

**Files:**
- Modify: `src/renderer/lib/citation.ts:269` (`formatPageLabel`)
- Modify: `src/renderer/lib/i18n.ts` (신규 키 3쌍 + 에러 문구 4쌍)
- Modify: `src/renderer/components/CitationButton.tsx`
- Modify: `src/shared/__tests__/source-scan.test.ts` (라벨 가드 추가)
- Test: `src/renderer/lib/__tests__/citation.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: Task 11 `openTabs[].unitKind` · `PdfDocument.unitKind`
- Produces: `formatPageLabel(page: number | undefined, unitKind?: UnitKind): string`

**배경:** AI 프롬프트는 건드리지 않는다. 모델은 계속 `[p.N]` 을 출력하고 `CITATION_REGEX` 도 그대로다. **교차문서 인용은 대상 탭의 `unitKind`** 를 써야 한다 — PPTX 를 인용하는데 활성 문서가 PDF 라고 `p.3` 이 되면 안 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/lib/__tests__/citation.test.ts` 끝에 추가:

```ts
import { formatPageLabel } from '../citation';
import { useAppStore } from '../store';

describe('formatPageLabel — 표시 라벨만 포맷별로 갈린다', () => {
  beforeEach(() => { useAppStore.setState({ uiLanguage: 'ko' }); });

  it('기본(page)은 종전과 같다', () => {
    expect(formatPageLabel(3, 'page')).toBe('p.3');
    expect(formatPageLabel(3)).toBe('p.3');
  });

  it('슬라이드와 장은 한국어 라벨이다', () => {
    expect(formatPageLabel(3, 'slide')).toBe('슬라이드 3');
    expect(formatPageLabel(3, 'chapter')).toBe('3장');
  });

  it('영어 UI 에서는 영어 라벨이다', () => {
    useAppStore.setState({ uiLanguage: 'en' });
    expect(formatPageLabel(3, 'slide')).toBe('Slide 3');
    expect(formatPageLabel(3, 'chapter')).toBe('Ch. 3');
    expect(formatPageLabel(3, 'page')).toBe('p.3');
  });

  it('페이지가 없으면 빈 문자열이다 (기존 동작 유지)', () => {
    expect(formatPageLabel(undefined, 'slide')).toBe('');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/lib/__tests__/citation.test.ts`
Expected: FAIL — `formatPageLabel` 이 두 번째 인자를 받지 않는다

- [ ] **Step 3: i18n 키 추가**

`src/renderer/lib/i18n.ts` 에 추가한다:

```ts
  'citation.unit.page': { ko: 'p.{n}', en: 'p.{n}' },
  'citation.unit.slide': { ko: '슬라이드 {n}', en: 'Slide {n}' },
  'citation.unit.chapter': { ko: '{n}장', en: 'Ch. {n}' },
  'doc.unsupported': {
    ko: '지원하지 않는 형식입니다. 열 수 있는 형식: {list}',
    en: 'Unsupported format. Supported: {list}',
  },
  'doc.corrupt': {
    ko: '파일이 손상되었거나 다른 형식일 수 있습니다.',
    en: 'The file appears to be corrupted or is a different format.',
  },
  'doc.encrypted': {
    ko: '암호로 보호된 문서는 열 수 없습니다. 암호를 해제한 뒤 다시 시도해 주세요.',
    en: 'Password-protected documents cannot be opened. Remove the password and try again.',
  },
  'doc.tooLarge': {
    ko: '압축을 풀면 너무 커지는 파일입니다.',
    en: 'This file expands to too large a size.',
  },
```

- [ ] **Step 4: `formatPageLabel` 구현**

`src/renderer/lib/citation.ts:269` 의 `formatPageLabel` 을 교체한다:

```ts
/**
 * 인용 라벨의 **단일 통로**.
 *
 * 내부 표현은 언제나 정수 N 이고(프롬프트도 `[p.N]` 그대로), 갈리는 것은 표시뿐이다.
 * 여기를 거치지 않고 'p.' 를 조립하면 source-scan 가드가 실패한다 — 표시 지점은 검색 스니펫·
 * 마인드맵·StatusBar 등에 흩어져 있어서, 열거하면 사각이 생긴다(QA33 I3).
 */
export function formatPageLabel(page?: number, unitKind: UnitKind = 'page'): string {
  if (page === undefined || !Number.isFinite(page)) return '';
  return t(`citation.unit.${unitKind}`, { n: String(page) });
}
```

`UnitKind` 와 `t` 의 import 를 추가한다.

- [ ] **Step 5: `CitationButton` 배선**

`src/renderer/components/CitationButton.tsx` 에서 활성 문서와 대상 탭의 `unitKind` 를 읽고, 라벨 조립을 교체한다:

```ts
  const activeUnitKind = useAppStore((s) => s.document?.unitKind);
  // ... targetTab 결정 이후
  const unitKind = (isCrossDoc ? targetTab?.unitKind : activeUnitKind) ?? 'page';
  const label = isCrossDoc && docName
    ? `[${docName} ${formatPageLabel(page, unitKind)}]`
    : `[${formatPageLabel(page, unitKind)}]`;
```

- [ ] **Step 6: 라벨 가드 추가**

`src/shared/__tests__/source-scan.test.ts` 에 추가한다:

```ts
describe("인용 라벨은 formatPageLabel 밖에서 조립하지 않는다", () => {
  const ALLOWED = new Set([
    'src/renderer/lib/citation.ts',
    'src/renderer/lib/i18n.ts',
  ]);

  it("'p.' 템플릿 리터럴이 단일 통로 밖에 없다", () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles('src')) {
      const norm = file.replace(/\\/g, '/');
      if (ALLOWED.has(norm) || norm.includes('__tests__')) continue;
      const src = stripJsComments(readFileSync(file, 'utf-8'));
      for (const [i, line] of src.split('\n').entries()) {
        // `p.${page}` / 'p.' + n / "p." 형태
        if (/['"`]p\.\s*(\$\{|["'`+])/.test(line)) offenders.push(`${norm}:${i + 1}`);
      }
    }
    expect(offenders, '라벨은 formatPageLabel 을 거친다').toEqual([]);
  });
});
```

- [ ] **Step 7: 전체 테스트**

Run: `npx vitest run`
Expected: PASS. 라벨 가드가 잡은 자리를 전부 `formatPageLabel` 로 바꾼다.

- [ ] **Step 8: Task 11 Step 6 의 뮤테이션 재확인**

`document-open.ts` 의 `unitKind: doc.unitKind` 를 `unitKind: 'page'` 로 바꾸고 전체 테스트.
Expected: **FAIL** (교차문서 라벨 테스트가 잡는다). 확인 뒤 되돌린다. 여전히 통과하면 `CitationButton` 의 교차문서 라벨 테스트를 추가한다.

- [ ] **Step 9: 커밋**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat(citation): 표시 라벨을 포맷별로, 내부 표현은 [p.N] 그대로

프롬프트도 CITATION_REGEX 도 건드리지 않는다. 모델이 [슬라이드 3] 을
출력하기 시작하면 정규식이 못 잡아 인용이 평문으로 떨어진다.
교차문서 인용은 대상 탭의 unitKind 를 쓴다 — 활성 문서 것을 쓰면
PPTX 인용이 'p.3' 으로 보인다. 라벨 조립 지점은 가드로 도출한다."
```

---

## Task 13: 원문 텍스트 뷰어 (`DocTextViewer`)

**Files:**
- Create: `src/renderer/components/DocTextViewer.tsx`
- Create: `src/renderer/components/__tests__/DocTextViewer.test.tsx`
- Modify: `src/renderer/components/SummaryViewer.tsx:369` (분기)

**Interfaces:**
- Consumes: `useAppStore` 의 `document.pageTexts` · `document.unitKind` · `citationTarget` · `pdfViewerZoom`
- Produces: `DocTextViewerPanel` (기본 내보내기 없음 — `PdfViewerPanel` 과 같은 이름 규칙)

**배경:** 새로 만드는 것은 "단위 헤더 + 본문 블록" 렌더뿐이다. 나머지는 기존 자산을 그대로 쓴다 — `citationTarget` 스크롤 계약, `ResizeHandle`, `viewer-zoom.ts`(canvas 배율 대신 글꼴 크기로 매핑), `citation-focus.ts`. 본문은 `markdown-renderer.tsx` 로 렌더한다(Task 3 의 GFM 표가 표로 보인다). 텍스트 뷰어에 들어오는 것은 언제나 추출기 출력뿐이라(PDF 는 canvas 뷰어) 이 가정이 안전하다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/renderer/components/__tests__/DocTextViewer.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocTextViewerPanel } from '../DocTextViewer';
import { useAppStore } from '../../lib/store';

function setDoc(pageTexts: string[], unitKind: 'page' | 'slide' | 'chapter' = 'page'): void {
  useAppStore.setState({
    document: {
      id: 'd1', fileName: 'a.docx', filePath: 'C:/x/a.docx',
      pageCount: pageTexts.length, extractedText: pageTexts.join('\n\n'),
      pageTexts, chapters: [], images: [], createdAt: new Date(), unitKind,
    },
    citationTarget: null,
  });
}

describe('DocTextViewerPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ uiLanguage: 'ko', pdfViewerZoom: 1 });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('단위마다 헤더와 본문을 렌더한다', () => {
    setDoc(['첫째 쪽 내용', '둘째 쪽 내용']);
    render(<DocTextViewerPanel />);
    expect(screen.getByText('p.1')).toBeTruthy();
    expect(screen.getByText('p.2')).toBeTruthy();
    expect(screen.getByText(/첫째 쪽 내용/)).toBeTruthy();
  });

  it('헤더 라벨이 unitKind 를 따른다', () => {
    setDoc(['a'], 'slide');
    render(<DocTextViewerPanel />);
    expect(screen.getByText('슬라이드 1')).toBeTruthy();
  });

  it('각 단위에 인용 점프용 id 를 단다', () => {
    setDoc(['a', 'b']);
    const { container } = render(<DocTextViewerPanel />);
    expect(container.querySelector('#unit-1')).not.toBeNull();
    expect(container.querySelector('#unit-2')).not.toBeNull();
  });

  it('citationTarget 이 가리키는 단위로 스크롤한다', () => {
    setDoc(['a', 'b', 'c']);
    const spy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = spy;
    useAppStore.setState({ citationTarget: { page: 2 } });
    render(<DocTextViewerPanel />);
    expect(spy).toHaveBeenCalled();
  });

  it('배율을 글꼴 크기로 매핑한다', () => {
    setDoc(['a']);
    useAppStore.setState({ pdfViewerZoom: 1.5 });
    const { container } = render(<DocTextViewerPanel />);
    const root = container.querySelector('[data-testid="doc-text-viewer"]') as HTMLElement;
    expect(root.style.fontSize).toBe('24px');
  });

  it('문서가 없으면 아무것도 렌더하지 않는다', () => {
    useAppStore.setState({ document: null });
    const { container } = render(<DocTextViewerPanel />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx vitest run src/renderer/components/__tests__/DocTextViewer.test.tsx`
Expected: FAIL — `Failed to resolve import "../DocTextViewer"`

- [ ] **Step 3: 구현**

`src/renderer/components/DocTextViewer.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { useAppStore } from '../lib/store';
import { formatPageLabel } from '../lib/citation';
// 원문은 신뢰할 수 없는 문서에서 온 텍스트다. 에러 경계와 안전 컴포넌트가 붙은 SafeMarkdown 을
// 쓴다(markdown-renderer 의 기본 내보내기는 경계 없이 raw 렌더한다).
import { SafeMarkdown } from '../lib/safe-markdown';

/** 배율 1.0 일 때의 본문 글꼴 크기(px). canvas 배율 대신 이것을 곱한다. */
const BASE_FONT_PX = 16;

/**
 * 비-PDF 문서의 원문 패널.
 *
 * PdfViewer 는 원본 바이트를 pdfjs canvas 로 그리는데, 비-PDF 는 그릴 대상이 없다(DOCX·HWPX 의
 * 페이지는 파일에 없고 PPTX 슬라이드를 그리려면 레이아웃 엔진이 필요하다). 대신 추출된 단위를
 * 그대로 보여주고 인용 클릭 → 근거 확인이라는 핵심 동작을 유지한다.
 *
 * 본문을 마크다운으로 렌더하는 이유: 추출기가 표를 GFM 으로 직렬화하므로 여기서 표가 표로
 * 보인다. 이 패널에 들어오는 것은 언제나 추출기 출력뿐이라(PDF 는 canvas 뷰어) 안전하다.
 */
export function DocTextViewerPanel() {
  const pageTexts = useAppStore((s) => s.document?.pageTexts);
  const unitKind = useAppStore((s) => s.document?.unitKind) ?? 'page';
  const citationTarget = useAppStore((s) => s.citationTarget);
  const zoom = useAppStore((s) => s.pdfViewerZoom);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const page = citationTarget?.page;
    if (!page || !rootRef.current) return;
    const el = rootRef.current.querySelector(`#unit-${page}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [citationTarget]);

  if (!pageTexts) return null;

  return (
    <div
      ref={rootRef}
      data-testid="doc-text-viewer"
      className="h-full overflow-y-auto px-4 py-3 bg-white dark:bg-gray-900"
      style={{ fontSize: `${BASE_FONT_PX * zoom}px` }}
    >
      {pageTexts.map((text, i) => {
        const page = i + 1;
        const isTarget = citationTarget?.page === page;
        return (
          <section
            key={page}
            id={`unit-${page}`}
            aria-label={formatPageLabel(page, unitKind)}
            className={`mb-6 scroll-mt-2 rounded-lg border p-3 transition-colors ${
              isTarget
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">
              {formatPageLabel(page, unitKind)}
            </h3>
            <SafeMarkdown content={text} />
          </section>
        );
      })}
    </div>
  );
}
```

> `SafeMarkdown({ content }: { content: string })` 은 `src/renderer/lib/safe-markdown.tsx:184` 의 named export 다(확인 완료). `markdown-renderer.tsx` 의 기본 내보내기는 `MarkdownRenderer({ children }: { children: string })` 으로 props 이름이 다르고 에러 경계가 없으므로 쓰지 않는다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npx vitest run src/renderer/components/__tests__/DocTextViewer.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: `SummaryViewer` 에서 분기**

`src/renderer/components/SummaryViewer.tsx:369` 부근:

```tsx
// 변경 전
            <PdfViewerPanel />

// 변경 후
            {isPdfDocument ? <PdfViewerPanel /> : <DocTextViewerPanel />}
```

컴포넌트 상단에 추가:

```tsx
  // PDF 만 canvas 로 그린다. 비-PDF 는 추출된 단위를 텍스트로 보여준다.
  const isPdfDocument = useAppStore((s) => (s.document?.unitKind ?? 'page') === 'page'
    && s.document?.fileName.toLowerCase().endsWith('.pdf') === true);
```

> ⚠️ `unitKind === 'page'` 만으로는 갈리지 않는다 — DOCX 도 `'page'` 다. 파일명 확장자를 함께 본다. 확장자 리터럴이 들어가므로 **Task 8 의 가드가 실패한다.** `document-formats.ts` 에 헬퍼를 추가해 그쪽을 쓴다:
>
> ```ts
> /** canvas 렌더 대상(PDF)인가. 나머지는 텍스트 뷰어가 맡는다. */
> export function isCanvasRenderable(fileName: string): boolean {
>   return fileName.toLowerCase().endsWith('.pdf');
> }
> ```

- [ ] **Step 6: 실제 DOCX 로 수동 확인**

```bash
npm run dev
```

DOCX 를 열고 요약을 만든 뒤 인용을 클릭해 오른쪽 패널이 해당 단위로 스크롤하고 강조되는지, Ctrl+휠로 글자가 커지는지, 표가 표로 보이는지 확인한다.

- [ ] **Step 7: 커밋**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat(viewer): 비-PDF 원문 텍스트 뷰어

인용 클릭 → 근거 확인은 이 앱의 핵심 동작이라 포맷마다 달라지면 안 된다.
citationTarget 스크롤 계약·ResizeHandle·viewer-zoom 은 그대로 쓰고
배율만 글꼴 크기로 매핑한다. 본문은 마크다운으로 렌더해 추출기가 만든
GFM 표가 표로 보이게 한다."
```

---

## Task 14: E2E 스펙

**Files:**
- Create: `e2e/docx-open.spec.ts`
- Create: `e2e/fixtures/sample.docx` (합성 픽스처 생성 스크립트 포함)

**Interfaces:**
- Consumes: Task 10·13 의 완성된 경로
- Produces: 없음

**배경:** 기존 `packaged-smoke` 는 라틴 PDF 만 밟으므로 신규 포맷은 별도 스펙이 필요하다. 실물 파일은 개인정보가 들어 있어 커밋하지 않는다 — **합성 DOCX 를 테스트에서 만들어** 쓰고, 실물 대조는 Step 5 의 수동 확인으로 한다.

- [ ] **Step 1: 기존 헬퍼 계약 확인**

`e2e/helpers.ts` 가 이미 제공하는 것(확인 완료):

- `launchElectron(userDataDir, seedSettings?): Promise<{ app, page, pageErrors }>` — `PDF_ANALYZER_USER_DATA` 로 사용자 데이터를 격리하고 Ollama 를 죽은 포트로 묶어 결정적으로 만든다
- `sendDropPath(app, realPath, b64): Promise<void>` — `file:dropped` IPC 로 **실제 경로 + 바이트**를 보낸다(합성 DragEvent 와 달리 진짜 filePath 를 갖는다)
- `cleanupDir(dir)`

**프로덕션 코드에 테스트 전용 진입점을 만들지 않는다.** 위 헬퍼로 충분하다.

- [ ] **Step 2: 픽스처 생성 스크립트 작성**

`e2e/fixtures/make-docx.ts`:

```ts
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 합성 DOCX 픽스처. 실물 파일은 개인정보가 들어 있어 커밋하지 않는다.
 * 쪽나눠 1회 + 표 1개를 포함해 추출기의 두 경로를 모두 밟는다.
 */
const DOC = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>첫째 쪽의 내용입니다</w:t></w:r></w:p>
<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>둘째 쪽의 내용입니다</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>값</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>달성률</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100%</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`;

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export function writeSampleDocx(path: string): void {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8(RELS),
    'word/document.xml': strToU8(DOC),
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zip);
}

if (process.argv[1] && process.argv[1].endsWith('make-docx.ts')) {
  writeSampleDocx(join(process.cwd(), 'e2e', 'fixtures', 'sample.docx'));
}
```

- [ ] **Step 3: E2E 스펙 작성**

`e2e/docx-open.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectron, sendDropPath, cleanupDir } from './helpers';
import { writeSampleDocx } from './fixtures/make-docx';

test('DOCX 를 열면 쪽나눠로 단위가 나뉘고 표가 표로 렌더된다', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-docx-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-docx-docs-'));
  const fixture = join(docsDir, 'sample.docx');
  writeSampleDocx(fixture);

  const { app, page, pageErrors } = await launchElectron(userDataDir);
  try {
    await sendDropPath(app, fixture, readFileSync(fixture).toString('base64'));

    // 인용 클릭 전에는 원문 패널이 없다. 먼저 파싱 완료를 문서 제목으로 기다린다.
    await expect(page.getByText('sample.docx')).toBeVisible({ timeout: 60_000 });

    // 인용 패널을 여는 경로가 스펙마다 다르므로, viewer-zoom.spec.ts 가 패널을 띄우는
    // 방식(인용 버튼 클릭 또는 store 직접 설정)을 그대로 따른다.
    await page.evaluate(() => {
      const w = window as unknown as { __APP_STORE__?: { setState: (s: unknown) => void } };
      w.__APP_STORE__?.setState({ citationTarget: { page: 2 } });
    });

    // 쪽나눠로 2단위가 나왔다.
    await expect(page.locator('#unit-2')).toBeVisible({ timeout: 30_000 });
    // 표가 GFM 으로 직렬화돼 표로 렌더된다.
    await expect(page.locator('[data-testid="doc-text-viewer"] table')).toBeVisible();

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});
```

> ⚠️ `__APP_STORE__` 전역이 없으면 **만들지 않는다.** `e2e/viewer-zoom.spec.ts` 가 인용 패널을 띄우는 실제 방식을 읽고 그대로 쓴다(요약을 생성해 인용 버튼을 클릭하는 형태라면 실 Ollama 가 필요하므로 `ollama-gate.ts` 의 게이트를 따른다). 이 스펙의 목적은 **단위 분할과 표 렌더의 확인**이므로, 인용 패널을 띄우기 어려우면 `citationTarget` 을 거치지 않고 원문 패널이 기본 표시되는 경로를 찾아 대체한다.

- [ ] **Step 4: E2E 실행**

Run: `npx playwright test e2e/docx-open.spec.ts`
Expected: PASS

- [ ] **Step 5: 실물 DOCX 로 수동 확인**

`npm run dev` 로 띄우고 실제 워드 문서(표와 그림이 든 것)를 열어 ① 단위가 그럴듯하게 나뉘는가 ② 표가 표로 보이는가 ③ 그림이 Vision 분석에 들어가는가 ④ 인용 클릭이 맞는 단위로 가는가 를 확인한다. **합성 픽스처가 통과해도 실물이 통과한다는 보장은 없다** — 이 저장소에서 가짜 픽스처가 진짜 동작을 못 잡은 전례가 반복됐다(QA33 H3·H4).

- [ ] **Step 6: 커버리지 게이트 재확인**

Run: `npx vitest run --coverage`
Expected: 게이트 통과. 새 파일이 분모에 들어와 임계를 밑돌면 `coverage-drift` 정책에 따라 임계를 조정하지 말고 **테스트를 보강한다.**

- [ ] **Step 7: 커밋**

```bash
npx tsc --noEmit
git add e2e/
git commit -m "test(e2e): DOCX 열기 → 단위 분할 → 인용 점프

기존 packaged-smoke 는 라틴 PDF 만 밟아 신규 포맷을 구조적으로 못
검증한다. 픽스처는 합성으로 만든다 — 실물 문서는 개인정보가 들어 있어
커밋하지 않고 수동 확인으로 대조한다."
```

---

## 완료 기준

- [ ] `npx vitest run` 전체 통과, 테스트 수가 착수 전(2567)보다 **늘었다**
- [ ] `npx tsc --noEmit` 통과
- [ ] `npm run build` 통과
- [ ] `npx playwright test` 통과
- [ ] 확장자 가드·라벨 가드가 **켜져 있고**(`.skip` 없음) 통과
- [ ] `audit-shipped.test.ts` 통과 (`fflate` 분류됨)
- [ ] 실물 DOCX 수동 확인 완료 (Task 14 Step 5 의 4항목)
- [ ] PDF 회귀 없음 — 실물 PDF 를 열어 요약·인용·뷰어가 종전대로 동작

## 이 계획 다음에 오는 것

| | |
|---|---|
| **P4** | HWPX · PPTX · EPUB 추출기. 착수 전 **각 포맷 실물 확보**가 선행 조건이다. HWPX 는 쪽나눠가 `hp:p/@pageBreak` 임을 확인했고(`hp:tbl` 의 동명 속성은 의미가 다르니 주의), PPTX 는 **`p:sldIdLst` → `r:id` → rels 순서를 반드시 따라야 한다**(실물에서 `rId20→slide15`, `rId21→slide16`, `rId22→slide17` 로 rels 가 번호순이 아니었다 — `slide*.xml` 을 정렬하면 인용이 조용히 어긋난다). PPTX 의 `‹#›` 는 `<a:fld type="slidenum">` 안이라 걸러야 한다. EPUB 은 아직 실물 미확보 |
| **P5** | README(ko/en) 의 제품 설명·설치 파일명 공개 + 릴리즈 v1.8.0 + §7.5 의 실기기 확인 4항목 |
