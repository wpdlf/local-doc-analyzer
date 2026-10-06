# 한글 바이너리(.hwp, HWP 5.x) 입력 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.hwp`(HWP 5.x 바이너리)를 `.hwpx` 와 같은 수준(본문 · 표 · 그림 Vision · 수식 · 개요 제목 · 쪽 나눔)으로 연다.

**Architecture:** CFB 컨테이너 리더(`cfb.ts`)가 기존 `ZipIndex` 와 같은 모양의 `ContainerIndex` 를 내놓고, HWP 추출기(`hwp.ts` + 순수 모듈 3개)가 레코드 스트림을 `ExtractedDoc` 으로 옮긴다. `normalize` 이후 흐름은 바꾸지 않는다. `document-open.ts` 는 CFB 를 try 안에서 열어 HWP 면 추출, 아니면 종전 `DOC_ENCRYPTED` 로 가른다.

**Tech Stack:** TypeScript 7 · fflate 0.8.3(이미 의존성 — `Inflate` 스트리밍 · 테스트의 `deflateSync`) · Vitest · Playwright

**Spec:** `docs/02-design/features/hwp-binary.design.md`

## Global Constraints

- **새 의존성 0.** `package.json` 의 dependencies/devDependencies 를 건드리지 않는다(audit 게이트·배포 분류 불변).
- 압축 해제 누적 상한 = `MAX_UNZIPPED_BYTES`(300MB, `extract/zip.ts`) **문서 전체 합계**. 디렉터리 항목 상한 = `MAX_ZIP_ENTRIES`(10,000).
- 표·글상자 중첩 상한 16(hwpx `MAX_NEST_DEPTH` 와 같은 값) · 도형 그룹 깊이 32 · 저장소 깊이 32.
- 오류 코드: 암호·DRM `DOC_ENCRYPTED` · 배포용 `DOC_DISTRIBUTION`(신규) · 비 5.x 와 HWP 3.x `DOC_UNSUPPORTED` · 구조 손상 `DOC_CORRUPT` · 상한 `DOC_TOO_LARGE`.
- `DOC_DISTRIBUTION` 문구 ko: `배포용 문서는 내용이 암호화돼 있어 열 수 없습니다. 한글에서 일반 문서로 저장한 뒤 다시 시도해주세요.`
- CFB 매직 바이트 리터럴은 `src/shared/document-formats.ts` 밖(테스트 제외)에 쓰지 않는다 — `hasCfbMagic()` 사용(소스 스캔 가드).
- `.hwp` 확장자 문자열 리터럴도 `src` 비테스트 코드에서는 `document-formats.ts` 에만 둔다.
- 포맷 id 리터럴 `'hwp'` 는 `document-formats.ts` 의 `HWP_FORMAT_ID` 한 곳.
- 주석·커밋 메시지는 한국어 평서체(기존 코드와 같은 톤). 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 실물 `.hwp` 파일은 **저장소에 넣지 않는다**(스크래치에서만 대조). 바탕화면 `업무` 폴더의 개인정보 서식은 어떤 대조에도 쓰지 않는다.
- 각 Task 끝에서 `npx tsc --noEmit` 통과(테스트 파일까지 검사된다). 기준 테스트 수 3118 — 줄면 안 된다.

## 실물로 확정한 바이트 배치 (설계 §0 — 계획 코드가 이 값에 기댄다)

| 항목 | 값 |
|---|---|
| 레코드 헤더 | u32: tag = bit0-9 · level = bit10-19 · size = bit20-31(0xFFF 면 다음 u32 가 크기) |
| 태그 | DOCUMENT_PROPERTIES 0x10 · BIN_DATA 0x12 · PARA_SHAPE 0x19 · PARA_HEADER 0x42 · PARA_TEXT 0x43 · CTRL_HEADER 0x47 · LIST_HEADER 0x48 · SHAPE_COMPONENT 0x4C · TABLE 0x4D · SHAPE_COMPONENT_PICTURE 0x55 · EQEDIT 0x58 |
| PARA_HEADER | paraShapeId u16 @8 · breakType u8 **@11**(bit0 구역 · bit2 쪽) |
| PARA_SHAPE | 속성 u32 @0: 머리 종류 bit23-24(1 = 개요) · 수준 bit25-27(0-based) |
| LIST_HEADER(셀) | **8바이트 머리** 뒤 열 @8 · 행 @10 · 열 병합 @12 · 행 병합 @14 |
| TABLE | 행 수 u16 @4 · 열 수 u16 @6 |
| PICTURE | BinItem id u16 @71(DocInfo BIN_DATA 1-based 순번) |
| BIN_DATA | 속성 u16(type 하위 4비트: 1 = 내장 · 압축 bit4-5: 0 문서 따름 / 1 압축 / 2 무압축) · id u16 @2 · 확장자 길이 u16 @4 · UTF-16 @6 → `BinData/BIN%04X.<ext>` |
| EQEDIT | 속성 u32 @0 · 스크립트 길이 u16 @4 · UTF-16 @6 |
| 컨트롤 id | 4바이트를 **뒤집어** 읽는다(`20 6c 62 74` → `tbl `). PARA_TEXT 의 확장 컨트롤 8 wchar 중 1~2번째 wchar 에 같은 4바이트 |
| PARA_TEXT 제어문자 | 8 wchar: 1-9 · 11-12 · 14-23 (그중 CTRL_HEADER 와 짝 = 1,2,3,11,12,14-18,21-23 / 9 = 탭) · 1 wchar: 0 · 10(줄바꿈) · 13(문단 끝) · 24(하이픈) · 25-29 · 30-31(빈칸) |
| FileHeader | 서명 `HWP Document File` @0 · 버전 u32 @32(최상위 바이트 = 주 버전) · 플래그 u32 @36(bit0 압축 · bit1 암호 · bit2 배포용 · bit4 DRM) |
| 압축 | raw deflate(zlib 머리 없음) |

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `src/renderer/lib/extract/types.ts` (수정) | `ContainerIndex` 계약 + `ZipIndex` 호환 별칭 | 1 |
| `src/renderer/lib/extract/table.ts` (수정) | `gridExtent` 를 hwpx 에서 옮겨 공유 | 1 |
| `src/renderer/lib/extract/hwpx.ts` (수정) | 공유 `gridExtent` import | 1 |
| `test/fixtures/cfb-builder.ts` (신규) | 테스트용 CFB 작성기(리더의 독립 오라클) | 2 |
| `src/renderer/lib/extract/cfb.ts` (신규) | CFB 리더(상한 내장) | 2 |
| `test/fixtures/hwp-builder.ts` (신규) | HWP 레코드·문서 작성기(유닛·E2E 공용) | 3 |
| `src/renderer/lib/extract/hwp-records.ts` (신규) | 레코드 분해·트리 · 예산 inflate · PARA_TEXT · 바이트 헬퍼 | 3 |
| `src/renderer/lib/extract/hwp-docinfo.ts` (신규) | 개요 수준 · BinData 목록 | 4 |
| `src/renderer/lib/extract/hwp-table.ts` (신규) | 표 컨트롤 → 셀 목록 | 4 |
| `src/renderer/lib/extract/hwp.ts` (신규) | 추출기 진입 | 5 |
| `src/shared/document-formats.ts` (수정) | id 유니온·`HWP_FORMAT_ID`(5) → 등록·`hasHwp3Magic`(6) | 5, 6 |
| `src/renderer/lib/document-open.ts` (수정) | 단위 표·오류 표(5) → CFB 분기(6) | 5, 6 |
| `src/renderer/lib/i18n.ts` (수정) | `doc.distribution` | 5 |
| `src/renderer/lib/extract/registry.ts` (수정) | `CFB_EXTRACTORS` · 컨테이너별 resolve | 6 |
| `src/renderer/App.tsx` (수정) | DOM 드롭 선검사가 HWP 3.x 서명도 통과 | 6 |
| `e2e/fixtures/make-hwp.ts` (신규) · `e2e/office-open.spec.ts` (수정) | 실앱 E2E | 7 |
| `CLAUDE.md` (수정) | 입력 포맷 줄 | 8 |

README 는 배치 갱신 관례(메모 `feedback_readme_batched`)에 따라 **이 계획 밖** — 출시 후 README 라운드에서 다룬다.

---

### Task 1: 컨테이너 중립 계약 + `gridExtent` 공유 (동작 변화 없음)

**Files:**
- Modify: `src/renderer/lib/extract/types.ts:13-22, 57-66`
- Modify: `src/renderer/lib/extract/table.ts` (끝에 추가)
- Modify: `src/renderer/lib/extract/hwpx.ts:3, 206-224`
- Test: `src/renderer/lib/extract/__tests__/table.test.ts`

**Interfaces:**
- Produces: `interface ContainerIndex { names(): string[]; has(name: string): boolean; text(name: string): string | null; bytes(name: string): Uint8Array | null }` · `type ZipIndex = ContainerIndex` · `Extractor.sniff(index: ContainerIndex)` / `extract(index: ContainerIndex, opts)` · `export function gridExtent(cells: GridCell[], axis: 'row' | 'col', declared: number): number` (table.ts)

- [ ] **Step 1: 실패하는 테스트 — `table.test.ts` 끝에 추가**

```ts
import { gridExtent } from '../table';

describe('gridExtent — 격자 한 축의 크기 (R18, hwpx·hwp 공유)', () => {
  const at = (row: number, rowSpan = 1) => ({ row, col: 0, rowSpan, colSpan: 1, text: '' });
  it('셀 원점은 선언값을 넘어도 포함한다 (선언값이 모자란 손상 파일에서 셀을 버리지 않게)', () => {
    expect(gridExtent([at(0), at(2)], 'row', 1)).toBe(3);
  });
  it('스팬 끝은 선언값 안에서만 믿는다 (병리적 rowSpan 이 빈 행을 만들지 않게)', () => {
    expect(gridExtent([at(0, 60000)], 'row', 2)).toBe(2);
  });
  it('선언값이 커도 셀이 차지하지 않으면 늘리지 않는다', () => {
    expect(gridExtent([at(0)], 'row', 100000)).toBe(1);
  });
});
```

(파일 상단 import 줄에 `gridExtent` 를 합쳐도 된다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/table.test.ts`
Expected: FAIL — `gridExtent` is not exported

- [ ] **Step 3: 구현**

`hwpx.ts:206-224` 의 `gridExtent` 함수(주석 포함)를 **그대로 잘라** `table.ts` 끝으로 옮기고 `export` 를 붙인다. 주석 첫 줄을 이렇게 바꾼다:

```ts
/**
 * 격자 한 축의 크기 — 선언값(rowCnt/colCnt · HWP TABLE 레코드)이 아니라 셀이 실제로 차지하는 범위로 정한다(R18).
```

`hwpx.ts:3` import 를 바꾼다:

```ts
import { toGfmTable, placeGridCells, gridExtent, type GridCell } from './table';
```

`types.ts:13-22` 를 바꾼다:

```ts
/**
 * 컨테이너(zip · CFB)의 읽기 전용 색인. 디스크에 풀지 않는다.
 *
 * CFB(.hwp)는 스트림 경로를 `/` 로 잇고(`BodyText/Section0`), bytes 는 **저장된 그대로**(압축된 채)다 —
 * 압축 해제는 추출기가 문서 전체 예산으로 한다(hwp-records.ts inflateBudgeted).
 */
export interface ContainerIndex {
  /** 컨테이너에 든 엔트리(스트림) 이름 전부 */
  names(): string[];
  has(name: string): boolean;
  /** UTF-8 로 디코드한 텍스트. 없으면 null */
  text(name: string): string | null;
  /** 원본 바이트. 없으면 null */
  bytes(name: string): Uint8Array | null;
}

/** zip 추출기들이 쓰던 이름 — 호환 별칭(시그니처를 깨지 않는다). */
export type ZipIndex = ContainerIndex;
```

`types.ts:63-65` 의 `Extractor` 를 바꾼다:

```ts
  /** 컨테이너 내부 엔트리로 판별한다. 확장자를 믿지 않는다. */
  sniff(index: ContainerIndex): boolean;
  extract(index: ContainerIndex, opts: ExtractOptions): Promise<ExtractedDoc>;
```

- [ ] **Step 4: 통과 확인 (기존 hwpx 테스트 포함)**

Run: `npx vitest run src/renderer/lib/extract` 그리고 `npx tsc --noEmit`
Expected: 전부 PASS, 타입 오류 0

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/extract/types.ts src/renderer/lib/extract/table.ts src/renderer/lib/extract/hwpx.ts src/renderer/lib/extract/__tests__/table.test.ts
git commit -m "refactor(extract): 컨테이너 중립 ContainerIndex 계약 · gridExtent 를 table.ts 로 공유

HWP(CFB) 추출기를 들이기 위한 준비. ZipIndex 는 호환 별칭으로 남겨 동작 변화 없음.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: CFB 리더 + 테스트용 CFB 작성기

**Files:**
- Create: `test/fixtures/cfb-builder.ts`
- Create: `src/renderer/lib/extract/cfb.ts`
- Test: `src/renderer/lib/extract/__tests__/cfb.test.ts`

**Interfaces:**
- Consumes: `ContainerIndex`(Task 1) · `hasCfbMagic`(document-formats) · `extractFail`(errors) · `MAX_ZIP_ENTRIES`(zip)
- Produces: `export function openCfb(data: ArrayBuffer): ContainerIndex` · `export const MAX_CFB_ENTRIES` · 테스트용 `buildCfb(streams: Record<string, Uint8Array>): CfbLayout`(아래 정의)

- [ ] **Step 1: 테스트용 작성기 — `test/fixtures/cfb-builder.ts`**

리더의 상수를 import 하지 않는다(독립 오라클 — 같은 사람이 같은 실수를 양쪽에 하면 테스트가 초록인 채 틀린다. 실물 대조는 Task 8).

```ts
/**
 * 테스트용 CFB(v3, 512바이트 섹터) 작성기 — cfb.ts 리더의 독립 오라클이 되도록 MS-CFB 규약을 여기서
 * 따로 구현한다(리더 상수를 import 하지 않는다). 4096 미만 스트림은 미니 스트림에 넣고, FAT 섹터가
 * 109개를 넘으면 DIFAT 섹터를 만든다. 공격 입력은 반환된 layout 의 오프셋으로 바이트를 고쳐 만든다.
 */
const SEC = 512;
const MINI = 64;
const CUTOFF = 4096;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface Node {
  name: string;
  type: 1 | 2 | 5;
  data: Uint8Array;
  children: Node[];
  index: number;
  start: number;
  size: number;
  right: number;
  child: number;
}

export interface CfbLayout {
  bytes: Uint8Array;
  /** 디렉터리 항목 번호('' = 루트) */
  entryIndex(path: string): number;
  /** 디렉터리 항목(128B)의 파일 내 오프셋 */
  entryOffset(path: string): number;
  /** 일반 FAT 항목 n 의 파일 내 오프셋 */
  fatEntryOffset(n: number): number;
  /** 미니 FAT 항목 n 의 파일 내 오프셋 */
  miniFatEntryOffset(n: number): number;
  /** 스트림의 시작 섹터(미니 스트림이면 미니 섹터 번호) */
  startSector(path: string): number;
  difatSectorCount: number;
}

function u32s(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function buildCfb(streams: Record<string, Uint8Array>): CfbLayout {
  const mk = (name: string, type: 1 | 2 | 5, data = new Uint8Array(0)): Node =>
    ({ name, type, data, children: [], index: -1, start: END, size: type === 2 ? data.length : 0, right: NOSTREAM, child: NOSTREAM });
  const root = mk('Root Entry', 5);
  const byPath = new Map<string, Node>([['', root]]);
  for (const [path, data] of Object.entries(streams)) {
    const parts = path.split('/');
    let parent = root;
    parts.forEach((part, i) => {
      const sub = parts.slice(0, i + 1).join('/');
      let node = byPath.get(sub);
      if (!node) {
        node = i === parts.length - 1 ? mk(part, 2, data) : mk(part, 1);
        parent.children.push(node);
        byPath.set(sub, node);
      }
      parent = node;
    });
  }
  // 항목 번호는 너비 우선. 형제는 오른쪽 링크 한 줄로 잇는다(리더는 균형을 요구하지 않는다).
  const order: Node[] = [];
  const queue: Node[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    n.index = order.length;
    order.push(n);
    queue.push(...n.children);
  }
  for (const n of order) {
    n.child = n.children[0]?.index ?? NOSTREAM;
    n.children.forEach((c, i) => { c.right = n.children[i + 1]?.index ?? NOSTREAM; });
  }

  // 미니 스트림
  const miniChunks: Uint8Array[] = [];
  const miniFat: number[] = [];
  for (const n of order) {
    if (n.type !== 2 || n.size === 0 || n.size >= CUTOFF) continue;
    const count = Math.ceil(n.size / MINI);
    n.start = miniFat.length;
    for (let k = 0; k < count; k++) {
      miniFat.push(k < count - 1 ? n.start + k + 1 : END);
      const c = new Uint8Array(MINI);
      c.set(n.data.subarray(k * MINI, (k + 1) * MINI));
      miniChunks.push(c);
    }
  }
  const miniStream = concat(miniChunks);
  root.size = miniStream.length;

  // 일반 섹터
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const alloc = (data: Uint8Array): number => {
    if (data.length === 0) return END;
    const count = Math.ceil(data.length / SEC);
    const start = fat.length;
    for (let k = 0; k < count; k++) {
      fat.push(k < count - 1 ? start + k + 1 : END);
      const s = new Uint8Array(SEC);
      s.set(data.subarray(k * SEC, (k + 1) * SEC));
      sectors.push(s);
    }
    return start;
  };
  for (const n of order) if (n.type === 2 && n.size >= CUTOFF) n.start = alloc(n.data);
  root.start = alloc(miniStream);
  const miniFatStart = alloc(u32s(miniFat));
  const miniFatSectors = Math.ceil((miniFat.length * 4) / SEC);

  const dir = new Uint8Array(Math.ceil(order.length / 4) * 4 * 128);
  const ddv = new DataView(dir.buffer);
  for (const n of order) {
    const o = n.index * 128;
    const name = n.name.slice(0, 31);
    for (let i = 0; i < name.length; i++) ddv.setUint16(o + i * 2, name.charCodeAt(i), true);
    ddv.setUint16(o + 64, (name.length + 1) * 2, true);
    dir[o + 66] = n.type;
    dir[o + 67] = 1; // black
    ddv.setUint32(o + 68, NOSTREAM, true);
    ddv.setUint32(o + 72, n.right, true);
    ddv.setUint32(o + 76, n.child, true);
    ddv.setUint32(o + 116, n.start, true);
    ddv.setUint32(o + 120, n.size, true);
  }
  const dirStart = alloc(dir);

  // FAT · DIFAT 섹터 수는 자기 자신도 섹터라 수렴할 때까지 반복한다.
  const data = fat.length;
  let nFat = 1;
  let nDifat = 0;
  for (;;) {
    const needFat = Math.ceil((data + nFat + nDifat) / 128);
    const needDifat = needFat > 109 ? Math.ceil((needFat - 109) / 127) : 0;
    if (needFat === nFat && needDifat === nDifat) break;
    nFat = needFat;
    nDifat = needDifat;
  }
  const fatIds = Array.from({ length: nFat }, (_, i) => data + i);
  const difatIds = Array.from({ length: nDifat }, (_, i) => data + nFat + i);
  for (let i = 0; i < nFat; i++) fat.push(FATSECT);
  for (let i = 0; i < nDifat; i++) fat.push(DIFSECT);
  while (fat.length < nFat * 128) fat.push(FREE);
  const fatBytes = u32s(fat);
  for (let i = 0; i < nFat; i++) sectors.push(fatBytes.slice(i * SEC, (i + 1) * SEC));
  const rest = fatIds.slice(109);
  for (let i = 0; i < nDifat; i++) {
    const chunk = rest.slice(i * 127, (i + 1) * 127);
    while (chunk.length < 127) chunk.push(FREE);
    chunk.push(i < nDifat - 1 ? difatIds[i + 1]! : END);
    sectors.push(u32s(chunk));
  }

  const header = new Uint8Array(SEC);
  const hv = new DataView(header.buffer);
  header.set(MAGIC, 0);
  hv.setUint16(24, 0x3e, true);
  hv.setUint16(26, 3, true);
  hv.setUint16(28, 0xfffe, true);
  hv.setUint16(30, 9, true);
  hv.setUint16(32, 6, true);
  hv.setUint32(44, nFat, true);
  hv.setUint32(48, dirStart, true);
  hv.setUint32(56, CUTOFF, true);
  hv.setUint32(60, miniFatStart, true);
  hv.setUint32(64, miniFatSectors, true);
  hv.setUint32(68, nDifat > 0 ? difatIds[0]! : END, true);
  hv.setUint32(72, nDifat, true);
  for (let i = 0; i < 109; i++) hv.setUint32(76 + i * 4, i < nFat ? fatIds[i]! : FREE, true);

  const bytes = concat([header, ...sectors]);
  const node = (path: string): Node => {
    const n = byPath.get(path);
    if (!n) throw new Error(`no entry ${path}`);
    return n;
  };
  return {
    bytes,
    entryIndex: (path) => node(path).index,
    entryOffset: (path) => (dirStart + 1) * SEC + node(path).index * 128,
    fatEntryOffset: (n) => (fatIds[Math.floor(n / 128)]! + 1) * SEC + (n % 128) * 4,
    miniFatEntryOffset: (n) => (miniFatStart + 1) * SEC + n * 4,
    startSector: (path) => node(path).start,
    difatSectorCount: nDifat,
  };
}

export const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
```

- [ ] **Step 2: 실패하는 테스트 — `src/renderer/lib/extract/__tests__/cfb.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { openCfb, MAX_CFB_ENTRIES } from '../cfb';
import { buildCfb, toArrayBuffer } from '../../../../../test/fixtures/cfb-builder';

const fill = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as { code?: string }).code); }
  return 'no-throw';
};
const poke32 = (bytes: Uint8Array, off: number, v: number) => new DataView(bytes.buffer, bytes.byteOffset).setUint32(off, v >>> 0, true);

describe('openCfb — 정상 경로', () => {
  it('일반 섹터 스트림 · 미니 스트림 · 중첩 저장소 경로를 그대로 읽는다', () => {
    const big = fill(5000, 1);
    const small = fill(100, 2);
    const nested = fill(70, 3);
    const idx = openCfb(toArrayBuffer(buildCfb({ FileHeader: small, 'BodyText/Section0': big, 'BinData/BIN0001.jpg': nested }).bytes));
    expect(idx.names().sort()).toEqual(['BinData/BIN0001.jpg', 'BodyText/Section0', 'FileHeader']);
    expect(idx.bytes('BodyText/Section0')).toEqual(big);
    expect(idx.bytes('FileHeader')).toEqual(small);
    expect(idx.bytes('BinData/BIN0001.jpg')).toEqual(nested);
    expect(idx.has('BodyText')).toBe(false); // 저장소는 스트림이 아니다
    expect(idx.bytes('없음')).toBeNull();
  });

  it('크기 0 스트림은 빈 바이트다', () => {
    expect(openCfb(toArrayBuffer(buildCfb({ empty: new Uint8Array(0) }).bytes)).bytes('empty')).toEqual(new Uint8Array(0));
  });

  it('미니 스트림 경계 — 4095 바이트(미니)와 4096 바이트(일반)를 둘 다 읽는다', () => {
    const a = fill(4095, 4);
    const b = fill(4096, 5);
    const idx = openCfb(toArrayBuffer(buildCfb({ a, b }).bytes));
    expect(idx.bytes('a')).toEqual(a);
    expect(idx.bytes('b')).toEqual(b);
  });

  it('FAT 섹터가 109개를 넘으면 DIFAT 체인을 따라간다 (~7MB)', () => {
    const big = fill(7_400_000, 9);
    const layout = buildCfb({ big });
    expect(layout.difatSectorCount).toBeGreaterThan(0);
    const out = openCfb(toArrayBuffer(layout.bytes)).bytes('big')!;
    expect(out.length).toBe(big.length);
    expect(out.subarray(0, 1000)).toEqual(big.subarray(0, 1000));
    expect(out.subarray(-1000)).toEqual(big.subarray(-1000));
  });

  it(`디렉터리 항목이 정확히 ${MAX_CFB_ENTRIES}개면 연다 (경계)`, () => {
    const streams: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_CFB_ENTRIES - 1; i++) streams[`s${i}`] = new Uint8Array(0); // + 루트 = MAX
    expect(openCfb(toArrayBuffer(buildCfb(streams).bytes)).names()).toHaveLength(MAX_CFB_ENTRIES - 1);
  });
});

describe('openCfb — 손상 · 공격 입력', () => {
  it('CFB 매직이 아니거나 헤더보다 짧으면 DOC_CORRUPT', () => {
    expect(codeOf(() => openCfb(new ArrayBuffer(600)))).toBe('DOC_CORRUPT');
    const short = buildCfb({ a: fill(10, 1) }).bytes.slice(0, 100);
    expect(codeOf(() => openCfb(toArrayBuffer(short)))).toBe('DOC_CORRUPT');
  });

  it('섹터 크기 필드가 9·12 가 아니면 DOC_CORRUPT', () => {
    const b = buildCfb({ a: fill(10, 1) }).bytes;
    new DataView(b.buffer).setUint16(30, 20, true);
    expect(codeOf(() => openCfb(toArrayBuffer(b)))).toBe('DOC_CORRUPT');
  });

  it('FAT 순환(뒤 섹터가 앞 섹터를 가리킴)은 무한 루프가 아니라 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    const s = layout.startSector('big');
    poke32(layout.bytes, layout.fatEntryOffset(s + 1), s);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it('미니 FAT 순환도 DOC_CORRUPT', () => {
    const layout = buildCfb({ small: fill(200, 1) }); // 미니 섹터 4개
    const s = layout.startSector('small');
    poke32(layout.bytes, layout.miniFatEntryOffset(s + 1), s);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('small'))).toBe('DOC_CORRUPT');
  });

  it('디렉터리 형제 링크 순환은 DOC_CORRUPT', () => {
    const layout = buildCfb({ a: fill(10, 1), b: fill(10, 2) });
    poke32(layout.bytes, layout.entryOffset('b') + 72, layout.entryIndex('b'));
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)))).toBe('DOC_CORRUPT');
  });

  it('저장소 중첩이 32단을 넘으면 DOC_CORRUPT (32단은 연다)', () => {
    const deep = (n: number) => `${Array.from({ length: n }, () => 'd').join('/')}/s`;
    expect(openCfb(toArrayBuffer(buildCfb({ [deep(32)]: fill(10, 1) }).bytes)).has(deep(32))).toBe(true);
    expect(codeOf(() => openCfb(toArrayBuffer(buildCfb({ [deep(33)]: fill(10, 1) }).bytes)))).toBe('DOC_CORRUPT');
  });

  it('범위 밖 시작 섹터는 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    poke32(layout.bytes, layout.entryOffset('big') + 116, 0x00ffffff);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it('스트림 크기가 체인보다 길면 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    poke32(layout.bytes, layout.entryOffset('big') + 120, 9000);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it('스트림 크기가 파일보다 크면 버퍼를 잡기 전에 DOC_CORRUPT', () => {
    const layout = buildCfb({ big: fill(5000, 1) });
    poke32(layout.bytes, layout.entryOffset('big') + 120, 0x7fffffff);
    expect(codeOf(() => openCfb(toArrayBuffer(layout.bytes)).bytes('big'))).toBe('DOC_CORRUPT');
  });

  it(`디렉터리 항목이 ${MAX_CFB_ENTRIES}개를 넘으면 DOC_TOO_LARGE`, () => {
    const streams: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_CFB_ENTRIES; i++) streams[`s${i}`] = new Uint8Array(0); // + 루트 = MAX + 1
    expect(codeOf(() => openCfb(toArrayBuffer(buildCfb(streams).bytes)))).toBe('DOC_TOO_LARGE');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/cfb.test.ts`
Expected: FAIL — Cannot find module '../cfb'

- [ ] **Step 4: 구현 — `src/renderer/lib/extract/cfb.ts`**

```ts
/**
 * OLE CFB(Compound File Binary) 읽기 전용 리더 — `.hwp`(HWP 5.x) 컨테이너.
 *
 * 새 의존성 없이 직접 구현한다(설계 H2). 신뢰할 수 없는 바이너리라 **모든 섹터 번호·길이를 믿지 않는다**:
 * 체인은 방문 집합으로 순환을 끊고 길이를 파일 섹터 수(또는 스트림 크기)로 묶으며, 디렉터리 트리는 방문
 * 집합과 깊이 상한으로 순회한다. 구조가 어긋나면 DOC_CORRUPT, 항목 수 상한은 DOC_TOO_LARGE.
 * 스트림은 bytes() 를 부를 때 읽고, 압축은 풀지 않는다 — 추출기가 문서 전체 예산으로 푼다.
 */
import { hasCfbMagic } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { MAX_ZIP_ENTRIES } from './zip';
import type { ContainerIndex } from './types';

const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;
const MAX_REGSECT = 0xfffffffa;
const HEADER_SIZE = 512;
const HEADER_DIFAT = 109;
const DIR_ENTRY = 128;
const MINI_CUTOFF = 4096;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
/** 디렉터리 항목 수 상한 — zip 엔트리 상한과 같은 값(목록 순회 비용을 묶는다). */
export const MAX_CFB_ENTRIES = MAX_ZIP_ENTRIES;
/** 저장소 중첩 깊이 상한. HWP 는 두 단(`BodyText/Section0`)이면 충분하다. */
const MAX_STORAGE_DEPTH = 32;

interface DirEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

function corrupt(why: string): never {
  return extractFail('DOC_CORRUPT', `cfb: ${why}`);
}

export function openCfb(data: ArrayBuffer): ContainerIndex {
  const buf = new Uint8Array(data);
  if (buf.length < HEADER_SIZE || !hasCfbMagic(buf)) corrupt('not a compound file');
  const dv = new DataView(data);
  const sectorShift = dv.getUint16(30, true);
  const miniShift = dv.getUint16(32, true);
  if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) corrupt('sector size');
  const secSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  // 헤더가 섹터 -1 자리를 차지한다(v4 는 4096 바이트 헤더). 잘린 마지막 섹터도 세고, 읽을 때 길이로 거른다.
  const sectorCount = Math.max(0, Math.ceil((buf.length - secSize) / secSize));
  const numFat = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true);
  const difatStart = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);
  if (miniCutoff !== MINI_CUTOFF) corrupt('mini stream cutoff');
  // FAT 섹터도 파일 안의 섹터다 — 개수는 파일 섹터 수를 넘을 수 없다(FAT 배열 크기 ≤ 파일 크기).
  if (numFat === 0 || numFat > sectorCount) corrupt('fat sector count');

  /** 메타데이터(FAT·DIFAT·디렉터리) 섹터는 온전한 한 섹터여야 한다. */
  const fullSector = (n: number): number => {
    const off = (n + 1) * secSize;
    if (n >= sectorCount || off + secSize > buf.length) corrupt('sector out of range');
    return off;
  };

  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT && fatSectors.length < numFat; i++) fatSectors.push(dv.getUint32(76 + i * 4, true));
  const perDifat = secSize / 4 - 1;
  const seenDifat = new Set<number>();
  for (let d = difatStart; fatSectors.length < numFat;) {
    if (d > MAX_REGSECT || seenDifat.has(d) || seenDifat.size >= numDifat) corrupt('difat chain');
    seenDifat.add(d);
    const off = fullSector(d);
    for (let i = 0; i < perDifat && fatSectors.length < numFat; i++) fatSectors.push(dv.getUint32(off + i * 4, true));
    d = dv.getUint32(off + perDifat * 4, true);
  }
  const perSector = secSize / 4;
  const fat = new Uint32Array(numFat * perSector);
  for (const [k, s] of fatSectors.entries()) {
    const off = fullSector(s);
    for (let i = 0; i < perSector; i++) fat[k * perSector + i] = dv.getUint32(off + i * 4, true);
  }

  /** start 부터 ENDOFCHAIN 까지(크기를 모르는 디렉터리·미니 FAT). 순환·범위 밖·과대 길이는 손상이다. */
  const walkChain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== ENDOFCHAIN; s = table[s]!) {
      if (s > MAX_REGSECT || s >= table.length || seen.has(s) || out.length >= limit) corrupt('sector chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  /** 정확히 count 개(스트림 크기에서 도출). 체인이 먼저 끝나면 손상 — 뒤 꼬리는 따라가지 않는다. */
  const takeChain = (start: number, table: Uint32Array, count: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; out.length < count; s = table[s]!) {
      if (s > MAX_REGSECT || s >= table.length || seen.has(s)) corrupt('sector chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readAll = (start: number): Uint8Array => {
    const secs = walkChain(start, fat, sectorCount);
    const out = new Uint8Array(secs.length * secSize);
    secs.forEach((s, i) => { const off = fullSector(s); out.set(buf.subarray(off, off + secSize), i * secSize); });
    return out;
  };
  const readRegular = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    for (const [i, s] of takeChain(start, fat, Math.ceil(size / secSize)).entries()) {
      if (s >= sectorCount) corrupt('sector out of range');
      const from = (s + 1) * secSize;
      const len = Math.min(secSize, size - i * secSize);
      if (from + len > buf.length) corrupt('stream past end of file');
      out.set(buf.subarray(from, from + len), i * secSize);
    }
    return out;
  };

  const dirBytes = readAll(dirStart);
  const entryCount = dirBytes.length / DIR_ENTRY;
  if (entryCount > MAX_CFB_ENTRIES) {
    // 빈 항목(type 0)은 섹터 채움이다 — 실제로 쓰인 항목만 센다.
    let used = 0;
    for (let i = 0; i < entryCount; i++) if (dirBytes[i * DIR_ENTRY + 66] !== 0) used += 1;
    if (used > MAX_CFB_ENTRIES) extractFail('DOC_TOO_LARGE', 'cfb directory entry count exceeded');
  }
  const ddv = new DataView(dirBytes.buffer);
  const entries: (DirEntry | null)[] = [];
  for (let i = 0; i < entryCount; i++) {
    const o = i * DIR_ENTRY;
    const type = dirBytes[o + 66]!;
    if (type === 0) { entries.push(null); continue; }
    const nameLen = Math.min(64, ddv.getUint16(o + 64, true));
    let name = '';
    for (let k = 0; k < nameLen / 2 - 1; k++) name += String.fromCharCode(ddv.getUint16(o + k * 2, true));
    // v4(4096 섹터)만 크기 상위 32비트를 쓴다. 100MB 파일에 4GB 넘는 스트림은 있을 수 없다.
    if (secSize === 4096 && ddv.getUint32(o + 124, true) !== 0) corrupt('stream size');
    entries.push({
      name, type,
      left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true),
      start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true),
    });
  }
  const root = entries[0];
  if (!root || root.type !== TYPE_ROOT) corrupt('root entry');
  if (root.size > buf.length) corrupt('mini stream size');

  const streams = new Map<string, DirEntry>();
  const visited = new Set<number>();
  const stack: { idx: number; prefix: string; depth: number }[] = [{ idx: root.child, prefix: '', depth: 0 }];
  while (stack.length > 0) {
    const { idx, prefix, depth } = stack.pop()!;
    if (idx === NOSTREAM) continue;
    if (idx >= entries.length || visited.has(idx)) corrupt('directory tree');
    visited.add(idx);
    const e = entries[idx];
    if (!e) corrupt('directory tree');
    stack.push({ idx: e.left, prefix, depth }, { idx: e.right, prefix, depth });
    const path = prefix + e.name;
    if (e.type === TYPE_STORAGE) {
      if (depth + 1 > MAX_STORAGE_DEPTH) corrupt('storage depth');
      stack.push({ idx: e.child, prefix: `${path}/`, depth: depth + 1 });
    } else if (e.type === TYPE_STREAM) {
      streams.set(path, e);
    }
  }

  let mini: { stream: Uint8Array; fat: Uint32Array } | null = null;
  const loadMini = () => {
    if (!mini) {
      const stream = root.size > 0 ? readRegular(root.start, root.size) : new Uint8Array(0);
      const mf = miniFatStart > MAX_REGSECT ? new Uint8Array(0) : readAll(miniFatStart);
      const mdv = new DataView(mf.buffer);
      const table = new Uint32Array(mf.length / 4);
      for (let i = 0; i < table.length; i++) table[i] = mdv.getUint32(i * 4, true);
      mini = { stream, fat: table };
    }
    return mini;
  };
  const readMini = (start: number, size: number): Uint8Array => {
    const { stream, fat: mfat } = loadMini();
    const out = new Uint8Array(size);
    for (const [i, s] of takeChain(start, mfat, Math.ceil(size / miniSize)).entries()) {
      const from = s * miniSize;
      const len = Math.min(miniSize, size - i * miniSize);
      if (from + len > stream.length) corrupt('mini sector out of range');
      out.set(stream.subarray(from, from + len), i * miniSize);
    }
    return out;
  };

  const read = (name: string): Uint8Array | null => {
    const e = streams.get(name);
    if (!e) return null;
    if (e.size === 0) return new Uint8Array(0);
    // 크기 필드를 믿고 버퍼부터 잡으면 4GB 할당이 먼저 터진다 — 파일보다 큰 스트림은 손상이다.
    if (e.size > buf.length) corrupt('stream larger than file');
    return e.size < miniCutoff ? readMini(e.start, e.size) : readRegular(e.start, e.size);
  };
  const decoder = new TextDecoder('utf-8');
  return {
    names: () => [...streams.keys()],
    has: (name) => streams.has(name),
    bytes: read,
    text: (name) => {
      const b = read(name);
      return b ? decoder.decode(b) : null;
    },
  };
}
```

> 참고: 정확히 `MAX_CFB_ENTRIES` 개 항목 테스트는 디렉터리 섹터의 빈 채움 항목(type 0)까지 세면 상한을 넘을 수 있어, 쓰인 항목만 센다(위 `used`). 이 분기가 없으면 경계 테스트가 실패한다.

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/cfb.test.ts` 그리고 `npx tsc --noEmit`
Expected: PASS(DIFAT 테스트 포함 수 초 이내), 타입 오류 0

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/cfb-builder.ts src/renderer/lib/extract/cfb.ts src/renderer/lib/extract/__tests__/cfb.test.ts
git commit -m "feat(extract): CFB 읽기 전용 리더 — 섹터 체인 순환·범위·항목 수 상한 내장

.hwp(HWP 5.x) 컨테이너용. 미니 스트림·DIFAT 지원. 테스트용 작성기는 리더 상수를 쓰지 않는 독립 오라클.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: HWP 레코드 · 예산 inflate · 본문 텍스트 + HWP 작성기

**Files:**
- Create: `test/fixtures/hwp-builder.ts`
- Create: `src/renderer/lib/extract/hwp-records.ts`
- Test: `src/renderer/lib/extract/__tests__/hwp-records.test.ts`

**Interfaces:**
- Consumes: `buildCfb`, `toArrayBuffer`(Task 2) · `extractFail`
- Produces (hwp-records.ts): `TAG` · `interface HwpRecord { tag: number; level: number; data: Uint8Array; children: HwpRecord[] }` · `parseRecords(bytes: Uint8Array): HwpRecord[]`(평평한 목록) · `buildTree(flat: HwpRecord[]): HwpRecord[]` · `interface InflateBudget { remaining: number }` · `inflateBudgeted(raw: Uint8Array, budget: InflateBudget): Uint8Array` · `type TextSeg = { kind: 'text'; text: string } | { kind: 'ctrl'; id: string }` · `readParaText(data: Uint8Array): TextSeg[]` · `ctrlIdAt(data: Uint8Array, offset: number): string` · `stripPua(s: string): string` · `u16(b, o)` · `u32(b, o)` · `readUtf16(b, o, count)`
- Produces (hwp-builder.ts): `T` · `Rec` · `serialize` · `para(content, opts?)` · `ctrl(id, children?)` · `table(rows, cols, cells)` · `cell(row, col, text, span?)` · `picture(binId)` · `groupedPicture(depth, binId)` · `textBox(paras)` · `equation(script)` · `docInfoBytes(spec)` · `buildHwp(spec): CfbLayout` · `HwpSpec` · `toArrayBuffer`(재수출)

- [ ] **Step 1: HWP 작성기 — `test/fixtures/hwp-builder.ts`**

```ts
/**
 * 테스트용 HWP 5.x 작성기 — 레코드 트리를 직렬화하고 CFB 로 묶는다. 유닛 테스트와 E2E 픽스처가 같이 쓴다.
 * 프로덕션 hwp-records.ts 의 상수를 import 하지 않는다(독립 오라클). 바이트 배치는 실물로 확정한 값이다
 * (docs/02-design/features/hwp-binary.design.md §0 "실물로 확정한 바이트 배치").
 */
import { deflateSync } from 'fflate';
import { buildCfb, toArrayBuffer, type CfbLayout } from './cfb-builder';

export { toArrayBuffer };

export const T = {
  DOCUMENT_PROPERTIES: 0x10, ID_MAPPINGS: 0x11, BIN_DATA: 0x12, PARA_SHAPE: 0x19,
  PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, CTRL_HEADER: 0x47, LIST_HEADER: 0x48,
  SHAPE_COMPONENT: 0x4c, TABLE: 0x4d, PICTURE: 0x55, EQEDIT: 0x58,
} as const;

export interface Rec { tag: number; data: Uint8Array; children?: Rec[] }

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const le16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const le32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const zeros = (n: number) => new Uint8Array(n);
const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c & 0xff; b[i * 2 + 1] = c >>> 8; }
  return b;
};
/** 컨트롤 id 4글자 → 저장 바이트(역순). 실물: `tbl ` ↔ 20 6c 62 74 */
export const idBytes = (id: string) => new Uint8Array([id.charCodeAt(3), id.charCodeAt(2), id.charCodeAt(1), id.charCodeAt(0)]);
const idOf = (rec: Rec) => String.fromCharCode(rec.data[3]!, rec.data[2]!, rec.data[1]!, rec.data[0]!);

export function serialize(nodes: Rec[], level = 0): Uint8Array {
  const out: Uint8Array[] = [];
  for (const n of nodes) {
    const size = n.data.length;
    const ext = size >= 0xfff;
    out.push(le32(((n.tag & 0x3ff) | ((level & 0x3ff) << 10) | ((ext ? 0xfff : size) << 20)) >>> 0));
    if (ext) out.push(le32(size));
    out.push(n.data);
    if (n.children?.length) out.push(serialize(n.children, level + 1));
  }
  return cat(...out);
}

/** 확장 컨트롤 문자 코드 — 구역/단 정의 2 · 필드 3 · 숨은 설명 15 · 머리말/꼬리말 16 · 각주/미주 17 · 자동 번호 18 · 개체 11 */
const CTRL_CHAR: Record<string, number> = { secd: 2, cold: 2, tcmt: 15, head: 16, foot: 16, 'fn  ': 17, 'en  ': 17, atno: 18 };
const ctrlChar = (id: string) => CTRL_CHAR[id] ?? (id.startsWith('%') ? 3 : 11);

export type Inline = string | Rec;
export interface ParaOptions { shape?: number; breakType?: number }

/** 문단 — 문자열은 본문, Rec(ctrl() 로 만든 CTRL_HEADER)은 그 자리에 확장 컨트롤 문자 8 wchar 를 넣는다. */
export function para(content: Inline | Inline[], o: ParaOptions = {}): Rec {
  const items = Array.isArray(content) ? content : [content];
  const units: number[] = [];
  const ctrls: Rec[] = [];
  for (const it of items) {
    if (typeof it === 'string') {
      for (let i = 0; i < it.length; i++) {
        const c = it.charCodeAt(i);
        if (c === 0x09) units.push(9, 0, 0, 0, 0, 0, 0, 9); // 탭은 인라인 컨트롤(8 wchar)
        else units.push(c); // '\n'(10)은 1 wchar 줄바꿈
      }
      continue;
    }
    const id = idOf(it);
    const code = ctrlChar(id);
    const b = idBytes(id);
    units.push(code, b[0]! | (b[1]! << 8), b[2]! | (b[3]! << 8), 0, 0, 0, 0, code);
    ctrls.push(it);
  }
  units.push(13);
  const text = new Uint8Array(units.length * 2);
  units.forEach((u, i) => { text[i * 2] = u & 0xff; text[i * 2 + 1] = u >>> 8; });
  // 24바이트: 글자 수 · 컨트롤 마스크 · 문단 모양 id @8 · 스타일 @10 · 나눔 종류 @11 · 글자 모양 수 @12(=1) · …
  const header = cat(le32(units.length), le32(0), le16(o.shape ?? 0), new Uint8Array([0, o.breakType ?? 0]), le16(1), zeros(10));
  return { tag: T.PARA_HEADER, data: header, children: [{ tag: T.PARA_TEXT, data: text }, { tag: T.PARA_CHAR_SHAPE, data: zeros(8) }, ...ctrls] };
}

export function ctrl(id: string, children: Rec[] = []): Rec {
  return { tag: T.CTRL_HEADER, data: cat(idBytes(id), zeros(40)), children };
}

export interface CellSpec { row: number; col: number; rowSpan?: number; colSpan?: number; paras: Rec[] }
export const cell = (row: number, col: number, text: string, span: { rowSpan?: number; colSpan?: number } = {}): CellSpec =>
  ({ row, col, ...span, paras: [para(text)] });

/** 표 셀 LIST_HEADER(47바이트, 실물과 같은 길이): 8바이트 머리 뒤 열 @8 · 행 @10 · 열 병합 @12 · 행 병합 @14 */
const cellHeader = (c: CellSpec) =>
  cat(le16(c.paras.length), le16(0), le32(0x20), le16(c.col), le16(c.row), le16(c.colSpan ?? 1), le16(c.rowSpan ?? 1), zeros(31));

export function table(rows: number, cols: number, cells: CellSpec[]): Rec {
  const tableRec: Rec = { tag: T.TABLE, data: cat(le32(0), le16(rows), le16(cols), zeros(10 + rows * 2)) };
  return ctrl('tbl ', [tableRec, ...cells.flatMap((c) => [{ tag: T.LIST_HEADER, data: cellHeader(c) }, ...c.paras])]);
}

const pictureRec = (binId: number): Rec => {
  const d = zeros(91);
  d[71] = binId & 0xff;
  d[72] = binId >>> 8;
  return { tag: T.PICTURE, data: d };
};
const shape = (id: string, children: Rec[]): Rec => ({ tag: T.SHAPE_COMPONENT, data: cat(idBytes(id), zeros(240)), children });

/** 실물과 같은 모양: gso → $pic → PICTURE */
export const picture = (binId: number): Rec => ctrl('gso ', [shape('$pic', [pictureRec(binId)])]);
/** 묶음 개체($con)로 depth 겹 감싼 그림 */
export function groupedPicture(depth: number, binId: number): Rec {
  let s = shape('$pic', [pictureRec(binId)]);
  for (let i = 0; i < depth; i++) s = shape('$con', [s]);
  return ctrl('gso ', [s]);
}
/** 글상자: gso → $rec → LIST_HEADER + 문단들 */
export const textBox = (paras: Rec[]): Rec =>
  ctrl('gso ', [shape('$rec', [{ tag: T.LIST_HEADER, data: cat(le16(paras.length), zeros(32)) }, ...paras])]);
export const equation = (script: string): Rec =>
  ctrl('eqed', [{ tag: T.EQEDIT, data: cat(le32(0), le16(script.length), utf16(script), zeros(16)) }]);

export interface BinSpec { id: number; ext: string; bytes: Uint8Array; type?: number; compress?: 0 | 1 | 2 }
export interface HwpSpec {
  /** 구역마다 최상위 문단 */
  sections: Rec[][];
  paraShapes?: { head: number; level: number }[];
  bins?: BinSpec[];
  /** 기본 0x01(압축) */
  flags?: number;
  /** 기본 5.1.1.0 */
  version?: number;
  prvText?: string;
  bodyDir?: 'BodyText' | 'ViewText';
  omit?: string[];
  /** 압축·직렬화를 건너뛰고 그대로 넣을 스트림(손상 입력용) */
  override?: Record<string, Uint8Array>;
}

export function docInfoBytes(spec: HwpSpec): Uint8Array {
  const shapes = spec.paraShapes ?? [{ head: 0, level: 0 }];
  return serialize([
    { tag: T.DOCUMENT_PROPERTIES, data: cat(le16(spec.sections.length), zeros(24)) },
    { tag: T.ID_MAPPINGS, data: cat(le32(spec.bins?.length ?? 0), zeros(68)) },
    ...(spec.bins ?? []).map((b) => ({ tag: T.BIN_DATA, data: cat(le16((b.type ?? 1) | ((b.compress ?? 0) << 4)), le16(b.id), le16(b.ext.length), utf16(b.ext)) })),
    ...shapes.map((s) => ({ tag: T.PARA_SHAPE, data: cat(le32(((s.head & 3) << 23) | ((s.level & 7) << 25)), zeros(50)) })),
  ]);
}

export function buildHwp(spec: HwpSpec): CfbLayout {
  const flags = spec.flags ?? 0x01;
  const compressed = (flags & 0x01) !== 0;
  const pack = (b: Uint8Array) => (compressed ? deflateSync(b) : b);
  const fileHeader = zeros(256);
  fileHeader.set(new TextEncoder().encode('HWP Document File'), 0);
  const fv = new DataView(fileHeader.buffer);
  fv.setUint32(32, spec.version ?? 0x05010100, true);
  fv.setUint32(36, flags, true);
  const streams: Record<string, Uint8Array> = { FileHeader: fileHeader, DocInfo: pack(docInfoBytes(spec)) };
  spec.sections.forEach((s, i) => { streams[`${spec.bodyDir ?? 'BodyText'}/Section${i}`] = pack(serialize(s)); });
  for (const b of spec.bins ?? []) {
    const name = `BinData/BIN${b.id.toString(16).toUpperCase().padStart(4, '0')}.${b.ext}`;
    const c = b.compress ?? 0;
    streams[name] = c === 2 || (c === 0 && !compressed) ? b.bytes : deflateSync(b.bytes);
  }
  if (spec.prvText !== undefined) streams.PrvText = utf16(spec.prvText);
  for (const o of spec.omit ?? []) delete streams[o];
  Object.assign(streams, spec.override ?? {});
  return buildCfb(streams);
}
```

- [ ] **Step 2: 실패하는 테스트 — `src/renderer/lib/extract/__tests__/hwp-records.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'fflate';
import { TAG, parseRecords, buildTree, inflateBudgeted, readParaText, ctrlIdAt, stripPua } from '../hwp-records';
import { T, serialize, para, table, cell } from '../../../../../test/fixtures/hwp-builder';

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as { code?: string }).code); }
  return 'no-throw';
};
const u16s = (...units: number[]) => {
  const b = new Uint8Array(units.length * 2);
  units.forEach((u, i) => { b[i * 2] = u & 0xff; b[i * 2 + 1] = u >>> 8; });
  return b;
};
let seed = 1;
const noise = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);

describe('레코드 분해', () => {
  it('TAG 는 스펙 값이다 — 작성기의 독립 상수와 대조', () => {
    expect(TAG).toMatchObject({
      DOCUMENT_PROPERTIES: T.DOCUMENT_PROPERTIES, BIN_DATA: T.BIN_DATA, PARA_SHAPE: T.PARA_SHAPE,
      PARA_HEADER: T.PARA_HEADER, PARA_TEXT: T.PARA_TEXT, CTRL_HEADER: T.CTRL_HEADER, LIST_HEADER: T.LIST_HEADER,
      SHAPE_COMPONENT: T.SHAPE_COMPONENT, TABLE: T.TABLE, SHAPE_COMPONENT_PICTURE: T.PICTURE, EQEDIT: T.EQEDIT,
    });
  });

  it('태그·레벨·크기를 분해하고 레벨로 트리를 묶는다', () => {
    const flat = parseRecords(serialize([para(['앞', table(1, 1, [cell(0, 0, '칸')])])]));
    expect(flat.map((r) => [r.tag, r.level])).toEqual([
      [T.PARA_HEADER, 0], [T.PARA_TEXT, 1], [T.PARA_CHAR_SHAPE, 1], [T.CTRL_HEADER, 1],
      [T.TABLE, 2], [T.LIST_HEADER, 2], [T.PARA_HEADER, 2], [T.PARA_TEXT, 3], [T.PARA_CHAR_SHAPE, 3],
    ]);
    const [root] = buildTree(flat);
    expect(root!.children.map((c) => c.tag)).toEqual([T.PARA_TEXT, T.PARA_CHAR_SHAPE, T.CTRL_HEADER]);
    expect(root!.children[2]!.children.map((c) => c.tag)).toEqual([T.TABLE, T.LIST_HEADER, T.PARA_HEADER]);
  });

  it('크기 필드가 0xFFF 면 다음 4바이트가 실제 크기다', () => {
    const [r] = parseRecords(serialize([{ tag: T.PARA_TEXT, data: new Uint8Array(5000).fill(7) }]));
    expect(r!.data.length).toBe(5000);
  });

  it('크기가 남은 바이트를 넘거나 헤더가 잘리면 DOC_CORRUPT', () => {
    const b = serialize([{ tag: T.PARA_TEXT, data: new Uint8Array(10) }]);
    expect(codeOf(() => parseRecords(b.slice(0, 8)))).toBe('DOC_CORRUPT');
    expect(codeOf(() => parseRecords(b.slice(0, 2)))).toBe('DOC_CORRUPT');
  });

  it('레벨이 건너뛰어도(손상) 가장 가까운 얕은 조상에 붙는다', () => {
    const flat = [0, 3, 1].map((level) => ({ tag: 1, level, data: new Uint8Array(0), children: [] }));
    const roots = buildTree(flat);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children.map((c) => c.level)).toEqual([3, 1]);
  });
});

describe('inflateBudgeted — 문서 전체 누적 예산', () => {
  it('여러 청크로 나뉘는 입력(>16KB 압축)도 원문을 복원한다', () => {
    const src = noise(100_000);
    const z = deflateSync(src);
    expect(z.length).toBeGreaterThan(16 * 1024);
    expect(inflateBudgeted(z, { remaining: 1_000_000 })).toEqual(src);
  });

  it('예산은 호출 사이에 누적된다 — 각각은 상한 안이어도 합이 넘으면 DOC_TOO_LARGE', () => {
    const budget = { remaining: 150_000 };
    const z = deflateSync(noise(100_000));
    inflateBudgeted(z, budget);
    expect(codeOf(() => inflateBudgeted(z, budget))).toBe('DOC_TOO_LARGE');
  });

  it('압축 폭탄은 다 풀기 전에 멈춘다', () => {
    const bomb = deflateSync(new Uint8Array(50_000_000));
    const budget = { remaining: 1_000_000 };
    expect(codeOf(() => inflateBudgeted(bomb, budget))).toBe('DOC_TOO_LARGE');
    expect(budget.remaining).toBeGreaterThan(-20_000_000); // 50MB 를 다 푼 뒤가 아니다
  });

  it('deflate 가 아니면 DOC_CORRUPT', () => {
    expect(codeOf(() => inflateBudgeted(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), { remaining: 1e6 }))).toBe('DOC_CORRUPT');
  });
});

describe('readParaText', () => {
  it('확장 컨트롤은 8 wchar 를 건너뛰고 그 자리에 컨트롤 id 를 남긴다', () => {
    const p = para(['앞 ', table(1, 1, [cell(0, 0, 'x')]), ' 뒤']);
    expect(readParaText(p.children![0]!.data)).toEqual([
      { kind: 'text', text: '앞 ' }, { kind: 'ctrl', id: 'tbl ' }, { kind: 'text', text: ' 뒤' },
    ]);
  });

  it('탭(인라인 8 wchar) · 줄바꿈(10) · 하이픈(24) · 빈칸(30·31) · 문단 끝(13)', () => {
    const d = u16s(0x61, 9, 0, 0, 0, 0, 0, 0, 9, 0x62, 10, 0x63, 24, 0x64, 30, 31, 0x65, 13);
    expect(readParaText(d)).toEqual([{ kind: 'text', text: 'a\tb\nc-d  e' }]);
  });

  it('사용자 정의 영역(PUA) 문자는 BMP·보충 평면 모두 지운다', () => {
    expect(readParaText(para('가\uE000나\uDB80\uDEB1다').children![0]!.data)).toEqual([{ kind: 'text', text: '가나다' }]);
    expect(stripPua('\uF8FF a \uDBFF\uDFFF')).toBe(' a ');
  });

  it('컨트롤이 문단 끝에서 잘리면 DOC_CORRUPT', () => {
    expect(codeOf(() => readParaText(u16s(0x41, 11, 0, 0)))).toBe('DOC_CORRUPT');
  });

  it('ctrlIdAt 은 저장 바이트를 뒤집어 읽는다 (실물 20 6c 62 74 → "tbl ")', () => {
    expect(ctrlIdAt(new Uint8Array([0x20, 0x6c, 0x62, 0x74]), 0)).toBe('tbl ');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/hwp-records.test.ts`
Expected: FAIL — Cannot find module '../hwp-records'

- [ ] **Step 4: 구현 — `src/renderer/lib/extract/hwp-records.ts`**

```ts
/**
 * HWP 5.x 레코드 스트림의 순수 함수들 — 레코드 분해·트리, 문서 전체 예산 inflate, PARA_TEXT 제어문자.
 *
 * 바이트 배치는 한컴 공개 스펙 "한글 문서 파일 구조 5.0" 을 따르되, 실물로 확인한 값이 스펙 표와 다르면
 * 실물을 따른다(설계 §0 "실물로 확정한 바이트 배치").
 */
import { Inflate } from 'fflate';
import { extractFail } from './errors';

export const TAG = {
  DOCUMENT_PROPERTIES: 0x10,
  BIN_DATA: 0x12,
  PARA_SHAPE: 0x19,
  PARA_HEADER: 0x42,
  PARA_TEXT: 0x43,
  CTRL_HEADER: 0x47,
  LIST_HEADER: 0x48,
  SHAPE_COMPONENT: 0x4c,
  TABLE: 0x4d,
  SHAPE_COMPONENT_PICTURE: 0x55,
  EQEDIT: 0x58,
} as const;

export interface HwpRecord {
  tag: number;
  level: number;
  data: Uint8Array;
  children: HwpRecord[];
}

export function u16(b: Uint8Array, o: number): number {
  return o + 2 <= b.length ? b[o]! | (b[o + 1]! << 8) : 0;
}

export function u32(b: Uint8Array, o: number): number {
  return o + 4 <= b.length ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 : 0;
}

/** UTF-16LE count 글자. 버퍼를 넘는 부분은 읽지 않는다. */
export function readUtf16(b: Uint8Array, o: number, count: number): string {
  let s = '';
  for (let i = 0; i < count && o + i * 2 + 2 <= b.length; i++) s += String.fromCharCode(u16(b, o + i * 2));
  return s;
}

/** 레코드 헤더(u32): tag bit0-9 · level bit10-19 · size bit20-31(0xFFF 면 다음 u32 가 크기). */
export function parseRecords(bytes: Uint8Array): HwpRecord[] {
  const out: HwpRecord[] = [];
  let p = 0;
  while (p < bytes.length) {
    if (p + 4 > bytes.length) extractFail('DOC_CORRUPT', 'truncated record header');
    const h = u32(bytes, p);
    p += 4;
    let size = h >>> 20;
    if (size === 0xfff) {
      if (p + 4 > bytes.length) extractFail('DOC_CORRUPT', 'truncated record size');
      size = u32(bytes, p);
      p += 4;
    }
    if (size > bytes.length - p) extractFail('DOC_CORRUPT', 'record size exceeds stream');
    out.push({ tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: bytes.subarray(p, p + size), children: [] });
    p += size;
  }
  return out;
}

/** 평평한 레코드 열 → 트리. level 이 건너뛰면(손상) 가장 가까운 얕은 조상에 붙인다. */
export function buildTree(flat: HwpRecord[]): HwpRecord[] {
  const roots: HwpRecord[] = [];
  const stack: HwpRecord[] = [];
  for (const r of flat) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= r.level) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(r);
    stack.push(r);
  }
  return roots;
}

/** 압축 해제 누적 예산 — 문서 하나에 객체 하나를 만들어 모든 스트림이 나눠 쓴다(스트림별 상한이 아니다). */
export interface InflateBudget {
  remaining: number;
}

/**
 * 입력을 이 크기로 잘라 넣는다. fflate 는 push 한 번의 출력을 한 번에 내므로, 통째로 넣으면 폭탄이 다 풀린
 * 뒤에야 크기를 셀 수 있다. 16KB 입력의 최대 출력(deflate 최대 비율 ~1032:1)은 ~16.5MB 라 상한 초과분도 그만큼으로 묶인다.
 */
const INFLATE_CHUNK = 16 * 1024;

export function inflateBudgeted(raw: Uint8Array, budget: InflateBudget): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk: Uint8Array) => {
    budget.remaining -= chunk.length;
    if (budget.remaining < 0) extractFail('DOC_TOO_LARGE', 'decompressed size exceeded');
    total += chunk.length;
    parts.push(chunk);
  });
  try {
    if (raw.length === 0) inflate.push(raw, true);
    for (let i = 0; i < raw.length; i += INFLATE_CHUNK) {
      inflate.push(raw.subarray(i, i + INFLATE_CHUNK), i + INFLATE_CHUNK >= raw.length);
    }
  } catch (err) {
    if ((err as { code?: unknown }).code === 'DOC_TOO_LARGE') throw err;
    extractFail('DOC_CORRUPT', 'inflate failed');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export type TextSeg = { kind: 'text'; text: string } | { kind: 'ctrl'; id: string };

/** 8 wchar 를 차지하는 인라인·확장 컨트롤 문자 */
const WIDE_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
/** 그중 CTRL_HEADER 와 짝을 이루는 확장 컨트롤 */
const EXTENDED_CONTROLS = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

/** 사용자 정의 영역 — 한글 전용 글머리 기호 글리프. AI 입력에 깨진 글자로 들어간다(설계 H5). */
const PUA = /[\uE000-\uF8FF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g;

export function stripPua(s: string): string {
  return s.replace(PUA, '');
}

/** 컨트롤 id — 4바이트를 뒤집어 읽는다(CTRL_HEADER 와 PARA_TEXT 확장 컨트롤이 같은 표기). */
export function ctrlIdAt(data: Uint8Array, offset: number): string {
  if (offset + 4 > data.length) return '';
  return String.fromCharCode(data[offset + 3]!, data[offset + 2]!, data[offset + 1]!, data[offset]!);
}

/** PARA_TEXT → 텍스트 조각과 확장 컨트롤 자리표시의 순서열. */
export function readParaText(data: Uint8Array): TextSeg[] {
  const segs: TextSeg[] = [];
  const n = Math.floor(data.length / 2);
  let buf = '';
  const flush = () => {
    if (buf) segs.push({ kind: 'text', text: stripPua(buf) });
    buf = '';
  };
  for (let i = 0; i < n;) {
    const c = u16(data, i * 2);
    if (c >= 32) { buf += String.fromCharCode(c); i += 1; continue; }
    if (WIDE_CONTROLS.has(c)) {
      if (i + 8 > n) extractFail('DOC_CORRUPT', 'truncated control in PARA_TEXT');
      if (c === 9) buf += '\t';
      else if (EXTENDED_CONTROLS.has(c)) { flush(); segs.push({ kind: 'ctrl', id: ctrlIdAt(data, i * 2 + 2) }); }
      i += 8;
      continue;
    }
    if (c === 10) buf += '\n';
    else if (c === 24) buf += '-';
    else if (c === 30 || c === 31) buf += ' ';
    // 13(문단 끝) · 0 · 25~29 는 글자가 아니다.
    i += 1;
  }
  flush();
  return segs;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/hwp-records.test.ts` 그리고 `npx tsc --noEmit`
Expected: PASS, 타입 오류 0

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/hwp-builder.ts src/renderer/lib/extract/hwp-records.ts src/renderer/lib/extract/__tests__/hwp-records.test.ts
git commit -m "feat(extract): HWP 레코드 분해·트리 · 문서 누적 예산 inflate · PARA_TEXT 제어문자

확장 컨트롤 8 wchar 와 그 안의 컨트롤 id(실물 배치), PUA 글머리 기호 제거. 테스트용 HWP 작성기 포함.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: DocInfo(개요 수준 · BinData) + 표 셀

**Files:**
- Create: `src/renderer/lib/extract/hwp-docinfo.ts`
- Create: `src/renderer/lib/extract/hwp-table.ts`
- Test: `src/renderer/lib/extract/__tests__/hwp-docinfo.test.ts`, `src/renderer/lib/extract/__tests__/hwp-table.test.ts`

**Interfaces:**
- Consumes: `TAG`, `HwpRecord`, `u16`, `u32`, `readUtf16`(Task 3)
- Produces: `interface BinDataEntry { stream: string; compress: 'doc' | 'yes' | 'no' }` · `interface HwpDocInfo { outlineLevels: Map<number, number>; binData: (BinDataEntry | null)[] }` · `readDocInfo(flat: HwpRecord[]): HwpDocInfo` · `interface HwpCell { row: number; col: number; rowSpan: number; colSpan: number; paras: HwpRecord[] }` · `readTable(ctrl: HwpRecord): { rows: number; cols: number; cells: HwpCell[] }` · `followingParagraphs(siblings: HwpRecord[], start: number): HwpRecord[]`

- [ ] **Step 1: 실패하는 테스트 둘**

`hwp-docinfo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readDocInfo } from '../hwp-docinfo';
import { parseRecords } from '../hwp-records';
import { docInfoBytes, type HwpSpec } from '../../../../../test/fixtures/hwp-builder';

const info = (spec: Partial<HwpSpec>) => readDocInfo(parseRecords(docInfoBytes({ sections: [], ...spec })));
const img = new Uint8Array(4);

describe('readDocInfo', () => {
  it('문단 모양의 머리 종류가 개요(1)일 때만 수준(+1)을 준다 — 번호(2)·글머리(3)는 제목이 아니다', () => {
    const d = info({ paraShapes: [{ head: 0, level: 0 }, { head: 1, level: 0 }, { head: 1, level: 2 }, { head: 2, level: 1 }, { head: 3, level: 0 }] });
    expect([...d.outlineLevels]).toEqual([[1, 1], [2, 3]]);
  });

  it('BIN_DATA → BinData/BIN%04X.<ext>(16진 대문자) · 압축 방식 · 링크형(0)은 null', () => {
    const d = info({
      bins: [
        { id: 1, ext: 'jpg', bytes: img },
        { id: 26, ext: 'PNG', bytes: img, compress: 2 },
        { id: 3, ext: 'bmp', bytes: img, type: 0 },
        { id: 4, ext: 'gif', bytes: img, compress: 1 },
      ],
    });
    expect(d.binData).toEqual([
      { stream: 'BinData/BIN0001.jpg', compress: 'doc' },
      { stream: 'BinData/BIN001A.png', compress: 'no' },
      null,
      { stream: 'BinData/BIN0004.gif', compress: 'yes' },
    ]);
  });

  it('확장자에 경로 문자가 있으면 그림으로 쓰지 않는다', () => {
    expect(info({ bins: [{ id: 1, ext: '../x', bytes: img }] }).binData).toEqual([null]);
  });
});
```

`hwp-table.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readTable } from '../hwp-table';
import { buildTree, parseRecords } from '../hwp-records';
import { serialize, table, cell, para, ctrl, T, type Rec } from '../../../../../test/fixtures/hwp-builder';

const node = (rec: Rec) => buildTree(parseRecords(serialize([rec])))[0]!;
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as { code?: string }).code); }
  return 'no-throw';
};

describe('readTable', () => {
  it('셀 주소·병합은 LIST_HEADER @8~@14 에서 읽는다 (실물 확인 배치)', () => {
    const t = readTable(node(table(2, 3, [
      cell(0, 0, '분류', { rowSpan: 2 }), cell(0, 1, '항목'), cell(0, 2, '달성률', { colSpan: 1 }),
      cell(1, 1, '기능', { colSpan: 2 }),
    ])));
    expect([t.rows, t.cols]).toEqual([2, 3]);
    expect(t.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan])).toEqual([[0, 0, 2, 1], [0, 1, 1, 1], [0, 2, 1, 1], [1, 1, 1, 2]]);
  });

  it('셀 문단은 다음 LIST_HEADER 전까지의 형제 문단이다', () => {
    const t = readTable(node(table(1, 2, [{ row: 0, col: 0, paras: [para('a'), para('b')] }, cell(0, 1, 'c')])));
    expect(t.cells.map((c) => c.paras.length)).toEqual([2, 1]);
  });

  it('TABLE 레코드가 없거나 셀 머리가 16바이트보다 짧으면 DOC_CORRUPT', () => {
    expect(codeOf(() => readTable(node(ctrl('tbl ', [{ tag: T.LIST_HEADER, data: new Uint8Array(20) }]))))).toBe('DOC_CORRUPT');
    const short = ctrl('tbl ', [{ tag: T.TABLE, data: new Uint8Array(20) }, { tag: T.LIST_HEADER, data: new Uint8Array(8) }]);
    expect(codeOf(() => readTable(node(short)))).toBe('DOC_CORRUPT');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/hwp-docinfo.test.ts src/renderer/lib/extract/__tests__/hwp-table.test.ts`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 구현 — `hwp-docinfo.ts`**

```ts
import { TAG, u16, u32, readUtf16, type HwpRecord } from './hwp-records';

/** 그림 스트림 하나. compress: 'doc' = 문서 압축 플래그를 따름(실물 기본값) */
export interface BinDataEntry {
  stream: string;
  compress: 'doc' | 'yes' | 'no';
}

export interface HwpDocInfo {
  /** 문단 모양 id → 제목 수준(1-based). 개요 문단 모양만 들어 있다. */
  outlineLevels: Map<number, number>;
  /** BinItem id(1-based) - 1 → 그림 스트림. 링크형·OLE 저장형은 null */
  binData: (BinDataEntry | null)[];
}

const HEAD_OUTLINE = 1;
const BIN_EMBEDDING = 1;

function readBinData(d: Uint8Array): BinDataEntry | null {
  if (d.length < 6) return null;
  const attr = u16(d, 0);
  if ((attr & 0xf) !== BIN_EMBEDDING) return null;
  const id = u16(d, 2);
  const extLen = u16(d, 4);
  if (6 + extLen * 2 > d.length) return null;
  const ext = readUtf16(d, 6, extLen).toLowerCase();
  // 스트림 이름에 붙는다 — 경로 문자나 이상한 길이는 받지 않는다.
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return null;
  const mode = (attr >>> 4) & 3;
  return {
    stream: `BinData/BIN${id.toString(16).toUpperCase().padStart(4, '0')}.${ext}`,
    compress: mode === 1 ? 'yes' : mode === 2 ? 'no' : 'doc',
  };
}

/** DocInfo 레코드(평평한 목록) → 개요 수준 · 그림 목록. 문단 모양·BinData id 는 등장 순번이다. */
export function readDocInfo(flat: HwpRecord[]): HwpDocInfo {
  const outlineLevels = new Map<number, number>();
  const binData: (BinDataEntry | null)[] = [];
  let shapeId = 0;
  for (const r of flat) {
    if (r.tag === TAG.PARA_SHAPE) {
      const attr = u32(r.data, 0);
      // 머리 종류 bit23-24(1 = 개요) · 수준 bit25-27(0-based). 스타일 이름("개요 1")은 보지 않는다 —
      // hwpx-header.ts 와 같은 이유(문단이 실제로 참조하는 모양 하나로 판정).
      if (r.data.length >= 4 && ((attr >>> 23) & 3) === HEAD_OUTLINE) outlineLevels.set(shapeId, ((attr >>> 25) & 7) + 1);
      shapeId += 1;
    } else if (r.tag === TAG.BIN_DATA) {
      binData.push(readBinData(r.data));
    }
  }
  return { outlineLevels, binData };
}
```

- [ ] **Step 4: 구현 — `hwp-table.ts`**

```ts
import { extractFail } from './errors';
import { TAG, u16, type HwpRecord } from './hwp-records';

export interface HwpCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** 이 셀의 문단(PARA_HEADER 노드) */
  paras: HwpRecord[];
}

/** LIST_HEADER 뒤에 이어지는 형제 문단들 — 셀·글상자의 내용이다(실물: 같은 level 의 형제). */
export function followingParagraphs(siblings: HwpRecord[], start: number): HwpRecord[] {
  const out: HwpRecord[] = [];
  for (let j = start; j < siblings.length && siblings[j]!.tag === TAG.PARA_HEADER; j++) out.push(siblings[j]!);
  return out;
}

/**
 * 표 컨트롤(CTRL_HEADER 'tbl ') → 선언 행·열 수와 셀 목록. 격자 배치(gridExtent·placeGridCells)는 호출자가 한다.
 *
 * 셀 LIST_HEADER 는 **8바이트 머리**(문단 수 u16 · 미상 u16 · 속성 u32) 뒤에 열 @8 · 행 @10 · 열 병합 @12 ·
 * 행 병합 @14 를 둔다 — 공식 스펙 표는 머리를 6바이트로 적어 두 칸 어긋난다(실물 3×5 병합 표로 확인, 설계 §0).
 */
export function readTable(ctrl: HwpRecord): { rows: number; cols: number; cells: HwpCell[] } {
  const kids = ctrl.children;
  const table = kids.find((k) => k.tag === TAG.TABLE);
  if (!table || table.data.length < 8) extractFail('DOC_CORRUPT', 'table record missing');
  const cells: HwpCell[] = [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k.tag !== TAG.LIST_HEADER) continue;
    if (k.data.length < 16) extractFail('DOC_CORRUPT', 'table cell header too short');
    cells.push({
      col: u16(k.data, 8),
      row: u16(k.data, 10),
      colSpan: Math.max(1, u16(k.data, 12)),
      rowSpan: Math.max(1, u16(k.data, 14)),
      paras: followingParagraphs(kids, i + 1),
    });
  }
  return { rows: u16(table.data, 4), cols: u16(table.data, 6), cells };
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/hwp-docinfo.test.ts src/renderer/lib/extract/__tests__/hwp-table.test.ts` 그리고 `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/lib/extract/hwp-docinfo.ts src/renderer/lib/extract/hwp-table.ts src/renderer/lib/extract/__tests__/hwp-docinfo.test.ts src/renderer/lib/extract/__tests__/hwp-table.test.ts
git commit -m "feat(extract): HWP DocInfo(개요 수준·BinData) · 표 셀 읽기 — 셀 머리 8바이트(실물 배치)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HWP 추출기 (`hwp.ts`) + 오류 코드 등록

**Files:**
- Create: `src/renderer/lib/extract/hwp.ts`
- Modify: `src/shared/document-formats.ts:11-19, 47` (id 유니온 · container 유니온 · `HWP_FORMAT_ID` — **`SUPPORTED_FORMATS` 배열은 아직 건드리지 않는다**)
- Modify: `src/renderer/lib/document-open.ts:36-48, 80-84` (`DOC_DISTRIBUTION` 번역 표 · `hwp` 단위)
- Modify: `src/renderer/lib/i18n.ts:190` 다음 줄
- Test: `src/renderer/lib/extract/__tests__/hwp.test.ts`

**Interfaces:**
- Consumes: Task 1~4 전부 · `paginate` · `toGfmTable`/`placeGridCells`/`gridExtent` · `collectImages`/`throwIfAborted`/`yieldToEventLoop` · `fitImage` · `MAX_PAGE_COUNT` · `MAX_UNZIPPED_BYTES`
- Produces: `createHwpExtractor(deps?: { fitImage?: ImageFitter; maxInflateBytes?: number }): Extractor` · `hwpExtractor: Extractor` · `HWP_FORMAT_ID`(document-formats)

`document-formats` 의 id 유니온에 `'hwp'` 가 들어가는 순간 `Extractor['id']` 를 키로 쓰는 `EXTRACTOR_UNIT_KIND` 가 타입 오류가 난다 — 그래서 단위 표를 이 Task 에서 함께 채운다. `extract/` 가 던지는 코드는 `document-open.test.ts` 의 전수 도출 가드가 번역 표와 대조하므로 `DOC_DISTRIBUTION` 표·문구도 이 Task 에서 함께 넣는다. 포맷 **등록**(진입 게이트가 `.hwp` 를 받기 시작)은 Task 6.

- [ ] **Step 1: 실패하는 테스트 — `hwp.test.ts`**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { openCfb } from '../cfb';
import { createHwpExtractor, hwpExtractor } from '../hwp';
import type { ExtractOptions } from '../types';
import { buildCfb } from '../../../../../test/fixtures/cfb-builder';
import {
  buildHwp, para, table, cell, textBox, picture, groupedPicture, equation, ctrl, toArrayBuffer, T, type HwpSpec,
} from '../../../../../test/fixtures/hwp-builder';

const FIT = vi.fn(async (b: Uint8Array) => ({ base64: `b${b[0]}`, width: 100, height: 100, mimeType: 'image/jpeg' as const }));
const x = createHwpExtractor({ fitImage: FIT });
const indexOf = (spec: HwpSpec) => openCfb(toArrayBuffer(buildHwp(spec).bytes));
const extract = (spec: HwpSpec, opts: ExtractOptions = { extractImages: false }) => x.extract(indexOf(spec), opts);
const failCode = (p: Promise<unknown>) => p.then(() => 'no-throw', (e) => String((e as { code?: string }).code));
const LIST = { tag: T.LIST_HEADER, data: new Uint8Array(34) };

describe('sniff', () => {
  it('FileHeader 서명이 있는 CFB 만 고른다 — 암호 걸린 OOXML(CFB)·다른 서명은 아니다', () => {
    expect(hwpExtractor.sniff(indexOf({ sections: [[para('a')]] }))).toBe(true);
    const ooxml = openCfb(toArrayBuffer(buildCfb({ EncryptionInfo: new Uint8Array(200), EncryptedPackage: new Uint8Array(5000) }).bytes));
    expect(hwpExtractor.sniff(ooxml)).toBe(false);
    const other = openCfb(toArrayBuffer(buildCfb({ FileHeader: new TextEncoder().encode('NOT A Document File' + ' '.repeat(40)) }).bytes));
    expect(hwpExtractor.sniff(other)).toBe(false);
  });
});

describe('본문 · 쪽 나눔', () => {
  it('쪽 나눔(@11 bit2)과 구역 경계로 단위를 나눈다', async () => {
    const doc = await extract({ sections: [[para('첫 쪽'), para('둘째 쪽', { breakType: 0x04 }), para('같은 쪽')], [para('둘째 구역')]] });
    expect(doc.unitKind).toBe('page');
    expect(doc.units).toEqual(['첫 쪽', '둘째 쪽\n\n같은 쪽', '둘째 구역']);
  });

  it('다단 나눔(bit1)·글자 모양 수(@12)는 쪽을 나누지 않는다', async () => {
    const doc = await extract({ sections: [[para('가'), para('나', { breakType: 0x02 })]] });
    expect(doc.units).toEqual(['가\n\n나']);
  });

  it('PUA 글머리 기호는 본문에서 지운다', async () => {
    expect((await extract({ sections: [[para('\uDB80\uDEB1 항목')]] })).units).toEqual(['항목']);
  });

  it('구역 정의·머리말·각주의 텍스트는 본문에 들어가지 않는다', async () => {
    const doc = await extract({ sections: [[para([
      ctrl('secd'), ctrl('cold'), '본문',
      ctrl('head', [LIST, para('머리말 문구')]), ctrl('fn  ', [LIST, para('각주 문구')]),
    ])]] });
    expect(doc.units).toEqual(['본문']);
  });

  it('본문에 자리표시가 없는 컨트롤(비표준 작성기)도 잃지 않는다', async () => {
    const p = para('앞');
    p.children!.push(table(1, 1, [cell(0, 0, '숨은 표')]));
    expect((await extract({ sections: [[p]] })).units[0]).toContain('숨은 표');
  });

  it('텍스트가 없으면 DOC_NO_TEXT', async () => {
    expect(await failCode(extract({ sections: [[para('')]] }))).toBe('DOC_NO_TEXT');
  });

  it('압축 안 된 문서(flags bit0 = 0)도 읽는다', async () => {
    expect((await extract({ flags: 0, sections: [[para('무압축')]] })).units).toEqual(['무압축']);
  });
});

describe('표', () => {
  it('좌표 격자 GFM — 세로 병합 칸은 위 칸을 이어받고, 표 앞뒤 텍스트 순서를 지킨다', async () => {
    const t = table(2, 3, [cell(0, 0, '분류', { rowSpan: 2 }), cell(0, 1, '항목'), cell(0, 2, '달성률'), cell(1, 1, '기능 개발'), cell(1, 2, '100%')]);
    const doc = await extract({ sections: [[para(['앞 문장', t, '뒤 문장'])]] });
    expect(doc.units[0]).toBe('앞 문장\n\n| 분류 | 항목 | 달성률 |\n| --- | --- | --- |\n| 분류 | 기능 개발 | 100% |\n\n뒤 문장');
  });

  it('256행을 넘는 표도 잘리지 않는다 (QA35 회귀)', async () => {
    const cells = Array.from({ length: 300 }, (_, r) => cell(r, 0, `행${r}`));
    expect((await extract({ sections: [[para(table(300, 1, cells))]] })).units.join('\n')).toContain('| 행299 |');
  });

  it('선언 행 수가 모자라도 셀은 버리지 않는다 (R18)', async () => {
    const doc = await extract({ sections: [[para(table(1, 2, [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(1, 0, 'c'), cell(1, 1, 'd')]))]] });
    expect(doc.units[0]).toBe('| a | b |\n| --- | --- |\n| c | d |');
  });

  it('병리적 rowSpan 은 선언 행 수 밖으로 빈 행을 만들지 않는다 (R18)', async () => {
    const doc = await extract({ sections: [[para(table(2, 1, [cell(0, 0, 'a', { rowSpan: 60000 })]))]] });
    expect(doc.units[0]!.split('\n')).toHaveLength(3);
  });

  it('셀 안 표는 평탄화한다 (hwpx 와 같은 규칙)', async () => {
    const inner = table(1, 2, [cell(0, 0, '안1'), cell(0, 1, '안2')]);
    const doc = await extract({ sections: [[para(table(1, 1, [{ row: 0, col: 0, paras: [para(['밖 ', inner])] }]))]] });
    expect(doc.units[0]).toContain('밖 안1 / 안2');
  });

  it('중첩이 깊이 상한(16)을 넘어도 던지지 않고 텍스트를 남긴다', async () => {
    let t = table(1, 1, [cell(0, 0, '가장 안쪽')]);
    for (let i = 0; i < 20; i++) t = table(1, 1, [{ row: 0, col: 0, paras: [para(t)] }]);
    expect((await extract({ sections: [[para(t)]] })).units.join('')).toContain('가장 안쪽');
  });
});

describe('글상자 · 수식 · 제목', () => {
  it('글상자 텍스트는 호스트 문단 뒤 블록이 된다', async () => {
    const doc = await extract({ sections: [[para(['본문', textBox([para('상자 안 제목')])]), para('다음 문단')]] });
    expect(doc.units[0]).toBe('본문\n\n상자 안 제목\n\n다음 문단');
  });

  it('수식은 [수식: 스크립트] — 앞뒤 글자와 한 칸 띄운다', async () => {
    const doc = await extract({ sections: [[para(['값은', equation('{a} over {b}'), '이다'])]] });
    expect(doc.units[0]).toBe('값은 [수식: {a} over {b}] 이다');
  });

  it('개요 문단 모양을 쓰는 문단은 제목(수준 동반)이다', async () => {
    const doc = await extract({
      paraShapes: [{ head: 0, level: 0 }, { head: 1, level: 0 }, { head: 1, level: 1 }],
      sections: [[para('Ⅰ. 서비스 명세', { shape: 1 }), para('본문'), para('가. 개요', { shape: 2 }), para('본문2')]],
    });
    expect(doc.headings).toEqual([{ level: 1, title: 'Ⅰ. 서비스 명세', unitIndex: 0 }, { level: 2, title: '가. 개요', unitIndex: 0 }]);
  });
});

describe('그림', () => {
  const bin = (id: number, over: Partial<{ type: number; compress: 0 | 1 | 2 }> = {}) => ({ id, ext: 'jpg', bytes: new Uint8Array(64).fill(id), ...over });

  it('BinData 를 풀어 Vision 대상으로 — 본문·표 안·글상자 안·그룹 안 모두, 단위 매핑 유지', async () => {
    FIT.mockClear();
    const doc = await extract({
      bins: [bin(1), bin(2), bin(3), bin(4)],
      sections: [[
        para(['첫 쪽', picture(1)]),
        para(['둘째 쪽', table(1, 1, [{ row: 0, col: 0, paras: [para(['칸', picture(2)])] }])], { breakType: 0x04 }),
        para(['셋째 쪽', textBox([para(['상자', picture(3)])])], { breakType: 0x04 }),
        para(['넷째 쪽', groupedPicture(5, 4)], { breakType: 0x04 }),
      ]],
    }, { extractImages: true });
    expect(doc.images.map((i) => [i.base64, i.unitIndex])).toEqual([['b1', 0], ['b2', 1], ['b3', 2], ['b4', 3]]);
  });

  it('깨진 그림은 그 그림만 건너뛴다 · 무압축(2) 그림은 그대로 · 링크형은 무시', async () => {
    const doc = await extract({
      bins: [bin(1, { compress: 2 }), bin(2), bin(3, { type: 0 })],
      override: { 'BinData/BIN0002.jpg': new Uint8Array([0xff, 0xff, 0xff]) },
      sections: [[para(['a', picture(1), picture(2), picture(3)])]],
    }, { extractImages: true });
    expect(doc.images.map((i) => i.base64)).toEqual(['b1']);
  });

  it('extractImages=false 면 그림을 풀지도 않는다', async () => {
    FIT.mockClear();
    const doc = await extract({ bins: [bin(1)], sections: [[para(['a', picture(1)])]] });
    expect(doc.images).toEqual([]);
    expect(FIT).not.toHaveBeenCalled();
  });
});

describe('거절 · 손상 · 상한', () => {
  it.each<[string, Partial<HwpSpec>, string]>([
    ['암호(bit1)', { flags: 0x03 }, 'DOC_ENCRYPTED'],
    ['DRM(bit4)', { flags: 0x11 }, 'DOC_ENCRYPTED'],
    ['배포용(bit2)', { flags: 0x05 }, 'DOC_DISTRIBUTION'],
    ['배포용 + 암호 — 배포용 안내가 먼저', { flags: 0x07 }, 'DOC_DISTRIBUTION'],
    ['주 버전 3', { version: 0x03000000 }, 'DOC_UNSUPPORTED'],
    ['본문이 ViewText/ 에만 있음', { bodyDir: 'ViewText' }, 'DOC_DISTRIBUTION'],
    ['본문 구역 없음', { omit: ['BodyText/Section0'] }, 'DOC_CORRUPT'],
    ['DocInfo 없음', { omit: ['DocInfo'] }, 'DOC_CORRUPT'],
  ])('%s → %s', async (_name, over, code) => {
    expect(await failCode(extract({ sections: [[para('본문')]], ...over }))).toBe(code);
  });

  it('구역 하나가 깨지면 일부만 내지 않고 문서 전체가 DOC_CORRUPT (압축 · 무압축)', async () => {
    const broken = { 'BodyText/Section1': new Uint8Array([1, 2, 3]) };
    expect(await failCode(extract({ sections: [[para('정상')], [para('x')]], override: broken }))).toBe('DOC_CORRUPT');
    expect(await failCode(extract({ flags: 0, sections: [[para('정상')], [para('x')]], override: broken }))).toBe('DOC_CORRUPT');
  });

  it('압축 해제 누적이 상한을 넘으면 DOC_TOO_LARGE — 구역마다가 아니라 합계로 센다', async () => {
    const big = 'ㄱ'.repeat(30_000); // 구역당 ~60KB(UTF-16)
    const small = () => createHwpExtractor({ fitImage: FIT, maxInflateBytes: 100_000 });
    expect(await failCode(small().extract(indexOf({ sections: [[para(big)], [para(big)]] }), { extractImages: false }))).toBe('DOC_TOO_LARGE');
    await expect(small().extract(indexOf({ sections: [[para(big)]] }), { extractImages: false })).resolves.toBeDefined();
  });
});

describe('취소 · 진행률', () => {
  it('이미 취소된 신호면 바로 ABORTED', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await failCode(x.extract(indexOf({ sections: [[para('a')]] }), { signal: ac.signal }))).toBe('ABORTED');
  });

  it('구역마다 취소를 확인한다 — 둘째 구역 시작에서 멈춘다', async () => {
    const ac = new AbortController();
    const onProgress = vi.fn((cur: number) => { if (cur === 1) ac.abort(); });
    const spec = { sections: [[para('a')], [para('b')], [para('c')]] };
    expect(await failCode(x.extract(indexOf(spec), { extractImages: false, signal: ac.signal, onProgress }))).toBe('ABORTED');
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });

  it('진행률은 구역 단위 n / total 이고 끝에 total / total', async () => {
    const onProgress = vi.fn();
    await x.extract(indexOf({ sections: [[para('a')], [para('b')]] }), { extractImages: false, onProgress });
    expect(onProgress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/lib/extract/__tests__/hwp.test.ts`
Expected: FAIL — Cannot find module '../hwp'

- [ ] **Step 3: `document-formats.ts` — id·container 유니온과 `HWP_FORMAT_ID` (배열은 그대로)**

```ts
export interface DocumentFormat {
  id: 'pdf' | 'docx' | 'pptx' | 'hwpx' | 'hwp';
  /** 소문자, 점 포함 */
  ext: string;
  /** 다이얼로그에 보일 이름 */
  label: string;
  /** 컨테이너 — zip(OOXML·HWPX) · cfb(HWP 5.x) · 고유 매직(PDF) */
  container: 'zip' | 'pdf' | 'cfb';
}
```

`HWPX_FORMAT_ID` 아래에 추가:

```ts
/** hwp(바이너리) 추출기(`extract/hwp.ts`)의 판별 값. 위 DOCX_FORMAT_ID 주석 참조 — 리터럴은 이 한 곳뿐. */
export const HWP_FORMAT_ID = 'hwp' as const satisfies DocumentFormat['id'];
```

- [ ] **Step 4: `document-open.ts` 표 두 개 + `i18n.ts` 문구**

`EXTRACTOR_ERROR_MESSAGE_KEYS` 에 추가하고 41~45행 주석의 DOC_ENCRYPTED 설명을 갱신한다:

```ts
  // DOC_ENCRYPTED 는 컨테이너를 연 뒤에야 알 수 있는 자리들이 던진다 — HWPX(META-INF/manifest.xml
  // encryption-data) · HWP(FileHeader 암호·DRM 플래그) · HWP 가 아닌 CFB(암호 걸린 OOXML, openContainerDocument).
  DOC_UNSUPPORTED: 'doc.unsupported',
  DOC_ENCRYPTED: 'doc.encrypted',
  // 배포용 HWP — 공공 자료에 흔하다. "손상"·"암호" 로 안내하면 원인을 알 수 없다(설계 H3).
  DOC_DISTRIBUTION: 'doc.distribution',
```

`EXTRACTOR_UNIT_KIND` 에 `hwp: 'page',` 를 추가한다.

`i18n.ts` 의 `'doc.encrypted'` 줄 다음에:

```ts
  'doc.distribution': {
    ko: '배포용 문서는 내용이 암호화돼 있어 열 수 없습니다. 한글에서 일반 문서로 저장한 뒤 다시 시도해주세요.',
    en: 'Distribution-only HWP documents are encrypted and cannot be opened. Save it as a regular document in Hancom Office and try again.',
  },
```

- [ ] **Step 5: 구현 — `src/renderer/lib/extract/hwp.ts`**

```ts
/**
 * 한글 바이너리(.hwp, HWP 5.x) 추출기 — 설계 docs/02-design/features/hwp-binary.design.md.
 *
 * 컨테이너는 CFB(cfb.ts), 그 안의 스트림은 레코드 열(hwp-records.ts)이다. 문단·표·글상자·그림·수식을 읽는
 * 규칙은 hwpx.ts 와 **같게** 맞춘다(확장자에 따라 품질이 갈리면 안 된다 — 설계 H1): 표는 좌표 격자 → GFM,
 * 셀 안 표는 평탄화, 글상자는 호스트 문단 뒤 블록, 수식은 `[수식: …]`, 머리말·각주·숨은 설명은 제외.
 */
import { paginate, type Block } from './paginate';
import { toGfmTable, placeGridCells, gridExtent, type GridCell } from './table';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import type { ContainerIndex, Extractor, ExtractedDoc, ExtractedHeading, ExtractOptions } from './types';
import { HWP_FORMAT_ID, SUPPORTED_LABEL } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';
import { collectImages, throwIfAborted, yieldToEventLoop } from './common';
import { MAX_UNZIPPED_BYTES } from './zip';
import {
  TAG, parseRecords, buildTree, inflateBudgeted, readParaText, ctrlIdAt, readUtf16, u16, u32,
  type HwpRecord, type InflateBudget,
} from './hwp-records';
import { readDocInfo, type BinDataEntry } from './hwp-docinfo';
import { readTable, followingParagraphs } from './hwp-table';

const SIGNATURE = 'HWP Document File';
const FLAG_COMPRESSED = 0x01;
const FLAG_PASSWORD = 0x02;
const FLAG_DISTRIBUTION = 0x04;
const FLAG_DRM = 0x10;
/** PARA_HEADER @11 나눔 종류 — bit0 구역 나눔 · bit2 쪽 나눔(실물 확인, 설계 §0). bit1 다단 · bit3 단은 쪽이 아니다. */
const BREAK_BEFORE_MASK = 0x01 | 0x04;
const SECTION_STREAM = /^BodyText\/Section(\d+)$/;
/** 표·글상자 중첩 상한 — hwpx.ts MAX_NEST_DEPTH 와 같은 값(형제 비대칭 방지) */
const MAX_NEST_DEPTH = 16;
/** 도형 그룹 중첩 상한 — pptx 그룹 깊이 상한과 같은 값 */
const MAX_SHAPE_DEPTH = 32;
const YIELD_EVERY = 200;
/** SHAPE_COMPONENT_PICTURE 의 BinItem id 위치(테두리 12 + 좌표 32 + 자르기 16 + 여백 8 + 밝기·대비·효과 3) */
const PICTURE_BIN_ID_OFFSET = 71;
/** 본문 내용을 담는 컨트롤 — 나머지(구역·단 정의, 머리말·꼬리말, 각주·미주, 숨은 설명, 필드…)는 본문이 아니다. */
const CONTENT_CTRLS = new Set(['tbl ', 'gso ', 'eqed']);

type TableText = (ctrl: HwpRecord, depth: number) => string;

function hasSignature(header: Uint8Array | null): header is Uint8Array {
  if (!header || header.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (header[i] !== SIGNATURE.charCodeAt(i)) return false;
  return true;
}

/** 수식 → `[수식: <한글 수식 스크립트>]`. LaTeX 로 옮기지 않는다(hwpx.ts equationText 와 같은 이유). */
function equationText(ctrl: HwpRecord): string {
  const eq = ctrl.children.find((c) => c.tag === TAG.EQEDIT);
  if (!eq || eq.data.length < 6) return '';
  const s = readUtf16(eq.data, 6, u16(eq.data, 4)).replace(/\s+/g, ' ').trim();
  return s ? `[수식: ${s}]` : '';
}

function pictureBinId(pic: HwpRecord): number {
  return pic.data.length >= PICTURE_BIN_ID_OFFSET + 2 ? u16(pic.data, PICTURE_BIN_ID_OFFSET) : 0;
}

/** 서브트리의 그림 BinItem id 전부(문서 순서). 표를 만나면 셀 안 그림을 한 번에 모은다(hwpx 의 raw walk 와 같은 규칙). */
function picturesIn(node: HwpRecord): number[] {
  const out: number[] = [];
  const visit = (n: HwpRecord) => {
    for (const c of n.children) {
      if (c.tag === TAG.SHAPE_COMPONENT_PICTURE) {
        const id = pictureBinId(c);
        if (id) out.push(id);
      }
      visit(c);
    }
  };
  visit(node);
  return out;
}

/** gso 서브트리 → 글상자 밖 그림과 글상자 문단 목록. 묶음 개체는 MAX_SHAPE_DEPTH 까지 내려간다. */
function scanShape(node: HwpRecord, depth: number, out: { pics: number[]; boxes: HwpRecord[][] }): void {
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k.tag === TAG.SHAPE_COMPONENT_PICTURE) {
      const id = pictureBinId(k);
      if (id) out.pics.push(id);
    } else if (k.tag === TAG.LIST_HEADER) {
      out.boxes.push(followingParagraphs(kids, i + 1));
    } else if (k.tag !== TAG.PARA_HEADER && depth < MAX_SHAPE_DEPTH) {
      scanShape(k, depth + 1, out);
    }
  }
}

/** 문단 하나를 읽은 결과 — hwpx.ts ParaOut 과 같은 모양(그림은 BinItem id). */
interface ParaOut {
  parts: string[];
  boxes: HwpRecord[][];
  pics: { binId: number; part: number }[];
}

function readParagraph(para: HwpRecord, depth: number, tableText: TableText): ParaOut {
  const out: ParaOut = { parts: [], boxes: [], pics: [] };
  let buf = '';
  // 수식 뒤 글자가 공백 없이 붙어 있으면 한 칸 띄운다(hwpx 와 같다).
  let padNext = false;
  const flush = () => { if (buf.trim()) out.parts.push(buf); buf = ''; padNext = false; };
  const append = (s: string) => {
    if (!s) return;
    if (padNext && !/^\s/.test(s)) buf += ' ';
    padNext = false;
    buf += s;
  };
  const ctrls = para.children.filter((c) => c.tag === TAG.CTRL_HEADER);
  const used = new Set<HwpRecord>();
  const handle = (ctrl: HwpRecord) => {
    used.add(ctrl);
    switch (ctrlIdAt(ctrl.data, 0)) {
      case 'tbl ': {
        flush();
        for (const binId of picturesIn(ctrl)) out.pics.push({ binId, part: out.parts.length });
        const tb = tableText(ctrl, depth + 1);
        if (tb) out.parts.push(tb);
        break;
      }
      case 'gso ': {
        const shape = { pics: [] as number[], boxes: [] as HwpRecord[][] };
        scanShape(ctrl, 0, shape);
        for (const binId of shape.pics) out.pics.push({ binId, part: out.parts.length });
        out.boxes.push(...shape.boxes);
        break;
      }
      case 'eqed': {
        const m = equationText(ctrl);
        if (m) {
          if (buf && !/\s$/.test(buf)) buf += ' ';
          buf += m;
          padNext = true;
        }
        break;
      }
      // 그 밖의 컨트롤은 본문이 아니다. 필드의 **표시 텍스트**는 컨트롤 밖 PARA_TEXT 에 있어 잃지 않는다.
    }
  };
  const text = para.children.find((c) => c.tag === TAG.PARA_TEXT);
  for (const seg of text ? readParaText(text.data) : []) {
    if (seg.kind === 'text') { append(seg.text); continue; }
    // 확장 컨트롤 문자와 CTRL_HEADER 는 순서대로 짝을 이룬다(실물 확인). id 로 다음 미사용 것을 고른다.
    const ctrl = ctrls.find((c) => !used.has(c) && ctrlIdAt(c.data, 0) === seg.id);
    if (ctrl) handle(ctrl);
  }
  // 본문에 자리표시가 없던 컨트롤(비표준 작성기)도 잃지 않는다 — 문단 끝에서 처리한다.
  for (const ctrl of ctrls) if (!used.has(ctrl)) handle(ctrl);
  flush();
  return out;
}

/** 깊이 상한을 넘은 서브트리 — 구조 없이 텍스트·수식·그림만 모은다(잃지 않는다, hwpx plainTextWithPics 와 같은 규칙). */
function plainTextWithPics(nodes: HwpRecord[]): { text: string; pics: number[] } {
  let text = '';
  const pics: number[] = [];
  const visit = (n: HwpRecord) => {
    if (n.tag === TAG.PARA_TEXT) {
      for (const seg of readParaText(n.data)) if (seg.kind === 'text') text += seg.text;
      text += '\n';
    } else if (n.tag === TAG.SHAPE_COMPONENT_PICTURE) {
      const id = pictureBinId(n);
      if (id) pics.push(id);
    } else if (n.tag === TAG.CTRL_HEADER) {
      const id = ctrlIdAt(n.data, 0);
      if (!CONTENT_CTRLS.has(id)) return; // 머리말·각주 등은 폴백에서도 제외
      if (id === 'eqed') { const m = equationText(n); if (m) text += ` ${m} `; }
    }
    for (const c of n.children) visit(c);
  };
  nodes.forEach(visit);
  return { text: text.trim(), pics };
}

/** 셀·글상자 문단들 → 한 덩어리 텍스트(문단은 줄바꿈) + 그 안의 그림(hwpx containerText 와 같은 규칙). */
function containerText(paras: HwpRecord[], depth: number, tableText: TableText): { text: string; pics: number[] } {
  if (depth > MAX_NEST_DEPTH) return plainTextWithPics(paras);
  const lines: string[] = [];
  const pics: number[] = [];
  for (const para of paras) {
    const r = readParagraph(para, depth, tableText);
    lines.push(...r.parts);
    pics.push(...r.pics.map((p) => p.binId));
    for (const box of r.boxes) {
      const nested = containerText(box, depth + 1, tableText);
      lines.push(nested.text);
      pics.push(...nested.pics);
    }
  }
  return { text: lines.join('\n'), pics };
}

/** 표 → 직사각형 행렬. 선언 행·열 수는 참고만 하고 셀 주소로 놓는다(gridExtent — R18, QA35 행 축 무상한). */
function tableGrid(ctrl: HwpRecord, depth: number): string[][] {
  const t = readTable(ctrl);
  // 셀 안 그림은 readParagraph 의 'tbl ' 분기(picturesIn)가 이미 실었다 — 여기서는 텍스트만 쓴다.
  const cells: GridCell[] = t.cells.map((c) => ({
    row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
    text: containerText(c.paras, depth, flattenTableText).text,
  }));
  return placeGridCells(cells, gridExtent(cells, 'row', t.rows), gridExtent(cells, 'col', t.cols));
}

function flattenTableText(ctrl: HwpRecord, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return plainTextWithPics([ctrl]).text;
  return tableGrid(ctrl, depth)
    .map((row) => row.map((c) => c.replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some((c) => c !== ''))
    .map((row) => row.join(' / '))
    .join('; ');
}

/** 최상위(본문·글상자)의 표 → GFM 표. */
function gridTableText(ctrl: HwpRecord, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return flattenTableText(ctrl, depth);
  return toGfmTable(tableGrid(ctrl, depth));
}

/** 본문 구역 스트림 — 번호순(사전순이면 Section10 이 Section2 앞에 온다). */
function sectionStreams(index: ContainerIndex): string[] {
  return index.names()
    .filter((n) => SECTION_STREAM.test(n))
    .sort((a, b) => Number(SECTION_STREAM.exec(a)![1]) - Number(SECTION_STREAM.exec(b)![1]));
}

export interface HwpExtractorDeps {
  fitImage?: ImageFitter;
  /** 압축 해제 누적 상한 — 테스트 전용 오버라이드(zip.ts maxUnzippedBytes 와 같은 관례). 기본 MAX_UNZIPPED_BYTES. */
  maxInflateBytes?: number;
}

export function createHwpExtractor(deps: HwpExtractorDeps = {}): Extractor {
  const fit = deps.fitImage ?? fitImage;
  return {
    id: HWP_FORMAT_ID,

    sniff: (index) => hasSignature(index.bytes('FileHeader')),

    extract: async (index: ContainerIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      const header = index.bytes('FileHeader');
      if (!hasSignature(header) || header.length < 40) extractFail('DOC_CORRUPT', 'FileHeader missing');
      const major = u32(header, 32) >>> 24;
      const flags = u32(header, 36);
      if (major !== 5) extractFail('DOC_UNSUPPORTED', `hwp major version ${major}`, { list: SUPPORTED_LABEL });
      if (flags & FLAG_DISTRIBUTION) extractFail('DOC_DISTRIBUTION', 'distribution document');
      if (flags & (FLAG_PASSWORD | FLAG_DRM)) extractFail('DOC_ENCRYPTED', 'password or drm protected hwp');

      const compressed = (flags & FLAG_COMPRESSED) !== 0;
      // 문서 하나의 모든 스트림(DocInfo·구역·그림)이 한 예산을 나눠 쓴다 — 스트림별 상한이 아니다(설계 §3.2).
      const budget: InflateBudget = { remaining: deps.maxInflateBytes ?? MAX_UNZIPPED_BYTES };
      const decode = (raw: Uint8Array): Uint8Array => (compressed ? inflateBudgeted(raw, budget) : raw);

      const docInfoRaw = index.bytes('DocInfo') ?? extractFail('DOC_CORRUPT', 'DocInfo missing');
      const docInfo = readDocInfo(parseRecords(decode(docInfoRaw)));

      const sections = sectionStreams(index);
      if (sections.length === 0) {
        // 배포용 문서는 본문을 ViewText/ 에 암호화해 둔다 — 플래그가 빠진 파일도 같은 안내로 간다.
        if (index.names().some((n) => n.startsWith('ViewText/'))) extractFail('DOC_DISTRIBUTION', 'viewtext only');
        extractFail('DOC_CORRUPT', 'no body section');
      }

      const blocks: Block[] = [];
      const headingAt: { level: number; title: string; blockIndex: number }[] = [];
      const imageAt: { binId: number; blockIndex: number }[] = [];
      let processed = 0;

      for (const [si, path] of sections.entries()) {
        // 구역마다 취소를 본다 — QA35 에서 HWPX 가 취소를 놓친 형제 비대칭을 반복하지 않는다.
        throwIfAborted(opts.signal);
        opts.onProgress?.(si, sections.length);
        await yieldToEventLoop();
        throwIfAborted(opts.signal);
        const raw = index.bytes(path) ?? extractFail('DOC_CORRUPT', `${path} missing`);
        // 구역 하나라도 깨지면 여기서 던진다 — 일부만 조용히 빠진 문서를 내지 않는다(설계 H4).
        const paras = buildTree(parseRecords(decode(raw))).filter((r) => r.tag === TAG.PARA_HEADER);
        let firstInSection = si > 0;
        for (const para of paras) {
          processed += 1;
          if (processed % YIELD_EVERY === 0) {
            await yieldToEventLoop();
            throwIfAborted(opts.signal);
          }
          const r = readParagraph(para, 0, gridTableText);
          const breakBefore = firstInSection || ((para.data[11] ?? 0) & BREAK_BEFORE_MASK) !== 0;
          firstInSection = false;
          const level = para.data.length >= 10 ? docInfo.outlineLevels.get(u16(para.data, 8)) : undefined;
          // 빈 문단도 쪽 나눔은 전한다(paginate 가 빈 breakBefore 블록을 flush 로 처리한다).
          if (r.parts.length === 0 && breakBefore) blocks.push({ text: '', breakBefore: true });
          const firstBlock = blocks.length;
          for (const [i, text] of r.parts.entries()) {
            if (i === 0 && level !== undefined && text.trim()) headingAt.push({ level, title: text.trim().split('\n')[0]!, blockIndex: blocks.length });
            blocks.push({ text, breakBefore: i === 0 && breakBefore });
          }
          for (const pic of r.pics) {
            const blockIndex = r.parts.length === 0 ? Math.max(0, blocks.length - 1) : firstBlock + Math.min(pic.part, r.parts.length - 1);
            imageAt.push({ binId: pic.binId, blockIndex });
          }
          // 글상자는 떠 있는 개체 — 쪽 나눔·제목을 만들지 않는다.
          for (const box of r.boxes) {
            const boxResult = containerText(box, 1, gridTableText);
            let boxBlockIndex: number;
            if (boxResult.text.trim()) {
              boxBlockIndex = blocks.length;
              blocks.push({ text: boxResult.text, breakBefore: false });
            } else {
              boxBlockIndex = Math.max(0, blocks.length - 1);
            }
            for (const binId of boxResult.pics) imageAt.push({ binId, blockIndex: boxBlockIndex });
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

      if (opts.extractImages === false || imageAt.length === 0) {
        return { units, images: [], headings, unitKind: 'page' };
      }
      // CFB 이름은 대소문자를 가리지 않는다 — DocInfo 의 확장자 표기와 스트림 이름이 다를 수 있다.
      const streamByLower = new Map(index.names().map((n) => [n.toLowerCase(), n] as const));
      const inflateOf = new Map<string, boolean>();
      const candidates = imageAt.map(({ binId, blockIndex }) => {
        const entry: BinDataEntry | null = docInfo.binData[binId - 1] ?? null;
        const path = entry ? streamByLower.get(entry.stream.toLowerCase()) : undefined;
        if (entry && path) inflateOf.set(path, entry.compress === 'yes' || (entry.compress === 'doc' && compressed));
        return { path, unitIndex: unitOfBlock[blockIndex] ?? 0 };
      });
      const imageSource: ContainerIndex = {
        names: () => index.names(),
        has: (name) => index.has(name),
        text: () => null,
        bytes: (name) => {
          const raw = index.bytes(name);
          if (!raw || !inflateOf.get(name)) return raw;
          try {
            return inflateBudgeted(raw, budget);
          } catch (err) {
            if ((err as { code?: unknown }).code === 'DOC_TOO_LARGE') throw err;
            return null; // 그림 하나가 깨졌으면 그 그림만 건너뛴다(설계 H4)
          }
        },
      };
      const { images, imageBudgetExceeded } = await collectImages(candidates, imageSource, fit, opts.signal);
      return { units, images, headings, unitKind: 'page', ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}) };
    },
  };
}

export const hwpExtractor: Extractor = createHwpExtractor();
```

- [ ] **Step 6: 통과 확인 (전체 스위트 — 번역 전수 가드 포함)**

Run: `npx vitest run src/renderer/lib/extract src/renderer/lib/__tests__/document-open.test.ts` 그리고 `npx tsc --noEmit`
Expected: PASS(`extractFail 로 던지는 모든 코드는 EXTRACTOR_ERROR_MESSAGE_KEYS 에 매핑이 있다` 포함), 타입 오류 0

- [ ] **Step 7: Commit**

```bash
git add src/renderer/lib/extract/hwp.ts src/renderer/lib/extract/__tests__/hwp.test.ts src/shared/document-formats.ts src/renderer/lib/document-open.ts src/renderer/lib/i18n.ts
git commit -m "feat(extract): HWP 5.x 추출기 — 본문·표·글상자·그림·수식·개요 제목·쪽 나눔

hwpx 와 같은 규칙(좌표 격자 GFM·셀 안 표 평탄화·글상자 블록·[수식: …]). 배포용 DOC_DISTRIBUTION 신설,
암호·DRM DOC_ENCRYPTED, 구역 하나 손상 시 문서 전체 DOC_CORRUPT, 압축 해제는 문서 합계 300MB.
진입 게이트 등록은 다음 커밋.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 배선 — 포맷 등록 · 레지스트리 · document-open CFB 분기 · HWP 3.x 안내

**Files:**
- Modify: `src/shared/document-formats.ts:21-26` (배열 등록) · 끝에 `hasHwp3Magic`
- Modify: `src/renderer/lib/extract/registry.ts`
- Modify: `src/renderer/lib/document-open.ts:8, 87-100, 121-169, 280-300, 347` 부근
- Modify: `src/renderer/App.tsx:339-346`
- Test: `src/shared/__tests__/document-formats.test.ts`, `src/main/__tests__/file-gates.test.ts`, `src/renderer/lib/extract/__tests__/registry.test.ts`, `src/renderer/lib/__tests__/document-open.test.ts`, `src/renderer/__tests__/App.drop.test.tsx`

**Interfaces:**
- Consumes: `openCfb`(Task 2) · `hwpExtractor`(Task 5)
- Produces: `CFB_EXTRACTORS` · `resolveExtractor(index: ContainerIndex, container?: 'zip' | 'cfb'): Extractor | null` · `hasHwp3Magic(head: Uint8Array): boolean`

- [ ] **Step 1: 기존 단언 뒤집기 + 새 실패 테스트**

`document-formats.test.ts`:
- 9~12행: 제목을 `'지원 목록은 pdf · docx · pptx · hwpx · hwp 다'` 로, 기대값을 `['pdf', 'docx', 'pptx', 'hwpx', 'hwp']` · `['.pdf', '.docx', '.pptx', '.hwpx', '.hwp']` 로.
- 36행: `['pdf', 'docx', 'pptx', 'hwpx', 'hwp']`.
- 69행: `'PDF, Word, PowerPoint, HWPX, HWP'`.
- import 에 `hasHwp3Magic` 추가하고 describe 안에 추가:

```ts
  // .hwp 를 받기 시작하면 HWP 3.x 이하(CFB 가 아니라 자체 서명) 파일이 "손상" 안내로 떨어진다 — 미지원으로 가른다.
  it('HWP 3.x 서명은 파일 맨 앞 "HWP Document File V" 다 (5.x 는 CFB 안의 FileHeader 라 여기 걸리지 않는다)', () => {
    const enc = new TextEncoder();
    expect(hasHwp3Magic(enc.encode('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05'))).toBe(true);
    expect(hasHwp3Magic(enc.encode('HWP Document File\0\0\0'))).toBe(false);
    expect(hasHwp3Magic(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(false);
    expect(hasHwp3Magic(enc.encode('HWP Doc'))).toBe(false);
  });
  it('.hwpx 와 .hwp 는 서로의 확장자 검사에 걸리지 않는다 (접미 관계)', () => {
    expect(isSupportedExtension('C:/x/a.hwp')).toBe(true);
    expect(stripSupportedExtension('보고서.hwpx')).toBe('보고서');
    expect(stripSupportedExtension('보고서.hwp')).toBe('보고서');
  });
```

`file-gates.test.ts`:
- 35행 다음에:

```ts
  // v1.12.0: HWP 5.x 바이너리가 열린다(hwpExtractor 등록).
  it('HWP 가 통과한다', () => {
    expect(isSupportedExtension('C:/x/공문.hwp')).toBe(true);
  });
```
- 38행 목록을 `['a.epub']` 로.

`registry.test.ts` 끝 describe 안에 추가(import: `openCfb` from `'../cfb'`, `resolveExtractor, CFB_EXTRACTORS` from `'../registry'`, `hwpExtractor` from `'../hwp'`, `HWP_FORMAT_ID` 추가, 작성기 두 개):

```ts
  it('CFB 에서는 CFB 추출기(hwp)만 고른다 — zip 추출기는 후보가 아니고, 반대도 같다', () => {
    const idx = openCfb(toArrayBuffer(buildHwp({ sections: [[para('a')]] }).bytes));
    expect(resolveExtractor(idx, 'cfb')?.id).toBe(HWP_FORMAT_ID);
    expect(resolveExtractor(idx, 'zip')).toBeNull();
  });

  it('HWP 서명이 없는 CFB 는 null — 호출자가 암호 OOXML 안내로 간다', () => {
    const idx = openCfb(toArrayBuffer(buildCfb({ EncryptionInfo: new Uint8Array(200), EncryptedPackage: new Uint8Array(5000) }).bytes));
    expect(resolveExtractor(idx, 'cfb')).toBeNull();
  });

  it('CFB_EXTRACTORS 에는 hwpExtractor 가 등록돼 있다', () => {
    expect(CFB_EXTRACTORS).toContain(hwpExtractor);
  });
```

작성기 import 경로: `'../../../../../test/fixtures/hwp-builder'`(`buildHwp, para, toArrayBuffer`), `'../../../../../test/fixtures/cfb-builder'`(`buildCfb`).

`document-open.test.ts` — 491~495행 테스트를 아래 셋으로 **교체**하고, 같은 describe 에 HWP 셋을 추가한다(import: `t` from `'../i18n'`, `SUPPORTED_LABEL` from `'../../../shared/document-formats'` 가 없으면 추가, 작성기는 `'../../../../test/fixtures/...'`):

```ts
  it('CFB 인데 HWP 가 아니면(암호 걸린 OOXML) 종전대로 DOC_ENCRYPTED + 암호 안내다', async () => {
    const cfb = buildCfb({ EncryptionInfo: new Uint8Array(200), EncryptedPackage: new Uint8Array(5000) }).bytes;
    await openDocumentData(toArrayBuffer(cfb), 'locked.docx', '/d/locked.docx');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_ENCRYPTED');
    expect(s.error?.message).toBe(t('doc.encrypted'));
  });

  it('CFB 매직만 있고 구조가 깨졌으면 DOC_CORRUPT 다 (손상 zip 과 같은 취급)', async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await openDocumentData(cfb.buffer, 'locked.docx', '/d/locked.docx');
    expect(useAppStore.getState().error?.code).toBe('DOC_CORRUPT');
  });

  it('HWP 성공 경로 — CFB 를 열어 추출 → toPdfDocument, unitKind page, pdfBytes 비상주', async () => {
    const hwp = buildHwp({ sections: [[para('첫째 쪽'), para('둘째 쪽', { breakType: 0x04 })]] }).bytes;
    await openDocumentData(toArrayBuffer(hwp), '보고서.hwp', '보고서.hwp');
    const s = useAppStore.getState();
    expect(s.error).toBeNull();
    expect(s.document?.unitKind).toBe('page');
    expect(s.document?.pageTexts).toEqual(['첫째 쪽', '둘째 쪽']);
    expect(s.pdfBytes).toBeNull();
    expect(P.getDocument).not.toHaveBeenCalled();
  });

  it('배포용 HWP 는 DOC_DISTRIBUTION + 전용 안내다', async () => {
    const hwp = buildHwp({ flags: 0x05, sections: [[para('비밀')]] }).bytes;
    await openDocumentData(toArrayBuffer(hwp), '공문.hwp', '/d/공문.hwp');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_DISTRIBUTION');
    expect(s.error?.message).toBe(t('doc.distribution'));
  });

  it('HWP 3.x(자체 서명)는 손상이 아니라 미지원 안내다', async () => {
    const old = new TextEncoder().encode(`HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05${' '.repeat(200)}`);
    await openDocumentData(toArrayBuffer(old), 'old.hwp', '/d/old.hwp');
    const s = useAppStore.getState();
    expect(s.error?.code).toBe('DOC_UNSUPPORTED');
    expect(s.error?.message).toBe(t('doc.unsupported', { list: SUPPORTED_LABEL }));
  });
```

`App.drop.test.tsx` — 114행 테스트 다음에:

```ts
  // v1.12.0: HWP 3.x 이하는 CFB 가 아니라 자체 서명이다. 선검사가 쓰레기로 거부하면 document-open 의
  // DOC_UNSUPPORTED("지원하지 않는 형식") 안내에 닿지 못한다.
  it('HWP 3.x 서명(.hwp)은 선검사를 통과해 document-open 의 미지원 안내로 간다', async () => {
    await drop(fileWith('old.hwp', [...new TextEncoder().encode('HWP Document File V3.00')]));
    await settle();
    expect(useAppStore.getState().error).toBeNull();
    expect(openDocumentData).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/shared/__tests__/document-formats.test.ts src/main/__tests__/file-gates.test.ts src/renderer/lib/extract/__tests__/registry.test.ts src/renderer/lib/__tests__/document-open.test.ts src/renderer/__tests__/App.drop.test.tsx`
Expected: FAIL — 목록·필터 기대값 불일치, `hasHwp3Magic`/`CFB_EXTRACTORS` 미정의, HWP 성공 경로가 DOC_ENCRYPTED, HWP 3.x 드롭이 거부됨

- [ ] **Step 3: `document-formats.ts`**

배열에 등록:

```ts
  { id: 'hwpx', ext: '.hwpx', label: 'HWPX', container: 'zip' },
  { id: 'hwp', ext: '.hwp', label: 'HWP', container: 'cfb' },
] as const;
```

파일 끝에 추가:

```ts
/**
 * HWP 3.x 이하(.hwp) 서명 `HWP Document File V…` — 파일 맨 앞의 평문이다. HWP 5.x 는 CFB 컨테이너라
 * 이 서명이 컨테이너 안 FileHeader 스트림에 있고(뒤에 " V" 가 없다) 여기 걸리지 않는다. `.hwp` 를 받기 시작하면
 * 옛 파일이 "손상" 안내로 떨어지므로 선검사가 이것으로 미지원 안내를 가른다.
 */
export function hasHwp3Magic(head: Uint8Array): boolean {
  const sig = 'HWP Document File V';
  if (head.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (head[i] !== sig.charCodeAt(i)) return false;
  return true;
}
```

- [ ] **Step 4: `registry.ts`**

```ts
import { docxExtractor } from './docx';
import { pptxExtractor } from './pptx';
import { hwpxExtractor } from './hwpx';
import { hwpExtractor } from './hwp';
import type { ContainerIndex, Extractor } from './types';

/**
 * 컨테이너별 포맷 판별.
 *
 * zip 포맷은 매직만으로는 구분되지 않아 엔트리 목록으로 sniff 한다 — 확장자는 힌트일 뿐 신뢰하지 않는다.
 * CFB 는 HWP 5.x 와 암호 걸린 OOXML 이 같은 컨테이너다 — HWP 추출기가 고르지 않으면 호출자가 암호 안내로 간다.
 */
export const ZIP_EXTRACTORS: readonly Extractor[] = [docxExtractor, pptxExtractor, hwpxExtractor];
export const CFB_EXTRACTORS: readonly Extractor[] = [hwpExtractor];

export function resolveExtractor(index: ContainerIndex, container: 'zip' | 'cfb' = 'zip'): Extractor | null {
  return (container === 'cfb' ? CFB_EXTRACTORS : ZIP_EXTRACTORS).find((e) => e.sniff(index)) ?? null;
}
```

- [ ] **Step 5: `document-open.ts`**

8행 import 에 `hasHwp3Magic` 추가.

`loadExtractChain` 에 CFB 리더를 넣는다(9~12행 주석의 "extract/zip = fflate…" 목록에 `extract/cfb` 를 덧붙인다):

```ts
async function loadExtractChain() {
  const [zip, cfb, registry, normalize, errors] = await Promise.all([
    import('./extract/zip'),
    import('./extract/cfb'),
    import('./extract/registry'),
    import('./extract/normalize'),
    import('./extract/errors'),
  ]);
  return {
    openZip: zip.openZip,
    openCfb: cfb.openCfb,
    resolveExtractor: registry.resolveExtractor,
    toPdfDocument: normalize.toPdfDocument,
    extractFail: errors.extractFail,
  };
}
```

`openZipDocument` 를 `openContainerDocument` 로 이름을 바꾸고(121~169행, 주석 첫 줄 "비-PDF(zip · CFB 컨테이너) 문서 열기: 컨테이너 열기 → 포맷 판별 → 추출 → PdfDocument 정규화."), 140~147행을 바꾼다:

```ts
    // 이미지 분석이 꺼져 있으면 zip 의 그림 파트는 풀지 않는다(QA34). CFB 는 bytes() 를 부를 때만 읽으므로
    // 거를 것이 없다 — 추출기가 extractImages=false 면 그림 스트림을 아예 읽지 않는다.
    const isCfb = hasCfbMagic(new Uint8Array(data, 0, Math.min(data.byteLength, 8)));
    const index = isCfb
      ? chain.openCfb(data)
      : chain.openZip(data, opts.extractImages ? undefined : { filter: isNotMediaPart });
    throwIfAborted(opts.signal);
    extractor = chain.resolveExtractor(index, isCfb ? 'cfb' : 'zip');
    if (!extractor) {
      // HWP 가 아닌 CFB 는 암호 걸린 OOXML 이다(MS-OFFCRYPTO 는 zip 을 CFB 로 감싼다) — v1.11.0 까지와 같은 안내.
      return isCfb
        ? chain.extractFail('DOC_ENCRYPTED', 'compound file without hwp header')
        : chain.extractFail('DOC_UNSUPPORTED', 'no extractor matched', { list: SUPPORTED_LABEL });
    }
    const extracted = await extractor.extract(index, {
```

`openDocumentData` 의 선검사(280~300행)를 바꾼다:

```ts
  if (!isPdf) {
    // HWP 3.x 이하는 CFB 가 아니라 자체 서명이다 — 손상으로 안내하면 원인을 모른다(설계 §1.2).
    if (hasHwp3Magic(head)) {
      store.setError({ code: 'DOC_UNSUPPORTED', message: t('doc.unsupported', { list: SUPPORTED_LABEL }) } as AppError);
      return;
    }
    // .hwp(HWP 5.x)와 암호 걸린 OOXML 은 둘 다 CFB 컨테이너다 — 어느 쪽인지는 컨테이너를 열어야 알 수 있어
    // try 안의 openContainerDocument 가 가른다(v1.11.0 까지는 여기서 곧장 DOC_ENCRYPTED 였다).
    // 부수효과: CFB 거절도 진행 중 파싱을 abort-replace 한다 — 손상 zip 과 같다(QA34).
    if (!hasZipMagic(head) && !hasCfbMagic(head)) {
      // (기존 주석 유지)
      store.setError({ code: 'DOC_CORRUPT', message: t('doc.corrupt') } as AppError);
      return;
    }
    // (기존 QA34(Low) 주석 유지 — "zip 해제" 를 "컨테이너 열기" 로)
  }
```

347행 부근 호출부의 `openZipDocument(` 를 `openContainerDocument(` 로.

- [ ] **Step 6: `App.tsx` 선검사(339~346행)**

```ts
        // HWP 3.x 서명("HWP Document File V…" 19바이트)까지 보려고 32바이트를 읽는다.
        const headerBuf = await file.slice(0, 32).arrayBuffer();
        const header = new Uint8Array(headerBuf);
        // Task9/10: 매직바이트 판정도 document-formats.ts 단일 출처를 쓴다. HWP 3.x 는 document-open 의
        // 미지원 안내(DOC_UNSUPPORTED)로 보내려고 통과시킨다 — 여기서 거부하면 "PDF·… 만 지원" 으로 뭉개진다.
        // ⚠️ App.drop.test.tsx 가 이 조건의 갈래를 실제 DOM 드롭으로 걷는다(E2E 는 IPC 주입이라 못 본다).
        if (!hasPdfMagic(header) && !hasZipMagic(header) && !hasCfbMagic(header) && !hasHwp3Magic(header)) {
```

25행 import 에 `hasHwp3Magic` 추가. 330~334행 주석의 "8바이트를 읽어" 문장을 "32바이트를 읽는다(HWP 3.x 서명 19바이트까지)" 로 고친다.

- [ ] **Step 7: 통과 확인 + 전체 스위트**

Run: `npx vitest run` 그리고 `npx tsc --noEmit`
Expected: 전부 PASS, 테스트 수 > 3118, 타입 오류 0

- [ ] **Step 8: Commit**

```bash
git add src/shared/document-formats.ts src/renderer/lib/extract/registry.ts src/renderer/lib/document-open.ts src/renderer/App.tsx src/shared/__tests__/document-formats.test.ts src/main/__tests__/file-gates.test.ts src/renderer/lib/extract/__tests__/registry.test.ts src/renderer/lib/__tests__/document-open.test.ts src/renderer/__tests__/App.drop.test.tsx
git commit -m "feat: .hwp(HWP 5.x) 열기 개통 — 포맷 등록 · CFB 분기 · HWP 3.x 미지원 안내

CFB 판정을 try 안으로 옮겨 HWP 면 추출, 아니면 종전 DOC_ENCRYPTED. CFB 구조 손상은 DOC_CORRUPT.
HWP 3.x 이하(자체 서명)는 손상이 아니라 미지원으로 안내한다(document-open · App 드롭 선검사).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 실앱 E2E

**Files:**
- Create: `e2e/fixtures/make-hwp.ts`
- Modify: `e2e/office-open.spec.ts` (import + 테스트 하나)

**Interfaces:**
- Consumes: `buildHwp`, `para`, `table`, `cell`, `textBox`(test/fixtures/hwp-builder) · `seedSessionWithCitation`, `openCitation`(spec 내부)

- [ ] **Step 1: 픽스처 — `e2e/fixtures/make-hwp.ts`**

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildHwp, para, table, cell, textBox } from '../../test/fixtures/hwp-builder';

/**
 * 합성 .hwp 픽스처 — make-hwpx.ts 와 같은 문서 모양(쪽 나눔 · 세로 병합으로 가려진 칸 · 글상자 · 잘린 PrvText)을
 * HWP 5.x 바이너리로. 실물은 저장소에 넣지 않는다(설계 §4.4).
 */
export function writeSampleHwp(path: string): void {
  const t = table(2, 3, [cell(0, 0, '분류', { rowSpan: 2 }), cell(0, 1, '항목'), cell(0, 2, '달성률'), cell(1, 1, '기능 개발'), cell(1, 2, '100%')]);
  const layout = buildHwp({
    sections: [[
      para('첫 쪽의 내용입니다'),
      para(['둘째 쪽의 내용입니다', textBox([para('상자 안 제목')])], { breakType: 0x04 }),
      para(t),
    ]],
    prvText: '첫 쪽의 내',
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, layout.bytes);
}

/** 배포용 문서(FileHeader bit2) — 전용 안내 배너 확인용 */
export function writeDistributionHwp(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildHwp({ flags: 0x05, sections: [[para('배포용 본문')]] }).bytes);
}
```

- [ ] **Step 2: 테스트 — `office-open.spec.ts` 끝에 추가 (import 에 `writeSampleHwp, writeDistributionHwp`)**

```ts
test('HWP — 바이너리 쪽나눔·좌표 격자 표·글상자, 배포용 안내', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwp-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwp-docs-'));
  try {
    const fixture = join(docsDir, 'sample.hwp');
    writeSampleHwp(fixture);
    const entry = await seedSessionWithCitation(userDataDir, docsDir, fixture, 'sample.hwp (2p)');
    expect(entry.unitKind, 'manifest 가 unitKind 를 싣는다').toBe('page');

    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      // 배포용 문서 — 문서가 열리기 전에 떨궈 discard 확인 없이 배너만 본다.
      const dist = join(docsDir, 'dist.hwp');
      writeDistributionHwp(dist);
      await sendDropPath(r2.app, dist, readFileSync(dist).toString('base64'));
      await expect(r2.page.getByText('배포용 문서는 내용이 암호화돼 있어 열 수 없습니다', { exact: false })).toBeVisible({ timeout: 30000 });

      await sendDropPath(r2.app, fixture, readFileSync(fixture).toString('base64'));
      await expect(r2.page.getByText('sample.hwp (2p)')).toBeVisible({ timeout: 60000 });

      const viewer = await openCitation(r2.page, /2 페이지 원문 열기$/);
      await expect(r2.page.locator('#unit-2')).toContainText('상자 안 제목');
      const row = r2.page.locator('#unit-2 table tbody tr').first().locator('td');
      await expect(row).toHaveText(['분류', '기능 개발', '100%']);
      // 1쪽 본문은 1쪽에만 있다(미리보기 PrvText 는 추출 대상이 아니다 — 본문과 겹치는 문자열이라 단위로 확인).
      await expect(r2.page.locator('#unit-2')).not.toContainText('첫 쪽의 내용입니다');
      await expect(viewer).toContainText('첫 쪽의 내용입니다');

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

- [ ] **Step 3: 타입 검사 + E2E 실행**

Run: `npx tsc --noEmit -p tsconfig.e2e.json` 그리고 `npm run test:e2e -- e2e/office-open.spec.ts`
Expected: 타입 오류 0, 3개 테스트 PASS(PPTX · HWPX · HWP)

실패하면: `sample.hwp (2p)` 헤더가 안 보이면 렌더러 에러 배너 문구를 스크린샷/trace 로 확인한다(`npx playwright show-trace`). 진입 게이트가 `.hwp` 를 막으면 Task 6 등록 누락이다.

- [ ] **Step 4: 전체 E2E (회귀)**

Run: `npm run test:e2e`
Expected: 종전 19 통과/2 skip 에 HWP 1개가 더해진 20/2(로컬 기준 — userdata-migration 은 로컬에서 실행될 수 있다)

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/make-hwp.ts e2e/office-open.spec.ts
git commit -m "test(e2e): HWP 바이너리 열기 — 쪽 나눔·병합 표·글상자 · 배포용 안내 배너

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 실물 대조 · 뮤테이션 · 게이트 · 문서

**Files:**
- Create(커밋 금지): `src/renderer/lib/extract/__tests__/hwp-real.local.test.ts`
- Modify: `CLAUDE.md` (입력 포맷 줄)

- [ ] **Step 1: 실물 대조 파일이 커밋되지 않게 막는다**

Run: `Add-Content -Path .git/info/exclude -Value 'src/renderer/lib/extract/__tests__/hwp-real.local.test.ts'`

- [ ] **Step 2: 실물 대조 테스트 작성 — `PrvText` 를 정답지로**

```ts
// 로컬 전용(커밋 금지 — .git/info/exclude). 실물 .hwp 를 HWP_REAL_DIR 에서 읽어 한글이 저장한 미리보기와 대조한다.
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openCfb } from '../cfb';
import { createHwpExtractor } from '../hwp';

const DIR = process.env.HWP_REAL_DIR ?? '';
const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
const fit = async () => ({ base64: 'x', width: 100, height: 100, mimeType: 'image/jpeg' as const });

describe.skipIf(!DIR)('실물 .hwp — PrvText 대조', () => {
  for (const f of DIR ? readdirSync(DIR).filter((n) => /\.hwp$/i.test(n)) : []) {
    it(f, async () => {
      const b = readFileSync(join(DIR, f));
      const index = openCfb(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      const doc = await createHwpExtractor({ fitImage: fit }).extract(index, { extractImages: true });
      const prv = new TextDecoder('utf-16le').decode(index.bytes('PrvText')!);
      const ours = norm(doc.units.join(''));
      const head = norm(prv).slice(0, 300);
      const tables = (doc.units.join('\n').match(/^\| ---/gm) ?? []).length;
      console.log(f, { units: doc.units.length, images: doc.images.length, tables, headings: doc.headings.length, prvMatched: ours.includes(head) });
      expect(ours.includes(head)).toBe(true);
    });
  }
});
```

- [ ] **Step 3: 실행 — 다운로드 폴더의 `.hwp` 4개**

Run (PowerShell): `$env:HWP_REAL_DIR = "$env:USERPROFILE\Downloads"; npx vitest run src/renderer/lib/extract/__tests__/hwp-real.local.test.ts`
Expected: 4개 PASS. 로그 기대값(2026-10-06 조사): 기술문서 3개 — `images: 1`, `tables` 5~11, 단위 수 ≥ 쪽 나눔 문단 수(6~7)+1 근처. 취업계 서식 — `images: 0`.
불일치 시: `prvMatched=false` 면 앞 300자에서 어긋난 지점을 출력해(`ours.slice(0, 400)` vs `head`) 원인을 찾는다 — 셀 순서·글상자 위치·PUA 가 후보. **실물을 우리 출력에 맞춰 해석하지 말 것.** 바탕화면 `업무` 폴더 파일은 실행하지 않는다.

- [ ] **Step 4: 대조 파일 삭제 + 깨끗한지 확인**

Run: `Remove-Item src/renderer/lib/extract/__tests__/hwp-real.local.test.ts; git status --short`
Expected: 이 파일이 목록에 없다

- [ ] **Step 5: 뮤테이션 라운드 (배선 보호 확인)**

Task 7 커밋 뒤 깨끗한 트리에서, 아래를 **하나씩** 적용 → 표시된 테스트 실행 → **빨강 확인** → `git restore <파일>`. 초록이면 그 자리를 지키는 테스트를 추가하고 커밋한다.

| # | 파일 | 변경 | 빨개져야 할 테스트 |
|---|---|---|---|
| M1 | document-open.ts | `isCfb ? 'cfb' : 'zip'` → `'zip'` | document-open.test "HWP 성공 경로" |
| M2 | document-open.ts | `isCfb ? DOC_ENCRYPTED : …` 를 항상 `DOC_UNSUPPORTED` | "CFB 인데 HWP 가 아니면" |
| M3 | document-open.ts | `hasHwp3Magic(head)` 분기 삭제 | "HWP 3.x(자체 서명)" |
| M4 | App.tsx | `&& !hasHwp3Magic(header)` 삭제 | App.drop "HWP 3.x 서명" |
| M5 | hwp.ts | `FLAG_DISTRIBUTION` 검사 삭제 | hwp.test "배포용(bit2)" |
| M6 | hwp.ts | `FLAG_DRM` 를 마스크에서 뺌 | hwp.test "DRM(bit4)" |
| M7 | hwp.ts | `para.data[11]` → `para.data[12]` | hwp.test "다단 나눔·글자 모양 수" |
| M8 | hwp-records.ts | `i += 8` → `i += 1` | hwp-records "확장 컨트롤은 8 wchar" |
| M9 | hwp-records.ts | `stripPua(buf)` → `buf` | "PUA … 지운다" |
| M10 | hwp-records.ts | `budget.remaining -= …` 줄 삭제 | "예산은 호출 사이에 누적" · "압축 폭탄" |
| M11 | hwp.ts | 구역 루프의 첫 `throwIfAborted` 와 yield 뒤 `throwIfAborted` 삭제 | "구역마다 취소를 확인한다" |
| M12 | hwp.ts | `gridExtent(cells, 'row', t.rows)` → `t.rows` | "선언 행 수가 모자라도" |
| M13 | hwp-table.ts | 열 @8 ↔ 행 @10 맞바꿈 | hwp-table "셀 주소·병합" · hwp.test 표 GFM |
| M14 | cfb.ts | `walkChain` 의 `seen.has(s)` 삭제 | cfb "FAT 순환" 이 시간 초과가 아니라 실패로 끝나는지(테스트 타임아웃 5s) |
| M15 | cfb.ts | 트리 순회의 `visited.has(idx)` 삭제 | cfb "디렉터리 형제 링크 순환" |
| M16 | hwp.ts | `imageSource.bytes` 의 catch 가 `throw err` | hwp.test "깨진 그림은 그 그림만" |
| M17 | registry.ts | `CFB_EXTRACTORS` 를 빈 배열 | registry "CFB 에서는 CFB 추출기만" · document-open HWP 성공 |

Run 예: `npx vitest run src/renderer/lib/__tests__/document-open.test.ts -t "HWP 성공 경로"`

- [ ] **Step 6: 전체 게이트**

Run:
```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.e2e.json
npm run test:coverage
npm run build
```
Expected: 타입 오류 0 · 커버리지 게이트 통과(coverage-drift 포함) · 빌드 성공. 테스트 수가 3118 보다 많은지 출력에서 확인한다.
번들 확인: `out/renderer/assets` 에서 `cfb`/`hwp` 코드가 진입 청크(index-*.js)가 아니라 동적 청크에 있는지 — `Select-String -Path out/renderer/assets/index-*.js -Pattern 'HWP Document File' -List` 결과가 없어야 한다.

- [ ] **Step 7: dev 앱에서 실물을 눈으로 확인 (사용자 확인 요청)**

`npm run dev` 로 띄우고 다운로드 폴더 실물 `.hwp` 하나를 끌어다 놓아, 사용자에게 다음을 확인받는다: 헤더의 쪽 수 · 원문 뷰어의 표 모양(칸 병합) · 이미지 분석을 켰을 때 그림 1장 분석 · 진행률 표시. 색·배치처럼 테스트가 못 보는 것을 보는 단계다(메모 `project_copy_toast_v130`).

- [ ] **Step 8: `CLAUDE.md` 입력 포맷 줄 갱신 + 커밋**

`**입력 포맷**: PDF · DOCX(v1.8.0~) · PPTX · 한글(HWPX)(v1.9.0~).` 를
`**입력 포맷**: PDF · DOCX(v1.8.0~) · PPTX · 한글(HWPX)(v1.9.0~) · 한글 바이너리(HWP 5.x)(v1.12.0~).` 로 바꾸고, 설계 링크 괄호에 `docs/02-design/features/hwp-binary.design.md` 를 덧붙인다.

```bash
git add CLAUDE.md
git commit -m "docs: 입력 포맷에 HWP 5.x 바이너리 추가

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: 알려진 한계 기록**

설계 §5 의 "합성 입력으로만 검증" 목록을 실제 결과로 갱신한다(수식 실물을 받았으면 그 결과, 못 받았으면 그대로). 출시는 사용자 요청 시 CLAUDE.md Release Procedure 를 따른다(**v1.12.0, minor**). README 는 배치 라운드에서.
