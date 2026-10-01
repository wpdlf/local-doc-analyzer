import { parseXml, walk, localName, attr } from './xml';
import { resolveRelTarget } from './ooxml';
import { extractFail } from './errors';
import type { ZipIndex } from './types';

/**
 * OCF(Open Container Format) 해석 — HWPX 가 쓴다(설계 §3.1). EPUB 도 같은 컨테이너지만 지원 제외(2026-10-01).
 *
 * `META-INF/container.xml` → rootfile(OPF) → manifest(id → 경로·media-type) + spine(순서).
 */

const CONTAINER_PART = 'META-INF/container.xml';
const MANIFEST_PART = 'META-INF/manifest.xml';

export interface OcfItem {
  id: string;
  /** zip 엔트리 경로(패키지 루트 기준) */
  path: string;
  mediaType: string;
}

export interface OcfPackage {
  opfPath: string;
  items: Map<string, OcfItem>;
  /** spine 순서의 항목 — manifest 에 없는 idref 는 뺀다 */
  spine: OcfItem[];
}

/**
 * manifest href → zip 경로. EPUB(OPF 규약)은 href 를 **OPF 파일 기준 상대**로 쓰고, HWPX 는
 * **패키지 루트 기준**으로 쓴다(`Contents/section0.xml`). 규약대로인 OPF-기준 해석을 먼저
 * 시도하고, 그 경로가 실제로 zip 에 있으면 그것을 믿는다 — OPF 규약이 표준이고, 두 해석이 같은
 * 파일을 다르게 가리키는 경우(예: `images/a.png` 와 `OEBPS/images/a.png` 가 둘 다 있는 zip)에도
 * 규약대로의 경로가 맞다. OPF-기준 경로가 zip 에 없을 때만 href 를 있는 그대로(패키지 루트 기준)
 * 받아들인다 — 둘 중 하나만 가정하면 한 포맷에서 모든 파트가 "없음" 이 된다(조용히 빈 문서).
 */
function resolveHref(zip: ZipIndex, opfPath: string, href: string): string {
  // QA35(O03): 잘못된 퍼센트 인코딩(`%E0%A4%A`)에서 decodeURIComponent 가 URIError 를 던져
  // 항목 하나 때문에 패키지 전체가 실패했다(HWPX 는 그림이 0개가 되고, EPUB 는 문서가 안 열린다).
  // 항목 단위로 가두고, 디코드할 수 없으면 href 를 그대로 쓴다.
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href;
  }
  const viaOpf = resolveRelTarget(opfPath, decoded);
  if (zip.has(viaOpf)) return viaOpf;
  return decoded;
}

export function readOcfPackage(zip: ZipIndex, packageMediaType: string): OcfPackage {
  const containerXml = zip.text(CONTAINER_PART) ?? extractFail('DOC_CORRUPT', 'container.xml missing');
  // rootfile 이 여럿이다(실물 HWPX: 패키지 · 미리보기 텍스트 · rdf) — 첫 항목을 믿지 않는다.
  const rootfile = [...walk(parseXml(containerXml).documentElement)].find(
    (e) => localName(e) === 'rootfile' && attr(e, 'media-type') === packageMediaType,
  );
  const opfPath = (rootfile && attr(rootfile, 'full-path')) || extractFail('DOC_CORRUPT', 'package rootfile missing');
  return readOpf(zip, opfPath);
}

/**
 * OPF(패키지 문서) 하나 → manifest + spine. container.xml 없이 OPF 경로를 이미 아는 호출자
 * (HWPX 의 관례 경로 `Contents/content.hpf` 폴백)도 같은 해석을 쓰도록 분리한다 — 사본을 두면
 * href 해석 규칙이 두 벌로 갈린다.
 */
export function readOpf(zip: ZipIndex, opfPath: string): OcfPackage {
  const opfXml = zip.text(opfPath) ?? extractFail('DOC_CORRUPT', 'package document missing');
  const root = parseXml(opfXml).documentElement;

  const items = new Map<string, OcfItem>();
  for (const el of walk(root)) {
    if (localName(el) !== 'item') continue;
    const id = attr(el, 'id');
    const href = attr(el, 'href');
    if (!id || !href) continue;
    items.set(id, { id, path: resolveHref(zip, opfPath, href), mediaType: attr(el, 'media-type') ?? '' });
  }
  const spine: OcfItem[] = [];
  for (const el of walk(root)) {
    if (localName(el) !== 'itemref') continue;
    const item = items.get(attr(el, 'idref') ?? '');
    if (item) spine.push(item);
  }
  return { opfPath, items, spine };
}

/**
 * 본문이 암호화된 패키지인가. ODF/OCF 는 암호화한 파트마다 `manifest.xml` 에 `encryption-data` 를
 * 둔다. 실물 샘플은 없다(설계 §11) — 판정을 여기 한 곳에 두어 샘플을 얻으면 이것만 고친다.
 */
export function hasEncryptionData(zip: ZipIndex): boolean {
  const xml = zip.text(MANIFEST_PART);
  if (!xml) return false;
  try {
    return [...walk(parseXml(xml).documentElement)].some((e) => localName(e) === 'encryption-data');
  } catch {
    return false;
  }
}
