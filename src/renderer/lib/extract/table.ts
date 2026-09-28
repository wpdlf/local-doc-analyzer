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

/** 격자 한 축의 칸 상한 — 파일이 주는 정수(rowCnt/colCnt/span)가 배열 길이가 되므로 병리 값을 자른다. */
export const MAX_GRID_CELLS_PER_AXIS = 256;

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
 */
export function placeGridCells(cells: GridCell[], rowCount: number, colCount: number): string[][] {
  const rows = Math.max(0, Math.min(Math.floor(rowCount) || 0, MAX_GRID_CELLS_PER_AXIS));
  const cols = Math.max(0, Math.min(Math.floor(colCount) || 0, MAX_GRID_CELLS_PER_AXIS));
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array<string | null>(cols).fill(null));
  for (const cell of cells) {
    const r0 = Math.floor(cell.row);
    const c0 = Math.floor(cell.col);
    if (!(r0 >= 0 && r0 < rows && c0 >= 0 && c0 < cols)) continue;
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
  return grid.map((row) => row.map((v) => v ?? ''));
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
