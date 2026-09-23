/**
 * Task 9: 진입 게이트(드롭 URL·다이얼로그 필터·재읽기·DOM 드롭)가 전부
 * document-formats.ts 단일 출처를 쓰도록 옮기는 리팩터의 회귀 넷.
 *
 * 이 테스트는 게이트 교체 **전후로 모두 통과**해야 한다 — 교체가 동작을
 * 바꾸지 않았다는 증거다.
 *
 * fix-round1(item3): 아래 첫 describe 는 document-formats.ts 만 찍어본다 — main/index.ts 나
 * App.tsx 를 한 번도 import 하지 않으므로, 마이그레이션이 아예 없었어도 동일하게 통과했을
 * 것이다("전후 통과"의 증거가 되지 못한다는 리뷰 지적). 두 번째 describe 가 실제
 * `createWindow()` 의 `will-navigate` 리스너를 구동해 실물 게이트를 검증한다
 * (모킹 패턴은 window-lifecycle.test.ts:147 을 따른다).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSupportedExtension, DIALOG_FILTERS } from '../../shared/document-formats';

describe('진입 게이트가 받아들이는 것 / 막는 것 (순수 함수)', () => {
  it('PDF 는 계속 통과한다 (회귀 방지)', () => {
    expect(isSupportedExtension('C:/x/a.pdf')).toBe(true);
    expect(isSupportedExtension('file:///C:/x/a.PDF')).toBe(true);
  });

  it('DOCX 가 통과한다', () => {
    expect(isSupportedExtension('C:/x/보고서.docx')).toBe(true);
  });

  it('아직 지원하지 않는 포맷은 막는다 (P4 에서 열린다)', () => {
    for (const p of ['a.pptx', 'a.hwpx', 'a.epub', 'a.hwp']) {
      expect(isSupportedExtension(p), p).toBe(false);
    }
  });

  it('실행 파일·스크립트는 막는다', () => {
    for (const p of ['a.exe', 'a.bat', 'a.js', 'a.pdf.exe']) {
      expect(isSupportedExtension(p), p).toBe(false);
    }
  });

  it('다이얼로그 필터가 비어 있지 않다 (빈 필터는 모든 파일을 고르게 한다)', () => {
    expect(DIALOG_FILTERS.length).toBeGreaterThan(0);
    expect(DIALOG_FILTERS[0]!.extensions.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 아래부터는 createWindow() 를 실제로 실행해 will-navigate 드롭 게이트를 구동한다.
// electron 모킹은 window-lifecycle.test.ts 와 같은 모양이지만, 그쪽 FakeWebContents.on() 은
// no-op 스텁이라 will-navigate 핸들러를 캡처하지 못한다 — 여기서는 실제로 캡처하도록 고쳤다.
// ─────────────────────────────────────────────────────────────────────────────

const H = vi.hoisted(() => {
  interface FakeEvent { defaultPrevented: boolean; preventDefault(): void }
  class FakeWebContents {
    sent: { channel: string; payload: unknown }[] = [];
    send(channel: string, payload?: unknown) { this.sent.push({ channel, payload }); }
    setWindowOpenHandler() {}
    openDevTools() {}
    closeDevTools() {}
    reload() {}
    session = {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    };
    private handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    on(event: string, fn: (...a: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    /** 캡처된 리스너를 실제 이벤트처럼 구동한다. */
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
  }
  class FakeBrowserWindow {
    static getAllWindows(): FakeBrowserWindow[] { return []; }
    static fromWebContents() { return { isDestroyed: () => false }; }
    destroyed = false;
    webContents = new FakeWebContents();
    private handlers = new Map<string, ((e: FakeEvent) => void)[]>();
    on(event: string, fn: (e: FakeEvent) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    once(event: string, fn: (e: FakeEvent) => void) { this.on(event, fn); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
  }
  return {
    FakeBrowserWindow,
    fsp: {
      lstat: vi.fn(),
      stat: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(), rename: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), unlink: vi.fn(), readdir: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    on: vi.fn(),
    once: vi.fn(),
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getLocale: () => 'ko-KR',
  },
  BrowserWindow: H.FakeBrowserWindow,
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } }) },
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('../ai-service', () => ({
  generate: vi.fn(), abortGenerate: vi.fn(), abortAllRequests: vi.fn(), checkAvailability: vi.fn(),
  analyzeImage: vi.fn(), analyzeImageForOcr: vi.fn(), generateEmbeddings: vi.fn(),
  checkEmbeddingAvailability: vi.fn(), cleanupAiService: vi.fn(),
  registerEmbedRequest: vi.fn(), unregisterEmbedRequest: vi.fn(), GEMINI_EMBED_MODEL: 'gemini-embedding-2',
}));
vi.mock('../ollama-manager', () => ({ OllamaManager: class { stop = vi.fn(); healthCheck = vi.fn(); killPullProcess = vi.fn(); } }));
vi.mock('../api-keys-store', () => ({ ApiKeyStore: class { read = vi.fn(); load = vi.fn(); save = vi.fn(); delete = vi.fn(); invalidate = vi.fn(); } }));
vi.mock('../settings-store', () => ({ loadSettings: vi.fn(async () => ({})), saveSettings: vi.fn() }));
vi.mock('fs/promises', () => ({ default: H.fsp }));

import { createWindow } from '../index';

/** file:// URL 을 만든다(테스트 전용 — 실 코드의 pathToFileURL 대체가 아니다). */
const fileUrl = (winPath: string) => `file:///${winPath.replace(/\\/g, '/')}`;

describe('createWindow() 의 will-navigate 드롭 게이트 (실물 배선 검증)', () => {
  beforeEach(() => {
    H.fsp.lstat.mockReset().mockResolvedValue({ isSymbolicLink: () => false });
    H.fsp.stat.mockReset().mockResolvedValue({ isFile: () => true, size: 1000 });
    H.fsp.readFile.mockReset().mockResolvedValue(Buffer.from('fake bytes'));
  });

  function drop(url: string) {
    const win = createWindow() as unknown as InstanceType<typeof H.FakeBrowserWindow>;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.webContents.emit('will-navigate', event, url);
    return { win, event };
  }

  it('.exe 드롭은 file:dropped 를 보내지 않는다 (fs 접근도 없다)', async () => {
    const { win, event } = drop(fileUrl('C:/x/a.exe'));
    await Promise.resolve();
    await Promise.resolve();

    expect(event.defaultPrevented, '네비게이션 자체는 항상 막아야 한다').toBe(true);
    expect(win.webContents.sent.some((s) => s.channel === 'file:dropped')).toBe(false);
    expect(H.fsp.lstat, '확장자 게이트를 통과하지 못하면 fs 접근도 없어야 한다').not.toHaveBeenCalled();
  });

  it('.docx 드롭은 file:dropped 를 보낸다 (P1 신규 포맷 통과)', async () => {
    const { win } = drop(fileUrl('C:/x/report.docx'));
    // will-navigate 핸들러 내부는 lstat→stat→readFile 순 비동기 체인 — 각 await 뒤로 진행되도록
    // 마이크로태스크를 여러 번 흘려보낸다.
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(win.webContents.sent.some((s) => s.channel === 'file:dropped'), 'docx 는 확장자 게이트를 통과해야 한다').toBe(true);
    expect(H.fsp.readFile).toHaveBeenCalled();
  });
});
