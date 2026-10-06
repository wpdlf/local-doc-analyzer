/**
 * 한글 바이너리(.hwp, HWP 5.x) 추출기 — 설계 docs/02-design/features/hwp-binary.design.md.
 *
 * 컨테이너는 CFB(cfb.ts), 그 안의 스트림은 레코드 열(hwp-records.ts)이다. 문단·표·글상자·그림·수식을 읽는
 * 규칙은 hwpx.ts 와 **같게** 맞춘다(확장자에 따라 품질이 갈리면 안 된다 — 설계 H1): 표는 좌표 격자 → GFM,
 * 셀 안 표는 평탄화, 글상자는 호스트 문단 뒤 블록, 수식은 `[수식: …]`, 머리말·각주·숨은 설명은 제외.
 */
import { paginate, type Block } from './paginate';
import { toGfmTable, placeGridCells, gridExtent, type GridCell } from './table';
import { MAX_PAGE_COUNT } from '../pdf-parser';
import type { ContainerIndex, Extractor, ExtractedDoc, ExtractedHeading, ExtractOptions } from './types';
import { HWP_FORMAT_ID, SUPPORTED_LABEL } from '../../../shared/document-formats';
import { extractFail } from './errors';
import { fitImage, type ImageFitter } from './image-fit';
import { collectImages, throwIfAborted, yieldToEventLoop } from './common';
import { MAX_UNZIPPED_BYTES } from './zip';
import {
  TAG, parseRecords, buildTree, inflateBudgeted, chargeRead, readParaText, ctrlIdAt, readUtf16, u16, u32,
  type HwpRecord, type InflateBudget,
} from './hwp-records';
import { readDocInfo, type BinDataEntry } from './hwp-docinfo';
import { readTable, followingParagraphs } from './hwp-table';

const SIGNATURE = 'HWP Document File';
const FLAG_COMPRESSED = 0x01;
const FLAG_PASSWORD = 0x02;
const FLAG_DISTRIBUTION = 0x04;
const FLAG_DRM = 0x10;
/** PARA_HEADER @11 나눔 종류 — bit0 구역 나눔 · bit2 쪽 나눔(실물 확인, 설계 §0). bit1 다단 · bit3 단은 쪽이 아니다. */
const BREAK_BEFORE_MASK = 0x01 | 0x04;
const SECTION_STREAM = /^BodyText\/Section(\d+)$/i;
/** 표·글상자 중첩 상한 — hwpx.ts MAX_NEST_DEPTH 와 같은 값(형제 비대칭 방지) */
const MAX_NEST_DEPTH = 16;
/** 도형 그룹 중첩 상한 — pptx 그룹 깊이 상한과 같은 값 */
const MAX_SHAPE_DEPTH = 32;
const YIELD_EVERY = 200;
/** SHAPE_COMPONENT_PICTURE 의 BinItem id 위치(테두리 12 + 좌표 32 + 자르기 16 + 여백 8 + 밝기·대비·효과 3) */
const PICTURE_BIN_ID_OFFSET = 71;
/** 본문 내용을 담는 컨트롤 — 나머지(구역·단 정의, 머리말·꼬리말, 각주·미주, 숨은 설명, 필드…)는 본문이 아니다. */
const CONTENT_CTRLS = new Set(['tbl ', 'gso ', 'eqed']);

type TableText = (ctrl: HwpRecord, depth: number) => string;

function hasSignature(header: Uint8Array | null): header is Uint8Array {
  if (!header || header.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (header[i] !== SIGNATURE.charCodeAt(i)) return false;
  return true;
}

/** 수식 → `[수식: <한글 수식 스크립트>]`. LaTeX 로 옮기지 않는다(hwpx.ts equationText 와 같은 이유). */
function equationText(ctrl: HwpRecord): string {
  const eq = ctrl.children.find((c) => c.tag === TAG.EQEDIT);
  if (!eq || eq.data.length < 6) return '';
  const s = readUtf16(eq.data, 6, u16(eq.data, 4)).replace(/\s+/g, ' ').trim();
  return s ? `[수식: ${s}]` : '';
}

function pictureBinId(pic: HwpRecord): number {
  return pic.data.length >= PICTURE_BIN_ID_OFFSET + 2 ? u16(pic.data, PICTURE_BIN_ID_OFFSET) : 0;
}

/** 서브트리의 그림 BinItem id 전부(문서 순서). 표를 만나면 셀 안 그림을 한 번에 모은다(hwpx 의 raw walk 와 같은 규칙). */
function picturesIn(node: HwpRecord): number[] {
  const out: number[] = [];
  const visit = (n: HwpRecord) => {
    for (const c of n.children) {
      // 머리말·각주·숨은 설명은 텍스트가 빠지므로 그림도 싣지 않는다(plainTextWithPics 와 같은 규칙).
      if (c.tag === TAG.CTRL_HEADER && !CONTENT_CTRLS.has(ctrlIdAt(c.data, 0))) continue;
      if (c.tag === TAG.SHAPE_COMPONENT_PICTURE) {
        const id = pictureBinId(c);
        if (id) out.push(id);
      }
      visit(c);
    }
  };
  visit(node);
  return out;
}

/** gso 서브트리 → 글상자 밖 그림과 글상자 문단 목록. 묶음 개체는 MAX_SHAPE_DEPTH 까지 내려간다. */
function scanShape(node: HwpRecord, depth: number, out: { pics: number[]; boxes: HwpRecord[][] }): void {
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k.tag === TAG.SHAPE_COMPONENT_PICTURE) {
      const id = pictureBinId(k);
      if (id) out.pics.push(id);
    } else if (k.tag === TAG.LIST_HEADER) {
      // gso CTRL_HEADER 바로 아래(depth 0)의 LIST_HEADER 는 캡션이다 — 글상자는 SHAPE_COMPONENT 아래에 있다.
      if (depth === 0) continue;
      out.boxes.push(followingParagraphs(kids, i + 1));
    } else if (k.tag !== TAG.PARA_HEADER && depth < MAX_SHAPE_DEPTH) {
      scanShape(k, depth + 1, out);
    }
  }
}

/** 문단 하나를 읽은 결과 — hwpx.ts ParaOut 과 같은 모양(그림은 BinItem id). */
interface ParaOut {
  parts: string[];
  boxes: HwpRecord[][];
  pics: { binId: number; part: number }[];
}

function readParagraph(para: HwpRecord, depth: number, tableText: TableText): ParaOut {
  const out: ParaOut = { parts: [], boxes: [], pics: [] };
  let buf = '';
  // 수식 뒤 글자가 공백 없이 붙어 있으면 한 칸 띄운다(hwpx 와 같다).
  let padNext = false;
  const flush = () => { if (buf.trim()) out.parts.push(buf); buf = ''; padNext = false; };
  const append = (s: string) => {
    if (!s) return;
    if (padNext && !/^\s/.test(s)) buf += ' ';
    padNext = false;
    buf += s;
  };
  const ctrls = para.children.filter((c) => c.tag === TAG.CTRL_HEADER);
  const used = new Set<HwpRecord>();
  const handle = (ctrl: HwpRecord) => {
    used.add(ctrl);
    switch (ctrlIdAt(ctrl.data, 0)) {
      case 'tbl ': {
        flush();
        for (const binId of picturesIn(ctrl)) out.pics.push({ binId, part: out.parts.length });
        const tb = tableText(ctrl, depth + 1);
        if (tb) out.parts.push(tb);
        break;
      }
      case 'gso ': {
        const shape = { pics: [] as number[], boxes: [] as HwpRecord[][] };
        scanShape(ctrl, 0, shape);
        for (const binId of shape.pics) out.pics.push({ binId, part: out.parts.length });
        out.boxes.push(...shape.boxes);
        break;
      }
      case 'eqed': {
        const m = equationText(ctrl);
        if (m) {
          if (buf && !/\s$/.test(buf)) buf += ' ';
          buf += m;
          padNext = true;
        }
        break;
      }
      // 그 밖의 컨트롤은 본문이 아니다. 필드의 **표시 텍스트**는 컨트롤 밖 PARA_TEXT 에 있어 잃지 않는다.
    }
  };
  const text = para.children.find((c) => c.tag === TAG.PARA_TEXT);
  for (const seg of text ? readParaText(text.data) : []) {
    if (seg.kind === 'text') { append(seg.text); continue; }
    // 확장 컨트롤 문자와 CTRL_HEADER 는 순서대로 짝을 이룬다(실물 확인). id 로 다음 미사용 것을 고른다.
    const ctrl = ctrls.find((c) => !used.has(c) && ctrlIdAt(c.data, 0) === seg.id);
    if (ctrl) handle(ctrl);
  }
  // 본문에 자리표시가 없던 컨트롤(비표준 작성기)도 잃지 않는다 — 문단 끝에서 처리한다.
  for (const ctrl of ctrls) if (!used.has(ctrl)) handle(ctrl);
  flush();
  return out;
}

/** 깊이 상한을 넘은 서브트리 — 구조 없이 텍스트·수식·그림만 모은다(잃지 않는다, hwpx plainTextWithPics 와 같은 규칙). */
function plainTextWithPics(nodes: HwpRecord[]): { text: string; pics: number[] } {
  let text = '';
  const pics: number[] = [];
  const visit = (n: HwpRecord) => {
    if (n.tag === TAG.PARA_TEXT) {
      for (const seg of readParaText(n.data)) if (seg.kind === 'text') text += seg.text;
      text += '\n';
    } else if (n.tag === TAG.SHAPE_COMPONENT_PICTURE) {
      const id = pictureBinId(n);
      if (id) pics.push(id);
    } else if (n.tag === TAG.CTRL_HEADER) {
      const id = ctrlIdAt(n.data, 0);
      if (!CONTENT_CTRLS.has(id)) return; // 머리말·각주 등은 폴백에서도 제외
      if (id === 'eqed') { const m = equationText(n); if (m) text += ` ${m} `; }
    }
    for (const c of n.children) visit(c);
  };
  nodes.forEach(visit);
  return { text: text.trim(), pics };
}

/** 셀·글상자 문단들 → 한 덩어리 텍스트(문단은 줄바꿈) + 그 안의 그림(hwpx containerText 와 같은 규칙). */
function containerText(paras: HwpRecord[], depth: number, tableText: TableText): { text: string; pics: number[] } {
  if (depth > MAX_NEST_DEPTH) return plainTextWithPics(paras);
  const lines: string[] = [];
  const pics: number[] = [];
  for (const para of paras) {
    const r = readParagraph(para, depth, tableText);
    lines.push(...r.parts);
    pics.push(...r.pics.map((p) => p.binId));
    for (const box of r.boxes) {
      const nested = containerText(box, depth + 1, tableText);
      lines.push(nested.text);
      pics.push(...nested.pics);
    }
  }
  return { text: lines.join('\n'), pics };
}

/** 표 → 직사각형 행렬. 선언 행·열 수는 참고만 하고 셀 주소로 놓는다(gridExtent — R18, QA35 행 축 무상한). */
function tableGrid(ctrl: HwpRecord, depth: number): string[][] {
  const t = readTable(ctrl);
  // 셀 안 그림은 readParagraph 의 'tbl ' 분기(picturesIn)가 이미 실었다 — 여기서는 텍스트만 쓴다.
  const cells: GridCell[] = t.cells.map((c) => ({
    row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
    text: containerText(c.paras, depth, flattenTableText).text,
  }));
  return placeGridCells(cells, gridExtent(cells, 'row', t.rows), gridExtent(cells, 'col', t.cols));
}

function flattenTableText(ctrl: HwpRecord, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return plainTextWithPics([ctrl]).text;
  return tableGrid(ctrl, depth)
    .map((row) => row.map((c) => c.replace(/\s+/g, ' ').trim()))
    .filter((row) => row.some((c) => c !== ''))
    .map((row) => row.join(' / '))
    .join('; ');
}

/** 최상위(본문·글상자)의 표 → GFM 표. */
function gridTableText(ctrl: HwpRecord, depth: number): string {
  if (depth > MAX_NEST_DEPTH) return flattenTableText(ctrl, depth);
  return toGfmTable(tableGrid(ctrl, depth));
}

/** 본문 구역 스트림 — 번호순(사전순이면 Section10 이 Section2 앞에 온다). */
function sectionStreams(index: ContainerIndex): string[] {
  return index.names()
    .filter((n) => SECTION_STREAM.test(n))
    .sort((a, b) => Number(SECTION_STREAM.exec(a)![1]) - Number(SECTION_STREAM.exec(b)![1]));
}

export interface HwpExtractorDeps {
  fitImage?: ImageFitter;
  /** 압축 해제 누적 상한 — 테스트 전용 오버라이드(zip.ts maxUnzippedBytes 와 같은 관례). 기본 MAX_UNZIPPED_BYTES. */
  maxInflateBytes?: number;
}

export function createHwpExtractor(deps: HwpExtractorDeps = {}): Extractor {
  const fit = deps.fitImage ?? fitImage;
  return {
    id: HWP_FORMAT_ID,

    sniff: (index) => hasSignature(index.bytes('FileHeader')),

    extract: async (index: ContainerIndex, opts: ExtractOptions): Promise<ExtractedDoc> => {
      throwIfAborted(opts.signal);
      const header = index.bytes('FileHeader');
      if (!hasSignature(header) || header.length < 40) extractFail('DOC_CORRUPT', 'FileHeader missing');
      const major = u32(header, 32) >>> 24;
      const flags = u32(header, 36);
      if (major !== 5) extractFail('DOC_UNSUPPORTED', `hwp major version ${major}`, { list: SUPPORTED_LABEL });
      if (flags & FLAG_DISTRIBUTION) extractFail('DOC_DISTRIBUTION', 'distribution document');
      if (flags & (FLAG_PASSWORD | FLAG_DRM)) extractFail('DOC_ENCRYPTED', 'password or drm protected hwp');

      const compressed = (flags & FLAG_COMPRESSED) !== 0;
      // 문서 하나의 모든 스트림(DocInfo·구역·그림)이 한 예산을 나눠 쓴다 — 스트림별 상한이 아니다(설계 §3.2).
      // 무압축 스트림은 읽은 바이트를 센다 — 항목들이 한 섹터 체인을 나눠 가지는 읽기 증폭도 여기서 막힌다.
      const budget: InflateBudget = { remaining: deps.maxInflateBytes ?? MAX_UNZIPPED_BYTES };
      const decode = (raw: Uint8Array): Uint8Array => (compressed ? inflateBudgeted(raw, budget) : chargeRead(raw, budget));

      const docInfoRaw = index.bytes('DocInfo') ?? extractFail('DOC_CORRUPT', 'DocInfo missing');
      const docInfo = readDocInfo(parseRecords(decode(docInfoRaw)));

      const sections = sectionStreams(index);
      if (sections.length === 0) {
        // 배포용 문서는 본문을 ViewText/ 에 암호화해 둔다 — 플래그가 빠진 파일도 같은 안내로 간다.
        if (index.names().some((n) => n.toLowerCase().startsWith('viewtext/'))) extractFail('DOC_DISTRIBUTION', 'viewtext only');
        extractFail('DOC_CORRUPT', 'no body section');
      }

      const blocks: Block[] = [];
      const headingAt: { level: number; title: string; blockIndex: number }[] = [];
      const imageAt: { binId: number; blockIndex: number }[] = [];
      let processed = 0;

      for (const [si, path] of sections.entries()) {
        // 구역마다 취소를 본다 — QA35 에서 HWPX 가 취소를 놓친 형제 비대칭을 반복하지 않는다.
        throwIfAborted(opts.signal);
        opts.onProgress?.(si, sections.length);
        await yieldToEventLoop();
        throwIfAborted(opts.signal);
        const raw = index.bytes(path) ?? extractFail('DOC_CORRUPT', `${path} missing`);
        // 구역 하나라도 깨지면 여기서 던진다 — 일부만 조용히 빠진 문서를 내지 않는다(설계 H4).
        const paras = buildTree(parseRecords(decode(raw))).filter((r) => r.tag === TAG.PARA_HEADER);
        let firstInSection = si > 0;
        for (const para of paras) {
          processed += 1;
          if (processed % YIELD_EVERY === 0) {
            await yieldToEventLoop();
            throwIfAborted(opts.signal);
          }
          const r = readParagraph(para, 0, gridTableText);
          const breakBefore = firstInSection || ((para.data[11] ?? 0) & BREAK_BEFORE_MASK) !== 0;
          firstInSection = false;
          const level = para.data.length >= 10 ? docInfo.outlineLevels.get(u16(para.data, 8)) : undefined;
          // 빈 문단도 쪽 나눔은 전한다(paginate 가 빈 breakBefore 블록을 flush 로 처리한다).
          if (r.parts.length === 0 && breakBefore) blocks.push({ text: '', breakBefore: true });
          const firstBlock = blocks.length;
          for (const [i, text] of r.parts.entries()) {
            if (i === 0 && level !== undefined && text.trim()) headingAt.push({ level, title: text.trim().split('\n')[0]!, blockIndex: blocks.length });
            blocks.push({ text, breakBefore: i === 0 && breakBefore });
          }
          for (const pic of r.pics) {
            const blockIndex = r.parts.length === 0 ? Math.max(0, blocks.length - 1) : firstBlock + Math.min(pic.part, r.parts.length - 1);
            imageAt.push({ binId: pic.binId, blockIndex });
          }
          // 글상자는 떠 있는 개체 — 쪽 나눔·제목을 만들지 않는다.
          for (const box of r.boxes) {
            const boxResult = containerText(box, 1, gridTableText);
            let boxBlockIndex: number;
            if (boxResult.text.trim()) {
              boxBlockIndex = blocks.length;
              blocks.push({ text: boxResult.text, breakBefore: false });
            } else {
              boxBlockIndex = Math.max(0, blocks.length - 1);
            }
            for (const binId of boxResult.pics) imageAt.push({ binId, blockIndex: boxBlockIndex });
          }
        }
      }
      opts.onProgress?.(sections.length, sections.length);

      const { units, unitOfBlock } = paginate(blocks);
      if (units.length === 0 || !units.some((u) => u.trim())) extractFail('DOC_NO_TEXT', 'no text in document');
      if (units.length > MAX_PAGE_COUNT) {
        extractFail('PDF_TOO_MANY_PAGES', `unit count ${units.length} exceeds ${MAX_PAGE_COUNT}`,
          { pages: String(units.length), max: String(MAX_PAGE_COUNT) });
      }
      const headings: ExtractedHeading[] = headingAt.map((h) => ({ level: h.level, title: h.title, unitIndex: unitOfBlock[h.blockIndex] ?? 0 }));

      if (opts.extractImages === false || imageAt.length === 0) {
        return { units, images: [], headings, unitKind: 'page' };
      }
      // CFB 이름은 대소문자를 가리지 않는다 — DocInfo 의 확장자 표기와 스트림 이름이 다를 수 있다.
      const streamByLower = new Map(index.names().map((n) => [n.toLowerCase(), n] as const));
      const inflateOf = new Map<string, boolean>();
      const candidates = imageAt.map(({ binId, blockIndex }) => {
        const entry: BinDataEntry | null = docInfo.binData[binId - 1] ?? null;
        const path = entry ? streamByLower.get(entry.stream.toLowerCase()) : undefined;
        if (entry && path) inflateOf.set(path, entry.compress === 'yes' || (entry.compress === 'doc' && compressed));
        return { path, unitIndex: unitOfBlock[blockIndex] ?? 0 };
      });
      const imageSource: ContainerIndex = {
        names: () => index.names(),
        has: (name) => index.has(name),
        text: () => null,
        bytes: (name) => {
          const raw = index.bytes(name);
          if (!raw) return raw;
          // 무압축 그림도 같은 예산이다 — DOC_TOO_LARGE 는 그림 하나 건너뛰기가 아니라 문서 전체 거절이다.
          if (!inflateOf.get(name)) return chargeRead(raw, budget);
          try {
            return inflateBudgeted(raw, budget);
          } catch (err) {
            if ((err as { code?: unknown }).code === 'DOC_TOO_LARGE') throw err;
            return null; // 그림 하나가 깨졌으면 그 그림만 건너뛴다(설계 H4)
          }
        },
      };
      const { images, imageBudgetExceeded } = await collectImages(candidates, imageSource, fit, opts.signal);
      return { units, images, headings, unitKind: 'page', ...(imageBudgetExceeded ? { imageBudgetExceeded: true } : {}) };
    },
  };
}

export const hwpExtractor: Extractor = createHwpExtractor();
