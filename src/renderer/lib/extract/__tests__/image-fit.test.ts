// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripJsComments } from '../../../../shared/__tests__/helpers/source-scan';
import {
  probeImage,
  downscaleTarget,
  createImageFitter,
  canvasCodec,
  MIN_IMAGE_SIZE,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  JPEG_QUALITY,
  type ImageCodec,
} from '../image-fit';

/** 헤더만 있는 합성 PNG — probeImage 는 IHDR 까지만 읽는다. */
export function pngHeader(width: number, height: number, tail: number[] = []): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0,
    ...tail,
  ]);
}

/** SOI → (채움 바이트) → APP0 → SOF0 순서의 합성 JPEG 헤더. */
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc4, 0x00, 0x03, 0x00, // DHT — SOF 가 아니다(C4 를 SOF 로 읽으면 크기가 틀린다)
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
  ]);
}

function stubCodec(): ImageCodec & { reencode: ReturnType<typeof vi.fn> } {
  return {
    reencode: vi.fn(async (bytes: Uint8Array, mimeType, target) =>
      target ? { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const } : { bytes, mimeType },
    ),
  };
}

describe('probeImage', () => {
  it('PNG 의 IHDR 에서 너비·높이를 읽는다', () => {
    expect(probeImage(pngHeader(300, 200))).toEqual({ mimeType: 'image/png', width: 300, height: 200 });
  });

  it('JPEG 는 앞 세그먼트(APP0·DHT·채움 바이트)를 건너뛰고 SOF 에서 읽는다', () => {
    expect(probeImage(jpegHeader(640, 480))).toEqual({ mimeType: 'image/jpeg', width: 640, height: 480 });
  });

  it('PNG·JPEG 가 아니거나(EMF/TIFF) 헤더가 잘렸으면 null', () => {
    expect(probeImage(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x6c, 0, 0, 0]))).toBeNull(); // EMF
    expect(probeImage(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBeNull(); // TIFF
    expect(probeImage(pngHeader(300, 200).subarray(0, 20))).toBeNull();
    expect(probeImage(jpegHeader(640, 480).subarray(0, 28))).toBeNull();
  });
});

describe('downscaleTarget', () => {
  it('긴 변이 MAX_IMAGE_EDGE 이하면 null, 넘으면 비율을 지켜 줄인다', () => {
    expect(downscaleTarget(MAX_IMAGE_EDGE, 10)).toBeNull();
    expect(downscaleTarget(2048, 1000)).toEqual({ width: 1024, height: 500 });
    expect(downscaleTarget(100, 3000)).toEqual({ width: 34, height: 1024 });
  });
});

describe('createImageFitter', () => {
  it('어느 한 변이 MIN_IMAGE_SIZE 미만이면 디코드하지 않고 건너뛴다', async () => {
    const codec = stubCodec();
    const fit = createImageFitter(codec);
    expect(await fit(pngHeader(MIN_IMAGE_SIZE - 1, 500))).toBeNull();
    expect(await fit(pngHeader(500, MIN_IMAGE_SIZE - 1))).toBeNull();
    expect(codec.reencode).not.toHaveBeenCalled();
    expect(await fit(pngHeader(MIN_IMAGE_SIZE, MIN_IMAGE_SIZE))).not.toBeNull();
  });

  it('픽셀 수가 MAX_IMAGE_PIXELS 를 넘으면 디코드 전에 건너뛴다 (선언 크기 폭탄)', async () => {
    const codec = stubCodec();
    const fit = createImageFitter(codec);
    expect(await fit(pngHeader(100_000, 100_000))).toBeNull();
    expect(await fit(pngHeader(2001, 2000))).toBeNull(); // 4,002,000 > 4M
    expect(codec.reencode).not.toHaveBeenCalled();
    expect(await fit(pngHeader(2000, 2000))).not.toBeNull(); // 정확히 4M 은 통과
  });

  it('긴 변이 1024 를 넘으면 축소 크기로 재인코딩을 요청하고, 원본 크기를 적는다', async () => {
    const codec = stubCodec();
    const out = await createImageFitter(codec)(pngHeader(2000, 1000));
    expect(codec.reencode).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/png', { width: 1024, height: 512 });
    expect(out).toEqual({ base64: btoa('\x01\x02\x03'), width: 2000, height: 1000, mimeType: 'image/jpeg' });
  });

  it('작으면 원본 바이트를 그대로 base64 로 담는다', async () => {
    const bytes = pngHeader(800, 600, [9, 9, 9]);
    const codec = stubCodec();
    const out = await createImageFitter(codec)(bytes);
    expect(codec.reencode).toHaveBeenCalledWith(bytes, 'image/png', null);
    expect(out).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      width: 800,
      height: 600,
      mimeType: 'image/png',
    });
  });

  it('디코드 실패(null 또는 throw)는 그 그림만 건너뛴다', async () => {
    const nullCodec: ImageCodec = { reencode: async () => null };
    const throwCodec: ImageCodec = { reencode: async () => { throw new Error('decode'); } };
    expect(await createImageFitter(nullCodec)(pngHeader(100, 100))).toBeNull();
    expect(await createImageFitter(throwCodec)(pngHeader(100, 100))).toBeNull();
  });

  it('기본 canvasCodec 은 디코드가 없거나 실패하면 throw 없이 null 이다', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    try {
      expect(await canvasCodec.reencode(pngHeader(100, 100), 'image/png', null)).toBeNull();
      vi.stubGlobal('createImageBitmap', async () => { throw new Error('InvalidStateError'); });
      expect(await canvasCodec.reencode(pngHeader(100, 100), 'image/png', null)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('기본 canvasCodec 은 디코드에 성공하고 축소가 필요 없으면 원본 바이트를 돌려주고 비트맵을 닫는다', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close }));
    try {
      const bytes = pngHeader(100, 100);
      expect(await canvasCodec.reencode(bytes, 'image/png', null)).toEqual({ bytes, mimeType: 'image/png' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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

/** 최소 GIF 헤더: 'GIF87a'/'GIF89a' + 논리 화면 너비(6)·높이(8) uint16 LE. */
function gifHeader(width: number, height: number, version: '87a' | '89a' = '89a'): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, ...Array.from(version, (c) => c.charCodeAt(0))]);
  const v = new DataView(b.buffer);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  return b;
}

describe('GIF (Vision 분석 대상 — 첫 프레임)', () => {
  it('GIF87a·GIF89a 헤더에서 크기를 읽는다', () => {
    expect(probeImage(gifHeader(300, 200))).toEqual({ mimeType: 'image/gif', width: 300, height: 200 });
    expect(probeImage(gifHeader(640, 480, '87a'))).toEqual({ mimeType: 'image/gif', width: 640, height: 480 });
  });

  it('GIF 로 시작하지만 버전이 다르거나 헤더가 잘렸으면 null', () => {
    const bad = gifHeader(300, 200); bad[4] = 0x38; // 'GIF88a'
    expect(probeImage(bad)).toBeNull();
    expect(probeImage(gifHeader(300, 200).subarray(0, 9))).toBeNull();
  });

  it('작아서 줄일 필요가 없어도 **항상** 재인코딩한다 — 애니메이션은 첫 프레임만, 출력은 PNG/JPEG', async () => {
    const calls: unknown[] = [];
    const codec = { async reencode(_b: Uint8Array, mime: string, target: unknown) { calls.push([mime, target]); return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' as const }; } };
    const out = await createImageFitter(codec)(gifHeader(300, 200));
    expect(calls).toEqual([['image/gif', { width: 300, height: 200 }]]);
    expect(out?.mimeType).toBe('image/jpeg');
  });

  it('50px 미만 GIF(스페이서·아이콘)는 디코드 없이 건너뛴다', async () => {
    const codec = { reencode: vi.fn() };
    expect(await createImageFitter(codec)(gifHeader(1, 1))).toBeNull();
    expect(codec.reencode).not.toHaveBeenCalled();
  });

  it('기본 canvasCodec 은 GIF 를 target 없이 받으면 원본을 그대로 돌려주지 않는다', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 300, height: 200, close })));
    try {
      expect(await canvasCodec.reencode(gifHeader(300, 200), 'image/gif', null)).toBeNull();
      expect(close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// QA35(B05): 그림 바이트는 신뢰할 수 없는 zip 에서 온다. 헤더가 잘린 조각에서 probeImage 가
// RangeError 를 던지면 그림 하나 때문에 문서 열기 전체가 실패한다.
describe('probeImage — 잘린 헤더에서도 throw 하지 않는다 (QA35 B05)', () => {
  it('20바이트 "BM" 조각은 null', () => {
    const b = new Uint8Array(20); b[0] = 0x42; b[1] = 0x4d; b[14] = 40;
    expect(() => probeImage(b)).not.toThrow();
    expect(probeImage(b)).toBeNull();
  });

  it('정상 헤더(PNG·JPEG·BMP·GIF)의 모든 접두 조각에서 throw 없이 null 또는 정상 값', () => {
    for (const full of [pngHeader(300, 200), jpegHeader(640, 480), bmpHeader(300, 200), gifHeader(300, 200)]) {
      for (let n = 0; n < full.length; n++) {
        const probe = probeImage(full.subarray(0, n));
        if (probe) {
          expect(Number.isFinite(probe.width) && Number.isFinite(probe.height)).toBe(true);
        }
      }
    }
  });

  it('JPEG SOF 가 잘려 크기를 읽을 수 없으면 null(NaN 크기를 내지 않는다)', () => {
    const j = jpegHeader(640, 480);
    const sof = j.length - 10; // 0xff 0xc0 위치
    expect(probeImage(j.subarray(0, sof + 6))).toBeNull();
  });

  it('createImageFitter 는 probe 가 던져도 null 로 건너뛴다', async () => {
    const codec = stubCodec();
    const hostile = new Proxy(pngHeader(300, 200), {
      get(target, key) {
        if (key === '0') throw new Error('hostile read');
        return Reflect.get(target, key);
      },
    }) as Uint8Array;
    await expect(createImageFitter(codec)(hostile)).resolves.toBeNull();
    expect(codec.reencode).not.toHaveBeenCalled();
  });
});

describe('PDF 경로와 크기 규칙 drift', () => {
  it('pdf-parser.ts 의 같은 이름 상수와 값이 같다', () => {
    // pdf-parser.ts 는 이 상수들을 export 하지 않아 import 로 묶을 수 없다. 원문(주석 제거)에서
    // 선언을 찾아 대조한다 — 한쪽만 바뀌면 DOCX 와 PDF 가 다른 그림을 Vision 에 넘긴다.
    const src = stripJsComments(readFileSync(resolve(__dirname, '../../pdf-parser.ts'), 'utf8'));
    const valueOf = (name: string): number => {
      const m = new RegExp(`const ${name}\\s*=\\s*([\\d_]+)\\s*;`).exec(src);
      expect(m, `${name} 선언을 pdf-parser.ts 에서 찾지 못했다`).not.toBeNull();
      return Number(m![1]!.replace(/_/g, ''));
    };
    expect(valueOf('MIN_IMAGE_SIZE')).toBe(MIN_IMAGE_SIZE);
    expect(valueOf('MAX_IMAGE_EDGE')).toBe(MAX_IMAGE_EDGE);
    expect(valueOf('MAX_IMAGE_PIXELS')).toBe(MAX_IMAGE_PIXELS);
    // 재인코딩 품질은 imageDataToBase64(추출 그림) 본문 안의 것만 본다 — 같은 파일의 OCR 페이지
    // 렌더(renderPageToImage)는 다른 품질(0.85)을 쓴다.
    const fnStart = src.indexOf('async function imageDataToBase64');
    expect(fnStart).toBeGreaterThan(-1);
    const quality = /convertToBlob\(\{\s*type:\s*'image\/jpeg',\s*quality:\s*([\d.]+)\s*\}\)/.exec(src.slice(fnStart))?.[1];
    expect(quality).toBe(String(JPEG_QUALITY));
  });
});
