import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchElectron, sendDropPath, cleanupDir } from './helpers';
import { writeSampleDocx } from './fixtures/make-docx';

/**
 * E2E — DOCX 열기 → 쪽나눔 2단위 분할 → 표 렌더 → 인용 클릭 → 원문 패널 점프.
 *
 * 기존 packaged-smoke/recent-restore 등은 라틴 PDF 만 밟으므로 신규 포맷 경로(zip 판별 →
 * docxExtractor → paginate → DocTextViewerPanel)를 구조적으로 검증하지 못한다. 실물 DOCX 는
 * 개인정보가 들어 있어 커밋하지 않고, fflate 로 합성 픽스처를 그 자리에서 만든다.
 *
 * 인용 패널을 실제로 열기 위해 가짜 전역(`__APP_STORE__`)을 만들지 않는다 — 대신 이 저장소가
 * session-store 를 검증할 때 쓰는 실제 경로를 그대로 탄다: ①DOCX 를 한 번 열어 세션을 실제로
 * 만들고 ②두 번째 문서를 드롭해 그 세션을 flush 시키고 ③디스크의 session.json 에 `[p.2]` 를
 * 포함한 요약을 심고 ④같은 DOCX 를 다시 열어 docHash 일치로 세션을 복원시킨다. 그러면 요약
 * 본문에 진짜 CitationButton 이 렌더되고, 클릭하면 실제 배선(citationTarget → DocTextViewerPanel
 * 마운트 → #unit-2 스크롤)을 그대로 타게 된다 — AI 호출 없이도 인용 클릭 경로 전체가 실증된다.
 */

const SEED = { provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light', persistSessions: true };

/** 세션 flush 트리거용 두 번째 문서(내용은 무관 — document-open.ts 가 이전 문서를 flush 하고 교체). */
async function makeFlushPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(
    'flush-only document used solely to force the DOCX session to be persisted before app close.',
    { x: 50, y: 780, size: 12, font, maxWidth: 500 },
  );
  return Buffer.from(await doc.save());
}

interface SessionManifest {
  entries: { docHash: string; fileName: string }[];
}

test('DOCX 를 열면 쪽나눔으로 2단위가 나뉘고 표가 표로 렌더되며 인용 클릭이 해당 단위로 점프한다', async () => {
  test.setTimeout(150000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'lpa-docx-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'lpa-docx-docs-'));
  try {
    const fixture = join(docsDir, 'sample.docx');
    writeSampleDocx(fixture);
    const docxBuf = readFileSync(fixture);

    // ── 1차 기동: DOCX 파싱 → 두 번째 문서 드롭으로 flush(recent-restore.spec.ts 와 동일 계약) ──
    const r1 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r1.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      await sendDropPath(r1.app, fixture, docxBuf.toString('base64'));
      // 쪽나눔 1회 → 2단위로 갈렸다는 사실이 헤더의 페이지 수 표기에 그대로 드러난다.
      await expect(r1.page.getByText('sample.docx (2p)')).toBeVisible({ timeout: 60000 });
      // A 의 세션 복원(restore-pending)이 settle 되어야 다음 드롭의 flush 가 A 를 저장한다.
      await r1.page.waitForTimeout(2000);

      const flushPath = join(docsDir, 'flush.pdf');
      const flushBuf = await makeFlushPdf();
      writeFileSync(flushPath, flushBuf);
      await sendDropPath(r1.app, flushPath, flushBuf.toString('base64'));
      await expect(r1.page.getByText('flush.pdf (1p)')).toBeVisible({ timeout: 30000 });
      await r1.page.waitForTimeout(500);

      expect(r1.pageErrors.map((e) => e.message), '1차 렌더러 에러').toEqual([]);
    } finally {
      await r1.app.close().catch(() => { /* 이미 종료 */ });
    }

    // ── DOCX 의 docHash 를 manifest 에서 찾아 session.json 에 인용 포함 요약을 심는다 ──
    const manifestPath = join(userDataDir, 'sessions', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SessionManifest;
    const entry = manifest.entries.find((e) => e.fileName === 'sample.docx');
    if (!entry) throw new Error('sample.docx 세션이 flush 되지 않았다 — manifest 에 항목이 없음');

    const sessionPath = join(userDataDir, 'sessions', entry.docHash, 'session.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      summaries: Record<string, unknown>;
      summaryType: string;
    };
    session.summaries.full = {
      content: '요약 결과입니다. 둘째 쪽의 표는 [p.2] 를 참고하세요.',
      model: 'e2e-fixture',
      provider: 'claude',
    };
    session.summaryType = 'full';
    writeFileSync(sessionPath, JSON.stringify(session), 'utf-8');

    // ── 2차 기동: 같은 DOCX 를 다시 드롭 → docHash 일치 → 세션 복원 → 진짜 인용 버튼 등장 ──
    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('PDF 파일을 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      await sendDropPath(r2.app, fixture, docxBuf.toString('base64'));
      await expect(r2.page.getByText('sample.docx (2p)')).toBeVisible({ timeout: 60000 });

      // 인용 클릭 전에는 원문 패널이 없다(showCitationPanel === citationTarget !== null).
      await expect(r2.page.locator('[data-testid="doc-text-viewer"]')).toHaveCount(0);

      // safe-markdown 은 lazy-load 라 Suspense 폴백(plain div)에도 "[p.2]" 문자열 자체는 먼저
      // 보인다 — 문자열이 아니라 실제 버튼 엘리먼트가 뜰 때까지 기다린다.
      const cite = r2.page.getByRole('button', { name: /페이지 원문 열기$/ }).first();
      await expect(cite).toBeVisible({ timeout: 30000 });
      await cite.click();

      // 쪽나눔으로 나온 2번째 단위로 점프했다.
      await expect(r2.page.locator('#unit-2')).toBeVisible({ timeout: 15000 });
      // 표가 GFM 으로 직렬화돼 실제 <table> 로 렌더된다(2번째 단위 안에 있다).
      await expect(r2.page.locator('[data-testid="doc-text-viewer"] table')).toBeVisible({ timeout: 15000 });

      expect(r2.pageErrors.map((e) => e.message), '2차 렌더러 에러').toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});
