/**
 * 셀 행렬 → GFM 마크다운 표.
 *
 * 평문화하면 열 대응이 사라진다(실물 HWPX 주간업무보고: 문단 180 중 표 셀 91).
 * remark-gfm 이 이미 번들에 있어 요약 뷰어·텍스트 뷰어가 표로 렌더한다.
 */

function cell(text: string): string {
  // 표 한 줄이 한 행이어야 하므로 줄바꿈을 접고, 파이프는 열 경계를 깨므로 이스케이프한다.
  // 역슬래시를 **먼저** 두 배로 한다 — 셀 끝의 역슬래시(`C:\`)가 뒤따르는 경계 파이프와 붙어
  // `\|` 로 읽히면 열이 하나 사라진다. 순서가 반대면 파이프 이스케이프가 만든 역슬래시까지
  // 두 배가 되어 이번엔 파이프가 경계로 풀린다.
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * 열 수 상한 — 파일이 주는 정수(colCnt/span)가 배열 길이가 되므로 병리 값을 자른다. 실물 업무 서식의
 * 최대 폭(수십 칸)보다 넉넉하다. 이름과 달리 **행에는 걸지 않는다**(아래 MAX_GRID_CELLS 참조).
 */
export const MAX_GRID_CELLS_PER_AXIS = 256;

/**
 * 격자 칸 총수 상한(행×열). QA35: 예전에는 열 상한(256)을 행에도 걸어 257행째부터 조용히 잘렸다 —
 * 긴 명단·실적표는 수백 행이 흔하다. 행 수 자체는 제한하지 않고 작업량(배열 크기)만 이 값으로 묶는다.
 */
export const MAX_GRID_CELLS = 200_000;

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
}

/**
 * 좌표·스팬이 명시된 셀들을 rowCount×colCount 격자에 놓는다(P4, HWPX).
 *
 * HWPX 는 병합으로 가려진 칸을 XML 에 **쓰지 않는다**(HTML 과 같다) — 셀을 나온 순서대로 늘어놓으면
 * 병합 뒤 칸이 전부 왼쪽으로 밀린다(DOCX 에서 QA34 High 였던 결함과 같은 모양). 실물 28개 표가
 * 전부 이 규칙으로 빈틈·겹침 없이 채워졌다.
 *
 * 규칙은 DOCX(docx.ts tableRows)와 같다: 가로 병합은 첫 칸에만 텍스트, 세로 병합은 아래 칸에 복사
 * (분류 열이 행마다 남아야 "어느 값이 무엇의 값인지" 가 GFM 표에서 유지된다). 겹치면 먼저 놓인
 * 칸이 이긴다 — 손상 파일에서 뒤 셀이 앞 셀을 덮어 내용이 사라지지 않게.
 *
 * 상한(열 MAX_GRID_CELLS_PER_AXIS · 총 칸 MAX_GRID_CELLS)에 걸려 격자에 못 놓은 셀은 버리지 않고,
 * 격자 뒤에 원래 행별로 " / " 로 이은 평문 행(첫 칸)으로 붙인다 — 열 대응은 잃어도 내용은 남는다.
 * 선언된 행·열 수 밖의 좌표(손상)는 상한과 무관하므로 예전처럼 버린다.
 */
export function placeGridCells(cells: GridCell[], rowCount: number, colCount: number): string[][] {
  const declaredRows = Math.max(0, Math.floor(rowCount) || 0);
  const declaredCols = Math.max(0, Math.floor(colCount) || 0);
  const cols = Math.min(declaredCols, MAX_GRID_CELLS_PER_AXIS);
  const rows = cols > 0 ? Math.min(declaredRows, Math.floor(MAX_GRID_CELLS / cols)) : Math.min(declaredRows, MAX_GRID_CELLS);
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null));
  const overflow: { row: number; col: number; text: string }[] = [];
  for (const cell of cells) {
    const r0 = Math.floor(cell.row);
    const c0 = Math.floor(cell.col);
    if (!(r0 >= 0 && r0 < declaredRows && c0 >= 0 && c0 < declaredCols)) continue;
    if (r0 >= rows || c0 >= cols) {
      if (cell.text.trim()) overflow.push({ row: r0, col: c0, text: cell.text });
      continue;
    }
    if (grid[r0]![c0] !== null) continue;
    const r1 = Math.min(rows, r0 + Math.max(1, Math.floor(cell.rowSpan) || 1));
    const c1 = Math.min(cols, c0 + Math.max(1, Math.floor(cell.colSpan) || 1));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (grid[r]![c] !== null) continue;
        grid[r]![c] = c === c0 ? cell.text : '';
      }
    }
  }
  const out = grid.map((row) => row.map((v) => v ?? ''));
  if (overflow.length > 0) {
    overflow.sort((a, b) => a.row - b.row || a.col - b.col);
    const width = Math.max(1, cols);
    let i = 0;
    while (i < overflow.length) {
      const row = overflow[i]!.row;
      const texts: string[] = [];
      for (; i < overflow.length && overflow[i]!.row === row; i++) texts.push(overflow[i]!.text.replace(/\s+/g, ' ').trim());
      const line = Array<string>(width).fill('');
      line[0] = texts.join(' / ');
      out.push(line);
    }
  }
  return out;
}

export function toGfmTable(rows: string[][]): string {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (rows.length === 0 || width === 0) return '';

  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cell(cells[i] ?? '')).join(' | ')} |`;

  const header = line(rows[0] ?? []);
  const divider = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  const body = rows.slice(1).map(line);
  return [header, divider, ...body].join('\n');
}

/**
 * 격자 한 축의 크기 — 선언값(rowCnt/colCnt · HWP TABLE 레코드)이 아니라 셀이 실제로 차지하는 범위로 정한다(R18).
 * 선언값만 믿으면 rowCnt="100000" 에 실제 2행인 표가 빈 행 수천 개(칸 상한까지)의 쓰레기 표가 된다.
 * 셀 **원점**은 선언값을 넘어도 항상 포함한다 — 선언값이 모자란 손상 파일에서 셀을 버리지 않게
 * (크기는 placeGridCells 의 상한이 묶고, 넘친 셀은 평문 행으로 남는다). 스팬 끝은 선언값 안에서만
 * 믿는다 — 병리적 rowSpan 하나가 빈 행을 만들지 않게.
 */
export function gridExtent(cells: GridCell[], axis: 'row' | 'col', declared: number): number {
  let origins = 0;
  let spans = 0;
  for (const c of cells) {
    const o = Math.floor(axis === 'row' ? c.row : c.col);
    if (!(o >= 0)) continue;
    const span = Math.max(1, Math.floor(axis === 'row' ? c.rowSpan : c.colSpan) || 1);
    origins = Math.max(origins, o + 1);
    spans = Math.max(spans, o + span);
  }
  return Math.max(origins, Math.min(spans, Math.max(0, declared)));
}
