import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip, resolveMaxUnzippedBytes, MAX_ZIP_ENTRIES, MAX_UNZIPPED_BYTES } from '../zip';

function makeZip(files: Record<string, string>): ArrayBuffer {
  const input: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) input[name] = strToU8(body);
  const out = zipSync(input);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

describe('openZip', () => {
  it('엔트리 이름과 텍스트를 읽는다', () => {
    const zip = openZip(makeZip({ 'a/b.xml': '<r>안녕</r>', 'c.txt': 'hi' }));
    expect(zip.names().sort()).toEqual(['a/b.xml', 'c.txt']);
    expect(zip.has('a/b.xml')).toBe(true);
    expect(zip.text('a/b.xml')).toBe('<r>안녕</r>');
  });

  it('없는 엔트리는 null 을 준다 (throw 하지 않는다)', () => {
    const zip = openZip(makeZip({ 'a.txt': 'x' }));
    expect(zip.text('없음.xml')).toBeNull();
    expect(zip.bytes('없음.xml')).toBeNull();
    expect(zip.has('없음.xml')).toBe(false);
  });

  it('zip 이 아니면 DOC_CORRUPT 로 거부한다', () => {
    const notZip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    expect(() => openZip(notZip)).toThrowError(
      expect.objectContaining({ code: 'DOC_CORRUPT' }),
    );
  });

  it('해제 총량 상한을 넘으면 풀기 전에 거부한다', () => {
    // 파일 크기 캡(MAX_PDF_SIZE_BYTES)은 zip 에서 실질 방어가 못 된다 — 작은 압축 아카이브가
    // 수백MB~수GB 로 풀릴 수 있어서다(zip bomb). fflate 의 filter 는 **해제 전에** 각 엔트리의
    // originalSize 를 알려주므로, 그 값을 누적해 상한 초과 시 실제 inflate 가 일어나기 전에
    // 거부한다 — 이 테스트는 정확히 그 분기(누적 originalSize > 상한)를 확인한다.
    //
    // 실 프로덕션 상한(MAX_UNZIPPED_BYTES=300MB)을 그대로 넘기려면 300MB 문자열을 실제로
    // 만들고 압축해야 해 커버리지 계측 하에서 5초 기본 타임아웃을 넘겼다(수 초~십수 초).
    // 상한을 테스트 전용으로 주입해(openZip 의 opts.maxUnzippedBytes) 몇 KB 짜리 아카이브로
    // 같은 분기를 밀리초 단위로 확인한다 — 실제 캡 값은 아래 "기본값" 테스트가 별도로 고정한다.
    const CAP = 4096;
    const big = 'A'.repeat(CAP + 1);
    expect(() => openZip(makeZip({ 'big.txt': big }), { maxUnzippedBytes: CAP })).toThrowError(
      expect.objectContaining({ code: 'DOC_TOO_LARGE' }),
    );
  });

  it('opts 없이 부르면 기본 상한은 MAX_UNZIPPED_BYTES 다 (drift 고정)', () => {
    // 위 테스트는 작은 캡을 주입해 빠르게 도는데, 그것만으로는 openZip 이 옵션 미지정 시
    // 실제로 MAX_UNZIPPED_BYTES 를 쓰는지 보증하지 못한다 — resolveMaxUnzippedBytes 의 `??`
    // 우변이 다른 상수로 바뀌어도 위 테스트는 여전히 통과한다. 이 순수 함수 assert 가
    // 기본값을 상수에 고정한다.
    expect(resolveMaxUnzippedBytes()).toBe(MAX_UNZIPPED_BYTES);
    expect(resolveMaxUnzippedBytes({ maxUnzippedBytes: 10 })).toBe(10);
  });

  it('엔트리 수 상한을 넘으면 거부한다', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) files[`f${i}.txt`] = 'x';
    expect(() => openZip(makeZip(files))).toThrowError(
      expect.objectContaining({ code: 'DOC_TOO_LARGE' }),
    );
  });
});
