"""
ローカルで起動した統合地図(server.js)に、想定しうる通報パターンを
1分おき(既定)に1件ずつ流して、表示のおかしなところがないか目視確認
するためのツール。

使い方:
  1. 別ターミナルでローカルサーバーを起動しておく
       cd map && PORT=8099 node server.js
  2. このスクリプトを実行する
       python3 test/replay_test_cases.py
       (対象URLや間隔を変えたい場合: python3 test/replay_test_cases.py http://localhost:8099 60)

全ケースは is_test_data: true を付けて送るので、パネルに
「🧪 テストデータ」のバナーが出る(本物の警報と混同しない)。
"""
import json
import random
import sys
import time
import urllib.error
import urllib.request

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8099"
INGEST_URL = BASE_URL.rstrip("/") + "/ingest"
INTERVAL_SEC = float(sys.argv[2]) if len(sys.argv) > 2 else 60


def post(payload, label):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        INGEST_URL, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
        print(f"✅ [{label}]")
    except urllib.error.URLError as e:
        print(f"❌ [{label}] 送信失敗: {e}")


def dms(decimal):
    d = int(decimal)
    m_full = (decimal - d) * 60
    m = int(m_full)
    s = round((m_full - m) * 60, 1)
    return d, m, s


def hypocenter_coords(lat, lon):
    lat_d, lat_m, lat_s = dms(lat)
    lon_d, lon_m, lon_s = dms(lon)
    return {
        "lat_d": lat_d, "lat_m": lat_m, "lat_s": lat_s, "lat_ns": 0,
        "lon_d": lon_d, "lon_m": lon_m, "lon_s": lon_s, "lon_ew": 0,
    }


SAT = {"satellite_id": 58, "satellite_prn": 186}

# ==================================================
# 地震・津波(disaster_category_no: 1=EEW, 2=震源, 3=震度速報, 5=津波)
# ==================================================
def eew(label, epicenter, lat, lon, magnitude, eew_regions, cancel=False):
    p = {
        "type": "QzssDcReportJmaEarthquakeEarlyWarning",
        "disaster_category": "緊急地震速報", "disaster_category_no": 1,
        "information_type": "取消" if cancel else "発表",
        "information_type_no": 2 if cancel else 0,
        "seismic_epicenter": epicenter,
        "coordinates_of_hypocenter": hypocenter_coords(lat, lon),
        "magnitude": magnitude,
        "eew_forecast_regions_raw": eew_regions,
        "eew_forecast_regions": [f"予報区{c}" for c in eew_regions],
        **SAT,
    }
    return (label, p)


def intensity_report(label, epicenter, lat, lon, magnitude, prefecture_ids, intensity_codes):
    p = {
        "type": "QzssDcReportJmaSeismicIntensity",
        "disaster_category": "震度速報", "disaster_category_no": 3,
        "information_type": "発表", "information_type_no": 0,
        "seismic_epicenter": epicenter,
        "coordinates_of_hypocenter": hypocenter_coords(lat, lon),
        "magnitude": magnitude,
        "prefectures_raw": prefecture_ids,
        "prefectures": [f"都道府県{i}" for i in prefecture_ids],
        "seismic_intensities_raw": intensity_codes,
        "seismic_intensities": [str(c) for c in intensity_codes],
        **SAT,
    }
    return (label, p)


def tsunami(label, warning_code_raw, warning_text, region_codes, region_names, heights=None, cancel_info=False):
    p = {
        "type": "QzssDcReportJmaTsunami",
        "disaster_category": "津波", "disaster_category_no": 5,
        "information_type": "解除" if cancel_info else "発表",
        "information_type_no": 2 if cancel_info else 0,
        "tsunami_warning_code_raw": warning_code_raw,
        "tsunami_warning_code": warning_text,
        "tsunami_forecast_regions_raw": region_codes,
        "tsunami_forecast_regions": region_names,
        "tsunami_heights": heights or [],
        **SAT,
    }
    return (label, p)


# ==================================================
# Jアラート(DCX)
# ==================================================
def jalert(label, hazard_type, severity, areas, message_type="Alert"):
    p = {
        "type": "QzssDcxJAlert", "dcx_message_type": "J-Alert",
        "a1_message_type": message_type,
        "a4_hazard_type": hazard_type,
        "a5_severity": severity,
        "ex9_target_area_list_ja": areas,
        **SAT,
    }
    return (label, p)


# ==================================================
# Lアラート(DCX)
# ==================================================
def lalert_ellipse(label, hazard_type, severity, lat, lon, major_km, minor_km, azimuth, instruction=""):
    p = {
        "type": "QzssDcxLAlert", "dcx_message_type": "L-Alert",
        "a1_message_type": "Alert",
        "a4_hazard_type": hazard_type,
        "a5_severity": severity,
        "a12_ellipse_centre_latitude": lat,
        "a13_ellipse_centre_longitude": lon,
        "a14_ellipse_semi_major_axis": major_km,
        "a15_ellipse_semi_minor_axis": minor_km,
        "a16_ellipse_azimuth": azimuth,
        "a11_japanese_library_ja": instruction,
        **SAT,
    }
    return (label, p)


def lalert_municipality(label, hazard_type, severity, area_name, area_code, instruction="", duration=""):
    p = {
        "type": "QzssDcxLAlert", "dcx_message_type": "L-Alert",
        "a1_message_type": "Alert",
        "a4_hazard_type": hazard_type,
        "a5_severity": severity,
        "ex1_target_area_ja": area_name,
        "ex1_target_area_code_raw": area_code,
        "a11_japanese_library_ja": instruction,
        "a8_hazard_duration": duration,
        **SAT,
    }
    return (label, p)


def lalert_all_clear(label, hazard_type, area_code=None, lat=None, lon=None):
    p = {
        "type": "QzssDcxLAlert", "dcx_message_type": "L-Alert",
        "a1_message_type": "All Clear",
        "a4_hazard_type": hazard_type,
        **SAT,
    }
    if area_code is not None:
        p["ex1_target_area_code_raw"] = area_code
    if lat is not None:
        p["a12_ellipse_centre_latitude"] = lat
        p["a13_ellipse_centre_longitude"] = lon
    return (label, p)


# ==================================================
# 気象警報・注意報(10)
# ==================================================
def weather(label, regions, sub_categories, cancel=False):
    codes = [c for c, _ in regions]
    names = [n for _, n in regions]
    p = {
        "type": "QzssDcReportJmaWeather",
        "disaster_category": "気象", "disaster_category_no": 10,
        "information_type": "取消" if cancel else "発表",
        "information_type_no": 2 if cancel else 0,
        "weather_warning_state": "解除" if cancel else "発表",
        "weather_forecast_regions_raw": codes,
        "weather_forecast_regions": names,
        "weather_related_disaster_sub_categories": sub_categories,
        "description": f"テスト: {'・'.join(names)}に{'・'.join(sub_categories)}",
        **SAT,
    }
    return (label, p)


# ==================================================
# 南海トラフ(4)・火山(8)・降灰(9)・洪水(11)
# ==================================================
def other_category(label, category_no, category_name, description, cancel=False):
    p = {
        "type": f"QzssDcReport{category_name}",
        "disaster_category": category_name, "disaster_category_no": category_no,
        "information_type": "取消" if cancel else "発表",
        "information_type_no": 2 if cancel else 0,
        "description": description,
        **SAT,
    }
    return (label, p)


def training_broadcast():
    p = {
        "type": "QzssDcReportJmaEarthquakeEarlyWarning",
        "disaster_category": "緊急地震速報", "disaster_category_no": 1,
        "information_type": "発表", "information_type_no": 0,
        "report_classification_no": 7,  # 公式訓練/試験 → 画面には出ないはず
        "seismic_epicenter": "テスト用震源",
        "coordinates_of_hypocenter": hypocenter_coords(35.0, 139.0),
        "magnitude": 5.0,
        "eew_forecast_regions_raw": [59],
        "eew_forecast_regions": ["関東地方"],
        **SAT,
    }
    return ("訓練放送(画面に出ないことを確認)", p)


def decode_error():
    return ("デコードエラー(短時間で自動的に消えることを確認)", {
        "type": "DecodeError",
        "sentence": "$QZQSM,58,BROKEN*00",
        "error": "テスト用の壊れたセンテンス",
    })


# ==================================================
# テストケース一覧(50件以上)
# ==================================================
CASES = []

# --- 地震・津波系(8件) ---
CASES.append(eew("EEW 小規模(M3.9 震度3程度・茨城県沖)", "茨城県沖", 36.3, 140.9, 3.9, [59]))
CASES.append(eew("EEW 大規模(M7.2 緊急・南海トラフ想定域)", "紀伊半島沖", 33.5, 136.0, 7.2, [65, 67, 68]))
CASES.append(intensity_report("震度速報(震度6強・関東)", "茨城県沖", 36.3, 140.9, 6.1, [8, 9, 12], [6, 5, 4]))
CASES.append(intensity_report("震度速報(震度7・南海トラフ想定域)", "紀伊半島沖", 33.5, 136.0, 8.6, [24, 30, 36], [7, 6, 6]))
CASES.append(tsunami("津波注意報(相模湾・東京湾)", 15, "津波注意報", [330, 312], ["相模湾・三浦半島", "東京湾内湾"], ["0.2m"]))
CASES.append(tsunami("津波警報(千葉九十九里)", 3, "津波警報", [310], ["千葉県九十九里・外房"], ["1m"]))
CASES.append(tsunami("大津波警報(高知県)", 4, "大津波警報", [610], ["高知県"], ["5m超"]))

# --- Jアラート(7件) ---
CASES.append(jalert("Jアラート: ミサイル発射", "Missile attack", "Extreme - Extraordinary threat to life or property", ["北海道", "青森県"]))
CASES.append(jalert("Jアラート: 航空攻撃", "Air strike", "Severe - Significant threat to life or property", ["沖縄県"]))
CASES.append(jalert("Jアラート: ゲリラ・特殊部隊", "Guerrilla attack", "Severe - Significant threat to life or property", ["東京都"]))
CASES.append(jalert("Jアラート: テロ", "Terrorism", "Extreme - Extraordinary threat to life or property", ["大阪府"]))
CASES.append(jalert("Jアラート: 化学攻撃", "Chemical attack", "Extreme - Extraordinary threat to life or property", ["福岡県"]))
CASES.append(jalert("Jアラート: 核攻撃", "Attack with nuclear weapons", "Extreme - Extraordinary threat to life or property", ["全国"]))
CASES.append(jalert("Jアラート: 訓練メッセージ", "Safety warning", "Unknown", ["東京都"], message_type="Test"))

# --- Lアラート 楕円ケース(8件) ---
CASES.append(lalert_ellipse("Lアラート(楕円): 洪水 Extreme 愛知/三重", "Flood", "Extreme - Extraordinary threat to life or property", 35.1, 136.9, 25, 12, 45, "河川の氾濫による浸水の危険があります。"))
CASES.append(lalert_ellipse("Lアラート(楕円): 大雨 Severe 静岡", "Rainfall", "Severe - Significant threat to life or property", 34.9, 138.3, 15, 8, 120, "土砂災害に警戒してください。"))
CASES.append(lalert_ellipse("Lアラート(楕円): 津波 Extreme 高知沖", "Tsunami", "Extreme - Extraordinary threat to life or property", 33.0, 133.8, 40, 20, 90, "直ちに高台へ避難してください。"))
CASES.append(lalert_ellipse("Lアラート(楕円): 竜巻 Severe 埼玉", "Tornado", "Severe - Significant threat to life or property", 36.0, 139.5, 8, 4, 30, "頑丈な建物の中へ避難してください。"))
CASES.append(lalert_ellipse("Lアラート(楕円): 地すべり Moderate 長野", "Landslide", "Moderate - Possible threat to life or property", 36.3, 137.9, 10, 5, 200, ""))
CASES.append(lalert_ellipse("Lアラート(楕円): 林野火災 Severe 岡山", "Forest fire", "Severe - Significant threat to life or property", 34.9, 133.9, 5, 3, 60, "延焼のおそれがあります。"))
CASES.append(lalert_ellipse("Lアラート(楕円): 火山噴火 Extreme 鹿児島沖", "Volcano eruption", "Extreme - Extraordinary threat to life or property", 31.6, 130.7, 12, 12, 0, "噴石に警戒してください。"))
CASES.append(lalert_ellipse("Lアラート(楕円): 不明種別 Unknown 北海道", "Epidemic", "Unknown", 43.5, 142.5, 20, 10, 0, ""))

# --- Lアラート 市区町村ケース(7件) ---
CASES.append(lalert_municipality("Lアラート(市区町村): 地すべり Extreme 札幌市中央区", "Landslide", "Extreme - Extraordinary threat to life or property", "札幌市中央区", 1101, "直ちに命を守るための最善の行動を。", "6H <= Duration < 12H"))
CASES.append(lalert_municipality("Lアラート(市区町村): 大雨 Severe 那覇市", "Rainfall", "Severe - Significant threat to life or property", "那覇市", 47201, "低い土地からの避難を検討してください。", "Duration < 6H"))
CASES.append(lalert_municipality("Lアラート(市区町村): 高潮 Extreme 名古屋市中区", "Coastal flooding", "Extreme - Extraordinary threat to life or property", "名古屋市中区", 23106, "沿岸部・河口付近は危険です。", "6H <= Duration < 12H"))
CASES.append(lalert_municipality("Lアラート(市区町村): 大雪 Moderate 新潟市中央区", "Snowfall", "Moderate - Possible threat to life or property", "新潟市中央区", 15102, "不要不急の外出は控えてください。", "12H <= Duration < 24H"))
CASES.append(lalert_municipality("Lアラート(市区町村): 暴風雪 Severe 函館市", "Snow storm / blizzard", "Severe - Significant threat to life or property", "函館市", 1202, "視界不良に警戒してください。", "6H <= Duration < 12H"))
CASES.append(lalert_municipality("Lアラート(市区町村): ダム決壊 Extreme 福岡市博多区", "Dam failure or bursting of a dam", "Extreme - Extraordinary threat to life or property", "福岡市博多区", 40133, "直ちに命を守るための最善の行動を。", "Duration < 6H"))
CASES.append(lalert_municipality("Lアラート(市区町村): 訓練 Unknown 仙台市青葉区", "Safety warning", "Unknown", "仙台市青葉区", 4101, "これは訓練です。", ""))

# --- 気象警報・注意報(7件) ---
CASES.append(weather("気象: 大雨特別警報(東京地方)", [(130010, "東京地方")], ["大雨特別警報"]))
CASES.append(weather("気象: 暴風特別警報(大阪府)", [(270000, "大阪府")], ["暴風特別警報"]))
CASES.append(weather("気象: 土砂災害警戒情報(熊本地方)", [(430010, "熊本地方")], ["土砂災害警戒情報"]))
CASES.append(weather("気象: 竜巻注意情報(宗谷地方)", [(11000, "宗谷地方")], ["竜巻注意情報"]))
CASES.append(weather("気象: 記録的短時間大雨情報(複数地域同時)", [(130010, "東京地方"), (140010, "東部"), (200010, "北部")], ["記録的短時間大雨情報"]))
CASES.append(weather("気象: 高潮特別警報(本島中南部)", [(471010, "本島中南部")], ["高潮特別警報"]))
CASES.append(weather("気象: 大雪特別警報+暴風雪特別警報(津軽)", [(20010, "津軽")], ["大雪特別警報", "暴風雪特別警報"]))

# --- 南海トラフ・火山・降灰・洪水(6件) ---
CASES.append(other_category("南海トラフ: 調査開始情報", 4, "南海トラフ地震関連情報", "南海トラフ沿いで異常な現象が観測されたため、調査を開始しました。"))
CASES.append(other_category("南海トラフ: 巨大地震警戒", 4, "南海トラフ地震臨時情報", "南海トラフ地震臨時情報(巨大地震警戒)が発表されました。"))
CASES.append(other_category("火山: 桜島 噴火警戒レベル4", 8, "噴火警報", "桜島の噴火警戒レベルが4(避難準備)に引き上げられました。"))
CASES.append(other_category("火山: 富士山 噴火警戒レベル2", 8, "噴火警報", "富士山の噴火警戒レベルが2(火口周辺規制)に引き上げられました。"))
CASES.append(other_category("降灰: 桜島 降灰予報", 9, "降灰予報", "桜島の降灰予報(多量)が発表されました。"))
CASES.append(other_category("洪水: 利根川 洪水警報", 11, "洪水警報", "利根川で氾濫警戒情報が発表されました。"))

# --- 異常系・端境ケース(3件) ---
CASES.append(training_broadcast())
CASES.append(decode_error())
CASES.append(lalert_ellipse("端境: 楕円が日本の端(沖縄はるか沖)", "Tsunami", "Extreme - Extraordinary threat to life or property", 24.5, 123.0, 60, 30, 45, ""))

random.shuffle(CASES)  # 順番に依存した見落としがないよう、毎回シャッフルする


# ==================================================
# 各テストケースを送った後、決まった時間で自動的に終了信号(取消/解除/
# All Clear)を送って地図をリセットする。次のケースとの間隔を空けることで
# 「無関係な通報がいつまでも積み上がって画面がごちゃごちゃになる」のを防ぎ、
# 1件ずつクリーンな状態で目視確認できるようにする。
# ==================================================
POST_TO_END_SIGNAL_SEC = 30  # 発表してから終了信号を送るまでの時間
END_SIGNAL_TO_NEXT_SEC = 10  # 終了信号を送ってから次のケースを送るまでの時間


def derive_end_signal(payload):
    """与えられたテストケースに対応する「終了信号」を作る。
    終了信号が存在しない/意味を持たない種類(訓練放送・デコードエラー)は
    Noneを返す。"""
    p = dict(payload)
    if p.get("type") in ("QzssDcxJAlert", "QzssDcxLAlert"):
        p["a1_message_type"] = "All Clear"
        return p
    if p.get("disaster_category_no") == 5:
        p["information_type"] = "解除"
        p["information_type_no"] = 2
        p["tsunami_warning_code_raw"] = 2
        p["tsunami_warning_code"] = "警報解除"
        return p
    if p.get("disaster_category_no") == 10:
        p["information_type"] = "解除"
        p["information_type_no"] = 2
        p["weather_warning_state"] = "解除"
        return p
    if "disaster_category_no" in p:
        p["information_type"] = "取消"
        p["information_type_no"] = 2
        p["information_type_en"] = "Cancel"
        return p
    return None


def main():
    total = len(CASES)
    print(f"🗺️  対象: {INGEST_URL}")
    print(f"📦 テストケース数: {total} 件")
    print(f"⏱️  発表→{POST_TO_END_SIGNAL_SEC}秒後に終了信号→{END_SIGNAL_TO_NEXT_SEC}秒後に次のケース、を繰り返します")
    print("-" * 60)
    for i, (label, payload) in enumerate(CASES, 1):
        payload = dict(payload)
        payload.setdefault("is_test_data", True)
        print(f"[{i}/{total}] {label}")
        post(payload, label)

        end_payload = derive_end_signal(payload)
        if end_payload is None:
            # 訓練放送・デコードエラーは終了信号が無い(前者は画面に出ない、
            # 後者は10秒で自動的に消える)。ペースだけ合わせて次へ進む
            time.sleep(POST_TO_END_SIGNAL_SEC + END_SIGNAL_TO_NEXT_SEC)
            continue

        time.sleep(POST_TO_END_SIGNAL_SEC)
        print(f"  ↻ 終了信号を送信して地図をリセットします")
        post(end_payload, label + "(終了信号)")
        time.sleep(END_SIGNAL_TO_NEXT_SEC)
    print("-" * 60)
    print("✅ 全ケース送信完了")


if __name__ == "__main__":
    main()
