# QZSS 災危通報マップ

みちびき(QZSS)が放送する災害・危機管理通報(DCR/DCX、いわゆる災危通報)を受信・デコードし、
地図上にリアルタイム表示するシステム。

- 緊急地震速報・震源情報・震度速報・津波警報・Jアラートをデコードし、地図上に表示する
- 受信機(u-blox GNSS)はラズベリーパイなどローカル環境に置き、重要な通報だけをGoogle Cloud上の
  Webサービスへ送信、ブラウザにはそのクラウドサービスからリアルタイム配信する構成にも対応する
- ローカルのみ(受信機なしのシミュレータ含む)でも動作確認できる

## 目次

- [全体構成](#全体構成)
- [ディレクトリ構成](#ディレクトリ構成)
- [対応している通報の種類](#対応している通報の種類)
- [地図表示の仕組み](#地図表示の仕組み)
- [セットアップ](#セットアップ)
  - [ローカルで動作確認する(擬似データ)](#ローカルで動作確認する擬似データ)
  - [実機(受信機)をローカルで使う](#実機受信機をローカルで使う)
  - [Google Cloudにデプロイする](#google-cloudにデプロイする)
  - [ラズベリーパイからクラウドへ送信する](#ラズベリーパイからクラウドへ送信する)
- [コスト対策(自動停止)](#コスト対策自動停止)
- [セキュリティ](#セキュリティ)
- [トラブルシューティング](#トラブルシューティング)

## 全体構成

2通りの動かし方に対応している。

### A. ローカル完結(クラウドを使わない)

```
[受信機 or test.py] --(FIFO: qzss_pipe)--> [server.js] --(WebSocket)--> [ブラウザ]
                                              └─ 静的ファイル(public/)も同じserver.jsが配信
```

`start_demo.sh`(擬似データ)または `start_prod.sh`(実機)で起動する。

### B. クラウド構成(ラズパイ + Google Cloud Run)

```
[受信機] --(シリアル)--> [read_legacy.py on ラズパイ]
                             │ azarashiでデコード
                             │ 重要な通報だけ(緊急地震速報/震源/震度速報/津波/Jアラート)
                             ▼
                     HTTPS POST /ingest (要トークン)
                             ▼
                  [Cloud Run: server.js] --(WebSocket)--> [ブラウザ]
                             └─ 静的ファイル(public/)もここから配信
```

ラズパイ側は `start_pi.sh`、クラウド側のデプロイは `deploy_gcloud.sh` を使う。
**ローカル/クラウドどちらの構成でも `server.js` は同じコード。** 環境変数 `PORT` と
`INGEST_TOKEN` だけで挙動が変わる。

## ディレクトリ構成

```
map/
├── public/                      # ブラウザに配信する静的ファイル一式
│   ├── index.html
│   ├── main.js                  # 地図描画・WebSocket受信・表示ロジック(フロントエンド全部)
│   ├── style.css
│   ├── style.json               # MapLibreのスタイル定義(国土地理院ベクトルタイルを参照)
│   └── data/
│       ├── epicenter_regions.geojson   # 気象庁「震央地名」332地域のポリゴン
│       ├── tsunami_regions.geojson     # 気象庁「津波予報区」66区域の沿岸線
│       └── prefectures.geojson         # 47都道府県のポリゴン(簡略化済み)
│
├── server.js             # Express製サーバー。静的配信 + WebSocket配信 + POST /ingest
├── package.json
│
├── qzss_decode.py         # azarashiでのデコード + JSON化 + 重要度判定(共通ヘルパー)
├── qzss_sink.py           # 送信先切り替え(ローカルFIFO or クラウドPOST)
├── read_legacy.py         # 実機(u-blox)からシリアルで読み取り、デコードして送信
├── test.py                # 擬似データ送信スクリプト(9種類の通報 + Jアラートを5秒おきに1周送信して終了)
├── requirements.txt       # azarashi, pyserial (venv用)
│
├── start_demo.sh          # ローカル + 擬似データで一発起動
├── start_prod.sh          # ローカル + 実機受信機で一発起動(クラウド不使用)
├── start_pi.sh            # ラズパイ側: 実機受信機 → クラウドへ送信
├── deploy_gcloud.sh       # Cloud Runへのデプロイ
├── start.sh               # start_demo.sh へのエイリアス(後方互換)
│
├── Dockerfile             # Cloud Run用コンテナビルド定義
├── .dockerignore
│
├── billing-guard/         # 予算超過時に自動で請求を止めるCloud Function
│   ├── index.js
│   └── package.json
│
└── venv/                  # Python仮想環境(azarashi等はシステムPythonに入れていない)
```

## 対応している通報の種類

QZSSは非常に多くの種類の通報(気象・火山・洪水など)を流しているが、通信量/コスト削減のため
**クラウドへ送信する(=地図に表示する)のは以下の「重要」な種類のみ**に絞っている
(`qzss_decode.py` の `IMPORTANT_CATEGORY_NOS` / `main.js` の `ALLOWED_CATEGORIES`)。

| 種別 | azarashiのクラス | 地図表示 |
|---|---|---|
| 緊急地震速報 (EEW) | `QzssDcReportJmaEarthquakeEarlyWarning` | 震央地名ポリゴンをハイライト + ✕マーカー |
| 震源に関する情報 | `QzssDcReportJmaHypocenter` | 緯度経度が直接わかるので、その座標に✕マーカー |
| 震度速報 | `QzssDcReportJmaSeismicIntensity` | 対象都道府県を震度に応じた色で塗りつぶし + 震度バッジ |
| 津波警報・注意報 | `QzssDcReportJmaTsunami` | 対象沿岸線を警報レベルに応じた色でハイライト |
| Jアラート | `QzssDcxJAlert` (DCX) | 対象都道府県を警戒色で塗りつぶし |

それ以外(南海トラフ地震関連情報・噴火警報・降灰予報・気象警報・洪水予報など)は
**デコードはするがクラウドへは送信せず、コンソールログにのみ出力する**(`read_legacy.py`/`test.py`
の「重要度低のため送信スキップ」ログ)。

## 地図表示の仕組み

- ベースマップは国土地理院の「最適化ベクトルタイル(optimal_bvmap)」を、`pmtiles`プロトコル経由で
  GSIのサーバーから直接タイル取得(ローカルにタイルファイルを持たない)。ズームレベルは4〜7に制限し、
  必要なレイヤーだけに絞って通信量を抑えている(`public/style.json`)。
- 震央地名・津波予報区・都道府県のポリゴンは、公開データセットを取得したうえで座標の簡略化・
  プロパティの削減を行い、`public/data/` に同梱している(外部への都度リクエストはしない)。
  - `epicenter_regions.geojson`: [0Quake/JMA_Region](https://github.com/0Quake/JMA_Region)
  - `tsunami_regions.geojson`: [Ichihai1415/JMA-GIS-GeoJSON](https://github.com/Ichihai1415/JMA-GIS-GeoJSON)
  - `prefectures.geojson`: [dataofjapan/land](https://github.com/dataofjapan/land) (topojsonから変換し
    Douglas-Peucker法で簡略化)
- 震度の配色は気象庁のカラーユニバーサルデザイン配色(震度1〜7、特務機関NERV防災など主要な
  地震情報サービスも準拠)を採用している(`main.js` の `SEISMIC_INTENSITY_COLORS`)。
- 震源マーカーは地図ピンではなく✕(バッテン)形状。実際の座標に正確に重なるよう中心アンカーにしている。
- 情報パネルはazarashiの全項目をそのまま出さず、通報種別ごとに重要な項目だけへ絞り込んで表示する
  (`main.js` の `buildSummary` / `renderJAlert`)。

## セットアップ

### ローカルで動作確認する(擬似データ)

受信機がなくても、9種類の通報 + Jアラートを5秒おきに1周だけ流すシミュレータで一通り確認できる
(既定では1周したら自動終了する。ずっと流し続けたい場合は `python3 test.py -n 0`)。

```bash
cd map
./start_demo.sh
```

初回はPythonのvenv作成・パッケージインストール・FIFO作成を自動で行う。
`http://localhost:8080/` が開き、ステータスがオンラインになって地図が更新されていくことを確認する。
`Ctrl-C` で全部まとめて停止する。

### 実機(受信機)をローカルで使う

u-bloxのGNSS受信機をUSB接続し、クラウドを使わず同じマシンで完結させる場合の手順。

1. **受信機をUSBで接続する**(屋外か、窓際など上空が開けた場所に置く。QZSSは上空高い衛星なので、
   室内奥など空が見えない場所ではまず受信できない)。

2. **シリアルポート名を確認する**。引数なしで `start_prod.sh` を実行するとポート候補が一覧表示される。

   ```bash
   cd map
   ./start_prod.sh
   ```

   `/dev/tty.usbserial-XXXX` や `/dev/tty.usbmodemXXXX` のような名前が候補として出る
   (何も出ない場合は「トラブルシューティング」を参照)。

3. **ポートを指定して起動する**(ボーレートは省略時 115200)。

   ```bash
   ./start_prod.sh /dev/tty.usbserial-XXXX 115200
   ```

   初回はPythonのvenv作成・パッケージインストール(azarashi, pyserial)・FIFO作成を自動で行う。
   自動で `http://localhost:8080/` が開き、以下の流れで動く。

   - `read_legacy.py` が受信機を初期化(`UBX-RXM-SFRBX` 出力ON)し、シリアルから読み続ける
   - QZSSのDC report(災危通報)メッセージを検出したらデコードし、ターミナルに逐次表示する
   - 「重要」(緊急地震速報・震源・震度速報・津波・Jアラート)と判定された通報だけが
     `qzss_pipe`(FIFO)経由で `server.js` に渡り、WebSocketでブラウザに配信される
   - それ以外の通報は「重要度低のため送信スキップ」とターミナルに出るだけで、画面には出ない

4. **確認方法**: ターミナルに `start!` と出た後、しばらくすると受信したメッセージが流れ始める
   (QZSSは他のGPS衛星と違い、常時ではなく一定間隔でのみDC reportを送信するため、
   最初のメッセージが出るまで数分かかることがある)。実際に地震などが起きない限り、
   通常は「重要」な通報自体はほぼ来ないので、ブラウザが🟢オンラインになっていて
   ターミナルにデコード結果が出続けていれば正常に動作していると判断してよい。

5. **停止する**: ターミナルで `Ctrl-C`。サーバーと受信プロセスが両方まとめて止まる。

**トラブルシューティング(実機接続時)**

- ポート候補が1つも出ない → 受信機のUSBケーブル/ドライバを確認する
  (チップベンダー独自のUSBシリアルドライバのインストールが必要な機種もある)。
- `Permission denied` でポートが開けない → 他のアプリ(u-center等)がポートを掴んでいないか確認する。
- ターミナルに何も表示されない → 上空が開けた場所か確認する。屋内では受信できないことが多い。

### Google Cloudにデプロイする

事前に [gcloud CLI](https://cloud.google.com/sdk/docs/install) のインストールと、
`gcloud auth login` / `gcloud config set project <プロジェクトID>` によるログイン・
プロジェクト選択、および請求先アカウントの有効化が必要(いずれも対話的な操作を伴うため、
このスクリプトが自動で行うことはできない)。

```bash
cd map
INGEST_TOKEN=$(openssl rand -hex 16) ./deploy_gcloud.sh [サービス名] [リージョン]
# 例: INGEST_TOKEN=$(openssl rand -hex 16) ./deploy_gcloud.sh qzss-map asia-northeast1
```

`Dockerfile` を使って `gcloud run deploy --source .` でビルド・デプロイする。
デプロイ完了後、表示されるURLと`INGEST_TOKEN`をラズパイ側の設定に使う。
**`INGEST_TOKEN`は誰でも`/ingest`にデータを送れてしまわないための秘密情報なので、
安全な場所(パスワードマネージャー等)に控えておくこと。**

### ラズベリーパイからクラウドへ送信する

ラズパイに受信機を接続し、`start_pi.sh` を使う。

```bash
cd map
export QZSS_CLOUD_URL="https://<デプロイ先のURL>/ingest"
export QZSS_INGEST_TOKEN="<deploy_gcloud.shが発行したトークン>"
./start_pi.sh /dev/ttyUSB0 115200
```

内部的には `read_legacy.py` → `qzss_decode.py` でデコード後、`qzss_sink.py` が
`QZSS_CLOUD_URL` の有無を見て送信先を自動判定する(未設定ならローカルFIFOに書き込む、
設定されていればそのURLへHTTPS POSTする)。

## コスト対策(自動停止)

Cloud Run自体は使った分だけの従量課金だが、想定外の高トラフィックなどで課金が膨らむのを防ぐため、
**月間¥1000を超えたら自動的にそのプロジェクトの請求を無効化する**仕組みを入れている
(Google公式が案内している「予算アラート→Pub/Sub→Cloud Function」パターン)。

構成:

1. 請求先アカウントに ¥1000/月 の予算(Budget)を設定し、Pub/Subトピック `billing-budget-stop`
   に通知するようにしてある。
2. `billing-guard/` の Cloud Function がそのPub/Subメッセージを受け取り、実際の使用額が予算を
   超えていたら Cloud Billing API 経由で対象プロジェクトの請求を無効化する。

**注意点:**
- 請求データの反映には数時間〜1日程度のタイムラグがあるため、「¥1000ちょうどで即座に止まる」
  厳密な保証ではない(あくまで安全弁)。
- 請求を無効化すると、このプロジェクトの**Cloud Runを含む全リソースが停止する**(このプロジェクトを
  QZSS用途専用にしているのはそのため)。
- 一度無効化されたら自動では復旧しない。[Cloud Consoleの請求](https://console.cloud.google.com/billing)
  から手動で請求先アカウントを再リンクする必要がある。

## セキュリティ

- `/ingest` は `X-Api-Key` ヘッダーに `INGEST_TOKEN` と一致する値がないと `401` を返す
  (未設定のまま起動した場合は無認証で受け付けてしまうので、ローカル動作確認以外では
  必ず設定すること。`server.js` 起動時にトークン未設定の警告ログが出る)。
- 地図タイル・GeoJSONデータはすべて読み取り専用の公開データで、個人情報などは含まない。

## トラブルシューティング

- **`server.js` 起動時に「FIFO が無い」と出る**: ローカルFIFO方式(`start_demo.sh`/`start_prod.sh`)
  を使う場合は `mkfifo qzss_pipe` を実行する(各スクリプトは自動で作成する)。クラウド構成では
  FIFOは使わないので、このメッセージが出ても問題ない。
- **ブラウザの地図が更新されない**: ブラウザの開発者コンソールでWebSocket接続エラーが出ていないか
  確認する。ローカルなら `ws://localhost:8080`、Cloud Runなら同一オリジンの `wss://` に自動で
  接続する(`main.js`)。
- **Cloud RunのURLが403/落ちている**: [コスト対策](#コスト対策自動停止)の自動停止が働いた
  可能性がある。`gcloud billing projects describe <プロジェクトID>` で `billingEnabled: false`
  になっていないか確認する。
- **ラズパイからの送信が401で弾かれる**: `QZSS_INGEST_TOKEN` が Cloud Run 側の `INGEST_TOKEN`
  と一致しているか確認する。
