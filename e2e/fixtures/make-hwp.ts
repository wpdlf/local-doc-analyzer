import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildHwp, para, table, cell, textBox } from '../../test/fixtures/hwp-builder';

/**
 * 합성 .hwp 픽스처 — make-hwpx.ts 와 같은 문서 모양(쪽 나눔 · 세로 병합으로 가려진 칸 · 글상자 · 잘린 PrvText)을
 * HWP 5.x 바이너리로. 실물은 저장소에 넣지 않는다(설계 §4.4).
 */
export function writeSampleHwp(path: string): void {
  const t = table(2, 3, [cell(0, 0, '분류', { rowSpan: 2 }), cell(0, 1, '항목'), cell(0, 2, '달성률'), cell(1, 1, '기능 개발'), cell(1, 2, '100%')]);
  const layout = buildHwp({
    sections: [[
      para('첫 쪽의 내용입니다'),
      para(['둘째 쪽의 내용입니다', textBox([para('상자 안 제목')])], { breakType: 0x04 }),
      para(t),
    ]],
    prvText: '첫 쪽의 내',
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, layout.bytes);
}

/** 배포용 문서(FileHeader bit2) — 전용 안내 배너 확인용 */
export function writeDistributionHwp(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildHwp({ flags: 0x05, sections: [[para('배포용 본문')]] }).bytes);
}
