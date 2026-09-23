import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { sendDropPath } from './helpers';

/**
 * 패키징된 앱(asar) 실행 스모크.
 *
 * 다른 E2E 스펙은 `electron.launch({ args: ['.'] })` 로 **소스 트리의 out/ 를 직접** 실행하므로,
 * 리포지토리의 node_modules 가 그대로 보인다. 즉 "asar 에 어떤 패키지가 들어갔는가"를 전혀
 * 검증하지 못한다 — dependencies 를 devDependencies 로 옮겨 asar 에서 제외해도(인스톨러 크기
 * 축소) 그 스펙들은 무조건 통과한다.
 *
 * 본 스펙은 실제로 패키징된 `win-unpacked` 바이너리를 띄워, asar 안의 번들만으로 renderer 가
 * 동작하는지(React 마운트 + pdfjs worker/cmaps 로 실제 PDF 파싱)를 확인한다. 회귀 대상:
 * renderer 번들이 자립적이지 않게 바뀌거나(외부 bare import 발생) main 이 새 런타임 의존성을
 * dependencies 에 넣지 않은 채 import 하면 여기서 잡힌다.
 *
 * 실행 조건: `npm run package` 또는 electron-builder 로 win-unpacked 이 만들어져 있어야 한다.
 * 없으면 skip — 패키징하지 않은 로컬/CI 잡에서 이 스펙 때문에 실패하지 않게 하기 위함이다.
 *
 * ⚠️ 그 skip 이 곧 이 스펙의 최대 위험이다. 릴리즈 워크플로(build-windows)는 실제로 패키징을
 * 하므로 여기서 조용히 skip 되면 **"게이트가 도는 줄 알았는데 한 번도 실행되지 않은"** 상태로
 * 그린 릴리즈가 나간다 — 이 저장소가 이미 두 번 겪은 실패 클래스다(test.yml 4릴리즈 연속 red,
 * QA20 D-MED 의 matrix 라벨 하드코딩). 그래서 **패키징이 선행된 것이 확실한 호출자**는
 * `PACKAGED_SMOKE_REQUIRED=1` 을 세우고, 그 경우 skip 조건은 전부 **실패**로 승격된다.
 */

// 게이트로서 호출됐는가(=패키징 산출물이 반드시 있어야 하는가). release.yml 의 build-windows
// 잡이 electron-builder 직후 이 값을 세워 호출한다.
const REQUIRED = process.env['PACKAGED_SMOKE_REQUIRED'] === '1';

// electron-builder 의 기본 출력 경로만 본다 — 임시 출력 디렉터리를 후보에 넣으면 오래된
// 산출물로 조용히 통과할 수 있다(stale pass). `npm run package` 후 실행할 것.
// exe 이름은 package.json 의 build.productName 에서 유도한다 — 하드코딩하면 productName 을
// 바꾸는 순간 "파일 없음 → skip" 으로 게이트가 무증상 증발한다(REQUIRED 모드에서는 실패로
// 잡히지만, 그때도 원인이 이름 drift 임을 즉시 알 수 있어야 한다).
const PRODUCT_NAME = (JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
) as { build?: { productName?: string } }).build?.productName ?? '';
const UNPACKED_DIR = join(process.cwd(), 'dist', 'win-unpacked');
const EXE_PATH = join(UNPACKED_DIR, `${PRODUCT_NAME}.exe`);
const ASAR_PATH = join(UNPACKED_DIR, 'resources', 'app.asar');

function findPackagedExe(): string | null {
  return existsSync(EXE_PATH) ? EXE_PATH : null;
}

/**
 * asar 크기 상한. v0.31.32 에서 renderer 전용 deps 6종을 devDependencies 로 옮겨
 * 64.69MB → 4.67MB(현재 실측 ~3.7MB)로 줄였다 — electron-builder 는 `files` 패턴과 무관하게
 * production dependencies 를 asar 에 수집하는데, renderer 는 vite 가 전부 번들하므로 그 사본들이
 * 통째로 죽은 무게였다(@napi-rs 36MB 등).
 *
 * 아래 기동 테스트는 모듈 **누락**만 잡는다 — 죽은 사본이 **다시 들어오는** 역방향 회귀
 * (dependencies 에 renderer 전용 패키지를 추가)는 앱이 정상 기동하므로 영원히 통과한다.
 * 실측의 4배가 넘는 넉넉한 상한으로 "정상 성장"과 "수십 MB 죽은 사본 유입"만 가른다.
 */
const ASAR_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 파서의 텍스트 하한(공백 제외 50자 미만이면 스캔본으로 보고 OCR fallback → 실패)을 넘도록
 * 충분히 긴 본문을 그린다. 짧은 문장이면 pdfjs 가 정상 동작해도 PDF_NO_TEXT 로 거부되어
 * "번들이 깨진 것"과 구분되지 않는다.
 */
async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  const lines = [
    'Packaged asar smoke test document for the local document analyzer.',
    'This paragraph exists so that the extracted text comfortably exceeds',
    'the minimum character threshold used to detect scanned documents.',
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 720 - i * 24, size: 12, font }));
  return Buffer.from(await pdf.save());
}

const exePath = findPackagedExe();

test.describe('패키징 앱 스모크 (win-unpacked 필요)', () => {
  // REQUIRED 모드에서는 skip 을 금지한다 — 전제 위반을 조용히 통과시키지 않고 즉시 실패시킨다.
  // (test.skip 은 조건이 false 면 no-op 이므로 두 모드가 같은 구조로 표현된다.)
  test.skip(!REQUIRED && exePath === null, 'win-unpacked 빌드가 없어 skip (electron-builder 실행 후 재시도)');
  test.skip(!REQUIRED && process.platform !== 'win32', 'Windows 패키징 산출물 전용');
  test.beforeAll(() => {
    if (!REQUIRED) return;
    if (process.platform !== 'win32') {
      throw new Error('PACKAGED_SMOKE_REQUIRED=1 인데 win32 가 아닙니다 — 게이트를 Windows 잡에서 실행하세요');
    }
    if (exePath === null) {
      throw new Error(
        `PACKAGED_SMOKE_REQUIRED=1 인데 패키징 산출물이 없습니다: ${EXE_PATH}\n`
        + 'electron-builder 가 선행됐는지, build.productName 이 바뀌지 않았는지 확인하세요.',
      );
    }
    // stale 산출물 가드. 이 스펙의 주석은 "기본 출력 경로만 보면 stale pass 를 피한다"고 했지만
    // 그건 사실이 아니다 — dist/win-unpacked 자체가 몇 주 전 빌드로 남아 있을 수 있고(실제로
    // 로컬에 5주 묵은 asar 이 앉아 있었다: 파일 잠금으로 electron-builder 의 unlink 가 실패해
    // 재패키징이 되지 않는 상태), 그대로 실행하면 **고친 코드가 아닌 옛 코드**를 검증하고 통과한다.
    // out/ 이 있으면(=소스 트리에서 돌린 경우) 빌드 산출물보다 asar 이 새것인지 확인한다.
    // CI 는 fresh runner 라 항상 만족하고, out/ 이 없는 격리 실행에서는 비교를 건너뛴다.
    const builtMain = join(process.cwd(), 'out', 'main', 'index.js');
    if (existsSync(builtMain) && existsSync(ASAR_PATH)
        && statSync(ASAR_PATH).mtimeMs < statSync(builtMain).mtimeMs) {
      throw new Error(
        `패키징 산출물이 out/ 보다 오래됐습니다(stale): ${ASAR_PATH}\n`
        + 'electron-builder 를 다시 실행하세요. 파일 잠금(EBUSY)으로 재패키징이 조용히 실패했을 수 있습니다.',
      );
    }
  });

  // 역방향 회귀 가드 — 기동 테스트가 구조적으로 못 보는 축(위 ASAR_MAX_BYTES 주석 참조).
  // 앱 실행이 필요 없으므로 별도 테스트로 분리한다(실패 시 원인이 즉시 구분된다).
  test('asar 크기 상한 — renderer 전용 deps 재유입 가드', () => {
    // QA21(A-LOW): REQUIRED 모드에서는 skip 을 금지한다 — 그러지 않으면 이 커밋이 닫으려던
    // "skip=green" 구멍이 **새로 추가한 테스트에** 그대로 남는다. exe 는 있는데 asar 만 없는
    // 상태(예: build 에 `"asar": false` 를 넣어 디버깅한 채 커밋)면 그룹 beforeAll 은 통과하고
    // 이 게이트만 무음 skip 된다. 아래 statSync 가 대신 소리 나게 실패한다.
    test.skip(!REQUIRED && !existsSync(ASAR_PATH), 'win-unpacked 빌드가 없어 skip');
    const bytes = statSync(ASAR_PATH).size;
    expect(
      bytes,
      `app.asar ${(bytes / 1024 / 1024).toFixed(2)}MB > 상한 ${ASAR_MAX_BYTES / 1024 / 1024}MB — `
      + 'renderer 전용 패키지가 dependencies 로 들어와 asar 에 죽은 사본이 수집됐을 수 있습니다. '
      + 'package.json 의 //dependenciesPolicy 를 확인하세요.',
    ).toBeLessThan(ASAR_MAX_BYTES);
  });

  // 콜드 CI 러너에서 패키징 앱의 첫 기동 + 실제 PDF 파싱은 전역 timeout(60s)을 넘길 수 있다
  // (소스트리 실행 스펙보다 asar 압축 해제·초기 캐시 미적재 비용이 크다). 이 스펙만 상향.
  test.setTimeout(180_000);

  test('asar 번들만으로 기동 + 실제 PDF 파싱 (node_modules 제외 회귀 가드)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'lpa-packaged-'));
    // provider=claude 시드로 첫 실행 셋업 위자드를 우회해 메인 화면으로 진입(smoke.spec 과 동일 계약).
    // 위자드 화면에서는 파일 드롭이 문서 화면으로 전환되지 않는다.
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light' }),
      'utf-8',
    );
    const app = await electron.launch({
      executablePath: exePath!,
      args: [],
      env: {
        ...process.env,
        DOC_ANALYZER_USER_DATA: userDataDir,
        // 실 Ollama 결합 차단 — 죽은 포트로 격리(다른 결정적 스펙과 동일 계약).
        DOC_ANALYZER_OLLAMA_URL: 'http://127.0.0.1:59999',
      },
    });

    try {
      const page = await app.firstWindow();
      const pageErrors: Error[] = [];
      page.on('pageerror', (err) => pageErrors.push(err));

      // 1) renderer 번들이 asar 안에서 마운트되는가 (React + Tailwind + store)
      await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });

      // 2) pdfjs worker + cmaps 가 asar/asarUnpack 경로에서 로드되어 실제 파싱이 되는가.
      //    file:dropped IPC 로 실제 바이트를 전달(합성 DragEvent 가 아닌 프로덕션 경로).
      const pdfPath = join(userDataDir, 'packaged-smoke.pdf');
      writeFileSync(pdfPath, await makePdf());
      // 드롭 페이로드 구성은 결정적 스펙들과 동일 계약(helpers.sendDropPath)을 재사용한다.
      await sendDropPath(app, pdfPath, readFileSync(pdfPath).toString('base64'));

      // 파싱이 성공하면 문서 화면으로 전환되어 파일명 + 페이지 수가 노출된다.
      await expect(page.getByText('packaged-smoke.pdf (1p)')).toBeVisible({ timeout: 60_000 });

      // 3) 번들 누락은 대개 pageerror(모듈 로드 실패)로 드러난다.
      expect(pageErrors.map((e) => e.message)).toEqual([]);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
