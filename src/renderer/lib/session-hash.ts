/**
 * 세션 식별용 콘텐츠 해시.
 *
 * Design Ref: §2.2 / Plan 결정: 문서 식별 = 콘텐츠 해시 기준.
 * 파싱된 extractedText 의 SHA-256 hex 를 docHash 로 사용한다 — 파일 이동/이름변경에도
 * 같은 내용이면 동일 해시로 캐시를 재사용하고, 내용이 바뀌면 자동으로 다른 해시가 되어
 * stale 세션 복원을 차단한다(캐시 무효화의 1차 키).
 *
 * crypto.subtle 은 secure context(Electron 렌더러는 충족)에서 사용 가능.
 */
export async function hashDocumentText(extractedText: string): Promise<string> {
  const bytes = new TextEncoder().encode(extractedText);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(digest);
}

/**
 * 세션 키(docHash) 계산의 단일 출처 — 복원 조회 키와 자동저장 키가 **반드시 같은 함수**를 거쳐야
 * 한다(한쪽만 바뀌면 모든 세션이 영구 miss 가 된다). use-session.ts 의 두 지점이 이것만 부른다.
 *
 * QA34(Important): 비-PDF 는 추출기(paginate)·normalize 가 단위를 '\n\n' 으로 이어 붙여
 * extractedText 에 **단위 경계가 보이지 않는다**. 그래서 DOCX 에서 쪽나눔만 바꾼 편집이 같은
 * 해시가 되어, 옛 요약·index.bin(청크 쪽번호)이 새 pageTexts 위에 복원돼 인용이 엉뚱한 단위로
 * 튀었다. 비-PDF(unitKind 가 있는 문서)는 단위를 '\f' 로 이어 경계를 해시에 넣는다.
 *
 * PDF(unitKind 없음)는 **바이트 단위로 종전과 동일**하다 — 기존 PDF 세션이 계속 hit 해야 한다
 * (session-hash.test.ts 가 값을 핀으로 박는다). 대가: v1.8.0 에서 저장된 DOCX 세션은 키가 바뀌어
 * 한 번 miss(재요약·재임베딩)하고, 옛 세션 파일은 LRU 로 정리된다.
 */
export async function hashDocumentForSession(
  doc: { extractedText: string; pageTexts: readonly string[]; unitKind?: string },
): Promise<string> {
  if (doc.unitKind === undefined) return hashDocumentText(doc.extractedText);
  return hashDocumentText(doc.pageTexts.join('\f'));
}

/** ArrayBuffer → lowercase hex 문자열 */
export function bufferToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    // noUncheckedIndexedAccess: 루프 인덱스가 length 내부임이 보장됨
    hex += view[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
