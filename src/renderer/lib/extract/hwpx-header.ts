import { parseXml, walk, localName, attr, childrenNamed } from './xml';

/** OWPML 개요 수준은 0..9(10단계). 그 밖의 값은 손상으로 보고 제목으로 쓰지 않는다. */
const MAX_OUTLINE_LEVEL = 10;

/**
 * paraPr 의 제목 정의. `hp:switch` 가 있으면 case 쪽 하나만 본다 — 실물은 case 에 OUTLINE,
 * default 에 NONE 을 두는 식이라 "처음 만나는 heading" 을 쓰면 갈래가 섞인다.
 */
function headingOf(paraPr: Element): Element | undefined {
  const sw = childrenNamed(paraPr, 'switch')[0];
  if (sw) {
    const branch = childrenNamed(sw, 'case')[0] ?? childrenNamed(sw, 'default')[0];
    return branch ? childrenNamed(branch, 'heading')[0] : undefined;
  }
  return childrenNamed(paraPr, 'heading')[0];
}

/**
 * header.xml → paraPr id → 제목 수준(1-based).
 *
 * 스타일 이름("개요 1")을 보지 않는다 — 실물에서 스타일 이름과 그 스타일의 paraPr, 그리고 문단이
 * 실제로 참조하는 paraPr 가 서로 달랐다(스타일은 BULLET 인데 문단의 paraPr 는 NONE). 판정은 문단의
 * paraPrIDRef 가 가리키는 paraPr 하나로 한다.
 */
export function readOutlineLevels(headerXml: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!headerXml) return out;
  let root: Element;
  try {
    root = parseXml(headerXml).documentElement;
  } catch {
    return out;
  }
  for (const el of walk(root)) {
    if (localName(el) !== 'paraPr') continue;
    const id = attr(el, 'id');
    const heading = id ? headingOf(el) : undefined;
    if (!heading || attr(heading, 'type') !== 'OUTLINE') continue;
    const level = Number.parseInt(attr(heading, 'level') ?? '', 10);
    if (Number.isInteger(level) && level >= 0 && level < MAX_OUTLINE_LEVEL) out.set(id!, level + 1);
  }
  return out;
}
