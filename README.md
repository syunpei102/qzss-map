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
- [デバイス管理・拠点ごとの地域設定](#デバイス管理拠点ごとの地域設定)
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
[受信機] --(シリアル)--> [read_legacy_dual.py(正式実装) on ラズパイ]
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
├── read_legacy.py         # 互換・検証用の受信実装(正式実装は qzss_pi_package/read_legacy_dual.py)
├── receiver_launcher.sh   # start_*.shが共通で使う受信プロセス起動(正式実装へ委譲)
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
クラウドへ送信するのは以下の種類に絞っている(`qzss_decode.py`/`read_legacy_dual.py` の
`ALLOWED_CATEGORY_NOS`)。台風(12)・海上警報(14)・北西太平洋津波(6)は表示手段が無い/
取消信号が来ないなどの理由で対象外。

地図側では、重要度に応じて2種類の表示にわかれる。

| 種別 | azarashiのクラス | 地図表示 |
|---|---|---|
| 緊急地震速報 (EEW) | `QzssDcReportJmaEarthquakeEarlyWarning` | 震央地名ポリゴンをハイライト + ✕マーカー(最優先でズーム) |
| 震源に関する情報 | `QzssDcReportJmaHypocenter` | 緯度経度が直接わかるので、その座標に✕マーカー(最優先でズーム) |
| 震度速報 | `QzssDcReportJmaSeismicIntensity` | 対象都道府県を震度に応じた色で塗りつぶし + 震度バッジ(最優先でズーム) |
| 津波警報・注意報 | `QzssDcReportJmaTsunami` | 対象沿岸線を警報レベルに応じた色でハイライト(最優先でズーム) |
| Jアラート/Lアラート | `QzssDcxJAlert`/`QzssDcxLAlert` (DCX) | 対象都道府県・市区町村を警戒色で塗りつぶし(最優先でズーム) |
| 気象警報・注意報 | `QzssDcReportJmaWeatherRelatedInfo`等 (カテゴリ10) | 対象地域を巡回ズーム表示(上記が無い間、地域を順番に表示) |
| 南海トラフ・火山・降灰・洪水 | カテゴリ4/8/9/11 | パネルにバッジ表示(専用の地図描画は無し) |

上記以外(訓練放送等)は表示しない。プッシュ通知(Web Push)にも対応しており、
表示対象になる通報はブラウザに登録済みなら即座に通知される(`server.js`)。

## 地図表示の仕組み

- ベースマップは国土地理院の「最適化ベクトルタイル(optimal_bvmap)」をダウンロード・軽量化した
  `public/data/base_slim_final.pmtiles`(約176KB)を、`pmtiles`プロトコル経由でアプリ自身が
  配信する(`public/style.json`が`pmtiles://./data/base_slim_final.pmtiles`を参照)。
  GSIのサーバーへ都度アクセスする方式ではないため、外部サービス側の障害・レート制限の影響を
  受けない。ズームレベルは4〜7に制限し、必要なレイヤーだけに絞って軽量化してある。
  (`inspect_pmtiles.py`で中身のメタデータを確認できる)
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

   - 受信実装(`receiver_launcher.sh`経由で`read_legacy_dual.py`)が受信機を初期化(`UBX-RXM-SFRBX` 出力ON)し、シリアルから読み続ける
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
ここで指定する`INGEST_TOKEN`は共有フォールバック用(ローカル動作確認や、
まだ拠点用トークンを発行していない場合のため)。**本番のラズパイ運用では
拠点ごとに別のトークンをDiscordの`/create_device_token`で発行する**
(次節参照)方式が基本で、この共有トークンをラズパイ側の本番設定に使う
必要はない。いずれにせよ`INGEST_TOKEN`は誰でも`/ingest`にデータを送れて
しまわないための秘密情報なので、安全な場所(パスワードマネージャー等)に
控えておくこと。

デバイス管理・拠点ごとの地域設定機能(次節)を使う場合は、あわせて以下も必要:

- Discordコマンド(`/reboot`等)を使うため `DISCORD_PUBLIC_KEY`(必須)・
  `DISCORD_ADMIN_USER_ID`(推奨)を環境変数に設定する。手順は
  `qzss_pi_package/DISCORD_SETUP.md` 参照
- 拠点の地域設定・拠点別トークン・管理者パスワードを永続化するGCSバケット
  を作成しておく(既定バケット名`qzss-map-state`。
  `gcloud storage buckets create gs://qzss-map-state --location=asia-northeast1`。
  無くても動くが、Cloud Run再起動のたびに設定が消える)。ラズパイの完全
  ローカルkiosk運用(`start_pi_local.sh`)ではそもそもインターネットが
  無い前提のため、`LOCAL_STATE_ONLY=true`を設定すると代わりにローカル
  ファイル(`.local_state/`、`.gitignore`対象)へ保存する
  (`start_demo.sh`/`start_prod.sh`/`start_pi_local.sh`は自動で設定する)
- Web管理画面(`/device-admin`)は既定で無効なので、`ADMIN_EMAIL`/
  `ADMIN_PASSWORD_HASH`/`SESSION_SECRET`/`ENABLE_WEB_ADMIN`は**本番では
  設定しない**(設定すると復活してしまう)

**Cloud Runは最大1インスタンスに固定している**(`deploy_gcloud.sh`の
`--max-instances 1`)。WebSocket接続・`activeReports`・通知の重複抑止・デバイス状態は
Nodeプロセスのメモリ上にあり、複数インスタンスに分かれると`/ingest`を受けた
インスタンス以外の閲覧者へ配信されないため。複数インスタンス化するには
Pub/Sub等で配信と状態を共有する設計変更が必要。GCSへの保存は同一ファイルごとに
呼び出し順で直列化している。デバイスコマンドの配送状態(`device_commands.json`)も
GCS/ローカルへ永続化する。

### ラズベリーパイからクラウドへ送信する

ラズパイに受信機を接続し、`start_pi.sh` を使う。`QZSS_INGEST_TOKEN`は
Discordの`/create_device_token device:<拠点ID>`で拠点ごとに発行した値を
使う(詳しい手順は`qzss_pi_package/NEW_DEVICE_ONBOARDING.md`参照)。

```bash
cd map
export QZSS_CLOUD_URL="https://eq.shum10.com/ingest"
export QZSS_INGEST_TOKEN="<Discordの/create_device_tokenで発行したこの拠点用のトークン>"
./start_pi.sh /dev/ttyUSB0 115200
```

#### 受信実装は1つに統一している

正式な受信実装は別リポジトリ
[`qzss-pi-package`](https://github.com/syunpei102/qzss-pi-package)の
`read_legacy_dual.py`(非同期送信・keep-alive・時間制の重複抑止・未知衛星/NMEA/UBX
対策を含む)。`start_pi.sh`/`start_receiver.sh`/`start_prod.sh`は共通の
`receiver_launcher.sh`を通して、必ずそれを起動する(Macでの手動受信も同じ)。

- 既定の場所は`map/qzss_pi_package/`(`git clone https://github.com/syunpei102/qzss-pi-package.git qzss_pi_package`)。
  別の場所なら`QZSS_PI_PACKAGE_DIR`で指定する
- 見つからない場合は、誤って旧経路で動かさないよう案内を出して終了する。
  開発・検証用に互換実装(このリポジトリの`read_legacy.py`)を使う場合だけ
  `QZSS_ALLOW_LEGACY_RECEIVER=1`を明示する
- `read_legacy.py`/`qzss_sink.py`/`qzss_decode.py`はシミュレータ(`test*.py`)と
  互換実装のために残しており、上記の不具合修正(未知衛星・NMEA大小文字・UBX長・
  送信成功時のみ重複登録・時間制重複抑止)は同じ内容を入れてCIで検証している。
  ただし正式実装との統合(共有パッケージ化・リポジトリ間の版固定)は
  `qzss-pi-package`側の作業が必要で、まだ未完了(Issue #19参照)。

### ローカルサーバー(`LOCAL_STATE_ONLY=true`)の公開範囲

- 既定では`127.0.0.1`(loopback)だけで待ち受ける。同一LANの別端末からは接続できない
- LANへ公開する場合は`HOST=0.0.0.0`を明示し、`INGEST_TOKEN`も設定する。
  トークン無しで公開する危険を承知の場合のみ`QZSS_ALLOW_INSECURE_LAN=true`
  (未設定だと起動を拒否する)
- トークン未設定のとき、`/ingest`・`/device/status`はloopback接続のみ無認証で許可する
- `/local-sync/*`は常にloopback接続のみ
- Cloud Run(`LOCAL_STATE_ONLY`なし)は従来どおり全インターフェースでPORTを受ける
- 起動ログに実際のbind先と認証状態を表示する

## テスト

```bash
npm ci
npm test                                   # Node(report-state・サーバー設定・検証・静的確認 等)
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python -m unittest discover -s test -p 'test_*.py' -v   # Python(デコード・受信)
```

`test.py`・`test_timeline.py`・`test_tohoku_2011.py`は送信シミュレータで、unittestではない。
CI(`.github/workflows/test.yml`)は構文検査・`npm test`・上記Pythonテストを実行する。

## デバイス管理・拠点ごとの地域設定

### デバイスコマンドの配送(ack)

コマンドは`id`・期限(24時間)・配送状態
(`pending`/`delivered`/`acked`/`sent_unconfirmed`/`expired`/`failed`)を持ち、
GCS/ローカルへ永続化される(`/admin/api/devices`の`commands`で確認できる)。
`/device/status`のリクエストに`supports_ack: true`と`acked_command_ids: [...]`を
含める端末には、ackされるまで(最大5回)再配信する。ack非対応の旧端末には
rebootの繰り返しを避けるため従来どおり1回だけ渡し`sent_unconfirmed`とする。
端末側は非冪等なコマンド(reboot)を実行する**前に**ackすること。
端末側(`qzss-pi-package`の`report_status.sh`)のack対応は別リポジトリの作業。

拠点(ラズパイ)の再起動予約・更新確認予約・対象地域の割り当ては、
**Discordのスラッシュコマンドから行う**(`/reboot device:<id>`・
`/update_check device:<id>`・`/set_region device:<id> prefecture:<都道府県名>`、
`device`/`prefecture`は入力補完付き)。設定手順は
`qzss_pi_package/DISCORD_SETUP.md` の「4. Discord Botを作る」を参照。
サーバー側の実体は `POST /discord/interactions`(Discordの
HTTP Interactionsエンドポイント方式。常時接続のGateway Botではなく、
コマンド実行のたびにDiscordからこのURLへPOSTが飛んでくるステートレスな
方式なので、Cloud Runとの相性がよい)。

拠点に「対象地域」(都道府県)を割り当てると、その都道府県+周辺地方
(例: 東京→関東)だけにその拠点の表示・送信が固定される
(`https://<デプロイ先>/?device=<拠点ID>` で表示、`<拠点ID>` はラズパイの
`qzss.env`の`QZSS_DEVICE_ID`と一致させる)。`?device=`を付けない通常の
公開URLは今まで通り全国対象・絞り込みなしのまま。

以前はメール+パスワードでログインするWeb管理画面(`/device-admin`)で
これらを操作していたが、Discordに一本化したため**Cloud Run本番では
既定で無効**になっている(コードは残っており、環境変数
`ENABLE_WEB_ADMIN=true` を設定すれば復活する。ローカルで試す場合:

```bash
ENABLE_WEB_ADMIN=true ADMIN_EMAIL=... ADMIN_PASSWORD_HASH=... SESSION_SECRET=... node server.js
```

`ADMIN_PASSWORD_HASH`は`node hash_admin_password.js 'パスワード'`で生成する)。

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

- `/ingest`・`/device/status` は `X-Api-Key` ヘッダーのトークンで認証する。
  **拠点(ラズパイ)ごとに別々のトークンを発行する**方式(`deviceIngestTokens`、
  GCS永続化)が基本で、Discordの`/create_device_token`で発行・再発行する。
  1台分のトークンが漏えいしても、他の拠点は無事(そのトークンだけ失効させれば
  良い)。環境変数`INGEST_TOKEN`(共有トークン)は後方互換・ローカル動作確認用の
  フォールバックとしてのみ残っている(未設定のまま起動すると無認証で受け付けて
  しまうので、拠点用トークンを1つも発行していない状態でローカル動作確認以外に
  使うのは避けること)。
- `/device-admin`(Web管理画面)はメールアドレス+パスワード(`ADMIN_EMAIL`/
  `ADMIN_PASSWORD_HASH`)でログインし、HMAC署名付きCookie(`SESSION_SECRET`)で
  セッションを保持する。パスワードは平文で保存・比較しない。ただし
  **本番(Cloud Run)では`ENABLE_WEB_ADMIN`を設定していないため、このルート自体が
  無効(存在しない)**。デバイス操作は`/discord/interactions`(後述)に一本化している。
- `/discord/interactions` はDiscordからのリクエストであることをEd25519署名
  (`DISCORD_PUBLIC_KEY`)で検証する(`discord-interactions`パッケージ使用)。
  検証を通らないリクエストは401で拒否する。`DISCORD_ADMIN_USER_ID`を設定すると、
  そのDiscordユーザー以外のコマンド実行も拒否する(二重の防御)。
- `INGEST_TOKEN` / `DISCORD_PUBLIC_KEY` / `ADMIN_PASSWORD_HASH` はすべてCloud Runの
  環境変数としてのみ保持し、**このリポジトリは公開リポジトリなので、コード・
  スクリプト・ドキュメントのどこにも実際の値を書かないこと。** ローカルで試す場合も、
  シェルの環境変数として渡すか未追跡ファイル(`.gitignore`対象)に置くこと。
- 地図タイル・GeoJSONデータはすべて読み取り専用の公開データで、個人情報などは含まない。
- 拠点の「対象地域」設定(`/device-region/:deviceId`)は認証なしの公開エンドポイント。
  値そのものは機密ではない(どの拠点がどの都道府県を見ているか、という情報のみ)ため
  意図的に無認証にしている。

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
- **ラズパイからの送信が401で弾かれる**: `qzss.env`の`QZSS_INGEST_TOKEN`が、
  Discordの`/create_device_token`でその拠点用に発行した最新の値と一致しているか
  確認する(再発行すると旧トークンはその場で失効する)。共有の`INGEST_TOKEN`を
  使っている場合はCloud Run側の値と一致しているか確認する。
