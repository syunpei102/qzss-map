import json
import unittest

from qzss_decode import decode_to_json


SAMPLES = [
    (
        "earthquake early warning",
        "$QZQSM,57,9AAC89558B0003240000AB160F3A2499B40000000000002000000010C93712C*0F",
        "QzssDcReportJmaEarthquakeEarlyWarning",
        1,
        True,
    ),
    (
        "seismic intensity",
        "$QZQSM,58,C6AF999C828001C82CB25AE775A8D4CA854AB8000000000000000011E027E5C*76",
        "QzssDcReportJmaSeismicIntensity",
        3,
        True,
    ),
    (
        "hypocenter",
        "$QZQSM,58,9AAF919C82800388000039051440C5C82A0108300000000000000012497DA18*0A",
        "QzssDcReportJmaHypocenter",
        2,
        True,
    ),
    (
        "tsunami",
        "$QZQSM,58,9AAFA99C828001E8F67C31053960414E621053BE00000000000000132735038*0F",
        "QzssDcReportJmaTsunami",
        5,
        True,
    ),
    (
        "weather",
        "$QZQSM,58,C6AFD19CB18001113880115F901186A011ADB011D4C011FBD00000135EAA3F8*73",
        "QzssDcReportJmaWeather",
        10,
        False,
    ),
    (
        "J-Alert",
        "$QZQSM,55,9AB0840DE2BF88E9200000000000000000001FFFFFFFFFFFC00000110D0A1B8*71",
        "QzssDcxJAlert",
        None,
        True,
    ),
]


class DecodeToJsonTests(unittest.TestCase):
    def test_representative_messages_decode_to_expected_types(self):
        for label, sentence, expected_type, expected_category, expected_important in SAMPLES:
            with self.subTest(label=label):
                payload, important = decode_to_json(sentence)
                decoded = json.loads(payload)
                self.assertEqual(decoded["type"], expected_type)
                self.assertEqual(decoded.get("disaster_category_no"), expected_category)
                self.assertEqual(important, expected_important)
                self.assertEqual(decoded.get("information_type_no"), 0 if expected_category else None)

    def test_invalid_sentence_returns_decode_error_instead_of_raising(self):
        payload, important = decode_to_json("not-a-qzqsm-sentence")
        decoded = json.loads(payload)
        self.assertEqual(decoded["type"], "DecodeError")
        self.assertEqual(decoded["sentence"], "not-a-qzqsm-sentence")
        self.assertIsInstance(decoded["error"], str)
        self.assertFalse(important)


if __name__ == "__main__":
    unittest.main()
