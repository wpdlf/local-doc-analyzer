import { parseXml, walk, localName, attr } from './xml';
import type { ZipIndex } from './types';

/**
 * OOXML 의 관계(rels) 해석.
 *
 * 관계 Target 은 **파트 기준 상대 경로**다. DOCX 는 `media/image1.png`(같은 디렉터리),
 * PPTX 슬라이드는 `../media/image2.png`(상위 이동) 형태라 둘 다 풀어야 한다.
 */

/** `word/document.xml` + `media/x.png` → `word/media/x.png` */
export function resolveRelTarget(partPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseParts = partPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') baseParts.pop();
    else baseParts.push(seg);
  }
  return baseParts.join('/');
}

/** 파트의 `_rels/<이름>.rels` 를 읽어 `Id → 해석된 엔트리 경로` 로 만든다. */
export function readRels(zip: ZipIndex, partPath: string): Map<string, string> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const file = partPath.split('/').slice(-1)[0] ?? '';
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${file}.rels`;
  const xml = zip.text(relsPath);
  const out = new Map<string, string>();
  if (!xml) return out;

  for (const el of walk(parseXml(xml).documentElement)) {
    if (localName(el) !== 'Relationship') continue;
    const id = attr(el, 'Id');
    const target = attr(el, 'Target');
    // 외부 링크(TargetMode="External")는 아카이브 안에 없으므로 담지 않는다.
    if (!id || !target || attr(el, 'TargetMode') === 'External') continue;
    out.set(id, resolveRelTarget(partPath, target));
  }
  return out;
}
