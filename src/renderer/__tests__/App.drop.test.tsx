// @vitest-environment happy-dom

/**
 * QA34(High): 창 capture-phase DOM 드롭 핸들러(App.tsx) 의 **게이트 배선**을 실제로 걷는다.
 *
 * E2E 는 드롭을 IPC(`file:dropped`)로 주입하므로 이 경로를 한 번도 지나지 않는다 — 실사용자의
 * 드래그드롭만 여기를 탄다. 그래서 매직 선검사를 `!hasPdfMagic(header)` 하나로 되돌려도
 * (Task10 round1 Critical — 드롭한 .docx 가 openDocumentData 에 도달하지 못하던 회귀) 아무
 * 테스트도 실패하지 않았다. 이 파일은 App 을 실제로 렌더하고 window 에 합성 drop 이벤트를 쏴서
 * 확장자 게이트 → 매직 선검사 → openDocumentData 호출까지를 본다.
 *
 * 자식 컴포넌트·훅 목 구성은 App.update-banner.test.tsx 와 같다(관심사 밖의 렌더 비용 제거).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

vi.mock('../components/PdfUploader', () => ({ PdfUploader: () => null }));
vi.mock('../components/RecentDocuments', () => ({ RecentDocuments: () => null }));
vi.mock('../components/GlobalSearch', () => ({ GlobalSearch: () => null }));
vi.mock('../components/CollectionsList', () => ({ CollectionsList: () => null }));
vi.mock('../components/TabBar', () => ({ TabBar: () => null }));
vi.mock('../components/SummaryViewer', () => ({ SummaryViewer: () => null }));
vi.mock('../components/SummaryTypeSelector', () => ({ SummaryTypeSelector: () => null }));
vi.mock('../components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../components/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('../components/OllamaSetupWizard', () => ({ OllamaSetupWizard: () => null }));
vi.mock('../lib/use-summarize', () => ({
  useSummarize: () => ({ handleSummarize: vi.fn(), handleAbort: vi.fn(), getPartialRecovery: () => null }),
}));
vi.mock('../lib/use-qa', () => ({ useRagBuilder: () => undefined }));
vi.mock('../lib/use-session', () => ({ useSessionPersistence: () => undefined }));
vi.mock('../lib/safe-markdown', () => ({ prefetchMarkdownRenderer: vi.fn() }));
const openDocumentData = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock('../lib/document-open', () => ({ openDocumentData, cancelDocumentParse: vi.fn() }));
vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    update: { onStatus: () => () => {}, getState: () => Promise.resolve(null), download: vi.fn(), install: vi.fn() },
    ollama: {
      getStatus: () => Promise.resolve({ installed: true, running: true, models: ['qwen3.5:4b'] }),
      pullModel: vi.fn(),
    },
    settings: { get: () => Promise.resolve({}), set: vi.fn(() => Promise.resolve()) },
    file: { openPdf: vi.fn() },
    onFileDropped: () => () => {},
    getPathForFile: (f: File) => `/d/${f.name}`,
  },
}));

import App from '../App';
import { useAppStore } from '../lib/store';
import { DEFAULT_SETTINGS } from '../types';
import { t } from '../lib/i18n';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function fileWith(name: string, head: number[]): File {
  const body = new Uint8Array(64);
  body.set(head, 0);
  return new File([body], name);
}

/** window capture-phase 핸들러가 받는 것과 같은 모양의 합성 drop 이벤트. */
async function drop(file: File): Promise<void> {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: Object.assign([file], { item: () => file }) } });
  await act(async () => { window.dispatchEvent(ev); });
}

/** 핸들러는 async(slice().arrayBuffer() → arrayBuffer()) — 호출 또는 에러 중 하나가 착지할 때까지 기다린다. */
async function settle(): Promise<void> {
  await vi.waitFor(() => {
    const s = useAppStore.getState();
    if (openDocumentData.mock.calls.length === 0 && !s.error) throw new Error('not yet');
  });
}

beforeEach(async () => {
  openDocumentData.mockClear();
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS }, document: null, error: null, notice: null });
  await act(async () => { render(<App />); });
});

afterEach(() => { cleanup(); });

describe('App — 창 DOM 드롭 게이트 (QA34)', () => {
  it('zip 매직을 가진 .docx 는 매직 선검사를 통과해 openDocumentData 에 도달한다', async () => {
    await drop(fileWith('x.docx', ZIP_MAGIC));
    await settle();
    expect(useAppStore.getState().error, `에러 배너: ${JSON.stringify(useAppStore.getState().error)}`).toBeNull();
    expect(openDocumentData).toHaveBeenCalledTimes(1);
    expect(openDocumentData.mock.calls[0]?.[1]).toBe('x.docx');
    expect(openDocumentData.mock.calls[0]?.[2]).toBe('/d/x.docx');
  });

  it('PDF 매직의 .pdf 도 종전대로 통과한다', async () => {
    await drop(fileWith('a.pdf', PDF_MAGIC));
    await settle();
    expect(openDocumentData).toHaveBeenCalledTimes(1);
  });

  // QA34(Medium): 암호 걸린 OOXML 은 zip 이 아니라 CFB 컨테이너다. 선검사가 이를 쓰레기로 보고
  // "PDF · Word 파일만 지원됩니다" 로 거부하면 document-open 의 DOC_ENCRYPTED 안내에 닿지 못한다.
  it('CFB 매직(암호 걸린 DOCX)은 선검사를 통과해 document-open 의 암호 안내 분기로 간다', async () => {
    await drop(fileWith('secret.docx', CFB_MAGIC));
    await settle();
    expect(useAppStore.getState().error).toBeNull();
    expect(openDocumentData).toHaveBeenCalledTimes(1);
  });

  it('지원 확장자인데 내용이 쓰레기면 materialize 전에 거부한다', async () => {
    await drop(fileWith('fake.docx', [1, 2, 3, 4, 5, 6, 7, 8]));
    await settle();
    expect(openDocumentData).not.toHaveBeenCalled();
    expect(useAppStore.getState().error?.message).toBe(t('uploader.notPdf'));
  });

  // 확장자 게이트: zip 매직을 가진 .xlsx 는 매직 선검사만으로는 통과한다 — 확장자 검사가
  // 빠지면 openDocumentData 가 불린다. 그래서 이 조합이 확장자 게이트만을 겨눈다.
  it('미지원 확장자(.xlsx, zip 매직)는 확장자 게이트에서 거부된다', async () => {
    await drop(fileWith('sheet.xlsx', ZIP_MAGIC));
    await settle();
    expect(openDocumentData).not.toHaveBeenCalled();
    expect(useAppStore.getState().error?.message).toBe(t('uploader.notPdf'));
  });
});
