// @vitest-environment happy-dom

// expandToRgba 순수 분류·확장 분기 가드 (post-v0.24.4 QA #2).
//
// imageDataToBase64 의 RGBA/RGB/grayscale 분류 + 확장 루프는 순수 typed-array 연산이지만
// canvas(OffscreenCanvas/putImageData) 경로에 묶여 happy-dom 으로 못 돌렸다. 해당 로직을
// expandToRgba 로 추출(행위 보존)해 길이 기반 포맷 추정·픽셀 확장·비지원 거부를 직접 검증한다.
// pdf-parser 모듈 import 가 pdfjs/worker/use-session 를 끌어오므로 handle.test 와 동일하게 목 격리.

import { describe, it, expect, vi } from 'vitest';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), OPS: { paintImageXObject: 85 } }));
vi.mock('../use-session', () => ({ restoreSessionForDocument: vi.fn(), persistCurrentSession: vi.fn() }));

import { expandToRgba, detectChapters, imageSignature } from '../pdf-parser';
import { useAppStore } from '../store';

describe('expandToRgba — 포맷 추정 + RGBA 확장', () => {
  it('RGBA(px*4): 그대로 복사', () => {
    // 2x1 = 2px, RGBA 8바이트
    const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80]);
    const out = expandToRgba(2, 1, data);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('RGBA 초과 길이: px*4 로 절단 복사', () => {
    // 1px RGBA(4) + 꼬리 2바이트 → 앞 4바이트만
    const data = new Uint8ClampedArray([1, 2, 3, 4, 99, 99]);
    const out = expandToRgba(1, 1, data);
    expect(Array.from(out!)).toEqual([1, 2, 3, 4]);
  });

  it('RGB(px*3): 각 픽셀 알파 255 부여', () => {
    // 2px RGB 6바이트
    const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60]);
    const out = expandToRgba(2, 1, data);
    expect(Array.from(out!)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('grayscale(px): R=G=B=v + 알파 255', () => {
    // 2px grayscale 2바이트
    const data = new Uint8ClampedArray([120, 200]);
    const out = expandToRgba(2, 1, data);
    expect(Array.from(out!)).toEqual([120, 120, 120, 255, 200, 200, 200, 255]);
  });

  it('1바이트/픽셀 미만: 비지원 → null', () => {
    // 4px(2x2) 인데 데이터 3바이트 → grayscale 임계(px=4) 미달
    const data = new Uint8ClampedArray([1, 2, 3]);
    expect(expandToRgba(2, 2, data)).toBeNull();
  });

  it('경계: 길이 == px → grayscale 분류', () => {
    const data = new Uint8ClampedArray([7, 8, 9, 10]); // 4px exactly
    const out = expandToRgba(2, 2, data);
    expect(out!.length).toBe(16);
    expect([out![0], out![1], out![2], out![3]]).toEqual([7, 7, 7, 255]);
  });

  it('경계: 길이 == px*3 → RGB 분류 (grayscale 보다 우선)', () => {
    // 2px*3 = 6 → RGB (grayscale 임계 2 도 넘지만 RGB 가 우선)
    const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6]);
    const out = expandToRgba(2, 1, data);
    expect(Array.from(out!)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('경계: 길이 == px*4 → RGBA 분류 (RGB 보다 우선)', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4]); // 1px*4
    const out = expandToRgba(1, 1, data);
    expect(Array.from(out!)).toEqual([1, 2, 3, 4]);
  });

  it('Uint8ClampedArray 클램핑: 255 초과 입력은 255 로 (alpha 채움도 동일 타입)', () => {
    // grayscale 경로에서 출력 컨테이너가 Uint8ClampedArray 인지 확인
    const data = new Uint8ClampedArray([300]); // 1px, 클램프되어 255 저장
    const out = expandToRgba(1, 1, data);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(Array.from(out!)).toEqual([255, 255, 255, 255]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA22(B-MED): 챕터 감지 — 러닝 헤더 오인 차단
//
// 국문 교재·학위논문은 "제3장 프로세스 관리" 같은 러닝 헤더를 **모든 페이지 상단**에 인쇄한다.
// 페이지의 첫 시각 줄만 보고 챕터를 승격하면 N페이지 = N챕터가 되고, summarizeByChapter 는
// 챕터당 최소 1회 LLM 을 호출하므로 300페이지 문서에서 ~30회여야 할 요약이 300회가 된다
// (로컬은 시간, 클라우드는 비용). 본문도 동일 제목 300개로 도배된다.
// ─────────────────────────────────────────────────────────────────────────────
describe('detectChapters — 러닝 헤더 (QA22)', () => {
  it('같은 제목이 매 페이지 상단에 반복되면 하나의 챕터로 흡수한다', () => {
    const pages = Array.from({ length: 12 }, (_, i) => `제3장 프로세스 관리\n${i + 1}쪽 본문 내용입니다.`);
    const chapters = detectChapters(pages);

    expect(chapters, 'N페이지 = N챕터가 되면 안 된다').toHaveLength(1);
    expect(chapters[0]!.startPage).toBe(1);
    expect(chapters[0]!.endPage).toBe(12);
    // 흡수된 페이지 본문이 유실되지 않아야 한다(요약 입력이 줄어들면 안 됨)
    expect(chapters[0]!.text).toContain('1쪽 본문');
    expect(chapters[0]!.text).toContain('12쪽 본문');
  });

  it('번호가 실제로 진행하면 정상적으로 새 챕터를 만든다 (오탐 방지)', () => {
    const pages = [
      '제1장 서론\n서론 본문',
      '제1장 서론\n서론 이어짐',      // 러닝 헤더
      '제2장 본론\n본론 본문',
      '제2장 본론\n본론 이어짐',      // 러닝 헤더
      '제3장 결론\n결론 본문',
    ];
    const chapters = detectChapters(pages);

    expect(chapters).toHaveLength(3);
    expect(chapters.map((c) => c.startPage)).toEqual([1, 3, 5]);
    expect(chapters[1]!.title).toContain('본론');
  });

  it('번호가 되돌아가면 새 챕터로 승격하지 않는다 (헤더/푸터 혼재 방어)', () => {
    const pages = [
      '제5장 심화\n심화 본문',
      '제2장 기초\n앞 장 참조 표기가 상단에 남은 페이지', // 번호 후퇴 → 승격 금지
      '제6장 마무리\n마무리 본문',
    ];
    const chapters = detectChapters(pages);

    expect(chapters.map((c) => c.startPage)).toEqual([1, 3]);
  });

  it('영문 Chapter 러닝 헤더도 동일하게 흡수', () => {
    const pages = Array.from({ length: 6 }, (_, i) => `Chapter 2 Memory\npage ${i + 1} body text`);
    expect(detectChapters(pages)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA23(C-HIGH): 위 러닝 헤더 가드의 **역효과**. 국문 교재·학위논문의 전형 구조는
// [표지 → 목차 2~4쪽 → 본문] 인데, 목차 줄("제1장 서론 …… 3")이 페이지 첫 줄이라 챕터로
// 승격되면서 **번호를 먼저 소진**한다. 그러면 뒤따르는 실제 본문 제1·2·3장이 전부
// `notAdvancing` 으로 억제돼 **본문 챕터 경계가 통째로 사라진다**(챕터 제목이 목차 점선 줄이
// 되고 본문 전체가 마지막 목차 챕터에 뭉친다). 가드 이전에는 과다검출이었지만 경계는 맞았다.
//
// 원 회귀 넷이 러닝 헤더 4케이스만 덮고 **자기 수정의 대표 입력(목차 선행)을 안 덮은** 결과다.
// ─────────────────────────────────────────────────────────────────────────────
describe('detectChapters — 목차 선행 문서 (QA23 회귀)', () => {
  it('점선 목차가 본문 챕터 번호를 소진하지 않는다', () => {
    const pages = [
      '표지\n제목: 운영체제 개론',
      '제1장 서론 ......... 3\n제2장 프로세스 ..... 12\n제3장 메모리 ....... 40',
      '제1장 서론\n서론 본문입니다.',
      '제2장 프로세스 관리\n프로세스 본문입니다.',
      '제3장 메모리 관리\n메모리 본문입니다.',
    ];
    const chapters = detectChapters(pages);

    expect(chapters, '본문 3개 장이 각각 챕터가 돼야 한다').toHaveLength(3);
    expect(chapters.map((c) => c.startPage)).toEqual([1, 4, 5]); // 첫 챕터는 표지·목차를 흡수
    expect(chapters[0]!.title, '목차 점선 줄이 챕터 제목이 되면 안 된다').not.toContain('...');
    expect(chapters[1]!.text).toContain('프로세스 본문');
    expect(chapters[2]!.text).toContain('메모리 본문');
  });

  it('공백으로 자리를 채운 목차도 동일하게 무시한다', () => {
    const pages = [
      '제1장 서론          3\n제2장 본론          20',
      '제1장 서론\n서론 본문',
      '제2장 본론\n본론 본문',
    ];
    const chapters = detectChapters(pages);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.title).not.toMatch(/\d\s*$/); // 쪽번호로 끝나는 목차 줄이 아님
  });

  it('장과 절이 섞여도 장 번호가 절 번호에 가려지지 않는다', () => {
    // 절이 새 쪽에서 시작하는 국문 교재에서 흔한 배치. `2절` 이 num=2 를 선점하면
    // 뒤의 `제2장` 이 notAdvancing 으로 억제돼 **장 하나가 통째로 사라진다**.
    const pages = [
      '제1장 개요\n개요 본문',
      '1절 배경\n배경 본문',
      '2절 목적\n목적 본문',
      '제2장 방법\n방법 본문',
      '1절 절차\n절차 본문',
    ];
    const chapters = detectChapters(pages);

    const titles = chapters.map((c) => c.title);
    expect(titles.some((t) => t.includes('제2장')), '제2장이 소실되면 안 된다').toBe(true);
  });
});

// QA22(B-MED): 문서 내 중복 이미지 제거 — 강의자료의 반복 로고가 Vision 예산을 선점하던 결함.
describe('imageSignature — 중복 이미지 판정 (QA22)', () => {
  const img = (base64: string, w = 100, h = 100) => ({ base64, width: w, height: h, mimeType: 'image/png' as const });

  it('같은 바이트·같은 크기면 동일 시그니처 (반복 로고)', () => {
    expect(imageSignature(img('AAAABBBBCCCC'))).toBe(imageSignature(img('AAAABBBBCCCC')));
  });

  it('내용이 다르면 다른 시그니처', () => {
    expect(imageSignature(img('AAAABBBBCCCC'))).not.toBe(imageSignature(img('ZZZZYYYYXXXX')));
  });

  it('크기가 다르면 다른 시그니처 (같은 로고의 다른 해상도는 별개 이미지)', () => {
    expect(imageSignature(img('AAAA', 100, 100))).not.toBe(imageSignature(img('AAAA', 200, 200)));
  });

  it('긴 base64 는 앞·뒤 표본으로 구분한다 (중간만 다른 경우도 길이로 분리)', () => {
    const a = 'H'.repeat(64) + 'A'.repeat(500) + 'T'.repeat(64);
    const b = 'H'.repeat(64) + 'B'.repeat(400) + 'T'.repeat(64); // 길이가 달라 구분
    expect(imageSignature(img(a))).not.toBe(imageSignature(img(b)));
  });
});

// QA35: 챕터 감지 실패 시의 분할 제목("1~10 페이지")이 단위를 몰랐다 — 휴리스틱 폴백은 추출기
// 문서(normalize.ts)도 타므로 슬라이드 덱에 "페이지" 제목이 붙었다. unitKind 를 받되 기본은 page.
describe('detectChapters — 폴백 분할 제목의 단위 (QA35)', () => {
  const plain = (n: number) => Array.from({ length: n }, (_, i) => `본문 ${i + 1}`);
  const lang = (l: 'ko' | 'en') => useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: l } }));

  it('기본(PDF)은 종전 페이지 제목 그대로', () => {
    lang('ko');
    expect(detectChapters(plain(12)).map((c) => c.title)).toEqual(['1~10 페이지', '11~12 페이지']);
  });

  it("unitKind 'slide' 면 슬라이드 제목", () => {
    lang('ko');
    expect(detectChapters(plain(12), 'slide').map((c) => c.title)).toEqual(['슬라이드 1~10', '슬라이드 11~12']);
  });

  it("unitKind 'chapter' 면 장 제목, 영어도 단위를 따른다", () => {
    lang('ko');
    expect(detectChapters(plain(3), 'chapter')[0]!.title).toBe('1~3장');
    lang('en');
    expect(detectChapters(plain(3), 'slide')[0]!.title).toBe('Slides 1–3');
    expect(detectChapters(plain(3))[0]!.title).toBe('Pages 1–3');
    lang('ko');
  });
});
