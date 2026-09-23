import { describe, it, expect, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  migrateLegacyUserData,
  findUserData,
  removeLegacyUpdaterCache,
  LEGACY_APP_DIR_NAME,
  LEGACY_UPDATER_CACHE_DIR_NAME,
  MIGRATION_MARKER,
} from '../userdata-migration';

/**
 * QA34(High) — 개명(summary-lecture-material → local-doc-analyzer) 후 v1.7.x 의 앱 내 업데이트가
 * v1.8.0 을 **새 appId 로 나란히 설치**하고 빈 `%APPDATA%\local-doc-analyzer` 로 기동시켜
 * 세션·설정·API 키가 사라진 것처럼 보이던 문제의 1회성 자동 이전(v1.8.1).
 *
 * 실제 파일시스템(임시 appData)으로 검증한다 — 판정 대상이 "디스크에 무엇이 있는가" 라서
 * fs 를 모킹하면 판정 규칙 자체를 테스트가 흉내 내게 된다.
 */

/** main/index.ts 의 defaultSettings 와 같은 모양(테스트 입력 — 실제 값은 호출자가 주입한다). */
const DEFAULTS = {
  provider: 'ollama',
  model: 'gemma3',
  ollamaBaseUrl: 'http://localhost:11434',
  theme: 'system',
  uiLanguage: 'ko',
  defaultSummaryType: 'full',
  maxChunkSize: 4000,
  enableImageAnalysis: true,
  enableOcrFallback: true,
  summaryLanguage: 'ko',
  customSummaryTemplates: [],
  enableAnswerVerification: true,
  persistSessions: true,
  autoCheckUpdates: true,
} as const;

const HASH = 'a'.repeat(64);

const tmpDirs: string[] = [];
function makeAppData(): { appData: string; legacy: string; target: string } {
  const appData = mkdtempSync(path.join(tmpdir(), 'udm-appdata-'));
  tmpDirs.push(appData);
  return {
    appData,
    legacy: path.join(appData, LEGACY_APP_DIR_NAME),
    target: path.join(appData, 'local-doc-analyzer'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ }
  }
});

function write(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** v1.7.x 가 실제로 남기는 userData 모양 — 앱 데이터 + Chromium 프로파일 + 캐시. */
function seedLegacy(legacy: string): void {
  write(path.join(legacy, 'settings.json'), JSON.stringify({ ...DEFAULTS, provider: 'claude', theme: 'dark' }));
  write(path.join(legacy, 'api-keys.enc'), Buffer.from([0x76, 0x31, 0x30, 1, 2, 3]));
  write(path.join(legacy, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEk=' } }));
  write(path.join(legacy, 'collections.json'), JSON.stringify({ schemaVersion: 1, collections: [{ id: 'c1' }] }));
  write(path.join(legacy, 'sessions', 'manifest.json'), JSON.stringify({ entries: [{ docHash: HASH }] }));
  write(path.join(legacy, 'sessions', HASH, 'session.json'), '{"fileName":"a.pdf"}');
  write(path.join(legacy, 'Local Storage', 'leveldb', '000003.log'), 'ratio');
  // 캐시·런타임 잠금 — 옮기지 않는다.
  write(path.join(legacy, 'Cache', 'Cache_Data', 'data_0'), 'x');
  write(path.join(legacy, 'Code Cache', 'js', 'index'), 'x');
  write(path.join(legacy, 'GPUCache', 'data_1'), 'x');
  write(path.join(legacy, 'DawnGraphiteCache', 'data_1'), 'x');
  write(path.join(legacy, 'Crashpad', 'settings.dat'), 'x');
  write(path.join(legacy, 'lockfile'), '');
  write(path.join(legacy, 'settings.json.tmp'), 'partial');
}

describe('migrateLegacyUserData', () => {
  it('신규 설치(옛 폴더 없음): 아무것도 하지 않고 표식도 쓰지 않는다', () => {
    const { legacy, target } = makeAppData();
    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS });
    expect(r).toEqual({ action: 'skipped', reason: 'no-source' });
    expect(existsSync(path.join(target, MIGRATION_MARKER))).toBe(false);
  });

  it('옛 폴더 + 빈 대상: Local State 를 포함해 사용자 데이터를 복사하고 캐시는 건너뛰며 표식을 쓴다', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);

    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS });

    expect(r.action).toBe('migrated');
    // 암호화된 키는 Local State 의 os_crypt 키로만 풀린다 — 둘은 반드시 함께 간다.
    expect(readFileSync(path.join(target, 'api-keys.enc'))).toEqual(readFileSync(path.join(legacy, 'api-keys.enc')));
    expect(readFileSync(path.join(target, 'Local State'), 'utf-8')).toContain('encrypted_key');
    expect(JSON.parse(readFileSync(path.join(target, 'settings.json'), 'utf-8')).provider).toBe('claude');
    expect(existsSync(path.join(target, 'collections.json'))).toBe(true);
    expect(existsSync(path.join(target, 'sessions', HASH, 'session.json'))).toBe(true);
    expect(existsSync(path.join(target, 'Local Storage', 'leveldb', '000003.log'))).toBe(true);
    for (const skipped of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'Crashpad', 'lockfile', 'settings.json.tmp']) {
      expect(existsSync(path.join(target, skipped)), skipped).toBe(false);
    }
    const marker = JSON.parse(readFileSync(path.join(target, MIGRATION_MARKER), 'utf-8'));
    expect(marker.result).toBe('migrated');
    expect(marker.failed).toEqual([]);
    // 원본은 절대 지우지 않는다(되돌릴 수 있어야 한다).
    expect(existsSync(path.join(legacy, 'api-keys.enc'))).toBe(true);
    expect(existsSync(path.join(legacy, 'sessions', HASH, 'session.json'))).toBe(true);
  });

  it('대상에 이미 실제 세션이 있으면 건드리지 않는다(표식만 남겨 이후 재판정도 하지 않는다)', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    const otherHash = 'b'.repeat(64);
    write(path.join(target, 'sessions', otherHash, 'session.json'), '{"fileName":"new.pdf"}');
    write(path.join(target, 'settings.json'), JSON.stringify(DEFAULTS));

    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS });

    expect(r).toEqual({ action: 'skipped', reason: 'target-has-user-data', detail: 'sessions' });
    expect(existsSync(path.join(target, 'api-keys.enc'))).toBe(false);
    expect(existsSync(path.join(target, 'sessions', HASH))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(target, 'settings.json'), 'utf-8')).provider).toBe('ollama');
    expect(JSON.parse(readFileSync(path.join(target, MIGRATION_MARKER), 'utf-8')).result).toBe('skipped:sessions');
  });

  it('두 번째 실행은 표식 때문에 아무것도 하지 않는다(그 사이 대상이 비워졌어도 되살리지 않는다)', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    expect(migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS }).action).toBe('migrated');

    // 사용자가 v1.8.x 에서 세션을 전부 지웠다 — 다음 기동이 옛 세션을 되살리면 안 된다.
    rmSync(path.join(target, 'sessions'), { recursive: true, force: true });
    rmSync(path.join(target, 'api-keys.enc'));

    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS });
    expect(r).toEqual({ action: 'skipped', reason: 'marker' });
    expect(existsSync(path.join(target, 'sessions'))).toBe(false);
    expect(existsSync(path.join(target, 'api-keys.enc'))).toBe(false);
  });

  it('v1.8.0 이 한 번 돈 대상(기본값 settings·빈 sessions·Chromium 파일)은 빈 것으로 보고 이전한다', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    // 앱 내 업데이트 경로: v1.8.0 이 빈 폴더로 기동돼 위자드의 언어 토글이 settings 를 썼고
    // (영문 OS → en), 부팅 reconcile 이 빈 manifest 를 남겼으며, Chromium 이 자기 파일을 만들었다.
    write(path.join(target, 'settings.json'), JSON.stringify({ ...DEFAULTS, uiLanguage: 'en', summaryLanguage: 'en' }));
    write(path.join(target, 'sessions', 'manifest.json'), JSON.stringify({ entries: [] }));
    write(path.join(target, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'TkVXS0VZ' } }));
    write(path.join(target, 'Preferences'), '{}');
    write(path.join(target, 'lockfile'), '');

    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS });

    expect(r.action).toBe('migrated');
    // 옛 Local State 로 **덮어써야** 옛 api-keys.enc 가 풀린다.
    expect(readFileSync(path.join(target, 'Local State'), 'utf-8')).toContain('RFBBUEk=');
    expect(JSON.parse(readFileSync(path.join(target, 'settings.json'), 'utf-8')).provider).toBe('claude');
    expect(existsSync(path.join(target, 'sessions', HASH, 'session.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(target, 'sessions', 'manifest.json'), 'utf-8')).entries).toHaveLength(1);
  });

  it('대상 settings 가 기본값이 아니면(사용자가 v1.8.x 에서 설정함) 이전하지 않는다', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    write(path.join(target, 'settings.json'), JSON.stringify({ ...DEFAULTS, model: 'qwen3.5:4b' }));

    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS });
    expect(r).toEqual({ action: 'skipped', reason: 'target-has-user-data', detail: 'settings' });
    expect(JSON.parse(readFileSync(path.join(target, 'settings.json'), 'utf-8')).model).toBe('qwen3.5:4b');
  });

  it('대상에 api-keys.enc 나 컬렉션이 있으면 이전하지 않는다', () => {
    for (const [file, content, detail] of [
      ['api-keys.enc', 'x', 'api-keys'],
      ['collections.json', JSON.stringify({ schemaVersion: 1, collections: [{ id: 'n' }] }), 'collections'],
    ] as const) {
      const { legacy, target } = makeAppData();
      seedLegacy(legacy);
      write(path.join(target, file), content);
      expect(migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS }))
        .toEqual({ action: 'skipped', reason: 'target-has-user-data', detail });
    }
  });

  it('대상 settings 를 읽을 수 없으면(손상) 보수적으로 사용자 데이터로 본다', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    write(path.join(target, 'settings.json'), '{not json');
    expect(migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS }))
      .toEqual({ action: 'skipped', reason: 'target-has-user-data', detail: 'settings' });
  });

  it('복사 중 오류가 나도 throw 하지 않고 실패 항목을 기록한다', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    const log = vi.fn();
    vi.spyOn(fs, 'cpSync').mockImplementation(() => { throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' }); });

    let r: ReturnType<typeof migrateLegacyUserData> | undefined;
    expect(() => { r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS, log }); }).not.toThrow();
    expect(r!.action).toBe('migrated');
    if (r!.action === 'migrated') {
      expect(r!.copied).toEqual([]);
      expect(r!.failed).toContain('api-keys.enc');
      expect(r!.failed).toContain('Local State');
    }
    expect(log).toHaveBeenCalled();
  });

  it('원본 목록조차 읽지 못하면 error 로 끝나고 표식을 쓰지 않는다(다음 기동에 재시도)', () => {
    const { legacy, target } = makeAppData();
    seedLegacy(legacy);
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });

    const r = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, defaults: DEFAULTS, log: () => {} });
    expect(r.action).toBe('error');
    vi.restoreAllMocks();
    expect(existsSync(path.join(target, MIGRATION_MARKER))).toBe(false);
  });

  it('원본과 대상이 같은 경로면 아무것도 하지 않는다', () => {
    const { legacy } = makeAppData();
    seedLegacy(legacy);
    expect(migrateLegacyUserData({ legacyDir: legacy, targetDir: legacy, defaults: DEFAULTS }))
      .toEqual({ action: 'skipped', reason: 'same-dir' });
    expect(existsSync(path.join(legacy, MIGRATION_MARKER))).toBe(false);
  });
});

describe('findUserData', () => {
  it('빈 manifest 만 있는 sessions 는 사용자 데이터가 아니다', () => {
    const { target } = makeAppData();
    write(path.join(target, 'sessions', 'manifest.json'), JSON.stringify({ entries: [] }));
    expect(findUserData(target, DEFAULTS)).toBeNull();
  });

  it('manifest 에 항목이 있으면 디렉터리가 없어도 사용자 데이터로 본다', () => {
    const { target } = makeAppData();
    write(path.join(target, 'sessions', 'manifest.json'), JSON.stringify({ entries: [{ docHash: HASH }] }));
    expect(findUserData(target, DEFAULTS)).toBe('sessions');
  });

  it('settings 에 모르는 키가 있으면 사용자 데이터로 본다', () => {
    const { target } = makeAppData();
    write(path.join(target, 'settings.json'), JSON.stringify({ ...DEFAULTS, futureKey: 1 }));
    expect(findUserData(target, DEFAULTS)).toBe('settings');
  });

  it('summaryLanguage 가 ko/en 이 아니면(사용자가 고름) 사용자 데이터로 본다', () => {
    const { target } = makeAppData();
    write(path.join(target, 'settings.json'), JSON.stringify({ ...DEFAULTS, summaryLanguage: 'ja' }));
    expect(findUserData(target, DEFAULTS)).toBe('settings');
  });

  it('빈 컬렉션 목록은 사용자 데이터가 아니다', () => {
    const { target } = makeAppData();
    write(path.join(target, 'collections.json'), JSON.stringify({ schemaVersion: 1, collections: [] }));
    expect(findUserData(target, DEFAULTS)).toBeNull();
  });
});

describe('removeLegacyUpdaterCache', () => {
  it('옛 업데이터 캐시 폴더만 정확히 지우고 현재 앱의 캐시는 건드리지 않는다', async () => {
    const local = mkdtempSync(path.join(tmpdir(), 'udm-local-'));
    tmpDirs.push(local);
    write(path.join(local, LEGACY_UPDATER_CACHE_DIR_NAME, 'pending', 'Setup.exe'), 'x'.repeat(1024));
    write(path.join(local, 'local-doc-analyzer-updater', 'pending', 'Setup.exe'), 'y');

    expect(await removeLegacyUpdaterCache(local)).toBe(true);
    expect(existsSync(path.join(local, LEGACY_UPDATER_CACHE_DIR_NAME))).toBe(false);
    expect(existsSync(path.join(local, 'local-doc-analyzer-updater', 'pending', 'Setup.exe'))).toBe(true);
  });

  it('폴더가 없으면 false, 오류가 나도 throw 하지 않는다', async () => {
    const local = mkdtempSync(path.join(tmpdir(), 'udm-local-'));
    tmpDirs.push(local);
    expect(await removeLegacyUpdaterCache(local)).toBe(false);
    write(path.join(local, LEGACY_UPDATER_CACHE_DIR_NAME, 'x'), 'x');
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(removeLegacyUpdaterCache(local, () => {})).resolves.toBe(false);
  });
});
