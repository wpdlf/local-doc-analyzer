/**
 * 블록 목록 → 단위(가상 페이지).
 *
 * DOCX·HWPX 는 물리적 페이지가 파일에 없다(레이아웃 엔진이 폰트·여백으로 계산하는 결과물).
 * 작성자가 넣은 쪽나눠가 있으면 그것이 사용자가 보는 경계이므로 우선하고, 없는 구간만 분량으로
 * 끊는다. 문단 경계는 넘지 않는다 — 문장이 잘리면 그 자리를 가리키는 인용이 의미를 잃는다.
 */

export interface Block {
  text: string;
  /** 이 블록 앞에서 쪽을 나눈다(명시적 쪽나눠). */
  breakBefore: boolean;
}

export interface PaginateResult {
  units: string[];
  /** blocks[i] 가 속한 단위의 0-based 인덱스. 빈 블록은 직전 단위를 가리킨다. */
  unitOfBlock: number[];
}

/** 한국어 A4 한 쪽 분량의 근사값. */
export const DEFAULT_UNIT_CHARS = 1800;

export function paginate(blocks: Block[], maxChars: number = DEFAULT_UNIT_CHARS): PaginateResult {
  const units: string[] = [];
  const unitOfBlock: number[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length > 0) {
      units.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
  };

  for (const block of blocks) {
    const text = block.text.trim();
    if (text === '') {
      // 빈 블록은 단위를 만들지 않는다. 매핑은 직전 단위(없으면 0)로 둔다.
      unitOfBlock.push(units.length > 0 || current.length > 0 ? units.length : 0);
      continue;
    }
    const tooLong = currentLen > 0 && currentLen + text.length > maxChars;
    if (block.breakBefore || tooLong) flush();
    unitOfBlock.push(units.length);
    current.push(text);
    currentLen += text.length;
  }
  flush();

  return { units, unitOfBlock };
}
