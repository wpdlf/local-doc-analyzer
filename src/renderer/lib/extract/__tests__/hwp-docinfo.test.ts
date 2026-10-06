import { describe, it, expect } from 'vitest';
import { readDocInfo } from '../hwp-docinfo';
import { parseRecords } from '../hwp-records';
import { docInfoBytes, type HwpSpec } from '../../../../../test/fixtures/hwp-builder';

const info = (spec: Partial<HwpSpec>) => readDocInfo(parseRecords(docInfoBytes({ sections: [], ...spec })));
const img = new Uint8Array(4);

describe('readDocInfo', () => {
  it('문단 모양의 머리 종류가 개요(1)일 때만 수준(+1)을 준다 — 번호(2)·글머리(3)는 제목이 아니다', () => {
    const d = info({ paraShapes: [{ head: 0, level: 0 }, { head: 1, level: 0 }, { head: 1, level: 2 }, { head: 2, level: 1 }, { head: 3, level: 0 }] });
    expect([...d.outlineLevels]).toEqual([[1, 1], [2, 3]]);
  });

  it('BIN_DATA → BinData/BIN%04X.<ext>(16진 대문자) · 압축 방식 · 링크형(0)은 null', () => {
    const d = info({
      bins: [
        { id: 1, ext: 'jpg', bytes: img },
        { id: 26, ext: 'PNG', bytes: img, compress: 2 },
        { id: 3, ext: 'bmp', bytes: img, type: 0 },
        { id: 4, ext: 'gif', bytes: img, compress: 1 },
      ],
    });
    expect(d.binData).toEqual([
      { stream: 'BinData/BIN0001.jpg', compress: 'doc' },
      { stream: 'BinData/BIN001A.png', compress: 'no' },
      null,
      { stream: 'BinData/BIN0004.gif', compress: 'yes' },
    ]);
  });

  it('확장자에 경로 문자가 있으면 그림으로 쓰지 않는다', () => {
    expect(info({ bins: [{ id: 1, ext: '../x', bytes: img }] }).binData).toEqual([null]);
  });
});
