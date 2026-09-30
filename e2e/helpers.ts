import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 결정적(AI 비의존) E2E 스펙이 공유하는 Electron 기동 격리 계약 — 단일 출처.
 *
 * 이 env/sandbox 블록은 모든 결정적 스펙에 동일해야 하는 "격리 불변식"이다. 과거에는 스펙마다
 * 복붙되어 한쪽만 바뀌면(예: dead-Ollama 포트 누락) 조용히 실사용자 상태/실 백엔드에 결합될
 * 위험이 있었다. 여기로 모아 drift 를 차단한다.
 *
 * 스펙별 고유 로직(makePdf 형태, smoke 의 합성 DragEvent 등)은 의도적으로 각 스펙에 인라인 유지.
 * 실 Ollama 가 필요한 로컬-전용 스펙(collection / tabs 의 인덱싱 테스트)은 본 헬퍼를 쓰지 않는다
 * (죽은 포트 격리와 상충).
 */
export interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  pageErrors: Error[];
}

/** seedSettings 가 있을 때만 settings.json 을 쓴다(재시작 시나리오의 2차 기동은 앱이 쓴 파일을 보존). */
export async function launchElectron(
  userDataDir: string,
  seedSettings?: Record<string, unknown>,
  /** 스펙 고유 env(예: userdata-migration 의 DOC_ANALYZER_LEGACY_USER_DATA). 격리 env 는 덮어쓸 수 없다. */
  extraEnv?: Record<string, string>,
): Promise<LaunchResult> {
  if (seedSettings) {
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(seedSettings), 'utf-8');
  }
  const app = await electron.launch({
    args: [
      '.',
      // GH ubuntu-24.04 러너는 unprivileged userns 제한(AppArmor)으로 Chromium setuid
      // sandbox 가 실패할 수 있어 CI 한정 비활성화. 로컬 실행은 샌드박스 유지.
      ...(process.env.CI ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      ...extraEnv,
      DOC_ANALYZER_USER_DATA: userDataDir,
      // 호스트에 실제 Ollama 가 실행 중이어도(개발 머신) 죽은 포트로 격리 —
      // 콜드 스타트 위자드 노출 등 Ollama 상태 의존 시나리오를 결정적으로 만든다.
      DOC_ANALYZER_OLLAMA_URL: 'http://127.0.0.1:59999',
    },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  return { app, page, pageErrors };
}

/**
 * file:dropped IPC 로 실제 경로 + 바이트를 전달. 합성 DragEvent 와 달리 진짜 filePath 를
 * 보유하므로(main 의 drop 핸들러와 동일 페이로드) 세션 fallback·재오픈 경로를 실측할 수 있다.
 */
export function sendDropPath(app: ElectronApplication, realPath: string, b64: string): Promise<void> {
  return app.evaluate(({ BrowserWindow }, arg) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const buf = Buffer.from(arg.b64, 'base64');
    win.webContents.send('file:dropped', {
      path: arg.realPath,
      name: arg.realPath.split(/[\\/]/).pop(),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });
  }, { realPath, b64 });
}

export interface ManifestEntry { docHash: string; fileName: string; unitKind?: string }

/** manifest 에서 fileName 항목을 찾되, 그 session.json 까지 디스크에 있을 때만 돌려준다. */
export function findFlushedSession(userDataDir: string, fileName: string): ManifestEntry | null {
  const sessionsDir = join(userDataDir, 'sessions');
  let entries: ManifestEntry[];
  try {
    entries = (JSON.parse(readFileSync(join(sessionsDir, 'manifest.json'), 'utf-8')) as { entries: ManifestEntry[] }).entries;
  } catch {
    return null; // 아직 없음 / 원자적 교체 도중 — 다음 폴링에서 다시 본다
  }
  const entry = entries.find((e) => e.fileName === fileName);
  return entry && existsSync(join(sessionsDir, entry.docHash, 'session.json')) ? entry : null;
}

/**
 * 문서를 열고 → 다른 문서를 드롭해 그 세션을 flush 시키고 → manifest 에 항목이 생길 때까지 기다린다.
 *
 * QA35(D5): 종전 스펙들은 `waitForTimeout(2000)`(A 의 세션 복원 settle 대기) + `(500)`(flush 쓰기
 * 대기)으로 버텼다. 둘 다 추측값이다 — 느린 러너에서는 모자라 "세션이 flush 되지 않았다" 로
 * 플레이크가 나고, 빠른 머신에서는 매번 2.5초를 버린다. flush 는 복원 대기(sessionRestorePending)
 * 중이면 **설계상** 건너뛰는데 그 상태가 DOM 에 드러나지 않으므로, 대신 **결과**(manifest 항목 +
 * session.json)를 폴링하고, 복원 전에 교체돼 flush 가 건너뛰어진 경우에만 열기→교체를 다시 한다.
 * 끝내 항목이 없으면 실패한다(재시도가 결함을 삼키지 않는다 — 한 번도 저장되지 않으면 빨갛다).
 */
export async function openAndFlushSession(
  r: LaunchResult,
  opts: { userDataDir: string; fixture: string; header: string; flushPath: string; flushBuf: Buffer },
): Promise<ManifestEntry> {
  const name = opts.fixture.split(/[\\/]/).pop()!;
  const buf = readFileSync(opts.fixture);
  const ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    await sendDropPath(r.app, opts.fixture, buf.toString('base64'));
    await expect(r.page.getByText(opts.header)).toBeVisible({ timeout: 60000 });
    await sendDropPath(r.app, opts.flushPath, opts.flushBuf.toString('base64'));
    await expect(r.page.getByText('flush.pdf (1p)')).toBeVisible({ timeout: 30000 });
    try {
      await expect.poll(() => findFlushedSession(opts.userDataDir, name) !== null, { timeout: 10000 }).toBe(true);
      return findFlushedSession(opts.userDataDir, name)!;
    } catch (err) {
      if (attempt >= ATTEMPTS) {
        throw new Error(`${name} 세션이 ${ATTEMPTS}회 교체에도 flush 되지 않았다 — manifest 에 항목이 없음`, { cause: err });
      }
      // 재시도가 잦아지면 신호다(복원이 느려졌거나 flush 가 간헐 실패) — 로그로 남겨 묻히지 않게 한다.
      console.warn(`[e2e] ${name}: 교체 ${attempt}회차에 flush 가 안 됐다 — 열기→교체를 다시 한다`);
    }
  }
}

/** 임시 디렉터리 정리(잠긴 파일 재시도 포함). */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
