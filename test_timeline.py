import json
import time

import qzss_sink
from qzss_decode import decode_to_json

# 同一の地震(日向灘沖, M7.2)について、実際の気象庁の発表の流れ・
# 間隔感を再現したタイムラインシミュレーション。
# 緊急地震速報 → 震源に関する情報 → 震度速報 → 津波警報 の順で
# 続報が届く様子を再現する(各カードは受信後30秒で自動的に消える)。
TIMELINE = [
    ("緊急地震速報", "$QZQSM,58,9AAF899C80000324000039000548C5E2C000000003DFF8001C000012FE4B0FC*7F", 0),
    ("震源に関する情報", "$QZQSM,58,9AAF919C82800388000039051440C5C82A0108300000000000000012497DA18*0A", 6),
    ("震度速報", "$QZQSM,58,C6AF999C828001C82CB25AE775A8D4CA854AB8000000000000000011E027E5C*76", 8),
    ("津波警報", "$QZQSM,58,9AAFA99C828001E8F67C31053960414E621053BE00000000000000132735038*0F", 8),
]


def mark_as_test_data(payload_json_str):
    data = json.loads(payload_json_str)
    data["is_test_data"] = True
    return json.dumps(data, ensure_ascii=False)


if __name__ == "__main__":
    print("=== 日向灘沖 M7.2 想定: 通報の経過をシミュレーションします ===")
    for i, (label, sentence, wait_before) in enumerate(TIMELINE):
        if i > 0:
            print(f"...{wait_before}秒後...")
            time.sleep(wait_before)
        payload, important = decode_to_json(sentence)
        payload = mark_as_test_data(payload)
        qzss_sink.send(payload)
        print(f"[{label}] を送信しました")
    print("=== シミュレーション終了 ===")
