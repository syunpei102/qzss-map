import argparse
import operator
from functools import reduce
from collections import deque
import json
import threading
import datetime
import serial
import time

import qzss_sink
from qzss_decode import decode_to_json

HEARTBEAT_INTERVAL_SEC = 30

# 災危通報は同一内容が配信終了条件を満たすまで数秒おきに再送され続ける仕様の
# ため、直近に送信成功した内容と完全一致する通報は短時間だけクラウドへ再送しない。
# 判定にはデコード結果の raw(DCRメッセージ本体)を使う。プリアンブル(A/B/C)は
# 送信ごとに巡回し、sentence は内容が同じでも毎回変わるが、raw はプリアンブル・
# CRC・衛星IDを含まないため、内容が同じなら常に一致する。
#
# 抑止するのは最後の送信成功から DEDUP_WINDOW_SEC の間だけ。数時間続く警報は
# 窓が過ぎたら再送し、サーバー側のTTL(最後の更新から数える)を更新する。
# 送信失敗時は履歴へ登録しないので、次の再送で即再試行される。
RECENT_CONTENT_HISTORY_SIZE = 50
DEDUP_WINDOW_SEC = 5 * 60
recent_content_keys = deque(maxlen=RECENT_CONTENT_HISTORY_SIZE)
_sent_at = {}  # key -> 最後に送信成功した時刻(monotonic)。履歴と同じ上限で管理


def send_if_new(payload, key, history, sender, now=None, window=DEDUP_WINDOW_SEC, sent_at=None):
    """時間窓内に送信成功済みの同一キーなら送らずFalseを返す。送信して成功した
    場合だけ履歴と時刻を更新してTrueを返す(失敗時は履歴に触れない)。"""
    now = time.monotonic() if now is None else now
    sent_at = _sent_at if sent_at is None else sent_at
    if key in history and now - sent_at.get(key, float("-inf")) < window:
        return False
    if not sender(payload):
        return False
    if key in history:
        history.remove(key)
    history.append(key)
    sent_at[key] = now
    # dequeのmaxlenで押し出されたキーの時刻も捨て、メモリ上限を保つ
    for stale in [k for k in sent_at if k not in history]:
        del sent_at[stale]
    return True

# シリアル接続が実際に確立できている間だけ立てるフラグ。
# ハートビートはこれを見て送るかどうかを決めるので、アンテナ/USBが
# 抜けて再接続待ちになっている間は、プロセス自体が生きていても
# ハートビートが止まり、ブラウザ側は正しく「応答なし」を検知できる。
serial_ok = threading.Event()


def send_heartbeat_loop():
    """受信機(このプロセス)が生きていることを一定間隔でサーバーに知らせる。
    重要な災危通報は滅多に来ないため、これが無いと「受信機が本当に
    動いているか」をブラウザ側から判断できない。"""
    while True:
        if serial_ok.is_set():
            payload = json.dumps({
                "type": "Heartbeat",
                "timestamp": datetime.datetime.now().isoformat(),
            }, ensure_ascii=False)
            try:
                qzss_sink.send(payload)
            except Exception as e:
                print("⚠️ ハートビート送信に失敗しました:", e)
        time.sleep(HEARTBEAT_INTERVAL_SEC)


# 平常時(実際の災害が起きていない時)でも、パイプライン全体
# (受信機→デコード→クラウド→ブラウザ)がちゃんと生きているかを
# その場で確認できるよう、ターミナルでEnterキーを押すとテスト通報を
# 送信できるようにする。1回目はテスト通報、2回目は取消(終了)信号、と
# 交互に送信する(表示され続けるか、取消でちゃんと消えるかの両方を確認できる)。
TEST_SENTENCE = '$QZQSM,58,9AAF899C80000324000039000548C5E2C000000003DFF8001C000012FE4B0FC*7F'


def send_test_signal_loop():
    print("💡 動作確認したい時は、このターミナルでEnterキーを押してください")
    print("   (1回目: テスト通報を送信 → 2回目: 取消(終了)信号を送信、を繰り返します)")
    is_active = False
    while True:
        try:
            input()
        except EOFError:
            return
        payload, important = decode_to_json(TEST_SENTENCE)
        data = json.loads(payload)
        data["is_test_data"] = True
        if not is_active:
            qzss_sink.send(json.dumps(data, ensure_ascii=False))
            print("🧪 テスト通報(緊急地震速報のサンプル)を送信しました。地図に反映されるか確認してください")
            is_active = True
        else:
            data["information_type"] = "取消"
            data["information_type_en"] = "Cancel"
            data["information_type_no"] = 2
            qzss_sink.send(json.dumps(data, ensure_ascii=False))
            print("🛑 取消(終了)信号を送信しました。表示が消えるか確認してください")
            is_active = False


VAL_SET_RAM_UBX_RXM_SFRBX_UART1_ON = bytes([0xB5, 0x62, 0x06, 0x8A, 0x09, 0x00, 0x01, 0x01, 0x00, 0x00, 0x32, 0x02, 0x91, 0x20, 0x01, 0x81, 0x30])

satellite_id = {
    # PRNの下位6bitを衛星番号文字列に対応させる。名称はL1S公式PRN割当に準拠
    # (185=QZS-4/4号機, 189=QZS-3/3号機。DCR同人誌の表は185↔189が逆なので注意)
    184: '56', # QZS-2  (2号機)
    185: '57', # QZS-4  (4号機)
    189: '61', # QZS-3  (3号機)
    183: '55', # QZS-1  (初号機・運用終了済み)
    186: '58', # QZS-1R (初号機後継機)
}

def nmea_checksum(sentence):
    data = sentence.strip("$").split('*', 1)[0]
    cksum = reduce(operator.xor, (ord(s) for s in data), 0)
    return cksum

def nmea_checksum_matches(sentence):
    """NMEAのチェックサムが正しいか。大文字・小文字の16進どちらも受理し、
    区切り(*)や値が無い/不正な場合は例外を出さずFalseを返す。"""
    if "*" not in sentence:
        return False
    _, given = sentence.split("*", 1)
    try:
        return nmea_checksum(sentence) == int(given.strip(), 16)
    except ValueError:
        return False

UBX_MAX_PAYLOAD = 1024  # 想定外に大きい長さは破損とみなす(受信停止を避ける)

def ubx_checksum(message):
    ck_a = 0
    ck_b = 0
    i = 0
    while i < len(message):
        ck_a = (ck_a + message[i]) & 0xff
        ck_b = (ck_b + ck_a) & 0xff
        i += 1
    return ck_a, ck_b

def ubx2qzqsm(line):
    if line[:7] == b'\xB5\x62\x02\x13\x2C\x00\x05': # UBX-RXM-SFRBX, 44 bytes, QZSS
        satId = satellite_id.get(line[7] + 182) # PRN -> Satellite ID
        if satId is None:
            # 未登録のSVID(新衛星・破損パケット)は警告してこのパケットだけ無視する
            print(f"⚠️ 未登録のQZSS衛星番号のため無視します (PRN={line[7] + 182})")
            return None
        data = b''
        for i in range(9):
            data += bytes((line[14+3+i*4], line[14+2+i*4], line[14+1+i*4], line[14+0+i*4]))
        if data[1] >> 2 == 43 or data[1] >> 2 == 44: # Message Type 43=JMA-DC Report, 44=Other
            dcr_message = (data[:31] + bytes((data[31] & 0xC0,))).hex()[:-1] # 256-4=252 bit
            sentence = '$QZQSM,' + satId + ',' + dcr_message + '*'
            return sentence + format(nmea_checksum(sentence), 'x')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Print QZQSM NMEA format sentence')  
    parser.add_argument('port', help='serial port. ex: /dev/ttyUSB0')
    parser.add_argument('baudrate', help='baudrate. ex: 115200')
    parser.add_argument('-n', '--nmea', help='print other standard NMEA sentence', action='store_true')
    args = parser.parse_args()

    threading.Thread(target=send_heartbeat_loop, daemon=True).start()
    threading.Thread(target=send_test_signal_loop, daemon=True).start()

    RECONNECT_WAIT_SEC = 5
    IDLE_TIMEOUT_SEC = 20  # これだけ何も受信しなければ切断とみなして再接続する

    # USBの抜き差し等でシリアル接続が切れてもプロセスごと終了させず、
    # ポートが復帰し次第自動で再接続する(受信機のオンライン/オフライン表示は
    # ハートビートの有無で判断されるので、ここで復帰できればそちらも自動で戻る)。
    # OS/ドライバによっては切断時に例外を出さず、読み取りが無音のまま
    # 固まることがある(Windowsで確認)ため、read()にタイムアウトを設け、
    # 一定時間データが来なければ強制的に再接続扱いにする。
    while True:
        try:
            with serial.Serial(args.port, args.baudrate, timeout=1) as ser:
                print('初期化中')
                ser.write(VAL_SET_RAM_UBX_RXM_SFRBX_UART1_ON) # UBX-RXM-SFRBX Output ON
                time.sleep(1)
                print('start!')
                serial_ok.set()
                last_byte_time = time.time()

                while True:
                    line = b''
                    nmea_flag = False
                    ubx_flag = False
                    count = 0
                    payload_length = 0
                    while True:
                        if ubx_flag:
                            if count > 5 and payload_length == 0:
                                # payload長は2バイトのlittle-endian
                                payload_length = int.from_bytes(line[4:6], "little")
                                if payload_length == 0 or payload_length > UBX_MAX_PAYLOAD:
                                    break # 破損フレーム: 下のチェックサム検証で捨てて再同期
                            if payload_length > 0 and count == payload_length + 8: # header 6 bytes + checksum 2 bytes
                                break
                        b = ser.read()
                        if not b:
                            # timeout=1 による空読み(データが来ていないだけ)
                            if time.time() - last_byte_time > IDLE_TIMEOUT_SEC:
                                print(f"🔴 オフライン({IDLE_TIMEOUT_SEC}秒間データを受信していません)")
                                raise serial.SerialException(
                                    f"{IDLE_TIMEOUT_SEC}秒間データを受信していません(切断の可能性)")
                            continue
                        last_byte_time = time.time()
                        if b == b'$' and not ubx_flag:
                            nmea_flag = True
                        if b == b'\x62' and line == b'\xB5':
                            ubx_flag = True
                        if b == b'\n':
                            if line.endswith(b'\r'):
                                line += b
                                break
                            else:
                                line += b
                        else:
                            line += b
                        count += 1

                    if args.nmea and nmea_flag:
                        try:
                            sentence = line.decode().strip('\r\n')
                            if nmea_checksum_matches(sentence):
                                print(sentence)
                        except UnicodeDecodeError:
                            # バイナリ(UBX)データの中の'$'に偶然反応しただけの
                            # ノイズなので、無視して読み取りを続ける
                            pass

                    if ubx_flag and 0 < payload_length <= UBX_MAX_PAYLOAD and len(line) == payload_length + 8:
                        ck_a, ck_b = ubx_checksum(line[2:payload_length+6])
                        if line[-2] == ck_a and line[-1] == ck_b:
                            sentence = ubx2qzqsm(line)
                            if sentence is not None:
                                print(sentence)
                                payload, important = decode_to_json(sentence)
                                if not important:
                                    print("重要度低のため送信スキップ:", payload)
                                else:
                                    # raw(プリアンブル/CRC/衛星IDを含まない本体)で重複判定する。
                                    try:
                                        dedup_key = json.loads(payload).get("raw")
                                    except (ValueError, TypeError):
                                        dedup_key = None
                                    dedup_key = dedup_key or sentence
                                    if send_if_new(payload, dedup_key, recent_content_keys, qzss_sink.send):
                                        print("送信:", payload)
                                    else:
                                        print("直近に送信済みの同一内容、または送信失敗のためスキップ(失敗時は次の再送で再試行)")
        except (serial.SerialException, OSError) as e:
            serial_ok.clear()
            print(f"⚠️ シリアル接続が切れました({e})。{RECONNECT_WAIT_SEC}秒後に再接続を試みます...")
            time.sleep(RECONNECT_WAIT_SEC)
