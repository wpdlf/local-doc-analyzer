import remarkGfm from 'remark-gfm';
import type { Options } from 'react-markdown';

// PluggableList 의 출처(`unified`)는 전이 의존이라 직접 import 하지 않는다 — math-plugins.ts 와 같은 방식.
type PluggableList = NonNullable<Options['remarkPlugins']>;

/**
 * GFM 플러그인 설정 — 화면(markdown-renderer)과 PDF 내보내기(export-html)가 함께 써야 할
 * 단일 출처 (math-plugins.ts 와 같은 이유: 두 사본이면 한쪽만 고쳐진다).
 *
 * QA34(M6): `singleTilde: false` — GFM 기본값은 **단일** 물결(`~x~`)도 취소선으로 본다. 그래서
 * 원문 뷰어(DocTextViewer)에서 "기간 9/1~9/30, 인원 10~20명" 의 두 물결 사이가 <del> 로 그려졌다.
 * 한국어 문서·요약에서 `~` 는 거의 언제나 **범위** 표기다(LLM 요약도 "3~5쪽", "10~20%" 를 그대로
 * 옮긴다). 반대로 LLM 이 취소선을 쓸 때는 표준 `~~x~~` 를 쓰고 그것은 이 설정에서도 유지된다.
 * 뷰어별로 옵션을 가르면 같은 문장이 요약과 원문에서 다르게 보이므로 렌더러 전체에 적용한다.
 *
 * ⚠️ 이 모듈은 remark-gfm 을 정적 import 한다 — 지연 청크(markdown-renderer·export-html)에서만
 * import 할 것(eager 번들로 끌려오면 cold-start 가 늘어난다, eager-graph.test.ts).
 */
export const GFM_REMARK_PLUGINS: PluggableList = [[remarkGfm, { singleTilde: false }]];
