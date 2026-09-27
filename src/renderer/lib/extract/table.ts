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
