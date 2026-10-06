import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchElectron, sendDropPath, cleanupDir, openAndFlushSession, findFlushedSession, type ManifestEntry } from './helpers';
import { writeSamplePptx } from './fixtures/make-pptx';
import { writeSampleHwpx } from './fixtures/make-hwpx';
import { writeSampleHwp, writeDistributionHwp } from './fixtures/make-hwp';

/**
 * E2E — PPTX·HWPX 열기 → 인용 점프 → 단위 라벨(P4).
 *
 * 유닛 테스트는 추출기를 증명하지만 배선(document-formats 등록 → 게이트 → 지연 로드된 레지스트리 →
 * normalize → 뷰어·라벨)은 실앱에서만 끝까지 증명된다. 인용 버튼은 docx-open.spec.ts 와 같은 실제
 * 경로로 만든다: 한 번 열어 세션을 만들고 → 다른 문서로 flush → session.json 에 `[p.2]` 요약을
 * 심고 → 다시 열어 docHash 일치로 복원.
 */
const SEED = { provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light', persistSessions: true };

/**
 * fix(brief): 브리프 원문 텍스트('flush-only document', 공백 제거 19자)는 pdf-parser.ts:482 의
 * PDF_NO_TEXT 50자 하한 아래라 매 실행 OCR 폴백 → OCR_FAIL 배너로 귀결됐다(PPTX/HWPX 와 무관 —
 * 순수 PDF-드롭 두 번 반복 스펙으로 재현·격리). docx-open.spec.ts 의 실제 통과 문구(50자 이상)를
 * 따른다.
 */
async function makeFlushPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(
    'flush-only document used solely to force the office session to be persisted before app close.',
    { x: 50, y: 780, size: 12, font, maxWidth: 500 },
  );
  return Buffer.from(await doc.save());
}

/** 1차 기동으로 세션을 만들고 flush 한 뒤, 그 세션에 `[p.2]` 인용 요약을 심는다. manifest 항목을 돌려준다. */
async function seedSessionWithCitation(userDataDir: string, docsDir: string, fixture: string, header: string): Promise<ManifestEntry> {
  const r1 = await launchElectron(userDataDir, SEED);
  let flushed: ManifestEntry;
  try {
    await expect(r1.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    const flushPath = join(docsDir, 'flush.pdf');
    const flushBuf = await makeFlushPdf();
    writeFileSync(flushPath, flushBuf);
    // QA35(D5): 고정 sleep(2000/500) 대신 manifest 항목이 생길 때까지 — helpers 주석 참조.
    flushed = await openAndFlushSession(r1, { userDataDir, fixture, header, flushPath, flushBuf });
    expect(r1.pageErrors.map((e) => e.message), '1차 렌더러 에러').toEqual([]);
  } finally {
    await r1.app.close().catch(() => { /* 이미 종료 */ });
  }
  // 종료 flush 가 manifest 를 다시 쓸 수 있으므로 닫은 뒤의 디스크 상태로 다시 읽는다.
  const name = fixture.split(/[\\/]/).pop()!;
  const entry = findFlushedSession(userDataDir, name);
  if (!entry) throw new Error(`${name} 세션이 종료 후 manifest 에서 사라졌다`);
  expect(entry.docHash).toBe(flushed.docHash);
  const sessionPath = join(userDataDir, 'sessions', entry.docHash, 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as { summaries: Record<string, unknown>; summaryType: string };
  session.summaries.full = { content: '요약입니다. 근거는 [p.2] 를 보세요.', model: 'e2e-fixture', provider: 'claude' };
  session.summaryType = 'full';
  writeFileSync(sessionPath, JSON.stringify(session), 'utf-8');
  return entry;
}

async function openCitation(page: Page, name: RegExp) {
  const cite = page.getByRole('button', { name }).first();
  await expect(cite).toBeVisible({ timeout: 30000 });
  await cite.click();
  await expect(page.locator('#unit-2')).toBeVisible({ timeout: 15000 });
  return page.locator('[data-testid="doc-text-viewer"]');
}

test('PPTX — 슬라이드 순서·라벨·표·노트, 번호 필드 미유입, 전역 검색 라벨', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-pptx-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-pptx-docs-'));
  try {
    const fixture = join(docsDir, 'sample.pptx');
    writeSamplePptx(fixture);
    const entry = await seedSessionWithCitation(userDataDir, docsDir, fixture, 'sample.pptx (3슬라이드)');
    expect(entry.unitKind, 'manifest 가 unitKind 를 싣는다').toBe('slide');

    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      // 전역 검색(Task 1 실앱 증명) — 표 안 단어가 2번 슬라이드에서 "슬라이드 2" 로 표시된다.
      await r2.page.getByLabel('문서 검색').fill('영업이익');
      await r2.page.getByRole('button', { name: '검색' }).click();
      await expect(r2.page.getByText('슬라이드 2', { exact: true })).toBeVisible({ timeout: 15000 });

      await sendDropPath(r2.app, fixture, readFileSync(fixture).toString('base64'));
      await expect(r2.page.getByText('sample.pptx (3슬라이드)')).toBeVisible({ timeout: 60000 });

      const viewer = await openCitation(r2.page, /슬라이드 2 원문 열기$/);
      await expect(r2.page.locator('#unit-2')).toHaveAttribute('aria-label', '슬라이드 2');
      // 제목 자리표시자가 본문보다 앞(spTree 에서는 뒤에 있다), 노트는 인용부.
      const unit2 = await r2.page.locator('#unit-2').innerText();
      expect(unit2.indexOf('둘째 슬라이드')).toBeLessThan(unit2.indexOf('분기 실적 요약'));
      await expect(r2.page.locator('#unit-2 blockquote')).toContainText('근거 수치는 부록 참조');
      // 자기 닫힘 병합 칸(Google 형식)이 위 칸 텍스트를 이어받아 열이 밀리지 않는다.
      await expect(r2.page.locator('#unit-2 table tbody tr').first().locator('td').first()).toHaveText('항목');
      // 슬라이드 번호 필드(‹#›)가 어느 단위에도 들어가지 않는다.
      await expect(viewer).not.toContainText('‹#›');

      expect(r2.pageErrors.map((e) => e.message), '2차 렌더러 에러').toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});

test('HWPX — 쪽나눔·좌표 격자 표·글상자, shapeComment·미리보기 미유입', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwpx-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwpx-docs-'));
  try {
    const fixture = join(docsDir, 'sample.hwpx');
    writeSampleHwpx(fixture);
    await seedSessionWithCitation(userDataDir, docsDir, fixture, 'sample.hwpx (2p)');

    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
      await sendDropPath(r2.app, fixture, readFileSync(fixture).toString('base64'));
      await expect(r2.page.getByText('sample.hwpx (2p)')).toBeVisible({ timeout: 60000 });

      const viewer = await openCitation(r2.page, /2 페이지 원문 열기$/);
      await expect(r2.page.locator('#unit-2')).toContainText('상자 안 제목');
      // 세로 병합으로 가려진 칸이 XML 에 없어도 둘째 행이 [분류 | 기능 개발 | 100%] 로 맞게 놓인다.
      const row = r2.page.locator('#unit-2 table tbody tr').first().locator('td');
      await expect(row).toHaveText(['분류', '기능 개발', '100%']);
      await expect(viewer).not.toContainText('사각형입니다');

      expect(r2.pageErrors.map((e) => e.message), '2차 렌더러 에러').toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});

test('HWP — 바이너리 쪽나눔·좌표 격자 표·글상자, 배포용 안내', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwp-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'doc-analyzer-hwp-docs-'));
  try {
    const fixture = join(docsDir, 'sample.hwp');
    writeSampleHwp(fixture);
    const entry = await seedSessionWithCitation(userDataDir, docsDir, fixture, 'sample.hwp (2p)');
    expect(entry.unitKind, 'manifest 가 unitKind 를 싣는다').toBe('page');

    const r2 = await launchElectron(userDataDir, SEED);
    try {
      await expect(r2.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });

      // 배포용 문서 — 문서가 열리기 전에 떨궈 discard 확인 없이 배너만 본다.
      const dist = join(docsDir, 'dist.hwp');
      writeDistributionHwp(dist);
      await sendDropPath(r2.app, dist, readFileSync(dist).toString('base64'));
      await expect(r2.page.getByText('배포용 문서는 내용이 암호화돼 있어 열 수 없습니다', { exact: false })).toBeVisible({ timeout: 30000 });

      await sendDropPath(r2.app, fixture, readFileSync(fixture).toString('base64'));
      await expect(r2.page.getByText('sample.hwp (2p)')).toBeVisible({ timeout: 60000 });

      const viewer = await openCitation(r2.page, /2 페이지 원문 열기$/);
      await expect(r2.page.locator('#unit-2')).toContainText('상자 안 제목');
      const row = r2.page.locator('#unit-2 table tbody tr').first().locator('td');
      await expect(row).toHaveText(['분류', '기능 개발', '100%']);
      // 1쪽 본문은 1쪽에만 있다(미리보기 PrvText 는 추출 대상이 아니다 — 본문과 겹치는 문자열이라 단위로 확인).
      await expect(r2.page.locator('#unit-2')).not.toContainText('첫 쪽의 내용입니다');
      await expect(viewer).toContainText('첫 쪽의 내용입니다');

      expect(r2.pageErrors.map((e) => e.message), '2차 렌더러 에러').toEqual([]);
    } finally {
      await r2.app.close().catch(() => { /* 이미 종료 */ });
    }
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(docsDir);
  }
});
