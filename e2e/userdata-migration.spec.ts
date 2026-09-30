import { test, expect } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectron, cleanupDir } from './helpers';

/**
 * E2E — QA34(High): 개명 이전 userData 의 자동 이전이 **암호화된 API 키까지** 살리는가.
 *
 * 단위 테스트(userdata-migration.test.ts)는 "파일이 복사됐다" 까지만 본다. 그런데 이 기능의
 * 성패는 복사가 아니라 **순서**에 달려 있다 — api-keys.enc 는 userData 의 `Local State` 안
 * os_crypt 키로만 풀리고, Chromium 은 main 스크립트의 최상위 동기 실행 직후 그 파일을 메모리에
 * 올린다. 이전을 `app.whenReady()` 안으로 옮기거나 await 뒤로 미루면 파일은 멀쩡히 복사되는데
 * 키는 새 프로파일의 새 os_crypt 키로 복호화를 시도해 실패하고, 설정 화면은 "키 미저장" 이 된다.
 * 그 실패는 실제 Electron 을 띄워 실제 safeStorage 로 풀어 봐야만 드러난다.
 *
 * 시나리오: ①옛 폴더 A 에서 앱을 띄워 실제 safeStorage 로 키를 저장(= v1.7.x 의 상태)
 *          ②빈 폴더 B 를 userData 로, A 를 원본으로 지정해 기동(= 앱 내 업데이트 직후의 v1.8.x)
 *          ③B 에서 키가 풀리고 설정이 따라왔는지 확인.
 */

/** 이 스펙이 쓰는 preload 표면만 추린 타입(런타임에는 지워진다). */
interface Api {
  apiKey: { save: (p: string, k: string) => Promise<{ success: boolean }>; has: (p: string) => Promise<boolean | null> };
  settings: { get: () => Promise<Record<string, unknown>> };
}
type Win = { electronAPI: Api };

// 게이트로서 호출됐는가(=safeStorage 가 반드시 있어야 하는가). release.yml build-windows 와
// test.yml 야간 package-smoke 잡이 이 값을 세운다.
const REQUIRED = process.env['MIGRATION_E2E_REQUIRED'] === '1';
// 부재 경로(skip→실패 승격)를 검증하기 위한 테스트 전용 스위치 — safeStorage 를 실제로 끌 방법이
// 없으므로 "없다" 고 보고된 것처럼 다룬다. CI 워크플로에서는 절대 세우지 않는다.
const FORCE_UNAVAILABLE = process.env['MIGRATION_E2E_FORCE_NO_SAFESTORAGE'] === '1';

const SEED = { provider: 'claude', model: 'claude-sonnet-4-5', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'dark' };

test('옛 userData 의 API 키·설정이 새 userData 로 이전되어 실제로 복호화된다', async () => {
  test.setTimeout(90000);
  const legacyDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-legacy-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-migrated-'));
  try {
    // ── ① v1.7.x 상태 만들기: 실제 safeStorage 로 키 저장 ──
    const r1 = await launchElectron(legacyDir, SEED);
    try {
      const available = !FORCE_UNAVAILABLE
        && await r1.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
      // QA35(D1): 게이트로 호출된 경우 skip 은 곧 "한 번도 실행되지 않은 초록" 이다 — ubuntu 러너는
      // safeStorage 가 없어 이 스펙이 모든 CI 에서 skip 되고 있었다. Windows 잡이 이 값을 세워
      // 호출하고, 그때 safeStorage 부재는 실패로 승격한다(packaged-smoke 의 PACKAGED_SMOKE_REQUIRED 와 동일).
      if (REQUIRED && !available) {
        throw new Error('MIGRATION_E2E_REQUIRED=1 인데 safeStorage 를 쓸 수 없습니다 — 게이트를 Windows 잡에서 실행하세요');
      }
      test.skip(!available, 'OS 키체인(safeStorage)을 쓸 수 없는 환경 — 암호화 키 이전을 검증할 수 없다');
      const saved = await r1.page.evaluate(() =>
        (window as unknown as Win).electronAPI.apiKey.save('claude', 'sk-e2e-migration-0001'));
      expect(saved.success).toBe(true);
    } finally {
      await r1.app.close().catch(() => { /* 이미 종료 */ });
    }
    expect(existsSync(join(legacyDir, 'api-keys.enc'))).toBe(true);
    expect(existsSync(join(legacyDir, 'Local State'))).toBe(true);

    // ── ② 빈 대상 + 옛 원본으로 기동 ──
    const r2 = await launchElectron(targetDir, undefined, { DOC_ANALYZER_LEGACY_USER_DATA: legacyDir });
    try {
      // ③ 키가 **풀린다** — Local State 가 Chromium 초기화 전에 들어왔다는 증거.
      const has = await r2.page.evaluate(() => (window as unknown as Win).electronAPI.apiKey.has('claude'));
      expect(has, '이전된 api-keys.enc 가 새 프로파일에서 복호화되어야 한다').toBe(true);
      const settings = await r2.page.evaluate(() => (window as unknown as Win).electronAPI.settings.get());
      expect(settings.provider).toBe('claude');
      expect(settings.theme).toBe('dark');
      expect(r2.pageErrors.map((e) => e.message)).toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
    const marker = JSON.parse(readFileSync(join(targetDir, '.migrated-from-summary-lecture-material'), 'utf-8'));
    expect(marker.result).toBe('migrated');
    // 원본은 그대로다.
    expect(existsSync(join(legacyDir, 'api-keys.enc'))).toBe(true);
  } finally {
    cleanupDir(legacyDir);
    cleanupDir(targetDir);
  }
});
