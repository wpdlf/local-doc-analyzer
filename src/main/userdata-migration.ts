import fs from 'fs';
import path from 'path';

/**
 * 개명 이전 userData 의 1회성 자동 이전 — QA34(High), v1.8.1.
 *
 * ## 왜 필요한가
 * v1.8.0 에서 appId/name 이 `summary-lecture-material` → `local-doc-analyzer` 로 바뀌었다. 옛
 * 저장소 URL 은 새 저장소로 301 리다이렉트되므로 **v1.7.x 의 앱 내 업데이터가 v1.8.0 을 그대로
 * 받는다**. NSIS 는 appId 가 달라 이를 **나란히 설치**하고 곧바로 실행하는데, 그때 userData 는
 * 새 이름의 빈 폴더(`%APPDATA%\local-doc-analyzer`)라 세션·설정·API 키가 전부 사라진 것처럼
 * 보인다. 릴리즈 노트의 "첫 실행 전에 폴더를 옮기세요" 는 이 경로에서는 **불가능**하다 — 설치
 * 직후 자동 실행되므로 사용자가 끼어들 틈이 없다. 그래서 앱이 스스로 옮긴다.
 *
 * ## 호출 시점 — 반드시 동기, 반드시 main 스크립트 최상위
 * API 키는 `safeStorage` 로 암호화돼 `api-keys.enc` 에 있고, Windows 의 safeStorage(OSCrypt)는
 * **userData 의 `Local State` 안 `os_crypt.encrypted_key`**(DPAPI 로 감싼 AES 키)로 복호화한다.
 * 즉 api-keys.enc 만 옮기면 새 프로파일의 새 키로는 풀리지 않는다 — Local State 가 함께 가야 한다.
 * 그런데 Chromium 은 Local State 를 **main 스크립트의 최상위 동기 실행이 끝난 직후**(Electron 의
 * PostEarlyInitialization → BrowserProcess 초기화) 읽어 메모리에 올린다. 그 뒤에 파일을 바꾸면
 * 이번 실행에는 반영되지 않고, 종료 시 메모리 사본이 디스크를 되덮는다. 그래서:
 *   - 이 함수는 **동기 fs 만** 쓴다(await 하는 순간 Chromium 초기화가 먼저 끝날 수 있다).
 *   - index.ts 의 최상위(`app.whenReady()` 등록 전, userData 오버라이드·단일 인스턴스 잠금 직후)
 *     에서 호출한다. 순서는 e2e/userdata-migration.spec.ts 가 실제 키 복호화로 검증한다.
 *
 * ## "대상에 사용자 데이터가 없다" 의 정의(findUserData)
 * 가장 흔한 실제 경로는 "v1.8.0 이 빈 폴더로 **이미 한 번 돌았다**" 이다. 그 실행이 남기는 것:
 *   - Chromium 프로파일 파일(Local State·Preferences·Local Storage 등) — 사용자 데이터 아님, 무시
 *   - `lockfile`(단일 인스턴스 잠금) — 무시
 *   - `sessions/manifest.json` 의 빈 목록(부팅 reconcile) — 항목이 없으면 비었다
 *   - `settings.json` — 위자드의 언어 토글이 쓴다. 로캘/토글로 갈리는 uiLanguage·summaryLanguage
 *     의 ko/en 만 허용하고 나머지가 전부 기본값이면 비었다
 * 반대로 다음 중 하나라도 있으면 **사용자가 새 버전에서 이미 무언가를 만든 것**이므로 절대
 * 덮지 않는다: 세션 디렉터리/manifest 항목, api-keys.enc(존재만으로 — 복호화 없이는 내용이 빈지
 * 알 수 없다), 컬렉션 1개 이상, 기본값이 아닌 settings. 읽을 수 없거나 손상된 파일도 사용자
 * 데이터로 본다(보수적 — 덮어써서 잃는 것이 옮기지 못해 불편한 것보다 항상 나쁘다).
 *
 * ## 1회성
 * 판정이 끝나면(이전했든, 대상에 데이터가 있어 건너뛰었든) 대상에 표식 파일을 남긴다. 사용자가
 * v1.8.x 에서 세션을 전부 지운 뒤 다음 기동에서 옛 세션이 되살아나면 안 되기 때문이다. 원본
 * 폴더는 절대 지우지 않는다(되돌릴 수 있어야 한다). 원본 목록조차 못 읽은 경우만 표식 없이
 * 끝내 다음 기동에 재시도한다.
 *
 * electron 을 import 하지 않는다 — 경로를 주입받아 임시 폴더로 단위 테스트한다.
 */

/** v1.7.x 까지의 package.json name — Electron 이 userData 폴더명으로 쓴 값. */
export const LEGACY_APP_DIR_NAME = 'summary-lecture-material';
/** v1.7.x electron-updater 의 캐시 폴더(`%LOCALAPPDATA%` 아래) — 인스톨러 사본 ~113MB 가 고아로 남는다. */
export const LEGACY_UPDATER_CACHE_DIR_NAME = `${LEGACY_APP_DIR_NAME}-updater`;
/** 대상 userData 에 남기는 1회성 표식. */
export const MIGRATION_MARKER = `.migrated-from-${LEGACY_APP_DIR_NAME}`;

/**
 * 옮기지 않는 최상위 항목(소문자 비교). 캐시는 재생성되고 용량만 크며, 잠금·크래시 덤프는
 * 옛 프로세스의 런타임 산물이라 새 프로파일에 들어가면 오히려 해롭다.
 */
const SKIP_ENTRIES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'grshadercache',
  'graphitedawncache',
  'shadercache',
  'blob_storage',
  'crashpad',
  'logs',
  'lockfile',
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
  MIGRATION_MARKER.toLowerCase(),
]);

/** 로캘 기본값이나 위자드 토글로 v1.8.0 이 스스로 쓸 수 있는 값 — 사용자 선택으로 보지 않는다. */
const LOCALE_KEYS = new Set(['uiLanguage', 'summaryLanguage']);
const LOCALE_VALUES = new Set(['ko', 'en']);

export type MigrationOutcome =
  | { action: 'skipped'; reason: 'no-source' | 'same-dir' | 'marker' }
  | { action: 'skipped'; reason: 'target-has-user-data'; detail: string }
  | { action: 'migrated'; copied: string[]; failed: string[] }
  | { action: 'error'; error: string };

export interface MigrationOptions {
  legacyDir: string;
  targetDir: string;
  /** main/index.ts 의 defaultSettings — 대상 settings.json 이 "손대지 않은 기본값" 인지 판정한다. */
  defaults: Readonly<Record<string, unknown>>;
  log?: (msg: string, err?: unknown) => void;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function isDefaultSettings(file: string, defaults: Readonly<Record<string, unknown>>): boolean {
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) return false;
    if (LOCALE_KEYS.has(key)) {
      if (typeof val !== 'string' || !LOCALE_VALUES.has(val)) return false;
      continue;
    }
    if (JSON.stringify(val) !== JSON.stringify(defaults[key])) return false;
  }
  return true;
}

/**
 * 대상 userData 에 사용자 데이터가 있으면 그 종류를, 없으면 null 을 반환한다(판정 규칙은 파일
 * 머리 주석). 읽기 실패·손상은 해당 종류가 "있다" 로 본다.
 */
export function findUserData(targetDir: string, defaults: Readonly<Record<string, unknown>>): string | null {
  if (fs.existsSync(path.join(targetDir, 'api-keys.enc'))) return 'api-keys';

  const sessionsDir = path.join(targetDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    try {
      const dirents = fs.readdirSync(sessionsDir, { withFileTypes: true });
      if (dirents.some((d) => d.isDirectory())) return 'sessions';
      if (dirents.some((d) => d.name === 'manifest.json')) {
        const m = readJson(path.join(sessionsDir, 'manifest.json')) as { entries?: unknown } | null;
        if (!m || !Array.isArray(m.entries) || m.entries.length > 0) return 'sessions';
      }
    } catch {
      return 'sessions';
    }
  }

  const collectionsFile = path.join(targetDir, 'collections.json');
  if (fs.existsSync(collectionsFile)) {
    try {
      const c = readJson(collectionsFile) as { collections?: unknown } | null;
      if (!c || !Array.isArray(c.collections) || c.collections.length > 0) return 'collections';
    } catch {
      return 'collections';
    }
  }

  const settingsFile = path.join(targetDir, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      if (!isDefaultSettings(settingsFile, defaults)) return 'settings';
    } catch {
      return 'settings';
    }
  }
  return null;
}

function writeMarker(targetDir: string, body: Record<string, unknown>, log: MigrationOptions['log']): void {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, MIGRATION_MARKER),
      JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2),
      'utf-8',
    );
  } catch (err) {
    // 표식을 못 쓰면 다음 기동이 다시 판정한다 — 그때는 방금 옮긴 데이터가 "사용자 데이터" 로
    // 보여 건너뛰므로 중복 복사는 일어나지 않는다.
    log?.('[migration] 표식 기록 실패', err);
  }
}

/**
 * 옛 userData(`legacyDir`)를 현재 userData(`targetDir`)로 1회 복사한다. **절대 throw 하지 않는다**
 * — 이전 실패가 앱 기동을 막으면 데이터를 잃는 것보다 나쁘다(앱 자체를 못 쓴다).
 */
export function migrateLegacyUserData(opts: MigrationOptions): MigrationOutcome {
  const { legacyDir, targetDir, defaults } = opts;
  const log = opts.log ?? ((msg: string, err?: unknown) => console.warn(msg, err ?? ''));
  try {
    if (path.resolve(legacyDir).toLowerCase() === path.resolve(targetDir).toLowerCase()) {
      return { action: 'skipped', reason: 'same-dir' };
    }
    if (!fs.existsSync(legacyDir)) return { action: 'skipped', reason: 'no-source' };
    if (fs.existsSync(path.join(targetDir, MIGRATION_MARKER))) return { action: 'skipped', reason: 'marker' };

    const found = findUserData(targetDir, defaults);
    if (found) {
      writeMarker(targetDir, { from: legacyDir, result: `skipped:${found}` }, log);
      return { action: 'skipped', reason: 'target-has-user-data', detail: found };
    }

    const entries = fs.readdirSync(legacyDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const copied: string[] = [];
    const failed: string[] = [];
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (SKIP_ENTRIES.has(lower) || lower.endsWith('.tmp')) continue;
      try {
        // 대상의 같은 이름(v1.8.0 이 만든 기본 settings·빈 manifest·새 Local State)은 덮어쓴다 —
        // 여기까지 왔다는 것은 findUserData 가 그것들을 "비었다" 로 판정했다는 뜻이다.
        fs.cpSync(path.join(legacyDir, name), path.join(targetDir, name), {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        });
        copied.push(name);
      } catch (err) {
        failed.push(name);
        log(`[migration] 복사 실패: ${name}`, err);
      }
    }
    // 부분 실패여도 표식을 남긴다 — 재시도해도 이미 옮긴 세션 때문에 "사용자 데이터 있음" 으로
    // 건너뛰게 되므로 재시도의 이득이 없고, 실패 목록은 표식 안에 진단으로 남는다.
    writeMarker(targetDir, { from: legacyDir, result: 'migrated', copied, failed }, log);
    return { action: 'migrated', copied, failed };
  } catch (err) {
    log('[migration] 이전 중단', err);
    return { action: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * v1.7.x 업데이터 캐시(`<localAppData>\summary-lecture-material-updater`)를 지운다. 새 앱은
 * 이 폴더를 다시 쓰지 않으므로 받아 둔 인스톨러(~113MB)가 영구 고아가 된다. **정확히 그 이름의
 * 폴더만** 지우고, best-effort 다(실패해도 throw 하지 않는다). 지웠으면 true.
 */
export async function removeLegacyUpdaterCache(
  localAppDataDir: string,
  log: (msg: string, err?: unknown) => void = (msg, err) => console.warn(msg, err ?? ''),
): Promise<boolean> {
  const dir = path.join(localAppDataDir, LEGACY_UPDATER_CACHE_DIR_NAME);
  try {
    if (!fs.existsSync(dir)) return false;
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log('[migration] 옛 업데이터 캐시 삭제 실패', err);
    return false;
  }
}
