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

/**
 * 문서 하나의 "읽거나 푼 바이트" 누적 예산 — 문서 하나에 객체 하나를 만들어 모든 스트림이 나눠 쓴다(스트림별 상한이
 * 아니다). 모든 스트림의 읽은 바이트에 압축 스트림의 푼 바이트를 더해 센다(zip.ts 가 항목마다 originalSize 를 세는 것과
 * 같은 취지 — 읽기 증폭은 압축 스트림에서도 생기므로 읽은 바이트도 뺀다).
 */
export interface InflateBudget {
  remaining: number;
}

/**
 * 스트림을 읽은 만큼 예산에서 뺀다. CFB 는 여러 디렉터리 항목이 한 섹터 체인을 가리킬 수 있어(체인 순환 검사는
 * 항목 하나 안에서만 본다) 같은 바이트를 몇천 번 읽는 증폭이 가능하다 — 읽을 때마다 센다.
 */
export function chargeRead(raw: Uint8Array, budget: InflateBudget): Uint8Array {
  budget.remaining -= raw.length;
  if (budget.remaining < 0) extractFail('DOC_TOO_LARGE', 'read size exceeded');
  return raw;
}

/**
 * 입력을 이 크기로 잘라 넣는다. fflate 는 push 한 번의 출력을 한 번에 내므로, 통째로 넣으면 폭탄이 다 풀린
 * 뒤에야 크기를 셀 수 있다. 16KB 입력의 최대 출력(deflate 최대 비율 ~1032:1)은 ~16.5MB 라 상한 초과분도 그만큼으로 묶인다.
 */
const INFLATE_CHUNK = 16 * 1024;

/**
 * fflate 0.8 Inflate 의 내부 상태 — `s.f` 는 마지막 블록(BFINAL) 표시, `s.l` 은 진행 중인 허프만 블록의 표.
 * 마지막 블록을 다 읽으면 `f` 는 참·`l` 은 비어 있다(esm/browser.js inflt 끝의 `st.l = lm, st.f = final`).
 */
interface InflateState { s?: { f?: number; l?: unknown } }

/** deflate 스트림이 끝났는지. 내부 상태를 못 읽으면(fflate 구조 변경) false — 그때는 끝까지 넣는 옛 동작으로 돌아간다. */
function streamEnded(inflate: Inflate): boolean {
  const st = (inflate as unknown as InflateState).s;
  return !!st && !!st.f && !st.l;
}

/**
 * 스트림 끝 뒤의 꼬리 바이트는 **버리고 푼 내용을 낸다** — 실제 작성기가 섹터 경계까지 채우는 일이 있고, 끝난 스트림
 * 뒤의 바이트는 본문에 아무것도 더하지 않는다(DOC_CORRUPT 로 문서 전체를 버릴 이유가 아니다).
 *
 * 꼬리를 계속 push 하면 안 된다: Inflate 는 끝난 뒤의 입력을 소비하지 않고 내부 버퍼에 이어 붙여 push 마다 통째로
 * 복사한다(O(n²)). 출력이 없어 예산도 걸리지 않으므로 100MB 꼬리면 렌더러 메인 스레드가 ~100초 멈춘다.
 * 끝을 "출력 0 인 push" 로 가리면 틀린다 — 저장(무압축) 블록은 블록 전체(최대 64KB)가 모일 때까지 16KB push 에
 * 출력이 0 이다. 그래서 fflate 내부 상태를 타입 캐스트로 읽는다. fflate 를 올려 구조가 바뀌면 hwp-records.test 의
 * push 횟수 단언이 깨져 알려 준다.
 */
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
    for (let i = 0; i < raw.length && !streamEnded(inflate); i += INFLATE_CHUNK) {
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
