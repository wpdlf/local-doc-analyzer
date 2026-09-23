import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { launchElectron, sendDropPath, cleanupDir } from './helpers';

/**
 * E2E — 업로드 에러 경로(결정적, AI 비의존).
 *
 * 단위 테스트(pdf-parser-handle/PdfUploader)가 mock 으로 검증하는 두 거부 경로를 실제 Electron
 * 에서 main↔renderer IPC + 실 pdfjs 파싱을 거쳐 사용자에게 보이는 에러 배너까지 검증한다.
 *   (1) 텍스트 없는(스캔성) PDF + OCR 비활성 → PDF_NO_TEXT
 *   (2) 매직바이트 불일치(위장 바이너리) → DOC_CORRUPT("손상되었거나 다른 형식일 수 있습니다")
 *
 * (2)의 기대 문구는 다중 포맷 입력 계획의 Task9(24b33ac, handlePdfData → document-open 이동)
 * 이후 바뀌었다. 단일 PDF 게이트였던 시절엔 "유효한 PDF 파일이 아닙니다"(pdf.invalidFile)를
 * 냈지만, 지금은 zip 매직도 아닌 입력을 "PDF 도 아니고 지원 포맷(zip 컨테이너)도 아님" 으로
 * 정확히 분류해 doc.corrupt 를 낸다(document-open.ts 의 `!hasZipMagic` 분기 — .pdf 로 드롭한
 * 사용자에게 "지원 형식: PDF" 라고만 답하면 오도되므로 손상/형식불일치로 안내한다는 그 설계
 * 그대로다). 이 스펙은 그 개통 커밋 이후 갱신되지 않아 옛 문구를 계속 찾다가 실패하고 있었다.
 */

/** 텍스트가 없는 유효한 PDF(빈 페이지) — 파서의 PDF_NO_TEXT(50자 미만) 경로 트리거. */
async function makeEmptyPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // drawText 없음 → 추출 텍스트 0
  return Buffer.from(await doc.save());
}

test('텍스트 없는 PDF + OCR 비활성 → PDF_NO_TEXT 에러 배너', async () => {
  test.setTimeout(90000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-err1-'));
  const r = await launchElectron(userDataDir, {
    provider: 'claude', uiLanguage: 'ko', theme: 'light', enableOcrFallback: false,
  });
  try {
    await expect(r.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    const empty = await makeEmptyPdf();
    await sendDropPath(r.app, '/tmp/scan.pdf', empty.toString('base64'));
    // OCR 비활성 → 추출 실패가 OCR 로 넘어가지 않고 즉시 PDF_NO_TEXT 배너로 수렴
    await expect(r.page.getByText(/텍스트를 추출할 수 없습니다/)).toBeVisible({ timeout: 30000 });
    // 에러 경로라도 처리되지 않은(uncaught) 렌더러 예외는 없어야 한다(다른 결정적 스펙과 동일 가드).
    expect(r.pageErrors, `렌더러 에러: ${r.pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await r.app.close().catch(() => { /* 이미 종료 */ });
    cleanupDir(userDataDir);
  }
});

test('매직바이트 불일치(위장 바이너리) → 손상/형식불일치 거부 배너', async () => {
  test.setTimeout(90000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-err2-'));
  const r = await launchElectron(userDataDir, { provider: 'claude', uiLanguage: 'ko', theme: 'light' });
  try {
    await expect(r.page.getByText('문서를 여기에 드래그하거나')).toBeVisible({ timeout: 15000 });
    // %PDF- 로도 zip 로컬 파일 헤더(PK\x03\x04)로도 시작하지 않는 바이트 — document-open.ts 의
    // 매직바이트 게이트가 pdfjs/추출기 진입 전에 거부한다.
    const notPdf = Buffer.from('This is plainly not a PDF document, just some plain text bytes.', 'utf-8');
    await sendDropPath(r.app, '/tmp/fake.pdf', notPdf.toString('base64'));
    await expect(r.page.getByText('파일이 손상되었거나 다른 형식일 수 있습니다.')).toBeVisible({ timeout: 15000 });
    expect(r.pageErrors, `렌더러 에러: ${r.pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  } finally {
    await r.app.close().catch(() => { /* 이미 종료 */ });
    cleanupDir(userDataDir);
  }
});
