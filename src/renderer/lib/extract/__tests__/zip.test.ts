import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip, MAX_ZIP_ENTRIES, MAX_UNZIPPED_BYTES } from '../zip';

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
    // originalSize 가 상한을 넘도록 만든 단일 엔트리. 압축률이 높아 파일 자체는 작다.
    const big = 'A'.repeat(MAX_UNZIPPED_BYTES + 1);
    expect(() => openZip(makeZip({ 'big.txt': big }))).toThrowError(
      expect.objectContaining({ code: 'DOC_TOO_LARGE' }),
    );
  });

  it('엔트리 수 상한을 넘으면 거부한다', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) files[`f${i}.txt`] = 'x';
    expect(() => openZip(makeZip(files))).toThrowError(
      expect.objectContaining({ code: 'DOC_TOO_LARGE' }),
    );
  });
});
