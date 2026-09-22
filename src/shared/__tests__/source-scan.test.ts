/**
 * QA29(D1-2): 공용 주석 제거기의 회귀 넷.
 *
 * 이 헬퍼는 저장소의 소스 스캔 가드 10곳이 전부 의존하는 단일 지점이라, 여기가 조용히
 * 틀리면 **그 10곳이 동시에** 거짓 통과(주석에 매칭)하거나 거짓 실패(URL 손상)한다.
 * 그래서 양방향을 모두 고정한다.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { stripJsComments, stripYamlComments, stripHtmlComments, readGeneratedText } from './helpers/source-scan';

/**
 * 소스 트리를 재귀 순회해 패턴에 맞는 파일을 모은다 — 여러 스캔 가드가 공유하는 단일 워커.
 * 가드마다 따로 두면 그 자체가 이 저장소 최다 결함 형태(형제 누락)를 반복하는 셈이다.
 */
function walkSourceFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(dir), { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(p, pattern));
    else if (pattern.test(entry.name)) out.push(p);
  }
  return out;
}

describe('stripJsComments — 주석은 지우고 코드는 남긴다', () => {
  it('줄 주석과 블록 주석을 지운다', () => {
    const s = stripJsComments('const a = 1; // 주석 안의 secretToken\n/* 여러 줄\n secretToken */\nconst b = 2;');
    expect(s).not.toContain('secretToken');
    expect(s).toContain('const a = 1;');
    expect(s).toContain('const b = 2;');
  });

  it('줄 번호와 오프셋을 보존한다 (윈도 정규식이 그대로 동작해야 한다)', () => {
    const src = 'a\n// 주석\nb\n';
    const s = stripJsComments(src);
    expect(s.length).toBe(src.length);
    expect(s.split('\n').length).toBe(src.split('\n').length);
  });

  it('문자열 안의 URL 을 훼손하지 않는다 (`//` 를 순진하게 지우면 뒤가 날아간다)', () => {
    const src = [
      "const url = 'https://github.com/owner/repo/releases';",
      'const api = "http://127.0.0.1:11434/api/tags";',
      'const t = `https://example.com/${id}/x`;',
    ].join('\n');
    const s = stripJsComments(src);
    expect(s).toContain("'https://github.com/owner/repo/releases'");
    expect(s).toContain('"http://127.0.0.1:11434/api/tags"');
    expect(s).toContain('`https://example.com/${id}/x`');
  });

  it('URL 뒤에 오는 진짜 주석은 지운다 (URL 보호가 통째 면제로 번지면 안 된다)', () => {
    const s = stripJsComments("const u = 'https://a.example'; // 주석 안의 ghostToken");
    expect(s).toContain("'https://a.example'");
    expect(s).not.toContain('ghostToken');
  });

  it('정규식 리터럴 안의 `\\/\\/` 를 주석으로 오인하지 않는다', () => {
    const src = 'const re = /^https?:\\/\\//; const keep = 1;';
    const s = stripJsComments(src);
    expect(s).toContain('/^https?:\\/\\//');
    expect(s).toContain('const keep = 1;');
  });

  it('따옴표를 품은 정규식이 문자열 추적을 무너뜨리지 않는다', () => {
    // /['"]…['"]/ 는 이 저장소 소스에 실제로 흔하다. 문자열로 오인하면 뒤따르는 주석이
    // 살아남아(=지워지지 않아) 가드가 조용히 주석에 매칭하게 된다.
    const src = "const re = /['\"]([^'\"]+)['\"]/g; // 주석 안의 ghostToken\nconst keep = 2;";
    const s = stripJsComments(src);
    expect(s).not.toContain('ghostToken');
    expect(s).toContain('const keep = 2;');
  });

  it('나눗셈을 정규식으로 오인해 파일 나머지를 삼키지 않는다', () => {
    const src = 'const ratio = a / b; const half = c / 2;\nconst keep = 3;';
    expect(stripJsComments(src)).toBe(src);
  });

  it('JSX 텍스트의 홑따옴표(축약형)가 뒤쪽 주석 제거를 막지 않는다', () => {
    const src = "<p>it's fine</p>\n// 주석 안의 ghostToken\n<b/>";
    const s = stripJsComments(src);
    expect(s).toContain("it's fine");
    expect(s).not.toContain('ghostToken');
  });

  it('실제 소스에 걸어도 코드 토큰이 살아남는다 (헬퍼가 소스를 망가뜨리지 않는다)', () => {
    const root = resolve(import.meta.dirname, '../..');
    for (const [file, tokens] of [
      ['main/index.ts', ['ipcMain.handle(', 'new BrowserWindow(']],
      ['preload/index.ts', ['contextBridge.exposeInMainWorld(', 'ipcRenderer.invoke(']],
      ['renderer/App.tsx', ['selectUpdateBanner(', 'export default']],
    ] as const) {
      const raw = readFileSync(resolve(root, file), 'utf-8');
      const s = stripJsComments(raw);
      expect(s.length, `${file}: 길이가 바뀌었다`).toBe(raw.length);
      for (const t of tokens) expect(s, `${file}: ${t} 가 사라졌다`).toContain(t);
    }
  });
});

describe('stripYamlComments — 워크플로 주석', () => {
  it('`#` 주석을 지우고 코드는 남긴다', () => {
    const src = '      - uses: actions/checkout@abc # v6.0.2\n      # 설명 주석의 ghostToken\n      run: node x.mjs';
    const s = stripYamlComments(src);
    expect(s).toContain('actions/checkout@abc');
    expect(s).not.toContain('v6.0.2');
    expect(s).not.toContain('ghostToken');
    expect(s).toContain('run: node x.mjs');
  });

  it('공백이 앞서지 않는 `#` 은 주석이 아니다 (셸 파라미터 확장 보호)', () => {
    const src = 'run: echo "${VAR#prefix}"';
    expect(stripYamlComments(src)).toContain('${VAR#prefix}');
  });

  it('따옴표 안의 `#` 은 주석이 아니다', () => {
    const src = 'run: echo "a # b"';
    expect(stripYamlComments(src)).toContain('a # b');
  });

  it('줄 수를 보존한다', () => {
    const src = 'a: 1\n# c\nb: 2\n';
    expect(stripYamlComments(src).split('\n').length).toBe(src.split('\n').length);
  });

  it('실제 워크플로에서 주석만 사라진다', () => {
    const root = resolve(import.meta.dirname, '../../..');
    for (const wf of ['.github/workflows/test.yml', '.github/workflows/release.yml']) {
      const raw = readFileSync(resolve(root, wf), 'utf8');
      const s = stripYamlComments(raw);
      expect(s.split('\n').length).toBe(raw.split('\n').length);
      expect(s).toContain('audit-shipped.mjs');
      // 주석 전용 관용구(SHA 핀 뒤 버전 표기)는 사라져야 한다.
      expect(raw).toMatch(/# v\d/);
      expect(s).not.toMatch(/# v\d/);
    }
  });
});

/**
 * QA29(D1-2) 구조적 종결.
 *
 * 이 라운드의 진짜 결함은 "8곳이 주석을 안 걷는다" 가 아니라 **한 곳씩 열거해 왔다는 것**이다
 * (이 저장소의 최다 결함 클래스 = 형제 누락). 그래서 목록을 손으로 들고 있지 않고, 소스 파일을
 * 읽는 테스트를 **도출**해서 전부가 공용 제거기를 쓰는지 본다 — 11번째 가드가 새로 생기면
 * 그것도 자동으로 이 규칙 아래로 들어온다.
 */
describe('stripHtmlComments — CSP 가드가 실물 meta 만 보게 한다', () => {
  it('HTML 주석을 지우고 마크업은 남긴다', () => {
    const src = `<!-- old -->
<meta content="live">`;
    const out = stripHtmlComments(src);
    expect(out).not.toContain('old');
    expect(out).toContain('content="live"');
  });

  it('줄 번호와 오프셋을 보존한다 (해시·정규식이 원본 좌표로 동작해야 한다)', () => {
    const src = `<!--
a
b
-->
<meta>`;
    const out = stripHtmlComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('여러 줄 주석 뒤의 실물을 삼키지 않는다', () => {
    const src = `<!--
x
-->
<meta http-equiv="Content-Security-Policy" content="A">`;
    expect(stripHtmlComments(src)).toContain('content="A"');
  });

  it('닫히지 않은 주석은 끝까지 지운다 (열린 채로 실물이 살아 보이면 안 된다)', () => {
    const src = `<!-- x
<meta content="B">`;
    expect(stripHtmlComments(src)).not.toContain('content="B"');
  });
});

describe('소스 스캔 가드는 전부 공용 제거기를 쓴다 (열거 금지)', () => {
  const SRC_ROOT = resolve(import.meta.dirname, '../..');

  /**
   * 소스(.ts/.tsx/.mts/.yml)를 텍스트로 읽는 테스트인가 — 경로 리터럴 형태와 readdir 필터 형태 둘 다.
   * QA30(D2): `.mts` 를 추가했다. `vitest.config.mts` 를 읽는 가드(coverage-drift.test)가
   * 확장자 하나 차이로 이 도출 밖에 있었고, 그것이 D1(주석을 파싱하던 드리프트 가드)의 구조적 뿌리다.
   * QA31(B·D 수렴): `.html` 을 추가했다. **같은 문장이 그대로 반복됐다** — csp-inline-hash.test 가
   * `index.html` 을 원본으로 읽어 주석 처리된 옛 CSP 를 검사하고 있었고(실물이 'unsafe-inline'
   * 이어도 2/2 통과), 확장자 하나 차이로 이 도출 밖이었다. 이번엔 보안 컨트롤 위였다.
   */
  const SRC_EXT = String.raw`(?:[mc]?tsx?|[mc]?jsx?|ya?ml|html?)`;
  const READ_CALL = String.raw`(?:readFileSync|\.readFile)\(`;
  const PATH_LITERAL = String.raw`['"\`][^'"\`]*\.` + SRC_EXT + String.raw`['"\`]`;
  /** 읽기 호출 **뒤**에 경로 리터럴이 오는 형태 — `readFileSync('a/b.ts')`. */
  const LITERAL_AFTER = new RegExp(READ_CALL + String.raw`[\s\S]{0,240}?\.` + SRC_EXT + String.raw`['"\`]`);
  /** 읽기 호출 **앞**에 오는 형태 — `const f = join(..., 'x.ts'); readFileSync(f)`. */
  const LITERAL_BEFORE = new RegExp(PATH_LITERAL + String.raw`[\s\S]{0,240}?` + READ_CALL);

  function scansSource(src: string): boolean {
    if (LITERAL_AFTER.test(src) || LITERAL_BEFORE.test(src)) return true;
    return src.includes('readdirSync') && src.includes('readFileSync') && /endsWith\(['"]\.tsx?['"]\)/.test(src);
  }

  const rel = (f: string) => f.slice(SRC_ROOT.length + 1).split('\\').join('/');
  // 이 파일(메타 가드)만 제외한다 — 제거기 자체를 검증하려면 **원본을 그대로** 읽어야 하고,
  // derived() 기계도 원본을 읽는다. 자기 자신을 파생 집합에 넣으면 그 read 사이트들이 위반으로
  // 잡힌다(QA31 에서 실제로 밟았다). 예외는 여기 한 곳뿐이며 이름으로 못박는다.
  const META_GUARD = 'shared/__tests__/source-scan.test.ts';
  const derived = () => walkSourceFiles(SRC_ROOT, /\.(test|spec)\.tsx?$/)
    .filter((f) => rel(f) !== META_GUARD)
    .filter((f) => scansSource(readFileSync(f, 'utf8')));

  it('소스를 텍스트로 읽는 테스트는 예외 없이 source-scan 헬퍼를 임포트한다', () => {
    const files = derived();
    // 도출이 0건이 되면(정규식이 낡으면) 이 가드는 조용히 공허해진다 — 하한을 먼저 못박는다.
    expect(files.length, '소스 스캔 가드를 한 건도 찾지 못했다 — 이 가드가 무력화된 상태다')
      .toBeGreaterThanOrEqual(15);
    const offenders = files
      .filter((f) => !readFileSync(f, 'utf8').includes('helpers/source-scan'))
      .map(rel);
    expect(offenders, `원본 소스에 매칭하는 가드: ${offenders.join(', ')} — 주석에 매칭해 조용히 통과한다`)
      .toEqual([]);
  });

  /**
   * QA30(D2): 위 임포트 검사만으로는 **파일 안 어디든 한 번** 헬퍼를 쓰면 나머지 read 사이트가
   * 자유였다. 실측: i18n.test 의 R44 블록 read 3곳을 원본 읽기로 되돌리고 임포트 줄만 남기니
   * 36/36 전부 통과했다 — 고아 키가 주석 한 줄로 구제되는 원래 결함이 부활하는데 스위트는 만점.
   *
   * 그래서 파일 단위가 아니라 **read 사이트 단위**로 본다: 파생된 가드 파일 안의 모든
   * `readFileSync(` 는 제거기(stripJsComments/stripYamlComments) 나 `JSON.parse` 로 감싸여
   * 있어야 한다. 소스가 아닌 산출물은 헬퍼의 `readGeneratedText`(확장자를 검사해 소스면 던진다)
   * 로 읽는다 — 그쪽은 `readFileSync` 가 아예 등장하지 않으므로 이 규칙과 충돌하지 않는다.
   *
   * ※ 후속(권장): 읽기까지 헬퍼가 소유하는 `readSource(path)` 로 좁히면 규칙이 API 모양으로
   *    닫힌다. 지금은 이 라운드의 파일 소유권 밖인 가드 6곳이 함께 바뀌어야 해서 미뤘다 —
   *    아래 규칙은 그 6곳에도 이미 동일하게 적용되고 있다(전부 감싼 형태).
   */
  it('파생된 가드의 모든 readFileSync 는 제거기(또는 JSON.parse)를 거친다 (파일당 1회로는 부족)', () => {
    // 제거기 호출이 읽기 **직전**에 와야 한다(원본 변수를 남기면 재사용될 여지가 생긴다).
    // QA31: promises 판(`await fs.readFile`)을 위해 `await` 와 객체 이름까지만 허용한다.
    const WRAPPED = /(?:stripJsComments|stripYamlComments|stripHtmlComments|JSON\.parse)\(\s*(?:await\s+)?[\w.]*$/;
    const offenders: string[] = [];
    let sites = 0;
    for (const f of derived()) {
      // 자기 자신의 주석은 걷고 본다 — 주석 처리된 예시 코드가 거짓 실패를 만들지 않도록.
      const src = stripJsComments(readFileSync(f, 'utf8'));
      const lines = src.split('\n');
      for (const m of src.matchAll(/readFileSync\(|\.readFile\(/g)) {
        sites += 1;
        if (WRAPPED.test(src.slice(0, m.index))) continue;
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel(f)}:${line} → ${lines[line - 1]?.trim() ?? ''}`);
      }
    }
    expect(sites, 'read 사이트를 한 건도 찾지 못했다 — 이 가드가 무력화된 상태다').toBeGreaterThanOrEqual(20);
    expect(offenders, `원본을 그대로 읽는 자리:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

describe('readGeneratedText — 소스가 아님을 확장자로 증명한 읽기만', () => {
  it('소스 확장자를 넘기면 던진다 (주석이 걸러지지 않는 통로가 되지 않도록)', () => {
    for (const p of ['a/b.ts', 'a/b.tsx', 'vitest.config.mts', 'x.yml', 'x.yaml', 'y.js', 'x.html', 'x.htm']) {
      expect(() => readGeneratedText(p), `${p} 를 허용하면 안 된다`).toThrow(/소스 파일/);
    }
  });

  it('생성 산출물은 읽어 준다', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'src-scan-')), 'step-summary.md');
    writeFileSync(p, '# 요약\n');
    expect(readGeneratedText(p)).toBe('# 요약\n');
  });
});

/** 경로에 `__tests__` 세그먼트가 있는가 — 테스트 픽스처는 파일명·바이트를 값으로 다뤄도 된다. */
function isTestPath(file: string): boolean {
  return /(^|[\\/])__tests__[\\/]/.test(file);
}

/**
 * fix-round1(item1): 스캔 대상이 조용히 좁혀져도 두 신규 가드가 그린으로 남는 문제의 대책.
 * `walkSourceFiles('src', …)` 를 `'src/shared'` 처럼 좁혀도 offender 목록은 여전히 빈 채라
 * 통과한다 — 이 저장소에 이미 출시된 적 있는 실패 형태(스캔 범위 붕괴)다. 개수 하한만으로는
 * "src/renderer 전체" 처럼 큰 단일 디렉터리로 좁혀져도 통과하므로, main·renderer 대표성을
 * 함께 요구한다(§263 의 read-사이트 하한과 같은 모양).
 */
function assertScanIsWide(files: readonly string[]): void {
  const rel = files.map((f) => f.replace(/\\/g, '/'));
  expect(rel.length, '스캔 대상이 너무 적다 — walkSourceFiles 범위가 좁혀진 것은 아닌지 확인').toBeGreaterThan(50);
  expect(rel.some((f) => f.startsWith('src/main/')), 'src/main 이 스캔 대상에 없다 — 범위가 좁혀졌다').toBe(true);
  expect(rel.some((f) => f.startsWith('src/renderer/')), 'src/renderer 가 스캔 대상에 없다 — 범위가 좁혀졌다').toBe(true);
}

describe('확장자 리터럴은 document-formats.ts 밖에 두지 않는다', () => {
  /**
   * 진입 게이트가 흩어져 있으면 포맷이 늘 때 한 곳이 안 따라간다. 새 게이트가 생기는 순간
   * 여기서 실패하게 만들어 지점을 **도출**한다(열거하면 사각이 생긴다 — QA33 I3).
   *
   * Task9(controller ruling 2): `__tests__` 는 스캔에서 뺀다. 테스트는 파일명을 값으로
   * 구성해도 정당하다(예: 긴 파일명 회귀 픽스처 `'x'.repeat(200) + '.pdf'`) — 프로덕션
   * 경로는 여전히 전수 스캔한다.
   */
  const ALLOWED = new Set([
    'src/shared/document-formats.ts',
    'src/shared/__tests__/document-formats.test.ts',
    'src/shared/__tests__/source-scan.test.ts',
  ]);
  // 내보내기 저장 다이얼로그(file:save / file:export-pdf)는 **출력** 확장자라 이 가드의 대상이
  // 아니다. 핸들러 단위로 스코프한다 — 이전엔 같은 줄에 키워드가 있어야 했는데, 필터 배열과
  // 확장자 비교가 다른 줄에 있는 file:export-pdf 핸들러(main/index.ts)에서 실패했다.
  //
  // fix-round1(item2): 스코프를 **닫아야** 한다. 이전 구현은 "다음 ipcMain.handle(" 이 나올
  // 때만 currentHandler 를 해제해서, file:export-pdf 의 닫는 `});` 부터 다음 핸들러 선언
  // 전까지의 **모듈 레벨 코드**(예: ALLOWED_EXTERNAL_HOSTS 상수)까지 면제 구간에 들어갔다.
  // 더 심각하게는, 그 틈에 `ipcMain.on('file:import-path', …)` 처럼 `.handle` 이 아닌 형태의
  // 새 게이트가 추가되면 HANDLER_DECL 에 안 걸려 **영원히 면제**된 채로 남는다 — 이 가드가
  // 막으려는 여섯 번째 게이트가 정확히 이 구멍에 빠진다.
  //
  // 이 파일의 모든 `ipcMain.handle(` 은 2-스페이스 들여쓰기(레지스터 함수 최상위 문)로 시작해
  // 콜백이 끝나는 지점의 `  });`(같은 2-스페이스)로 정확히 1:1 닫힌다(내부 중첩 블록은 전부
  // 그보다 깊게 들여써진다 — 실측: 40개 핸들러 전부 이 규칙으로 정확히 짝지어졌다). 그
  // 닫는 줄을 만나면 currentHandler 를 해제해 스코프를 닫는다.
  const OUTPUT_ONLY_HANDLERS = new Set(['file:save', 'file:export-pdf']);
  const HANDLER_DECL = /^ {2}ipcMain\.handle\(\s*['"]([\w:-]+)['"]/;
  const HANDLER_CLOSE = /^ {2}\}\);\s*$/;

  it("'.pdf'/'.docx' 리터럴이 단일 출처 밖에 없다", () => {
    const scanned = walkSourceFiles('src', /\.(ts|tsx)$/);
    assertScanIsWide(scanned);
    const offenders: string[] = [];
    for (const file of scanned) {
      const rel = file.replace(/\\/g, '/');
      if (ALLOWED.has(rel) || isTestPath(file)) continue;
      const src = stripJsComments(readFileSync(file, 'utf-8'));
      let currentHandler: string | null = null;
      for (const [i, line] of src.split('\n').entries()) {
        const handlerMatch = line.match(HANDLER_DECL);
        if (handlerMatch?.[1]) currentHandler = handlerMatch[1];
        const isOutputOnly = currentHandler !== null && OUTPUT_ONLY_HANDLERS.has(currentHandler);
        if (HANDLER_CLOSE.test(line)) currentHandler = null;
        if (isOutputOnly) continue;
        if (/['"`]\.?(pdf|docx)['"`]/i.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders, '확장자는 document-formats.ts 에서만 안다').toEqual([]);
  });
});

describe('PDF 매직바이트는 document-formats.ts 밖에 두지 않는다', () => {
  /**
   * Task8 이 찾은 사각: pdf-parser.ts 의 `%PDF-` 검사가 16진 배열([0x25, 0x50, 0x44, 0x46, ...])
   * 이라 위 문자열 리터럴 가드에 안 걸린다. 같은 시퀀스가 또 다른 진입 게이트를 단일 출처
   * 밖에 만드는 것을 막는다(App.tsx 의 DOM 드롭 매직바이트 검사가 실제로 이 형태였다 — Task9).
   *
   * pdf-parser.ts 자신은 한시적으로 허용한다 — 이 파일의 매직 검사는 Task10 에서 sniff() 기반
   * 다중 포맷 판별로 옮겨진다. **Task10 Step 6 에서 이 항목을 반드시 뺀다.**
   */
  const ALLOWED = new Set([
    'src/shared/document-formats.ts',
    // TODO(Task10): sniff() 기반 판별로 옮기면서 제거.
    'src/renderer/lib/pdf-parser.ts',
  ]);
  const PDF_MAGIC_BYTES = /0x25\s*,\s*0x50\s*,\s*0x44\s*,\s*0x46/i;

  it('0x25,0x50,0x44,0x46 (%PDF) 바이트열이 단일 출처 밖에 없다', () => {
    const scanned = walkSourceFiles('src', /\.(ts|tsx)$/);
    assertScanIsWide(scanned);
    const offenders: string[] = [];
    for (const file of scanned) {
      const rel = file.replace(/\\/g, '/');
      if (ALLOWED.has(rel) || isTestPath(file)) continue;
      const src = stripJsComments(readFileSync(file, 'utf-8'));
      for (const [i, line] of src.split('\n').entries()) {
        if (PDF_MAGIC_BYTES.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders, 'PDF 매직바이트는 document-formats.ts 에서만 안다').toEqual([]);
  });
});
