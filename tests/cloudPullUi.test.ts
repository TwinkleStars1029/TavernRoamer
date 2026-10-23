import { describe, expect, it } from 'vitest';
import { renderCloudChatListHtml, renderCloudRoleListHtml } from '../src/ui';

describe('cloud pull rendering', () => {
  it('renders role buttons with escaped names', () => {
    const html = renderCloudRoleListHtml([{ roleKey: 'Alice<& >' }]);
    expect(html).toContain('data-cloud-role="Alice&lt;&amp; &gt;"');
    expect(html).toContain('Alice&lt;&amp; &gt;');
    expect(html).toContain('tr-cloud-role-chevron');
    expect(html).toMatch(/tr-cloud-role-chevron" aria-hidden="true"/);
    expect(html).not.toContain('Alice<&');
  });

  it('renders empty state when no roles', () => {
    expect(renderCloudRoleListHtml([])).toContain('雲端沒有任何備份');
  });

  it('renders chat rows with latest info and pull button data attributes', () => {
    const html = renderCloudChatListHtml('Alice', [
      {
        chatId: '2026-06-28@15h24m22s470ms',
        versionCount: 2,
        latest: {
          fileId: 'f1',
          filename: '2026-06-26T09-00-00Z__B電腦.jsonl',
          uploadedAt: new Date('2026-06-26T09:00:00Z'),
          uploadedAtUtc: '2026-06-26T09-00-00Z',
          device: 'B電腦'
        }
      }
    ]);
    expect(html).toContain('data-cloud-pull-role="Alice"');
    expect(html).toContain('data-cloud-pull-chat="2026-06-28@15h24m22s470ms"');
    expect(html).toContain('B電腦');
    expect(html).toContain('2 版');
    expect(html).toContain('data-cloud-back');
    expect(html).toContain('>建立</button>');
  });

  it('disables pull button for chats without versions', () => {
    const html = renderCloudChatListHtml('Alice', [
      { chatId: '2026-07-01@08h00m00s000ms', versionCount: 0, latest: null }
    ]);
    expect(html).toContain('disabled');
  });
});
