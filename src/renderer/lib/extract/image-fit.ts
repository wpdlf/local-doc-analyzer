/**
 * zip 포맷(DOCX 등)에 담긴 그림을 Vision 입력으로 맞춘다 — PDF 경로(pdf-parser.ts)와 같은 크기 규칙.
 *
 * QA34(Medium): DOCX 그림은 원본 바이트를 그대로 base64 로 넘기고 크기를 0×0 으로 적었다. PDF
 * 경로가 거르는 것(50px 미만 아이콘·구분선, 4M 픽셀 초과, 긴 변 1024px 초과)이 그대로 들어가
 * 수십 MB 사진이 Vision 요청 한 건이 되거나, 장식용 점 이미지가 예산(MAX_TOTAL_IMAGES)을 먹었다.
 *
 * 순서가 중요하다: **디코드 전에** 헤더에서 크기를 읽어 거른다. 디코드부터 하면 100000×100000
 * 선언 PNG 한 장이 거르기도 전에 렌더러 메모리를 다 쓴다.
 */

/**
 * pdf-parser.ts 의 같은 이름 상수와 같은 값이어야 한다. 그쪽이 export 하지 않아 import 할 수 없으므로
 * 여기 두고, image-fit.test.ts 가 pdf-parser.ts 원문과 값을 대조해 drift 를 막는다.
 */
export const MIN_IMAGE_SIZE = 50;
export const MAX_IMAGE_EDGE = 1024;
export const MAX_IMAGE_PIXELS = 4_000_000;
/** pdf-parser.ts imageDataToBase64 의 재인코딩 품질과 같다. */
export const JPEG_QUALITY = 0.8;

export type FittedMime = 'image/png' | 'image/jpeg';
/** 디코드는 되지만 Vision 으로 그대로 보낼 수 없는 원본 형식 — 항상 재인코딩한다. */
export type SourceMime = FittedMime | 'image/bmp';

export interface ImageProbe {
  mimeType: SourceMime;
  width: number;
  height: number;
}

export interface FittedImage {
  base64: string;
  /** 원본 픽셀 크기 — PDF 경로(PageImage.width/height)와 같은 의미 */
  width: number;
  height: number;
  mimeType: FittedMime;
}

/**
 * 디코드·재인코딩 담당. 주입 가능하게 분리한다 — 테스트 환경(happy-dom)의 createImageBitmap 은
 * 실제로 디코드하지 않고 OffscreenCanvas 도 없어, 기본 구현으로는 크기·재인코딩 경로를 검증할 수 없다.
 */
export interface ImageCodec {
  /**
   * 바이트가 실제로 디코드되는지 확인하고, target 이 있으면 그 크기로 줄여 재인코딩한다.
   * target 이 null 이면 원본 바이트를 그대로 돌려준다(무손실·무비용). 실패하면 null.
   */
  reencode(
    bytes: Uint8Array,
    mimeType: SourceMime,
    target: { width: number; height: number } | null,
  ): Promise<{ bytes: Uint8Array; mimeType: FittedMime } | null>;
}

export type ImageFitter = (bytes: Uint8Array) => Promise<FittedImage | null>;

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) + b[o + 1]!;
}

/** SOF 마커(프레임 헤더) — C4(DHT)·C8(JPG 예약)·CC(DAC)는 SOF 가 아니다. */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * 매직 바이트와 헤더만으로 형식·크기를 읽는다. PNG·JPEG 외(EMF/WMF/TIFF/GIF…)와 헤더가 깨진
 * 것은 null. 확장자는 믿지 않는다 — Vision API 는 선언된 mimeType 과 실제 바이트가 다르면 거절한다.
 */
export function probeImage(b: Uint8Array): ImageProbe | null {
  // PNG: 8바이트 시그니처 + 첫 청크가 IHDR(너비·높이 4바이트씩)
  if (
    b.length >= 24 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52
  ) {
    return { mimeType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  // JPEG: SOI 뒤 세그먼트를 길이로 건너뛰며 SOF 를 찾는다. SOS(스캔 시작) 이후는 엔트로피
  // 부호화 데이터라 더 보지 않는다.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1]!;
      if (marker === 0xff) { o += 1; continue; } // 채움 바이트
      if (marker === 0xd9 || marker === 0xda) return null;
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; } // 길이 없는 마커
      const len = u16be(b, o + 2);
      if (len < 2) return null;
      if (isSof(marker)) {
        if (o + 9 > b.length) return null;
        return { mimeType: 'image/jpeg', height: u16be(b, o + 5), width: u16be(b, o + 7) };
      }
      o += 2 + len;
    }
  }
  // BMP: 'BM' + BITMAPFILEHEADER(14) 뒤 BITMAPINFOHEADER 의 너비·높이(int32 LE). 높이가 음수면
  // top-down 저장이라는 뜻일 뿐 크기는 절댓값이다. OS/2 식 12바이트 헤더(BITMAPCOREHEADER)는
  // 실물에 없고 드물어 받지 않는다(헤더 크기 40 이상만).
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getUint32(14, true) < 40) return null;
    return { mimeType: 'image/bmp', width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) };
  }
  return null;
}

/** 긴 변이 MAX_IMAGE_EDGE 를 넘으면 비율을 지켜 줄인 크기, 아니면 null(그대로 둔다). */
export function downscaleTarget(width: number, height: number): { width: number; height: number } | null {
  const edge = Math.max(width, height);
  if (edge <= MAX_IMAGE_EDGE) return null;
  const scale = MAX_IMAGE_EDGE / edge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function createImageFitter(codec: ImageCodec): ImageFitter {
  return async (bytes) => {
    const probe = probeImage(bytes);
    if (!probe) return null;
    const { width, height, mimeType } = probe;
    // 아이콘·구분선·글머리표 그림 — Vision 이 읽을 내용이 없고 예산만 먹는다.
    if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) return null;
    // 디코드하면 픽셀×4 바이트가 한 번에 잡힌다(OOM 방지). 헤더 값이라 디코드 전에 거른다.
    if (width * height > MAX_IMAGE_PIXELS) return null;
    // BMP 는 줄일 필요가 없어도 제 크기로 재인코딩한다 — Vision API(Claude·OpenAI)가 받지 않는다.
    const target = downscaleTarget(width, height) ?? (mimeType === 'image/bmp' ? { width, height } : null);
    let out: Awaited<ReturnType<ImageCodec['reencode']>>;
    try {
      out = await codec.reencode(bytes, mimeType, target);
    } catch {
      out = null;
    }
    // 디코드·인코딩 실패는 그 그림만 건너뛴다 — 그림 하나 때문에 문서 열기를 실패시키지 않는다.
    if (!out || out.bytes.length === 0) return null;
    return { base64: toBase64(out.bytes), width, height, mimeType: out.mimeType };
  };
}

/** 브라우저(렌더러) 기본 구현 — createImageBitmap 으로 디코드하고 OffscreenCanvas 로 줄인다. */
export const canvasCodec: ImageCodec = {
  async reencode(bytes, mimeType, target) {
    if (typeof createImageBitmap !== 'function') return null;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mimeType }));
    } catch {
      return null;
    }
    let canvas: OffscreenCanvas | null = null;
    try {
      if (!target) return mimeType === 'image/bmp' ? null : { bytes, mimeType };
      if (typeof OffscreenCanvas === 'undefined') return null;
      canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // JPEG 에는 알파가 없다 — 투명 PNG 를 그대로 옮기면 투명 영역이 검게 나온다. 종이색으로 깐다.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      // PDF 경로(imageDataToBase64)와 같은 형식·품질로 재인코딩한다.
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/jpeg' };
    } catch {
      return null;
    } finally {
      bitmap.close();
      // GPU/backing store 즉시 반환 — pdf-parser.ts 의 finally-해제 패턴과 같다.
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  },
};

export const fitImage: ImageFitter = createImageFitter(canvasCodec);
