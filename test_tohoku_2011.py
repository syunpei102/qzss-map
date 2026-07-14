"""
2011年3月11日 東北地方太平洋沖地震(東日本大震災)のシミュレーション。

QZSSの災危通報(DC report)サービス自体は2018年開始のため、この地震(2011年)当時の
実際のQZQSMセンテンスは存在しない。そのため実際の気象庁発表内容・時刻を元に
JSONペイロードを直接組み立てて送信する(qzss_decode.decode_to_jsonは経由しない)。

発表内容・時刻は気象庁の公表資料に基づく(一部、震度速報は実際の観測点単位ではなく
本システムの仕様に合わせて都道府県単位に簡略化している)。
参考: 気象庁「東北地方太平洋沖地震に対する津波警報発表経過と課題」(中央防災会議資料)

実時間では 14:46(地震発生)〜16:00(M8.4への修正)まで約74分だが、
そのままでは待たされるだけなので、既定では1分=1秒に圧縮して再生する
(--speed 1 を指定すると実時間通りに再生する)。
"""
import argparse
import json
import time

import qzss_sink

EARTHQUAKE_ORIGIN = "2011-03-11T14:46:18"


def mark_as_test_data(payload):
    payload["is_test_data"] = True
    return payload


def base_fields(report_time, disaster_category, disaster_category_no):
    return {
        "message_header": "$QZQSM",
        "satellite_id": 58,
        "satellite_prn": 186,
        "message_type": "DCR",
        "version": 1,
        "report_classification": "最優先",
        "report_classification_en": "Maximum Priority",
        "report_classification_no": 1,
        "disaster_category": disaster_category,
        "disaster_category_no": disaster_category_no,
        "report_time": report_time,
        "information_type": "発表",
        "information_type_en": "Issue",
        "information_type_no": 0,
    }


EEW_REGION_NAMES = {
    58: "東北", 59: "関東",
}


def eew(report_time, magnitude, depth, intensity_upper, forecast_region_codes):
    d = base_fields(report_time, "緊急地震速報", 1)
    d.update({
        "type": "QzssDcReportJmaEarthquakeEarlyWarning",
        "occurrence_time_of_earthquake": EARTHQUAKE_ORIGIN,
        "depth_of_hypocenter": depth,
        "magnitude": magnitude,
        "assumptive": False,
        "seismic_epicenter": "三陸沖",
        "seismic_epicenter_raw": 288,
        "seismic_intensity_lower_limit": intensity_upper,
        "seismic_intensity_upper_limit": intensity_upper,
        "eew_forecast_regions": [EEW_REGION_NAMES[c] for c in forecast_region_codes],
        "eew_forecast_regions_raw": forecast_region_codes,
        "notifications_on_disaster_prevention": ["強い揺れに警戒してください。"],
    })
    return mark_as_test_data(d)


def seismic_intensity(report_time, entries):
    # entries: [(prefecture_name, prefecture_id, intensity_code), ...]
    d = base_fields(report_time, "震度", 3)
    d.update({
        "type": "QzssDcReportJmaSeismicIntensity",
        "occurrence_time_of_earthquake": EARTHQUAKE_ORIGIN,
        "prefectures": [e[0] for e in entries],
        "prefectures_raw": [e[1] for e in entries],
        "seismic_intensities": [e[2] for e in entries],
        "seismic_intensities_raw": [e[2] for e in entries],
    })
    return mark_as_test_data(d)


def tsunami(report_time, warning_code, warning_code_raw, regions, heights):
    # regions: [(name, code), ...] / heights: 対応する高さ文字列のリスト
    d = base_fields(report_time, "津波", 5)
    d.update({
        "type": "QzssDcReportJmaTsunami",
        "tsunami_warning_code": warning_code,
        "tsunami_warning_code_raw": warning_code_raw,
        "tsunami_forecast_regions": [r[0] for r in regions],
        "tsunami_forecast_regions_raw": [r[1] for r in regions],
        "tsunami_heights": heights,
        "tsunami_heights_raw": heights,
        "expected_tsunami_arrival_times": [report_time] * len(regions),
        "notifications_on_disaster_prevention": [
            "沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。"
        ],
    })
    return mark_as_test_data(d)


def hypocenter_update(report_time, magnitude, depth):
    d = base_fields(report_time, "震源", 2)
    d.update({
        "type": "QzssDcReportJmaHypocenter",
        "occurrence_time_of_earthquake": EARTHQUAKE_ORIGIN,
        "depth_of_hypocenter": depth,
        "magnitude": magnitude,
        "seismic_epicenter": "三陸沖",
        "seismic_epicenter_raw": 288,
        "coordinates_of_hypocenter": {
            "lat_ns": 0, "lat_d": 38, "lat_m": 6, "lat_s": 12,
            "lon_ew": 0, "lon_d": 142, "lon_m": 51, "lon_s": 36,
        },
    })
    return mark_as_test_data(d)


def tsunami_resolution(report_time):
    d = base_fields(report_time, "津波", 5)
    d.update({
        "type": "QzssDcReportJmaTsunami",
        "tsunami_warning_code": "警報解除",
        "tsunami_warning_code_raw": 2,
    })
    return mark_as_test_data(d)


# (地震発生からの経過秒数, ラベル, 実際の発表内容に基づくペイロード生成)
# 緊急地震速報「警報」として実際に発表されたのは検知8.6秒後の第4報から
# (それ以前の第1〜3報は警報基準未達の予報段階のため、一般に配信される
# 緊急地震速報としては第4報以降のみを採用する)。
# 対象地域(eew_forecast_regions)は公式記録が無いため合理的な近似値。
TIMELINE = [
    (30.8, "緊急地震速報(警報) 第4報(検知8.6秒後, M7.2)",
     lambda: eew("2011-03-11T14:46:48.8", "7.2", "10km", "震度6弱", [58, 59])),

    (31.8, "緊急地震速報(警報) 第5報(検知9.6秒後, M6.3。震源域が広大すぎ推定が安定しなかった)",
     lambda: eew("2011-03-11T14:46:49.8", "6.3", "10km", "震度6弱", [58, 59])),

    (120, "震度速報(宮城県で震度7を観測。都道府県単位に簡略化)",
     lambda: seismic_intensity("2011-03-11T14:48:00", [
         ("宮城県", 4, 7), ("福島県", 7, 6), ("岩手県", 3, 6),
         ("茨城県", 8, 6), ("栃木県", 9, 5), ("群馬県", 10, 4),
         ("埼玉県", 11, 4), ("千葉県", 12, 4), ("東京都", 13, 4),
         ("新潟県", 15, 3),
     ])),

    (180, "大津波警報 第1報(宮城6m/岩手3m/福島3m ※当時の旧基準では3mも大津波警報)",
     lambda: tsunami("2011-03-11T14:49:00", "大津波警報", 4,
                      [("宮城県", 220), ("岩手県", 210), ("福島県", 250)],
                      ["6m", "3m", "3m"])),

    (1680, "大津波警報 更新(宮城10m超/岩手6m/福島6m/茨城4m/千葉3m/青森3m)",
     lambda: tsunami("2011-03-11T15:14:00", "大津波警報", 4,
                      [("宮城県", 220), ("岩手県", 210), ("福島県", 250),
                       ("茨城県", 300), ("千葉県九十九里・外房", 310),
                       ("青森県太平洋沿岸", 201)],
                      ["10m超", "6m", "6m", "4m", "3m", "3m"])),

    (2640, "大津波警報 更に更新(東北〜関東の太平洋沿岸ほぼ全域が10m超に)",
     lambda: tsunami("2011-03-11T15:30:00", "大津波警報", 4,
                      [("宮城県", 220), ("岩手県", 210), ("福島県", 250),
                       ("茨城県", 300), ("千葉県九十九里・外房", 310),
                       ("青森県太平洋沿岸", 201),
                       ("北海道太平洋沿岸中部", 101)],
                      ["10m超", "10m超", "10m超", "10m超", "10m超", "8m", "6m"])),

    (4440, "震源に関する情報 更新(M7.9→M8.4への修正。この後さらにM8.8→最終M9.0まで引き上げられていく)",
     lambda: hypocenter_update("2011-03-11T16:00:00", "8.4", "24km")),
]

# 実際の大津波警報の解除は2日後(3/13)だが、機能確認のためここでは
# タイムラインの最後に短縮して追加する(史実の時間感覚とは異なる点に注意)
RESOLUTION_NOTE = "津波警報解除(※実際は約2日後の3/13。動作確認用に短縮して追加)"


def resolution_step():
    return tsunami_resolution("2011-03-13T00:00:00")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="2011年東北地方太平洋沖地震の実際の発表経過・時刻を再現するシミュレーション"
    )
    parser.add_argument(
        "--speed", type=float, default=1.0,
        help="再生速度の倍率(既定: 1倍 = 実際の発表間隔そのまま)。"
             "早送りしたい場合は例えば 60 を指定する(1分を1秒で再生)"
    )
    parser.add_argument(
        "--with-resolution", action="store_true",
        help="最後に津波警報解除(画面リセットの確認用、実際は2日後)も送信する"
    )
    args = parser.parse_args()

    print("=== 2011年3月11日 14:46 東北地方太平洋沖地震(M9.0) シミュレーション ===")
    print("実際の発表間隔の通りに再生します(全体で74分)" if args.speed == 1
          else f"再生速度: {args.speed}倍")

    prev_sec = 0
    for sec, label, build in TIMELINE:
        wait_sec = (sec - prev_sec) / args.speed
        if wait_sec > 0:
            print(f"...{sec - prev_sec:.1f}秒後...")
            time.sleep(wait_sec)
        payload = build()
        qzss_sink.send(json.dumps(payload, ensure_ascii=False))
        print(f"[経過{sec:.1f}秒] {label}")
        prev_sec = sec

    if args.with_resolution:
        wait_seconds = 10
        print(f"...{wait_seconds}秒後...")
        time.sleep(wait_seconds)
        payload = resolution_step()
        qzss_sink.send(json.dumps(payload, ensure_ascii=False))
        print(f"[{RESOLUTION_NOTE}]")

    print("=== シミュレーション終了 ===")
