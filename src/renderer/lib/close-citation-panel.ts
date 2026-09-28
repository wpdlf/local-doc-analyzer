import { useAppStore } from './store';
import { restoreCitationFocus } from './citation-focus';

/**
 * 인용 패널(원문 보기) 닫기 — PdfViewerPanel·DocTextViewerPanel 공유 (QA34 H1).
 *
 * 종전에는 이 시퀀스가 PdfViewerPanel 안에만 있어서 v1.8.0 에 추가된 형제 패널
 * (DocTextViewerPanel)이 ✕ 버튼·Esc·포커스 반환을 **통째로** 갖지 못했다 — DOCX 문서에서
 * 인용을 누르면 패널을 닫을 방법이 없었다. 배율 컨트롤(ZoomControls)이 같은 이유로 분리된
 * 것과 같은 형태다: 사본이 둘이면 한쪽만 따라간다.
 *
 * QA14(D-MED): 패널 닫힘 시 포커스를 트리거 CitationButton 으로 반환(패널 언마운트로 body 유실
 * 방지). 재렌더로 트리거 버튼이 재부착된 뒤 포커스하도록 rAF 로 지연.
 */
export function closeCitationPanel(): void {
  useAppStore.getState().setCitationTarget(null);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreCitationFocus);
  else restoreCitationFocus();
}
