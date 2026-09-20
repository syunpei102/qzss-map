"""デコード済みJSONの送信先(ローカルFIFO or クラウド)を切り替えるヘルパー。

環境変数 QZSS_CLOUD_URL が設定されていればクラウド(Cloud Run等)の
/ingest エンドポイントへHTTPS POSTする。未設定ならこれまで通り
ローカルのFIFO(qzss_pipe)に書き込む(同一マシンでのテスト用)。
"""
import json
import os
import urllib.error
import urllib.request

CLOUD_URL = os.environ.get("QZSS_CLOUD_URL", "").strip()
INGEST_TOKEN = os.environ.get("QZSS_INGEST_TOKEN", "").strip()


def send(payload_json_str):
    """送信に成功したらTrue，失敗したらFalseを返す(呼び出し側は成功時だけ
    重複履歴へ登録する)。"""
    if CLOUD_URL:
        return _send_cloud(payload_json_str)
    return _send_local_fifo(payload_json_str)


def _send_cloud(payload_json_str):
    req = urllib.request.Request(
        CLOUD_URL,
        data=payload_json_str.encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": INGEST_TOKEN,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, OSError) as e:
        # HTTPError(4xx/5xx)もURLErrorの一種なので失敗として扱う
        print("⚠️ クラウドへの送信に失敗しました:", e)
        return False
    return True


def _send_local_fifo(payload_json_str):
    try:
        with open("qzss_pipe", "w") as fifo:
            fifo.write(payload_json_str + "\n")
    except OSError as e:
        print("⚠️ ローカルFIFOへの書き込みに失敗しました:", e)
        return False
    return True
