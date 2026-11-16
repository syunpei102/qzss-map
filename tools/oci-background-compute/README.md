# 基盤サーバーの回収防止処理

ユーザー指定により，円周率の中点数値積分と照合を低優先度で繰り返す．2つの計算プロセスへ分散し，ゲストOS全体のCPU使用率を約30%に近づけるよう実測値で計算時間を増減する．共有CPUの割当てや混雑で目標に届かない場合があり，Oracleのアイドル判定・回収防止は保証しない．

SCHED_IDLE・Nice19・CPUWeight1，CPUQuota100%（論理CPU1個分．2論理CPUのゲスト全体では計算だけで最大約50%），メモリ64MiB，スワップ禁止．ネットワーク通信なし．通常処理の負荷上昇に合わせ計算量を減らす．cgroup全体のCPU時間とカーネルのnice CPU時間を照合し，CPU待ちの計上差で通常処理を過小評価しないようにする．計算自身を除くCPU25%以上が3秒続く，またはsteal70%以上が10秒続く場合は休止．通常処理CPU60%以上，MemAvailable192MiB未満，受信通知の正常監視が60秒より古い／ready以外，手動休止ファイルがある場合は即時休止する．正常が5秒続けば再開する．状態変化時および5秒ごとに固定サイズJSONを上書きする．CPU使用率はOracle側の判定用メトリクスと一致することを保証しない．

状態には現在の実測値，目標値，判定しきい値，直近の停止時刻・理由・停止判定時の実測値を保持する．再開後も直近の停止記録は残す．監視画面は新しい観測がある場合だけ動作中・停止中とし，古い報告は要確認にする．数値・許可済みの状態名以外は公開しない．

基盤サーバーのみで `sudo bash install.sh` を実行する．更新時は `sudo systemctl restart qzss-background-compute` を実行する．

```sh
# 計算だけを休止・再開する．受信・通知は停止しない．
sudo touch /run/qzss-background-compute.pause
sudo rm /run/qzss-background-compute.pause
# 完全停止・無効化
sudo systemctl disable --now qzss-background-compute
# 状態の確認
cat /var/lib/qzss-background-compute/state.json
```
