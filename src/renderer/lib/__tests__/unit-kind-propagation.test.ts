import { describe, it, expect } from 'vitest';
import { SESSION_SCHEMA_VERSION } from '../../../shared/session-types';
import { useAppStore } from '../store';

describe('unitKind 전파', () => {
  it('스키마 버전을 올리지 않는다 (부재가 곧 page 이므로 마이그레이션이 불필요하다)', () => {
    expect(SESSION_SCHEMA_VERSION).toBe(1);
  });

  it('openTabs 항목이 unitKind 를 싣는다', () => {
    useAppStore.setState({ openTabs: [] });
    useAppStore.getState().upsertOpenTab({
      filePath: 'C:/x/a.docx', fileName: 'a.docx', pageCount: 3, unitKind: 'page',
    });
    expect(useAppStore.getState().openTabs[0]?.unitKind).toBe('page');
  });

  it('unitKind 없는 기존 탭도 허용된다 (선택 필드)', () => {
    useAppStore.setState({ openTabs: [] });
    useAppStore.getState().upsertOpenTab({
      filePath: 'C:/x/a.pdf', fileName: 'a.pdf', pageCount: 3,
    });
    expect(useAppStore.getState().openTabs[0]?.unitKind).toBeUndefined();
  });
});
