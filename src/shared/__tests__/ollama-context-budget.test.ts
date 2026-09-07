/**
 * QA33(H1·H2): `num_ctx` 사다리와 감시견 상한이 **실제 파이프라인의 숫자**와 맞는지.
 *
 * 왜 별도 파일인가 — 기존 `ollama-context.test.ts` 는 합성 문자열("あ".repeat(n))로만 버킷을
 * 확인한다. 그래서 다음 두 가지를 구조적으로 볼 수 없었고, 둘 다 실제로 어긋나 있었다:
 *
 *  1. 기본 설정의 요약 청크가 어느 버킷에 떨어지는가 — 모듈 주석은 8192 라고 단언했지만
 *     실측은 한국어 문서에서 **16384**(최상위)였다. 최상위 버킷은 메모리(llama3.2 기준
 *     +2.00GB)와 감시견 배율(4)이 모두 최대인 상태라 기본값이어서는 안 된다.
 *  2. 렌더러 요약 감시견이 main 의 idle 상한보다 넉넉한가 — QA32 가 main 에만 배율을 곱해
 *     **백업이 원본보다 먼저 발화**하는 역전이 생겼는데, 두 값을 잇는 것은 주석뿐이었다.
 *
 * 여기서는 프롬프트·청크·상수를 전부 **실물로 가져와** 잰다. 프롬프트가 길어지거나 청크 기본값이
 * 바뀌면 이 테스트가 먼저 깨진다 — 그때 사다리를 다시 조정하라는 신호다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripJsComments } from './helpers/source-scan';

vi.mock('electron', () => ({ BrowserWindow: class { static getAllWindows(): unknown[] { return []; } } }));

import {
  CONTEXT_BUCKETS, resolveNumCtx, numCtxTimeoutScale, MAX_NUM_CTX_TIMEOUT_SCALE,
  __resetStickyNumCtxForTest,
} from '../ollama-context';
import { STREAM_IDLE_TIMEOUT_MS, RENDERER_IDLE_BACKUP_FACTOR } from '../constants';
import { buildPrompt, splitPrompt } from '../../main/ai-service';
import { chunkText } from '../../renderer/lib/chunker';
import { SUMMARY_IDLE_TIMEOUT_MS } from '../../renderer/lib/use-summarize';

/** 설정 기본값. `settings-validate` 의 기본 `maxChunkSize` 와 같아야 한다(아래 대조 테스트). */
const DEFAULT_MAX_CHUNK_SIZE = 4000;

const TOP_BUCKET = CONTEXT_BUCKETS[CONTEXT_BUCKETS.length - 1]!;

/** 40쪽 분량의 문서를 만든다 — 페이지 라벨(`[p.N]`)까지 실제 요약 경로와 같은 형태로. */
function makeDoc(paragraph: string, pages = 40): string {
  let out = '';
  for (let p = 1; p <= pages; p++) {
    for (let i = 0; i < 6; i++) out += `[p.${p}] ${paragraph}\n\n`;
  }
  return out;
}

const KO_PARAGRAPH = '이 문서는 기계학습 모델의 학습 절차와 평가 지표를 설명한다. 특히 교차 검증과 정규화의 상호작용을 다루며, 과적합을 줄이기 위한 조기 종료 조건을 실험으로 비교한다.';
const EN_PARAGRAPH = 'This document describes the training procedure and evaluation metrics of the model. It covers the interaction between cross validation and regularization, and compares early stopping criteria through experiments on several datasets.';

/** 이 문서를 기본 설정으로 요약할 때 **가장 큰 청크**가 쓰게 될 `num_ctx`. */
function numCtxForLongestChunk(docText: string, uiLang: 'ko' | 'en'): number {
  const chunks = chunkText(docText, DEFAULT_MAX_CHUNK_SIZE);
  expect(chunks.length, '문서가 한 청크로 끝나면 예산 대조가 무의미하다').toBeGreaterThan(1);
  const longest = chunks.reduce((a, b) => (a.length >= b.length ? a : b), '');
  const { system, user } = splitPrompt(buildPrompt(longest, 'full', uiLang));
  return resolveNumCtx(system, user);
}

describe('기본 워크플로의 컨텍스트 예산 (실제 프롬프트·청크로 측정)', () => {
  beforeEach(() => {
    __resetStickyNumCtxForTest();
  });

  // 문서 언어 × UI 언어 4조합 — system 지시문 길이가 UI 언어로 갈리므로 둘 다 돈다.
  const cases: Array<{ doc: 'ko' | 'en'; ui: 'ko' | 'en' }> = [
    { doc: 'ko', ui: 'ko' }, { doc: 'ko', ui: 'en' },
    { doc: 'en', ui: 'ko' }, { doc: 'en', ui: 'en' },
  ];

  it.each(cases)('기본 요약(문서=$doc, UI=$ui)이 최상위 버킷에 닿지 않는다', ({ doc, ui }) => {
    const text = makeDoc(doc === 'ko' ? KO_PARAGRAPH : EN_PARAGRAPH);
    const numCtx = numCtxForLongestChunk(text, ui);
    // 최상위는 메모리·감시견 배율이 모두 최대인 상태다. 기본 설정이 여기 앉으면 사다리가
    // 아무 일도 하지 않는 것과 같다(QA33 H2 이전이 정확히 그 상태였다 — 한국어 = 16384).
    expect(numCtx, `문서=${doc}/UI=${ui} 의 최장 청크가 최상위 버킷을 요구한다`).toBeLessThan(TOP_BUCKET);
    expect(CONTEXT_BUCKETS).toContain(numCtx);
  });

  it.each(['ko', 'en'] as const)('Q&A(UI=%s)도 최상위 버킷에 닿지 않는다', (ui) => {
    // use-qa 의 컨텍스트 예산은 8,000자다. 한국어가 토큰을 가장 많이 먹으므로 그쪽으로 잰다.
    const context = makeDoc(KO_PARAGRAPH).slice(0, 8000);
    const { system, user } = splitPrompt(buildPrompt(context, 'qa', ui));
    expect(resolveNumCtx(system, user)).toBeLessThan(TOP_BUCKET);
  });

  it('사다리에 12288 단계가 있다 — 한국어 기본 경로가 앉는 자리', () => {
    // 이 값을 빼면 위 요약 케이스(한국어)가 곧바로 최상위로 되돌아간다. 근거를 값으로 못박아
    // "왜 4단계인가" 가 주석에만 남지 않게 한다.
    expect(CONTEXT_BUCKETS).toContain(12288);
    const koNumCtx = numCtxForLongestChunk(makeDoc(KO_PARAGRAPH), 'ko');
    expect(koNumCtx).toBe(12288);
  });

  it('청크 기본값이 커지면 이 대조가 무의미해지므로 함께 못박는다', async () => {
    // settings 기본값이 바뀌면 위 측정 전제가 통째로 달라진다 — 여기서 같이 깨지게 한다.
    // 기본값은 main(index.ts)과 renderer(types/index.ts) 두 곳에 있고 별도 drift 가드가 대조하므로,
    // 여기서는 렌더러 쪽(요약 경로가 실제로 읽는 값)을 기준으로 본다.
    const { DEFAULT_SETTINGS } = await import('../../renderer/types');
    expect(DEFAULT_SETTINGS.maxChunkSize).toBe(DEFAULT_MAX_CHUNK_SIZE);
  });
});

describe('감시견 상한의 순서 (QA33 H1)', () => {
  it('렌더러 요약 감시견은 main 의 최대 idle 상한보다 넉넉하다', () => {
    // 백업이 원본보다 먼저 발화하면 백업이 아니라 새로운 실패 원인이 된다.
    const mainWorstCase = STREAM_IDLE_TIMEOUT_MS * MAX_NUM_CTX_TIMEOUT_SCALE;
    expect(SUMMARY_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(mainWorstCase);
    expect(SUMMARY_IDLE_TIMEOUT_MS).toBe(
      STREAM_IDLE_TIMEOUT_MS * RENDERER_IDLE_BACKUP_FACTOR * MAX_NUM_CTX_TIMEOUT_SCALE,
    );
  });

  it('main 의 idle 타이머가 리터럴이 아니라 shared 기준선에서 파생된다', () => {
    // 주석은 걷고 본다 — QA29: 소스 스캔 가드가 주석에 매칭돼 통과하던 클래스.
    const code = stripJsComments(readFileSync('src/main/ai-service.ts', 'utf8'));
    expect(code).toMatch(/IDLE_TIMEOUT_MS\s*=\s*Math\.round\(\s*STREAM_IDLE_TIMEOUT_MS\s*\*/);
  });

  it('렌더러 감시견도 리터럴이 아니라 파생이다', () => {
    const code = stripJsComments(readFileSync('src/renderer/lib/use-summarize.ts', 'utf8'));
    expect(code).toMatch(/export const SUMMARY_IDLE_TIMEOUT_MS\s*=\s*\n?\s*STREAM_IDLE_TIMEOUT_MS/);
    expect(code).not.toMatch(/SUMMARY_IDLE_TIMEOUT_MS\s*=\s*[0-9]/);
  });

  it('최대 배율은 최상위 버킷에서 나온다', () => {
    expect(MAX_NUM_CTX_TIMEOUT_SCALE).toBe(numCtxTimeoutScale(TOP_BUCKET));
  });
});
