# QZSS専用地図エンジン（試験実装）

## 起動

ローカルサーバーで `/?renderer=native&web-preview=1` を開く．`?renderer=native&mapPerf=1` ではCanvas要素の `data-base-frames`，`data-overlay-frames`，`data-total-ms` を記録する．公開Webは独自Canvasを既定とし，`?renderer=maplibre` で旧方式を開ける．ラズパイのlocalhost表示は，実機検証までMapLibreを既定とする．

## 構成

- ブラウザでMapLibre GL JSとPMTiles JSは読み込まない．`public/native-map.js` が地図の投影，カメラ操作，図形描画，警報マスク，クリック判定を担当する．
- `scripts/build-native-tiles.js` は，既存のPMTiles/MVTをビルド時に読み，使用する `AdmArea`，`Cstline`，`AdmBdry` だけを小さな独自バイナリへ変換する．この変換時に限り既存の `pmtiles` パッケージを使用する．ブラウザの描画処理は依存しない．
- 基図と警報を別々のCanvasに描く．警報の色・範囲だけが変わるとき，基図は再描画しない．カメラ移動・拡大縮小時は両方を描き直す．
- GeoJSONは現在の通報ロジックからそのまま渡す．震源アイコンと震度バッジにも対応する．

## 確認済み

- デスクトップのローカルWeb表示で，現行方式と基図・大雨警報・緊急地震速報・大津波警報を比較した．
- クリック用の面・線判定，ベクタータイルの読み込み，投影と色指定のテストを追加した．
- マウスホイールのズームとドラッグを確認した．ピンチ操作は実装済みだが実機で未検証．

## 採用前に必要な検証

ラズパイのキオスクで，起動から地図表示までの時間，連続通報時の描画時間，ChromiumのCPU・RSS，スワップ使用量を現行方式と同じ条件で比較する．地震・津波・気象・洪水・火山・Jアラートの再生と，スマホのタッチ操作も確認する．公開Webの採用は実機性能の保証ではない．

## 復旧手順

個別の閲覧画面はURLに `?renderer=maplibre` を付けて再読み込みする．独自タイルが読み込めない場合は自動でこのURLへ遷移する．

全体を戻す場合はCloud Runの直前リビジョンを確認し，次を実行する．イメージ再ビルドは不要．

```sh
gcloud run services describe qzss-map --region asia-northeast1 --format='value(status.traffic)'
gcloud run services update-traffic qzss-map --region asia-northeast1 --to-revisions=＜直前の安定リビジョン＞=100
```

反映後に公開ページと `/api/latency-history` を確認する．サービスワーカーの旧キャッシュで一時的に新しい画面が残る場合は，画面を再読み込みする．
