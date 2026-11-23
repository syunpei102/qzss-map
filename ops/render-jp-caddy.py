#!/usr/bin/env python3
"""Render a Caddy IP allowlist from DB-IP Lite country geolocation data."""

import argparse
import csv
import datetime
import gzip
import ipaddress
import io
import pathlib
import urllib.request

DBIP_URL = "https://download.db-ip.com/free/dbip-country-lite-{month}.csv.gz"
SELF_IPS = ("127.0.0.1/32", "::1/128", "168.138.208.223/32")


def jp_networks(data):
    networks = []
    for row in csv.reader(io.StringIO(gzip.decompress(data).decode("utf-8"))):
        if len(row) != 3 or row[2] != "JP":
            continue
        start, end = ipaddress.ip_address(row[0]), ipaddress.ip_address(row[1])
        networks.extend(ipaddress.summarize_address_range(start, end))
    if len(networks) < 30000:
        raise ValueError("DB-IP JP data is unexpectedly small")
    networks.extend(ipaddress.ip_network(item) for item in SELF_IPS)
    ipv4 = ipaddress.collapse_addresses(n for n in networks if n.version == 4)
    ipv6 = ipaddress.collapse_addresses(n for n in networks if n.version == 6)
    return [str(network) for network in (*ipv4, *ipv6)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--template", type=pathlib.Path,
                        default=pathlib.Path(__file__).with_name("jp-access-Caddyfile.template"))
    args = parser.parse_args()
    month = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m")
    request = urllib.request.Request(DBIP_URL.format(month=month), headers={"User-Agent": "QZSS-JP-access/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(10_000_000)
    networks = jp_networks(data)
    if not 30000 <= len(networks) <= 50000:
        raise ValueError("DB-IP JP CIDR count is outside the expected range")
    parsed = [ipaddress.ip_network(item) for item in networks]
    if not any(ipaddress.ip_address("133.78.37.242") in item for item in parsed):
        raise ValueError("Known Japanese access network is missing")
    if not any(ipaddress.ip_address("168.138.208.223") in item for item in parsed):
        raise ValueError("Known Tokyo cloud network is missing")
    if any(ipaddress.ip_address("8.8.8.8") in item for item in parsed):
        raise ValueError("Known non-JP network is unexpectedly included")
    template = args.template.read_text(encoding="utf-8")
    if template.count("JP_IPS") != 3:
        raise ValueError("Caddy template must contain exactly three JP_IPS placeholders")
    output = template.replace("JP_IPS", " ".join(networks))
    args.output.write_text(output, encoding="utf-8")
    print(f"Rendered {len(networks)} JP/self CIDRs from DB-IP Lite {month} to {args.output}")


if __name__ == "__main__":
    main()
