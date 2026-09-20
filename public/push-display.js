// Service Workerのpush受信ペイロード({title, body, tag})から通知内容を組み立てる．
// tagはサーバー(request-guards.jsのnotificationTag)が事象単位で決める:
//  - 地震は同一事象の更新を同じtagで置換する
//  - 地域単位の種別は内容ごとに別tagとし，別の災害通知を上書きしない
//  - tagが無い場合はtagを付けず，常に新しい通知として追加する
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PushDisplay = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT = { title: '防災情報', body: '新しい通報が届きました。アプリを開いて確認してください。' };

  function parsePushData(event) {
    try {
      if (event && event.data) return { ...DEFAULT, ...event.data.json() };
    } catch (e) { /* JSONでなければ既定文言 */ }
    return { ...DEFAULT };
  }

  function buildNotification(data) {
    const options = {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
    };
    if (typeof data.tag === 'string' && data.tag) {
      options.tag = data.tag;
      options.renotify = true; // 同一事象の更新も再度知らせる
    }
    return { title: data.title, options };
  }

  return { parsePushData, buildNotification };
});
