import { describe, it, expect } from 'vitest';
import { collectImages, throwIfAborted, type ImageCandidate } from '../common';
import type { ImageFitter } from '../image-fit';
import type { ZipIndex } from '../types';

/** 경로 → 바이트만 아는 가짜 zip. 바이트 내용은 경로를 담아 fit 이 어느 그림인지 알게 한다. */
function fakeZip(paths: Iterable<string>): ZipIndex {
  const set = new Set(paths);
  return {
    names: () => [...set],
    has: (n) => set.has(n),
    text: () => null,
    bytes: (n) => (set.has(n) ? new TextEncoder().encode(n) : null),
  };
}

/** 받은 바이트(=경로)를 base64 자리에 되돌려, 어느 그림이 채택됐는지 단언할 수 있게 한다. */
function countingFit(accept = true): { fit: ImageFitter; calls: () => number } {
  let n = 0;
  const fit: ImageFitter = async (bytes) => {
    n += 1;
    if (!accept) return null;
    return { base64: new TextDecoder().decode(bytes), width: 100, height: 100, mimeType: 'image/png' };
  };
  return { fit, calls: () => n };
}

const unique = (n: number): ImageCandidate[] => Array.from({ length: n }, (_, i) => ({ path: `m/${i}.png`, unitIndex: i }));

describe('collectImages — 예산', () => {
  it('같은 경로의 중복 참조는 검사 예산을 쓰지 않는다 — 401번 재사용된 로고 뒤의 고유 그림도 채택', async () => {
    const candidates: ImageCandidate[] = [
      ...Array.from({ length: 401 }, (_, i) => ({ path: 'm/logo.png', unitIndex: i })),
      { path: 'm/unique.png', unitIndex: 401 },
    ];
    const { fit } = countingFit();
    const out = await collectImages(candidates, fakeZip(['m/logo.png', 'm/unique.png']), fit);
    expect(out.images.map((i) => [i.base64, i.unitIndex])).toEqual([['m/logo.png', 0], ['m/unique.png', 401]]);
    expect(out.imageBudgetExceeded).toBe(false);
  });

  it('고유 경로 401개 → 400개만 검사하고 예산 초과 표식을 세운다', async () => {
    const c = unique(401);
    const { fit, calls } = countingFit(false);
    const out = await collectImages(c, fakeZip(c.map((x) => x.path!)), fit);
    expect(calls()).toBe(400);
    expect(out.imageBudgetExceeded).toBe(true);
  });

  it('고유 경로 정확히 400개면 예산 초과가 아니다', async () => {
    const c = unique(400);
    const { fit, calls } = countingFit(false);
    const out = await collectImages(c, fakeZip(c.map((x) => x.path!)), fit);
    expect(calls()).toBe(400);
    expect(out.imageBudgetExceeded).toBe(false);
  });

  it('고유 그림 51개 → 50개 채택 + 표식', async () => {
    const c = unique(51);
    const { fit } = countingFit();
    const out = await collectImages(c, fakeZip(c.map((x) => x.path!)), fit);
    expect(out.images).toHaveLength(50);
    expect(out.imageBudgetExceeded).toBe(true);
  });

  it('경로 없음·바이트 없음·fit null 은 건너뛴다', async () => {
    const c: ImageCandidate[] = [
      { path: null, unitIndex: 0 }, { path: undefined, unitIndex: 0 }, { path: 'm/missing.png', unitIndex: 1 },
      { path: 'm/ok.png', unitIndex: 2 },
    ];
    const { fit } = countingFit();
    const out = await collectImages(c, fakeZip(['m/ok.png']), fit);
    expect(out.images.map((i) => i.unitIndex)).toEqual([2]);
    const rejected = await collectImages(c, fakeZip(['m/ok.png']), countingFit(false).fit);
    expect(rejected.images).toEqual([]);
    expect(rejected.imageBudgetExceeded).toBe(false);
  });

  it('취소된 signal 이면 ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(collectImages(unique(1), fakeZip(['m/0.png']), countingFit().fit, ctrl.signal))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(() => throwIfAborted(ctrl.signal)).toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});
