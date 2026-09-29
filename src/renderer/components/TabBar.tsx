import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { switchToTab, closeTab, openNewTabView } from '../lib/tabs';
import { formatUnitCount } from '../lib/citation';

/**
 * 다중 문서 탭바 (multi-doc Phase 1).
 * 열린 문서가 1개 이상일 때 헤더 아래에 표시. 활성 탭 = document.filePath 파생.
 * 생성/파싱 중에는 전환·닫기·새 탭을 비활성화 (handlePdfData 내부 가드의 사전 차단판).
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activePath = useAppStore((s) => s.document?.filePath ?? null);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const isParsing = useAppStore((s) => s.isParsing);
  const isCollectionBusy = useAppStore((s) => s.isCollectionBusy);
  // QA21(B-LOW): 전환 진행 중 표식. 이전엔 tabs.ts 의 **모듈 로컬** 변수라 React 가 구독할 수
  // 없어, 전환 중 다른 탭을 클릭하면 switchToTab 이 조용히 return 했다(index.bin 이 큰 문서에선
  // 수 초간 클릭이 안 먹는 것처럼 보임). store 이관으로 이제 시각화할 수 있다.
  const isTabSwitching = useAppStore((s) => s.isTabSwitching);
  // QA22(A-LOW): **비활성 탭 닫기의 실제 가드**를 그대로 반영한다. closeTab 은 비활성 탭에서도
  // isCollectionBusy / collectionOpenInFlight / isTabSwitching 이면 **조용히 return** 하는데,
  // 버튼은 `blocked && isActive` 라 항상 enabled 였다 — 누르면 아무 일도 안 일어난다. Tier4(QA21)가
  // blocked 에 isTabSwitching 을 추가하며 전환 버튼은 시각화했지만 닫기 버튼의 비대칭은 남았고,
  // 오히려 무음 무시 조건이 셋으로 늘었다. (진실의 원천은 훅 가드, UI 는 그 시각화 — Tier2 원칙)
  const collectionOpenInFlight = useAppStore((s) => s.collectionOpenInFlight);
  const inactiveCloseBlocked = isCollectionBusy || collectionOpenInFlight || isTabSwitching;
  const t = useT();

  if (openTabs.length === 0) return null;
  // isCollectionBusy 포함 — isTabSwitchBlocked 와 동일 기준(gather 중 전환 차단).
  const blocked = isGenerating || isQaGenerating || isParsing || isCollectionBusy || isTabSwitching;

  // a11y M4: 이전엔 <div role="tab"> 안에 전환·닫기 버튼 2개를 중첩해 ARIA nested-interactive 를
  // 위반했고, role="tab" 자체는 비포커스이며 roving tabindex/화살표키·tabpanel 연결도 없어 불완전한
  // 탭 패턴이었다. 닫기 버튼이 달린 브라우저식 탭은 ARIA Tabs 보다 "탐색 목록"이 정합적이므로
  // <nav><ul><li> + 활성 표시 aria-current="page" 로 재구성(중첩 위반 제거, 시맨틱 정확).
  return (
    <nav
      aria-label={t('tabs.label')}
      className="flex items-center gap-1 px-2 py-1 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 overflow-x-auto"
    >
      <ul role="list" className="flex items-center gap-1 m-0 p-0 list-none">
        {openTabs.map((tab) => {
          const isActive = tab.filePath === activePath;
          return (
            <li
              key={tab.filePath}
              className={`group flex items-center gap-1 max-w-48 shrink-0 rounded-t px-2 py-1 text-xs border-b-2 transition-colors ${
                isActive
                  ? 'border-blue-500 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-medium'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <button
                onClick={() => { if (!blocked) void switchToTab(tab.filePath); }}
                disabled={blocked && !isActive}
                aria-current={isActive ? 'page' : undefined}
                className="truncate disabled:cursor-not-allowed"
                title={`${tab.fileName} (${formatUnitCount(tab.pageCount, tab.unitKind ?? 'page', 'short')})`}
              >
                📄 {tab.fileName}
              </button>
              {/* 활성 탭은 blocked(생성/파싱/전환), 비활성 탭은 컬렉션·전환 진행 중에만 차단 —
                  둘 다 closeTab 의 실제 가드와 1:1 대응(QA22 A-LOW). */}
              <button
                onClick={() => { void closeTab(tab.filePath); }}
                disabled={isActive ? blocked : inactiveCloseBlocked}
                aria-label={t('tabs.close', { name: tab.fileName })}
                className="shrink-0 rounded px-0.5 text-gray-400 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed opacity-60 group-hover:opacity-100"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={() => { if (!blocked) void openNewTabView(); }}
        disabled={blocked || activePath === null}
        aria-label={t('tabs.newTab')}
        title={t('tabs.newTab')}
        className="shrink-0 rounded px-2 py-1 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ＋
      </button>
    </nav>
  );
}
