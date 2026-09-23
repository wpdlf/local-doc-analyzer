// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { readRels, resolveRelTarget } from '../ooxml';

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`;

const RELS_WITH_DUPE = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/first.png"/>
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/last.png"/>
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

  it('TargetMode="External" 관계는 담지 않는다', () => {
    const zip = zipOf({ 'word/document.xml': '<x/>', 'word/_rels/document.xml.rels': RELS });
    const rels = readRels(zip, 'word/document.xml');
    // 외부 링크는 아카이브에 없으므로 제외된다
    expect(rels.has('rId9')).toBe(false);
    // 기존 관계는 여전히 해석된다
    expect(rels.has('rId6')).toBe(true);
    expect(rels.has('rId7')).toBe(true);
  });

  it('루트 레벨 파트는 _rels/<파일>.rels 에서 읽는다', () => {
    const relsAtRoot = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="images/pic1.png"/>
</Relationships>`;
    const zip = zipOf({ 'content.xml': '<x/>', '_rels/content.xml.rels': relsAtRoot });
    const rels = readRels(zip, 'content.xml');
    expect(rels.get('rId1')).toBe('images/pic1.png');
  });

  it('중복 Id 는 마지막 것이 이긴다 (Map 시맨틱스)', () => {
    const zip = zipOf({ 'word/document.xml': '<x/>', 'word/_rels/document.xml.rels': RELS_WITH_DUPE });
    const rels = readRels(zip, 'word/document.xml');
    // Map.set 이므로 마지막 값으로 덮어씌워진다
    expect(rels.get('rId1')).toBe('word/media/last.png');
  });
});
