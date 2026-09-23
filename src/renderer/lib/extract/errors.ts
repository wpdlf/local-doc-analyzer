/**
 * 추출기(docx.ts/zip.ts/xml.ts) 공용 에러 던지기 — 단일 출처.
 *
 * Task10 fix round2: `PDF_TOO_MANY_PAGES` 가 PDF 경로(parsePdf)와 DOCX 경로(docx.ts) 양쪽에서
 * 던져지는데, PDF 쪽은 이미 번역된 문자열을 message 에 직접 담아 던지고 DOCX 쪽은 개발자용
 * 영어를 던져 document-open.ts 의 바깥 catch 를 그대로 통과했다("PDF 경로는 이미 번역돼 온다"는
 * 가정이 두 번째 추출기가 생기는 순간 깨졌다). 추출기는 번역하지 않는다(단일 경계 원칙 유지) —
 * 대신 코드 옆에 **번역 파라미터**를 함께 싣는다. 파라미터가 있으면(빈 객체 포함) 그 에러는
 * "경계에서 t() 로 번역해야 한다"는 신호고, 없으면(undefined) "이미 번역됐거나 메시지 그대로
 * 보여줘도 된다"는 신호다 — document-open.ts 의 catch 가 이 구분으로 두 관례를 모두 옳게 다룬다.
 *
 * docx.ts·xml.ts·zip.ts 가 각자 로컬 `fail()` 을 갖던 것을 걷어낸다 — 로컬 헬퍼가 여러 개면
 * 그중 하나만 파라미터를 붙이는 형제 누락이 그대로 재현된다(이 라운드가 정확히 그 사례였다).
 */
export interface ExtractError extends Error {
  code: string;
  /** 있으면(빈 객체 포함) document-open.ts 의 catch 가 t(key, params) 로 번역한다. */
  params?: Record<string, string>;
}

export function extractFail(code: string, message: string, params?: Record<string, string>): never {
  throw Object.assign(new Error(message), { code, params: params ?? {} }) as ExtractError;
}
