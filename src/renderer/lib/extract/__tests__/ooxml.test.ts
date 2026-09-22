// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { readRels, resolveRelTarget } from '../ooxml';

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>
</Relationships>`;

function zipOf(files: Record<string, string>): ReturnType<typeof openZip> {
  const input: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) input[k] = strToU8(v);
  const out = zipSync(input);
  return openZip(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
}

describe('resolveRelTarget — Target 은 파트 기준 상대 경로다', () => {
  it('같은 디렉터리 기준으로 푼다', () => {
    expect(resolveRelTarget('word/document.xml', 'media/image1.png')).toBe('word/media/image1.png');
  });

  it('상위 이동(..)을 푼다 — PPTX 슬라이드 rels 가 이 형태다', () => {
    expect(resolveRelTarget('ppt/slides/slide1.xml', '../media/image2.png')).toBe('ppt/media/image2.png');
  });

  it('절대(/로 시작) Target 은 루트 기준이다', () => {
    expect(resolveRelTarget('word/document.xml', '/word/media/x.png')).toBe('word/media/x.png');
  });
});

describe('readRels', () => {
  it('Id → 해석된 엔트리 경로를 준다', () => {
    const zip = zipOf({ 'word/document.xml': '<x/>', 'word/_rels/document.xml.rels': RELS });
    const rels = readRels(zip, 'word/document.xml');
    expect(rels.get('rId6')).toBe('word/media/image1.png');
    expect(rels.get('rId7')).toBe('media/image2.png');
  });

  it('rels 파일이 없으면 빈 Map 이다 (throw 하지 않는다)', () => {
    const zip = zipOf({ 'word/document.xml': '<x/>' });
    expect(readRels(zip, 'word/document.xml').size).toBe(0);
  });
});
