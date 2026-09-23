import { unzipSync, type UnzipFileInfo } from 'fflate';
import type { ZipIndex } from './types';
import { extractFail } from './errors';

/**
 * 압축 해제 누적 바이트 상한.
 *
 * 파일 크기 캡(MAX_PDF_SIZE_BYTES, 100MB)은 zip 에서 실질 방어가 못 된다 — 100MB zip 이 수 GB 로
 * 풀릴 수 있다. fflate 의 filter 는 **해제 전에** originalSize 를 주므로 여기서 누적해 막는다.
 */
export const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;

/** 엔트리 수 상한 — 수십만 개의 빈 엔트리로 메모리를 밀어내는 형태를 막는다. */
export const MAX_ZIP_ENTRIES = 2000;

export interface OpenZipOptions {
  /**
   * 해제 누적 바이트 상한 — 테스트 전용 오버라이드. 기본값은 `MAX_UNZIPPED_BYTES`.
   * 프로덕션 호출부(document-open.ts)는 이 옵션을 넘기지 않으므로 항상 기본값을 쓴다.
   */
  maxUnzippedBytes?: number;
}

/**
 * opts.maxUnzippedBytes 미지정 시의 기본값 해석 — 순수 함수로 분리해 기본값이
 * `MAX_UNZIPPED_BYTES` 에서 조용히 drift 하지 않도록 직접 단위 테스트한다(zip.test.ts).
 * 이 분리가 없으면 기본값 회귀는 300MB 문자열을 실제로 만들어야만 잡히는 비싼 테스트가 된다.
 */
export function resolveMaxUnzippedBytes(opts: OpenZipOptions = {}): number {
  return opts.maxUnzippedBytes ?? MAX_UNZIPPED_BYTES;
}

export function openZip(data: ArrayBuffer, opts: OpenZipOptions = {}): ZipIndex {
  const maxUnzippedBytes = resolveMaxUnzippedBytes(opts);
  const bytes = new Uint8Array(data);
  let unzipped: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file: UnzipFileInfo): boolean => {
        count += 1;
        if (count > MAX_ZIP_ENTRIES) extractFail('DOC_TOO_LARGE', 'zip entry count exceeded');
        total += file.originalSize;
        if (total > maxUnzippedBytes) extractFail('DOC_TOO_LARGE', 'unzipped size exceeded');
        // 디렉터리 엔트리는 담지 않는다.
        return !file.name.endsWith('/');
      },
    });
  } catch (err) {
    // 상한 위반은 우리가 던진 것이므로 그대로 올린다. 그 외는 손상으로 본다.
    if ((err as { code?: string }).code === 'DOC_TOO_LARGE') throw err;
    extractFail('DOC_CORRUPT', 'not a readable zip archive');
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
