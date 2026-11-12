/* テスト用iframeの中だけで使用する．実受信・外部書込み・通知購読を遮断する． */
(() => {
  'use strict';
  if (new URLSearchParams(location.search).get('sandbox') !== '1') return;
  const token = location.hash.slice(1);
  const config = { showTrainingBroadcasts: false, lalertEnabled: false, weatherEnabled: false, volcanoEnabled: false };
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    if (url.origin === location.origin && url.pathname === '/config' && method === 'GET') {
      return new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } });
    }
    if (!['GET', 'HEAD'].includes(method)) throw new Error('テスト画面からのサーバー書込みは無効です．');
    return fetchOriginal(input, options);
  };
  class DisabledWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { throw new Error('テスト画面では実際のWebSocketへ接続しません．'); }
  }
  window.WebSocket = DisabledWebSocket;
  if (navigator.sendBeacon) navigator.sendBeacon = () => false;
  // テスト操作で通常画面の表示設定を書き換えない．
  const memory = new Map();
  try {
    Object.defineProperty(window, 'localStorage', { value: {
      getItem: key => memory.get(String(key)) ?? null,
      setItem: (key, value) => memory.set(String(key), String(value)),
      removeItem: key => memory.delete(String(key)), clear: () => memory.clear(),
    } });
  } catch { /* 保存機能に依存せず，通信の隔離は維持する． */ }
  const post = message => {
    if (window.parent !== window && token) window.parent.postMessage({ ...message, token }, location.origin);
  };
  window.QzssSandbox = {
    attach(apply, ready) {
      let busy = false;
      window.addEventListener('message', async event => {
        if (event.source !== window.parent || event.origin !== location.origin || !token
          || event.data?.token !== token || event.data?.type !== 'qzss-test-command') return;
        const { id, reset, reports = [] } = event.data;
        if (busy) return post({ type: 'qzss-test-result', id, error: '処理中です．' });
        busy = true;
        try {
          if (!Array.isArray(reports) || reports.length > 20) throw new Error('通報の形式が不正です．');
          // コピー元の分類にかかわらず，画面は必ずテスト扱いにする．
          const now = new Date().toISOString();
          const normalized = reports.map(report => {
            const result = { ...report, is_test_data: true, timestamp: now };
            delete result.client_timestamps;
            return result;
          });
          const results = await apply({ reset: !!reset, reports: normalized });
          post({ type: 'qzss-test-result', id, results });
        } catch (error) {
          post({ type: 'qzss-test-result', id, error: error.message });
        } finally { busy = false; }
      });
      Promise.resolve(ready).then(() => post({ type: 'qzss-test-ready' })).catch(() => post({ type: 'qzss-test-error', error: '地図の準備に失敗しました．' }));
    },
  };
})();
