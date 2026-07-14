import argparse
import json
import time

import qzss_sink
from qzss_decode import decode_to_json

# 動作確認用の擬似データ。JAXA/受信機ベンダーが公開しているサンプルログ
# (nbtk/azarashi の tests/qzqsm_220307.log) から、代表的な災害種別を
# ひととおり網羅するように抜粋している。
SCENARIOS = [
    ("緊急地震速報", "$QZQSM,57,9AAC89558B0003240000AB160F3A2499B40000000000002000000010C93712C*0F"),
    ("震度速報", "$QZQSM,58,C6AF999C828001C82CB25AE775A8D4CA854AB8000000000000000011E027E5C*76"),
    ("震源に関する情報", "$QZQSM,58,9AAF919C82800388000039051440C5C82A0108300000000000000012497DA18*0A"),
    ("津波警報", "$QZQSM,58,9AAFA99C828001E8F67C31053960414E621053BE00000000000000132735038*0F"),
    ("気象警報", "$QZQSM,58,C6AFD19CB18001113880115F901186A011ADB011D4C011FBD00000135EAA3F8*73"),
    ("Jアラート", "$QZQSM,55,9AB0840DE2BF88E9200000000000000000001FFFFFFFFFFFC00000110D0A1B8*71"),
]

def mark_as_test_data(payload_json_str):
    """本物の通報と見分けられるよう、シミュレータ送信であることを示す
    フラグを載せる(main.js側で「テストデータ」表示に使う)。"""
    data = json.loads(payload_json_str)
    data["is_test_data"] = True
    return json.dumps(data, ensure_ascii=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="QZSS災危通報の擬似データを送信する(既定では全パターンを1周したら終了する)"
    )
    parser.add_argument(
        "-n", "--repeat", type=int, default=1,
        help="全パターンを何周するか(既定: 1周のみ)。ずっと流し続けたい場合は 0 を指定する"
    )
    parser.add_argument(
        "-i", "--interval", type=float, default=5.0,
        help="送信間隔(秒、既定: 5)"
    )
    args = parser.parse_args()

    cycle = 0
    while args.repeat == 0 or cycle < args.repeat:
        for label, sentence in SCENARIOS:
            payload, important = decode_to_json(sentence)
            if important:
                payload = mark_as_test_data(payload)
                qzss_sink.send(payload)
                print(f"送信 [{label}]:", payload)
            else:
                print(f"重要度低のため送信スキップ [{label}]")
            time.sleep(args.interval)
        cycle += 1

    print("送信完了(全パターンを送り終えたので終了します)")
