import { zipSync, strToU8 } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 합성 DOCX 픽스처. 실물 파일은 개인정보가 들어 있어 커밋하지 않는다.
 * 쪽나눔 1회 + 표 1개를 포함해 추출기(`extract/docx.ts`)의 두 경로를 모두 밟는다.
 *
 * `word/document.xml` 만 있으면 `docxExtractor.sniff` 가 통과하고(zip.has 검사뿐), 표 안에
 * 그림이 없으므로 `[Content_Types].xml`/rels 의 실제 내용은 추출에 관여하지 않는다 — 최소
 * 골격만 갖춘다.
 */
const DOC = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>첫째 쪽의 내용입니다</w:t></w:r></w:p>
<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>둘째 쪽의 내용입니다</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>값</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>달성률</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100%</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`;

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export function writeSampleDocx(path: string): void {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '_rels/.rels': strToU8(RELS),
    'word/document.xml': strToU8(DOC),
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zip);
}

if (process.argv[1] && process.argv[1].endsWith('make-docx.ts')) {
  writeSampleDocx(join(process.cwd(), 'e2e', 'fixtures', 'sample.docx'));
}
