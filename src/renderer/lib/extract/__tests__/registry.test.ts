import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { resolveExtractor, ZIP_EXTRACTORS } from '../registry';
import { docxExtractor } from '../docx';

// Task10 리뷰 라운드1(Critical 2 / mutation 킬): resolveExtractor 자체는 어떤 테스트도 실행하지
// 않았다 — `.find(sniff)` 를 `ZIP_EXTRACTORS[0]` 로 바꾸는 뮤테이션이 살아남는다(현재 목록이
// docxExtractor 하나뿐이라 매치되는 zip 에 대해서는 결과가 우연히 같기 때문). sniff 가 거짓인
// zip 을 넣어야 두 구현이 갈린다.

function zipOf(files: Record<string, string>): ArrayBuffer {
  const input: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) input[name] = strToU8(body);
  const out = zipSync(input);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

describe('resolveExtractor', () => {
  it('word/document.xml 이 있는 zip 은 docxExtractor 를 반환한다', () => {
    const zip = openZip(zipOf({ 'word/document.xml': '<w:document/>' }));
    expect(resolveExtractor(zip)).toBe(docxExtractor);
  });

  it('아는 추출기가 sniff 하지 못하는 zip 은 null 을 반환한다 — 목록의 첫 원소를 무조건 주지 않는다', () => {
    // `ZIP_EXTRACTORS[0]` 뮤테이션이면 여기서도 docxExtractor 를 반환해 이 단언이 실패한다.
    const zip = openZip(zipOf({ 'ppt/presentation.xml': '<p:presentation/>' }));
    expect(resolveExtractor(zip)).toBeNull();
  });

  it('ZIP_EXTRACTORS 에는 docxExtractor 하나가 등록돼 있다', () => {
    expect(ZIP_EXTRACTORS).toEqual([docxExtractor]);
  });
});
