// @vitest-environment happy-dom

/**
 * QA34(H1): SummaryViewer 가 인용 슬롯에 마운트할 수 있는 **모든** 패널이 닫힌다.
 *
 * v1.8.0 의 DocTextViewerPanel 은 PdfViewerPanel 이 가진 ✕ 버튼·Escape·포커스 반환·region
 * 랜드마크를 하나도 갖지 않았다 — DOCX 에서 인용을 누르면 패널을 닫을 방법이 없었다. 패널별
 * 테스트는 각자 있었지만 "형제가 같은 계약을 지키는가" 를 묻는 테스트가 없었다.
 *
 * 패널 목록은 열거하지 않고 SummaryViewer.tsx 소스에서 **도출**한다(`<XxxPanel />` 마운트 +
 * `import { XxxPanel } from './Mod'`). 세 번째 뷰어(PPTX 등)가 슬롯에 붙는 순간 자동으로
 * 이 계약의 대상이 된다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { stripJsComments } from '../../../shared/__tests__/helpers/source-scan';

vi.mock('pdfjs-dist', () => {
  const page = {
    getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    cleanup: () => {},
  };
  return {
    GlobalWorkerOptions: { workerSrc: 'mock-worker' },
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 2, getPage: () => Promise.resolve(page), destroy: () => Promise.resolve() }),
      destroy: () => Promise.resolve(),
    }),
  };
});

import { useAppStore } from '../../lib/store';
import { t } from '../../lib/i18n';
import { setCitationReturnFocus } from '../../lib/citation-focus';

const SUMMARY_VIEWER = resolve('src/renderer/components/SummaryViewer.tsx');

/** SummaryViewer 가 마운트하는 `*Panel` 과 그 모듈을 소스에서 도출한다. */
function derivePanels(src: string): { name: string; module: string }[] {
  const code = stripJsComments(src);
  const mounted = new Set([...code.matchAll(/<(\w+Panel)\s*\/>/g)].map((m) => m[1]!));
  const imports = new Map(
    [...code.matchAll(/import\s*\{\s*(\w+Panel)\s*\}\s*from\s*'\.\/(\w+)'/g)].map((m) => [m[1]!, m[2]!]),
  );
  return [...mounted].map((name) => {
    const module = imports.get(name);
    if (!module) throw new Error(`${name} 의 import 를 찾지 못했다 — 도출 정규식을 확인할 것`);
    return { name, module };
  });
}

const modules = import.meta.glob('../*.tsx');

async function loadPanel(p: { name: string; module: string }): Promise<ComponentType> {
  const loader = modules[`../${p.module}.tsx`];
  if (!loader) throw new Error(`모듈 없음: ${p.module}`);
  const mod = (await loader()) as Record<string, ComponentType>;
  const C = mod[p.name];
  if (!C) throw new Error(`${p.module} 에 ${p.name} 내보내기가 없다`);
  return C;
}

const panels = derivePanels(readFileSync(SUMMARY_VIEWER, 'utf-8'));

function openPanelState(): void {
  // 두 패널이 동시에 렌더 가능한 상태 — PDF 는 상주 바이트(목 pdfjs), 텍스트 뷰어는 pageTexts.
  useAppStore.setState((s) => ({
    settings: { ...s.settings, uiLanguage: 'ko' },
    document: {
      id: 'd1', fileName: 'x.pdf', filePath: 'x.pdf', pageCount: 2,
      extractedText: 'a\n\nb', pageTexts: ['a', 'b'], chapters: [], images: [], createdAt: new Date(),
    },
    pdfBytes: new Uint8Array([1, 2, 3]),
    citationTarget: { page: 1 },
    citationJumpNonce: 0,
    pdfViewerZoom: 1,
  }));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  openPanelState();
});
afterEach(async () => {
  cleanup();
  // 닫기는 포커스 반환을 rAF 로 미룬다 — 앞 테스트의 대기 중 프레임이 다음 테스트가 등록한
  // 트리거를 먼저 소비하지 않도록 한 프레임을 흘려보낸다(FIFO).
  await new Promise((r) => requestAnimationFrame(() => r(null)));
});

describe('인용 패널 도출 (자기 점검)', () => {
  it('SummaryViewer 에서 PDF·텍스트 뷰어 패널이 모두 도출된다', () => {
    // 양성 표본: 도출 정규식이 구조적으로 아무것도 못 잡게 되면(빈 목록) 아래 each 가 0건이
    // 돼 조용히 초록이 된다 — 알려진 두 패널이 반드시 잡혀야 한다.
    const names = panels.map((p) => p.name).sort();
    expect(names).toEqual(expect.arrayContaining(['DocTextViewerPanel', 'PdfViewerPanel']));
  });

  it('도출 함수가 합성 소스에서 마운트와 import 를 짝짓는다', () => {
    const src = "import { FooPanel } from './Foo';\n// <GhostPanel />\nconst x = <FooPanel />;";
    expect(derivePanels(src)).toEqual([{ name: 'FooPanel', module: 'Foo' }]);
  });
});

describe.each(panels)('$name — 닫기 계약', (p) => {
  it('region 랜드마크(원문 보기)로 노출된다', async () => {
    const Panel = await loadPanel(p);
    render(<Panel />);
    expect(screen.getByRole('region', { name: t('pdfviewer.title') })).toBeTruthy();
  });

  it('✕ 버튼 → citationTarget 해제', async () => {
    const Panel = await loadPanel(p);
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(screen.getByRole('button', { name: t('pdfviewer.close') }));
    expect(useAppStore.getState().citationTarget).toBeNull();
  });

  it('Escape → citationTarget 해제', async () => {
    const Panel = await loadPanel(p);
    render(<Panel />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useAppStore.getState().citationTarget).toBeNull();
  });

  it('닫으면 트리거(인용 버튼)로 포커스를 돌려준다', async () => {
    const Panel = await loadPanel(p);
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    try {
      setCitationReturnFocus(trigger);
      render(<Panel />);
      await user.click(screen.getByRole('button', { name: t('pdfviewer.close') }));
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      trigger.remove();
    }
  });
});
