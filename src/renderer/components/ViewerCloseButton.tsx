import { useEffect } from 'react';
import { useT } from '../lib/i18n';
import { isEditableFocused } from '../lib/use-zoom-controls';

interface ViewerCloseButtonProps {
  onClose: () => void;
  /** 버튼 배치(여백)만 호출자가 정한다 — 모양·라벨·동작은 여기서 고정. */
  className?: string;
}

/**
 * 인용 패널의 ✕ 닫기 버튼 + Escape 키 닫기 — PdfViewer·DocTextViewer 공유 (QA34 H1).
 *
 * Escape 핸들러를 **버튼과 한 컴포넌트에** 둔다: 닫기 버튼을 그리는 패널은 Esc 도 자동으로
 * 갖게 되고, 둘 중 하나만 있는 패널이 생길 수 없다. 종전에는 Esc 가 PdfViewer 본체에만
 * 있어서 PdfViewerPanel 의 로딩/실패 화면(✕ 는 있음)과 DocTextViewerPanel(둘 다 없음)에서
 * Esc 가 죽어 있었다.
 *
 * v0.18.4 H3 fix: editable 포커스(textarea/input/contenteditable) 에서 ESC 는 입력 롤백·IME
 * 조합 취소 등 관례적 용도로 쓰이므로 가로채지 않고 흘려보낸다(QaChat 질문 입력 중 ESC 가
 * 인용 패널을 닫던 UX 이슈). Shadow DOM 추적은 isEditableFocused 가 한다(v0.18.5 L1).
 */
export function ViewerCloseButton({ onClose, className = '' }: ViewerCloseButtonProps) {
  const t = useT();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isEditableFocused()) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <button
      type="button"
      onClick={onClose}
      className={`text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm px-2 py-1 ${className}`}
      aria-label={t('pdfviewer.close')}
    >
      ✕
    </button>
  );
}
