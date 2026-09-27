import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { stripJsComments } from './helpers/source-scan';
import { UNIT_KINDS } from '../document-formats';
import { safeUnitKind } from '../../main/session-store';

/**
 * `src/shared/session-types.ts` 는 main/renderer 공용이라 `src/renderer/**` 를 import 하면
 * 레이어링이 뒤집힌다(renderer 가 main 아래에 있어야 하는데 shared→renderer 참조가 생긴다).
 * 그래서 `SessionManifestEntry.unitKind` 는 `src/renderer/lib/extract/types.ts` 의 `UnitKind`
 * 리터럴 유니온을 import 하지 않고 그대로 복제해 선언한다.
 *
 * 복제는 의도적이지만 drift 는 안 된다 — updater-cache-name-drift.test.ts 와 같은 패턴으로,
 * 이 테스트는 두 소스 파일에서 리터럴 유니온을 각각 정규식으로 뽑아 **양쪽 다** 대조한다
 * (한쪽을 재선언해 자기 자신과 비교하는 항진명제를 피한다).
 */
const RENDERER_TYPES_PATH = path.join(
  process.cwd(), 'src', 'renderer', 'lib', 'extract', 'types.ts',
);
const SESSION_TYPES_PATH = path.join(process.cwd(), 'src', 'shared', 'session-types.ts');

function extractLiterals(filePath: string, pattern: RegExp): string[] {
  const src = stripJsComments(readFileSync(filePath, 'utf-8'));
  const match = pattern.exec(src);
  if (!match) {
    throw new Error(`유니온 선언을 찾지 못했다: ${filePath} (패턴 ${pattern})`);
  }
  return match[1]!
    .split('|')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0)
    .sort();
}

describe('UnitKind 유니온 drift 가드 (extract/types.ts ↔ session-types.ts)', () => {
  it('두 선언의 리터럴 집합이 일치한다', () => {
    const rendererValues = extractLiterals(
      RENDERER_TYPES_PATH,
      /export type UnitKind = ([^;]+);/,
    );
    const sharedValues = extractLiterals(
      SESSION_TYPES_PATH,
      /unitKind\?:\s*([^;]+);/,
    );
    expect(
      sharedValues,
      'session-types.ts 의 SessionManifestEntry.unitKind 유니온이 ' +
        'extract/types.ts 의 UnitKind 와 어긋났다 — 둘을 함께 갱신할 것',
    ).toEqual(rendererValues);
  });
});

/**
 * QA34(L7): 세 번째 사본 — main 의 session-store 가 디스크에서 읽은 unitKind 를 거르던 리터럴
 * 집합(`v === 'page' || v === 'slide' || ...`)이 위 가드 밖에 있었다. 새 단위(예: EPUB 'chapter'
 * 외 추가)가 타입 두 곳에만 들어가면 main 이 저장된 값을 조용히 undefined 로 버려 'page' 로
 * 보였을 것이다. 이제 session-store 는 `UNIT_KINDS`(document-formats.ts) 런타임 상수를 쓰고,
 * 여기서 그 상수를 타입 선언과 대조한다.
 */
describe('UNIT_KINDS 런타임 상수 drift 가드 (document-formats.ts ↔ extract/types.ts)', () => {
  it('런타임 상수가 UnitKind 유니온과 같은 집합이다', () => {
    const typeValues = extractLiterals(RENDERER_TYPES_PATH, /export type UnitKind = ([^;]+);/);
    expect([...UNIT_KINDS].sort()).toEqual(typeValues);
  });

  it('session-store 는 리터럴 사본 없이 공유 판정(isUnitKind)을 쓴다', () => {
    const src = stripJsComments(readFileSync(path.join(process.cwd(), 'src', 'main', 'session-store.ts'), 'utf-8'));
    const body = /function safeUnitKind\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(body, 'safeUnitKind 선언을 찾지 못했다 — 추출 정규식을 확인할 것').toBeDefined();
    expect(body).toMatch(/\bisUnitKind\(/);
    expect(body).not.toMatch(/'(page|slide|chapter)'/);
  });

  it('safeUnitKind: 알려진 값은 통과, 나머지는 undefined(= page 폴백)', () => {
    for (const k of UNIT_KINDS) expect(safeUnitKind(k)).toBe(k);
    expect(safeUnitKind('Slide')).toBeUndefined();
    expect(safeUnitKind('')).toBeUndefined();
    expect(safeUnitKind(null)).toBeUndefined();
    expect(safeUnitKind(1)).toBeUndefined();
    expect(safeUnitKind({ toString: () => 'page' })).toBeUndefined();
  });
});
