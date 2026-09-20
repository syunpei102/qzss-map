import json
import unittest
from unittest import mock
import urllib.error
from collections import deque

import qzss_sink
import read_legacy


class CloudSinkTests(unittest.TestCase):
    def test_cloud_send_reports_success(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with mock.patch.object(qzss_sink, "CLOUD_URL", "https://example.test/ingest"), \
             mock.patch.object(qzss_sink.urllib.request, "urlopen", return_value=response):
            self.assertTrue(qzss_sink._send_cloud(json.dumps({"type": "Heartbeat"})))

    def test_cloud_send_reports_failure(self):
        error = urllib.error.URLError("temporary failure")
        with mock.patch.object(qzss_sink, "CLOUD_URL", "https://example.test/ingest"), \
             mock.patch.object(qzss_sink.urllib.request, "urlopen", side_effect=error):
            self.assertIs(qzss_sink._send_cloud(json.dumps({"type": "Heartbeat"})), False)


class ReceiverParsingTests(unittest.TestCase):
    def test_unknown_qzss_satellite_is_ignored_instead_of_crashing_receiver(self):
        packet = bytearray(52)
        packet[:7] = b"\xb5\x62\x02\x13\x2c\x00\x05"
        packet[7] = 99
        self.assertIsNone(read_legacy.ubx2qzqsm(bytes(packet)))

    def test_failed_delivery_is_not_remembered_as_a_duplicate(self):
        history = deque(maxlen=50)
        sender = mock.Mock(return_value=False)
        self.assertFalse(read_legacy.send_if_new("payload", "key", history, sender))
        self.assertEqual(list(history), [])
        sender.assert_called_once_with("payload")

    def test_successful_delivery_is_remembered_and_not_sent_twice(self):
        history = deque(maxlen=50)
        sender = mock.Mock(return_value=True)
        self.assertTrue(read_legacy.send_if_new("payload", "key", history, sender))
        self.assertEqual(list(history), ["key"])
        self.assertFalse(read_legacy.send_if_new("payload", "key", history, sender))
        sender.assert_called_once_with("payload")


class DedupWindowTests(unittest.TestCase):
    def test_suppressed_inside_window_and_resent_after_it(self):
        history, sent_at = deque(maxlen=50), {}
        sender = mock.Mock(return_value=True)
        send = lambda now: read_legacy.send_if_new("p", "k", history, sender, now=now, window=300, sent_at=sent_at)
        self.assertTrue(send(0))
        self.assertFalse(send(299))
        self.assertTrue(send(300))  # 窓経過後は再送してサーバーTTLを更新する
        self.assertEqual(sender.call_count, 2)

    def test_failure_allows_immediate_retry(self):
        history, sent_at = deque(maxlen=50), {}
        sender = mock.Mock(side_effect=[False, True])
        args = ("p", "k", history, sender)
        self.assertFalse(read_legacy.send_if_new(*args, now=0, window=300, sent_at=sent_at))
        self.assertTrue(read_legacy.send_if_new(*args, now=1, window=300, sent_at=sent_at))

    def test_memory_is_bounded(self):
        history, sent_at = deque(maxlen=3), {}
        for i in range(10):
            read_legacy.send_if_new("p", f"k{i}", history, lambda _: True, now=i, sent_at=sent_at)
        self.assertEqual(len(history), 3)
        self.assertEqual(set(sent_at), set(history))


class NmeaChecksumTests(unittest.TestCase):
    BODY = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"

    def sentence(self, fmt):
        return self.BODY + "*" + format(read_legacy.nmea_checksum(self.BODY), fmt)

    def test_accepts_upper_and_lower_case(self):
        self.assertTrue(read_legacy.nmea_checksum_matches(self.sentence("X")))
        self.assertTrue(read_legacy.nmea_checksum_matches(self.sentence("x")))

    def test_rejects_wrong_missing_or_malformed(self):
        self.assertFalse(read_legacy.nmea_checksum_matches(self.BODY + "*00" if read_legacy.nmea_checksum(self.BODY) != 0 else self.BODY + "*01"))
        self.assertFalse(read_legacy.nmea_checksum_matches(self.BODY))
        self.assertFalse(read_legacy.nmea_checksum_matches(self.BODY + "*"))
        self.assertFalse(read_legacy.nmea_checksum_matches(self.BODY + "*ZZ"))


class SinkFailureTests(unittest.TestCase):
    def test_http_error_is_a_failure(self):
        error = urllib.error.HTTPError("https://example.test", 503, "unavailable", {}, None)
        with mock.patch.object(qzss_sink, "CLOUD_URL", "https://example.test/ingest"), \
             mock.patch.object(qzss_sink.urllib.request, "urlopen", side_effect=error):
            self.assertFalse(qzss_sink.send("{}"))


if __name__ == "__main__":
    unittest.main()
