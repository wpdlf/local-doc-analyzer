/**
 * 셀 행렬 → GFM 마크다운 표.
 *
 * 평문화하면 열 대응이 사라진다(실물 HWPX 주간업무보고: 문단 180 중 표 셀 91).
 * remark-gfm 이 이미 번들에 있어 요약 뷰어·텍스트 뷰어가 표로 렌더한다.
 */

function cell(text: string): string {
  // 표 한 줄이 한 행이어야 하므로 줄바꿈을 접고, 파이프는 열 경계를 깨므로 이스케이프한다.
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
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
