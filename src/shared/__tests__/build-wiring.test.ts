/**
 * QA33(H7·M): **게이트를 켜는 스위치**의 회귀 넷.
 *
 * 이 저장소에는 잘 작동하는 게이트가 여럿 있는데(eager 경계·cmaps 복사·커버리지 드리프트),
 * 뮤테이션으로 재보니 게이트의 **순수부**만 보호되고 그것을 실제로 빌드 실패로 바꾸는
 * **집행부와 배선**은 아무도 보고 있지 않았다:
 *
 *   `scripts.build` 의 ` && node scripts/postbuild.mjs`  → 지워도 2510 전량 그린
 *   postbuild 의 EAGER_FORBIDDEN / checkEagerScope / exit(1) → 무력화해도 전량 그린
 *   coverage-drift 의 main()                              → 조용히 exit 0 이 될 수 있었다
 *
 * 배선이 빠지면 (1) pdfjs cmaps 가 복사되지 않아 **패키징 앱에서 CJK 글리프가 깨지고**
 * (스모크 PDF 는 라틴이라 밟지 않는다), (2) eager 청크 경계 게이트가 통째로 사라진다.
 * 그런데도 빌드는 성공하고 유닛·E2E·packaged-smoke 가 전부 초록이다.
 *
 * 형제 관계: `coverage-drift.test.ts` 는 이미 `posttest:coverage` 배선을 정확히 못박고 있다 —
 * 같은 관용구를 빌드 쪽에도 적용한다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripJsComments } from './helpers/source-scan';

const ROOT = resolve(import.meta.dirname, '../../..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  build: { asarUnpack?: string[]; files?: string[]; publish?: unknown; forceCodeSigning?: boolean };
};

describe('빌드 배선 (postbuild 가 실제로 불린다)', () => {
  it('`npm run build` 가 postbuild.mjs 를 호출한다', () => {
    // 이 한 줄이 cmaps 복사와 eager 경계 게이트의 **유일한** 호출 경로다.
    expect(pkg.scripts.build).toBe('electron-vite build && node scripts/postbuild.mjs');
  });

  it('패키징 계약: cmaps 는 asar 밖으로 풀린다', () => {
    // asar 안에 갇히면 pdfjs 가 cMapUrl('./cmaps/')로 읽지 못해 **한국어/일본어/중국어 PDF
    // 에서만** 글리프가 깨진다. 라틴 스모크로는 절대 드러나지 않고 사용자 설치 후에 발견된다.
    expect(pkg.build.asarUnpack ?? []).toContain('out/renderer/cmaps/**');
  });
});

describe('postbuild 의 집행부 (판정이 실제로 빌드를 세우는가)', () => {
  const src = stripJsComments(readFileSync(resolve(ROOT, 'scripts/postbuild.mjs'), 'utf8'));

  it('금지 목록이 비어 있지 않다 (katex · pdfjs 청크)', () => {
    const forbidden = /const EAGER_FORBIDDEN = \[[\s\S]*?\];/.exec(src)?.[0] ?? '';
    expect(forbidden, 'EAGER_FORBIDDEN 을 찾지 못했다 — 이 가드가 무력화된 상태다').not.toBe('');
    expect(forbidden, '금지 목록이 비면 게이트는 아무것도 막지 않으면서 초록이다').toMatch(/katex/i);
    const chunks = /const EAGER_FORBIDDEN_CHUNKS = \[[\s\S]*?\];/.exec(src)?.[0] ?? '';
    expect(chunks).toMatch(/pdfjs/i);
  });

  it('위반과 범위축소 판정이 각각 exit 1 로 끝난다', () => {
    expect(src, '위반을 찾고도 경고만 하면 게이트가 아니다')
      .toMatch(/if \(failures\.length > 0\)[\s\S]*?process\.exit\(1\)/);
    expect(src, '범위 축소(조용한 통과)를 실패로 다루지 않는다')
      .toMatch(/const scopeError = checkEagerScope\([\s\S]*?process\.exit\(1\)/);
  });

  it('범위 검사에 실제 측정값이 들어간다 (상수로 바꿔 무력화 차단)', () => {
    expect(src).toContain('checkEagerScope(eager.size, totalBytes)');
  });

  it('index.html 이 없으면 조용히 건너뛰지 않는다', () => {
    // 산출물 부재를 skip 으로 흘리면 "빌드가 깨진 상태" 가 곧 "게이트 통과" 가 된다.
    expect(src).toMatch(/if \(!existsSync\(indexHtml\)\)[\s\S]*?process\.exit\(1\)/);
  });
});

/**
 * QA33(M): `coverage-drift.mjs` 의 순수부(checkDrift/parseGates)는 4/4 검출인데 `main()` 은
 * 한 줄도 보호되지 않았다 — 요약 파일 부재 분기 앞에 `process.exit(0)` 을 끼우면 조용히 통과한다
 * (QA29 의 "`{}` 를 먹은 audit 게이트가 로그 없이 exit 0" 과 같은 클래스). 자식 프로세스로
 * 실제 실행해 종료 코드를 본다 — audit-shipped.test.ts 와 같은 방식.
 */
describe('coverage-drift 실행 (게이트가 조용히 통과하지 않는다)', () => {
  const GATES = { statements: 82, branches: 75, functions: 81, lines: 85 };

  function runIn(setup: (dir: string) => void): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-drift-'));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/coverage-gates.json'), JSON.stringify(GATES));
      // 스크립트는 **자기 위치**에서 저장소 루트를 도출한다(cwd 가 아니다) — 사본을 임시
      // 저장소 안에 두고 실행해야 그 경로 계산까지 함께 검증된다.
      copyFileSync(resolve(ROOT, 'scripts/coverage-drift.mjs'), join(dir, 'scripts/coverage-drift.mjs'));
      setup(dir);
      try {
        const out = execFileSync(process.execPath, [join(dir, 'scripts/coverage-drift.mjs')], {
          cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 각 지표를 게이트 + offset 으로 쓴다 — 마진 정책(-5pp)이 지표별로 판정되기 때문. */
  function writeSummary(dir: string, offset: number): void {
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    const total = Object.fromEntries(
      Object.entries(GATES).map(([m, gate]) => [m, { pct: gate + offset }]),
    );
    writeFileSync(join(dir, 'coverage/coverage-summary.json'), JSON.stringify({ total }));
  }

  it('요약 파일이 없으면 실패한다 (부재를 통과로 흘리지 않는다)', () => {
    const { code } = runIn(() => { /* 요약 없음 */ });
    expect(code).not.toBe(0);
  });

  it('게이트 미달이면 실패한다', () => {
    const { code } = runIn((dir) => writeSummary(dir, -3));
    expect(code).not.toBe(0);
  });

  it('실측이 게이트보다 크게 앞서면(드리프트) 실패한다', () => {
    const { code } = runIn((dir) => writeSummary(dir, 9));
    expect(code).not.toBe(0);
  });

  it('정상 범위면 통과한다', () => {
    const { code, out } = runIn((dir) => writeSummary(dir, 2));
    expect(code, out).toBe(0);
    expect(out).toContain('[coverage-drift] OK');
  });
});
