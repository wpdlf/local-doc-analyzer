import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { stripJsComments } from './helpers/source-scan';

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
