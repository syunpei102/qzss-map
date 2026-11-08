# 独自地図エンジンの導入・性能測定

測定日：2026年11月8日（日）．公開Webとqzss01（Raspberry Pi 3 Model B+）を対象とした．

## 導入状態

- 公開Web：独自Canvas方式が既定．`?renderer=maplibre` で旧方式へ即時切り替え可能．Cloud Runリビジョン `qzss-map-00212-ric` が100％のトラフィックを受ける．
- qzss01：`qzss-map` は `b6462d6`，`qzss-pi-package` は `7a0f24e`．キオスクのURLを `http://localhost:8080?renderer=native` に変更した．地図・デコーダー・キオスクは稼働中．
- Pi側の旧systemdユニットは `/etc/systemd/system/qzss-kiosk@.service.bak-native-20261108` に保存した．

## 測定方法

ChromiumのDevTools Protocolで，ページ遷移開始から `qzss:map-ready` までを測った．これは警報範囲を描き終える時間や秒間フレーム数ではなく，地図の初期表示準備時間である．同じブラウザーで旧方式と独自方式を交互に表示したキャッシュ済みの結果を中央値で示す．Piは同じキオスク環境，WebはMacのChromeヘッドレスで測定した．

| 指標 | 旧方式 | 独自方式 | 差 |
| --- | ---: | ---: | ---: |
| Web・地図準備（各4回の中央値） | 862 ms | 434 ms | 428 ms短縮，約50％ |
| Pi・地図準備（各3回の中央値） | 4,268 ms | 1,428 ms | 2,840 ms短縮，約67％ |
| Web・ページJSヒープ（新規Chrome，各1回，GC後） | 10.1 MB | 7.6 MB | 2.5 MB減，約25％ |

WebのJSヒープはページのJavaScriptだけであり，ブラウザー・GPU・OSを含む総メモリではない．別の連続遷移試験ではヒープ値が遷移ごとに大きく変動した．上記のメモリ差は単発の参考値である．

PiではChromium全プロセスのPSS合計を比較した．デバッグポートを有効にした試験では旧方式421 MiB，独自方式461 MiBで増加した．デバッグポートを外した試験では旧方式502 MiB，独自方式424 MiBで減少した．測定ごとの振れ幅が差より大きいため，Piの総メモリが減ったとは結論できない．通常運転中の独自方式では403 MiBも観測した．

## 確認と限界

- 公開WebとPiの独自方式で地図を表示した．Piの地図サーバー，デコーダー，キオスクは稼働しており，ローカルHTTPは200を返した．
- 旧方式へのURL切り替えを公開Webの候補リビジョンで確認した．独自タイルの読込エラー時には旧方式へ自動で遷移する．
- 実際の警報受信から描画完了までの比較，複数警報の連続受信，スマホのピンチ操作，Piの長時間稼働・クラッシュ頻度は今回の数値に含まれない．現在の数値から「描画処理そのものが約67％高速」とは言えない．

## すぐに戻す方法

Piのキオスクのみ旧方式へ戻すには，保存済みのユニットを復元する．地図サーバーとデコーダーは再起動しない．

```sh
sudo cp /etc/systemd/system/qzss-kiosk@.service.bak-native-20261108 /etc/systemd/system/qzss-kiosk@.service
sudo systemctl daemon-reload
sudo systemctl restart qzss-kiosk@qzss01
```

公開Web全体を戻す場合は，Cloud Runの直前の安定リビジョンへトラフィックを戻す．

```sh
gcloud run services update-traffic qzss-map --region asia-northeast1 --to-revisions=qzss-map-00183-7t9=100
```
