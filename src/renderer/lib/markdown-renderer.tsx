import ReactMarkdown from 'react-markdown';
import { GFM_REMARK_PLUGINS } from './gfm-plugins';
import { safeComponents, sourceComponents, type MarkdownVariant } from './safe-markdown';
import { MATH_REMARK_PLUGINS, MATH_REHYPE_PLUGINS } from './math-plugins';
import { normalizeMathDelimiters } from './math-normalize';

// react-markdown + remark-gfm 를 담는 지연 청크 타깃.
//
// 이 모듈은 safe-markdown 의 `SafeMarkdown` 이 `React.lazy(() => import('./markdown-renderer'))`
// 로만 끌어온다 — 정적 import 가 어디에도 없으므로 react-markdown(≈50KB gzip)·remark-gfm 이
// cold-start eager 번들에서 빠지고, 요약/Q&A 첫 렌더 직전에 비동기 로드된다.
// (export-html 은 이미 별도 lazy 청크라 자체적으로 react-markdown 을 정적 import 한다.)

/**
 * remark/rehype 플러그인 — 모듈 스코프 상수로 매 렌더 새 참조 생성 방지.
 * GFM 설정(단일 물결 취소선 끔, QA34 M6)은 gfm-plugins.ts 가 단일 출처다.
 */
const REMARK_PLUGINS = [...GFM_REMARK_PLUGINS, ...MATH_REMARK_PLUGINS];
const REHYPE_PLUGINS = MATH_REHYPE_PLUGINS;

/**
 * 원문 패널(variant='source')용 — QA35. 원문은 신뢰할 수 없는 문서 텍스트이므로 인용 변환·수식
 * 플러그인을 끄고 GFM(추출기가 직렬화한 표)만 쓴다.
 *
 * 수식 플러그인을 꺼도 CommonMark 의 역슬래시 이스케이프가 `\(`·`\[` 의 역슬래시를 먹어 원문의
 * `\(x\)` 가 `(x)` 로 보인다. 수식 구분자 앞 역슬래시만 두 배로 해 글자 그대로 남긴다 — 표 셀은
 * 추출기(table.ts)가 이미 역슬래시를 두 배로 했지만, 두 배가 된 쌍의 **뒤쪽** 하나만 다시 두 배가
 * 되므로 렌더 결과는 같다(`\\(` → `\\\(` → 화면 `\(`). 다른 이스케이프(`\|` 등)는 건드리지 않는다.
 */
const SOURCE_REMARK_PLUGINS = [...GFM_REMARK_PLUGINS];
function keepMathDelimitersLiteral(text: string): string {
  return text.replace(/\\(?=[()[\]])/g, '\\\\');
}

export default function MarkdownRenderer({ children, variant = 'summary' }: { children: string; variant?: MarkdownVariant }) {
  if (variant === 'source') {
    return (
      <ReactMarkdown
        remarkPlugins={SOURCE_REMARK_PLUGINS}
        components={sourceComponents}
      >{keepMathDelimitersLiteral(children)}</ReactMarkdown>
    );
  }
  // 파싱 전에 `\(…\)` → `$$…$$` 정규화. 저장된 세션의 기존 요약도 렌더 시점에 함께 살아난다
  // (본문을 마이그레이션하지 않는다 — 원문은 LLM 출력 그대로 보존).
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={safeComponents}
    >{normalizeMathDelimiters(children)}</ReactMarkdown>
  );
}
