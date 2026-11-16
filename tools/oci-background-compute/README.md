# 基盤サーバーの回収防止処理

ユーザー指定により，円周率の中点数値積分と照合を低優先度で繰り返す．Oracleのアイドル回収防止を保証しない．SCHED_IDLE・Nice19・CPUWeight1，CPUQuota50%（論理CPU1個の半分．2論理CPUのゲスト全体では最大約25%），メモリ64MiB，スワップ禁止．ネットワーク通信なし．Microのバースト資源を使うため，低優先度でも本来の処理への影響がゼロとは限らない．

毎秒，この計算自身を除くCPU使用率・steal・空きメモリ・既存の受信通知API監視結果を確認する．通常処理CPU20%以上，steal30%以上，MemAvailable192MiB未満，監視結果が60秒より古い／ready以外，手動休止ファイルがある場合は休止する．正常状態が15秒続いた後に再開する．サービス異常終了は30秒後に再起動する．起動時も15秒の確認期間を置く．結果・状態は10秒ごとに一定サイズのJSONへ上書きし，監視画面へは数値と許可した状態名だけを渡す．

基盤サーバーのみで `sudo bash install.sh` を実行する．

```sh
# 計算だけを休止・再開する．受信・通知は停止しない．
sudo touch /run/qzss-background-compute.pause
sudo rm /run/qzss-background-compute.pause
# 完全停止・無効化
sudo systemctl disable --now qzss-background-compute
# 状態の確認
cat /var/lib/qzss-background-compute/state.json
```

管理画面は動作中／停止中／要確認を表示する．停止中には通常処理優先・メモリ不足・監視待ちなどの理由を表示する．回収可否を判定する機能ではない．
