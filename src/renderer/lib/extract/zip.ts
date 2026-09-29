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

/**
 * 엔트리 수 상한 — 수십만 개의 빈 엔트리로 메모리를 밀어내는 형태를 막는다.
 *
 * R15: 2000 이던 때는 정상적인 ~400장 PPTX 덱(슬라이드마다 slideN.xml · 그 rels · 빈 노트
 * notesSlideN.xml · 그 rels 로 ≈4 엔트리)을 "너무 크다"는 엉뚱한 사유로 거절했다. 상한을 단위
 * 상한(MAX_PAGE_COUNT 500)에서 도출한다: 500장 × 슬라이드당 파트 ~6(슬라이드·노트·차트/다이어그램
 * 파트와 각 rels) ≈ 3000 + 미디어·레이아웃·마스터·테마 수천 → 10000. 메모리 방어의 본체는 여전히
 * 해제 총량 상한(MAX_UNZIPPED_BYTES 300MB)이고, 이 상한은 엔트리 목록 순회 비용만 묶는다.
 */
export const MAX_ZIP_ENTRIES = 10_000;

export interface OpenZipOptions {
  /**
   * 해제 누적 바이트 상한 — 테스트 전용 오버라이드. 기본값은 `MAX_UNZIPPED_BYTES`.
   * 프로덕션 호출부(document-open.ts)는 이 옵션을 넘기지 않으므로 항상 기본값을 쓴다.
   */
  maxUnzippedBytes?: number;
  /**
   * 엔트리 이름 필터 — false 를 돌려준 엔트리는 **풀지 않는다**(inflate 자체를 건너뛴다).
   * 거부된 엔트리는 ZipIndex 에서 없는 것으로 보이고(has=false, bytes/text=null, names 에서 빠짐)
   * 해제 총량에도 들어가지 않는다. 쓰지도 않을 파트(예: 이미지 분석이 꺼졌을 때의
   * word/media/**) 때문에 메모리를 쓰거나 DOC_TOO_LARGE 로 거절되지 않게 하려는 것이다.
   * 엔트리 수 상한은 거부 여부와 무관하게 전체 엔트리에 건다 — 목록을 훑는 비용은 똑같이 든다.
   */
  filter?: (name: string) => boolean;
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
        // 디렉터리 엔트리와 호출자가 거부한 엔트리는 풀지 않는다 — 풀지 않을 것은 총량에도
        // 넣지 않는다(총량 상한은 "실제로 풀리는 바이트"에 대한 방어다).
        if (file.name.endsWith('/')) return false;
        if (opts.filter && !opts.filter(file.name)) return false;
        total += file.originalSize;
        if (total > maxUnzippedBytes) extractFail('DOC_TOO_LARGE', 'unzipped size exceeded');
        return true;
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
