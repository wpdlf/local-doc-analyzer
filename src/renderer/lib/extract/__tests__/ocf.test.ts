// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from '../zip';
import { readOcfPackage, hasEncryptionData } from '../ocf';
import type { ZipIndex } from '../types';

function zipOf(files: Record<string, string>): ZipIndex {
  const u8 = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return openZip(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}
const HWPX_PKG = 'application/hwpml-package+xml';
const container = `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>`
  + `<rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>`
  + `<rootfile full-path="Contents/content.hpf" media-type="${HWPX_PKG}"/>`
  + `<rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></rootfiles></container>`;
const opf = (href: string) => `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>`
  + `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>`
  + `<opf:item id="section0" href="${href}" media-type="application/xml"/>`
  + `<opf:item id="image1" href="BinData/image1.bmp" media-type="image/bmp"/>`
  + `</opf:manifest><opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/><opf:itemref idref="nope"/></opf:spine></opf:package>`;

describe('readOcfPackage', () => {
  it('media-type 로 rootfile 을 고르고(3개 중), 루트 기준 href 를 그대로 받는다(HWPX)', () => {
    const pkg = readOcfPackage(zipOf({
      'META-INF/container.xml': container,
      'Contents/content.hpf': opf('Contents/section0.xml'),
      'Contents/section0.xml': '<hs:sec xmlns:hs="urn:hs"/>',
    }), HWPX_PKG);
    expect(pkg.opfPath).toBe('Contents/content.hpf');
    expect(pkg.spine.map((i) => i.path)).toEqual(['Contents/header.xml', 'Contents/section0.xml']);
    expect(pkg.items.get('image1')?.path).toBe('BinData/image1.bmp');
  });

  it('루트 기준 경로가 없으면 OPF 파일 기준 상대로 푼다(EPUB 규약)', () => {
    const pkg = readOcfPackage(zipOf({
      'META-INF/container.xml': container,
      'Contents/content.hpf': opf('section0.xml'),
      'Contents/section0.xml': '<x/>',
    }), HWPX_PKG);
    expect(pkg.items.get('section0')?.path).toBe('Contents/section0.xml');
  });

  it('spine 이 manifest 에 없는 id 를 가리키면 건너뛴다', () => {
    const pkg = readOcfPackage(zipOf({ 'META-INF/container.xml': container, 'Contents/content.hpf': opf('Contents/section0.xml') }), HWPX_PKG);
    expect(pkg.spine.some((i) => i.id === 'nope')).toBe(false);
  });

  it('container.xml 이나 맞는 rootfile 이 없으면 DOC_CORRUPT', () => {
    expect(() => readOcfPackage(zipOf({}), HWPX_PKG)).toThrow(expect.objectContaining({ code: 'DOC_CORRUPT' }));
    expect(() => readOcfPackage(zipOf({ 'META-INF/container.xml': container }), 'application/oebps-package+xml'))
      .toThrow(expect.objectContaining({ code: 'DOC_CORRUPT' }));
  });

  it('두 해석 다 zip 에 있으면 OPF 규약대로(OPF 기준 상대)를 믿는다', () => {
    const EPUB_PKG = 'application/oebps-package+xml';
    const epubContainer = `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>`
      + `<rootfile full-path="OEBPS/content.opf" media-type="${EPUB_PKG}"/></rootfiles></container>`;
    const epubOpf = `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>`
      + `<opf:item id="a" href="images/a.png" media-type="image/png"/>`
      + `</opf:manifest><opf:spine/></opf:package>`;
    const pkg = readOcfPackage(zipOf({
      'META-INF/container.xml': epubContainer,
      'OEBPS/content.opf': epubOpf,
      'images/a.png': 'root-based-decoy',
      'OEBPS/images/a.png': 'opf-relative-real',
    }), EPUB_PKG);
    expect(pkg.items.get('a')?.path).toBe('OEBPS/images/a.png');
  });

  it('어느 쪽 경로도 zip 에 없으면 href 를 있는 그대로(패키지 루트 기준) 받아들인다', () => {
    const pkg = readOcfPackage(zipOf({
      'META-INF/container.xml': container,
      'Contents/content.hpf': opf('Contents/section0.xml'),
    }), HWPX_PKG);
    // 'image1' 의 href="BinData/image1.bmp" — OPF 기준(Contents/BinData/image1.bmp)도
    // 루트 기준(BinData/image1.bmp)도 zip 에 없다. href 를 그대로 받는다.
    expect(pkg.items.get('image1')?.path).toBe('BinData/image1.bmp');
  });
});

describe('hasEncryptionData', () => {
  it('manifest.xml 의 encryption-data 를 찾는다', () => {
    const enc = '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><odf:file-entry odf:full-path="Contents/section0.xml"><odf:encryption-data/></odf:file-entry></odf:manifest>';
    expect(hasEncryptionData(zipOf({ 'META-INF/manifest.xml': enc }))).toBe(true);
    expect(hasEncryptionData(zipOf({ 'META-INF/manifest.xml': '<odf:manifest xmlns:odf="urn:x"/>' }))).toBe(false);
    expect(hasEncryptionData(zipOf({}))).toBe(false);
  });
});
