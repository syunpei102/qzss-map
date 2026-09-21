// 状態ファイルの非同期保存を，同一ファイル名ごとに呼び出し順で直列化する．
// 先行が失敗しても後続は実行する．異なるファイル名は互いに待たない．
function createSerialQueue() {
  const tails = new Map();
  function enqueue(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  // 呼出し時点までに予約された全保存が終わるまで待つ．SIGTERM時に利用する．
  enqueue.drain = async () => {
    while (tails.size) await Promise.all([...tails.values()]);
  };
  return enqueue;
}

// 高頻度に更新される状態向け．最後の呼び出しから遅延後(または最大待ち時間経過後)に
// 1回だけ保存し，GCSへの書込み回数を抑える．flush()で待たずに即時保存できる(終了時用)．
function createDebouncedTask(task, { delayMs = 30000, maxWaitMs = 5 * 60 * 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  let timer = null;
  let firstAt = 0;
  const run = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    firstAt = 0;
    return task();
  };
  const schedule = () => {
    const t = now();
    if (timer === null) firstAt = t;
    else clearTimer(timer);
    const wait = Math.max(0, Math.min(delayMs, firstAt + maxWaitMs - t));
    timer = setTimer(run, wait);
    if (timer && timer.unref) timer.unref();
  };
  return { schedule, flush: () => (timer === null ? undefined : run()), pending: () => timer !== null };
}

module.exports = { createSerialQueue, createDebouncedTask };
