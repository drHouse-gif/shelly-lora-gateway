#!/usr/bin/env python3
"""Provision the LoRa gateway/slave pair.

Gateway keeps WiFi and carries the virtual components Home Assistant talks to.
Slave is reachable over LoRa only. Run with no arguments to apply everything;
--check only reports.

Two local files are needed and neither is committed:
  ips.env   the two addresses - copy ips.env.example and fill it in
  aes.key   the shared SheLr key, written to both devices as key slot 1
            (openssl rand -base64 16)

Addresses may also come from the environment as GW and SL, which override
ips.env.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

def _addr(name):
    """The device's IP, from the environment or from ips.env next to this file."""
    if os.environ.get(name):
        return os.environ[name]
    path = os.path.join(HERE, "ips.env")
    if os.path.exists(path):
        for line in open(path):
            line = line.split("#", 1)[0].strip()
            if line.startswith(name + "="):
                value = line.split("=", 1)[1].strip()
                if value:
                    return value
    raise SystemExit(
        "%s is not set. Copy ips.env.example to ips.env and fill in the two "
        "addresses, or pass %s=<ip> in the environment." % (name, name)
    )


GW_IP, GW_ADDR, GW_NUM = _addr("GW"), "00010001", 0x00010001
SL_IP, SL_ADDR, SL_NUM = _addr("SL"), "00010002", 0x00010002

# Radio: 868.1 MHz, SF9/BW125 is the compromise between range and latency.
# A report frame measures 317 ms of air time at SF9 (the add-on's own tx_time),
# and 868.1 MHz is an EU868 1% duty cycle sub-band - 36 s per hour. The 120 s
# heartbeat in lora-slave.js spends 9.5 s of that, about a quarter.
RADIO = {"band_plan": "EU868", "freq": 868100000, "bw": 125, "dr": 9,
         "cr": 5, "plen": 10, "txp": 14, "rx_enable": True}

# Virtual components on the gateway, mirroring the slave. Ids are forced so the
# gateway script can hardcode them. Names stay ASCII: the 64 char limit is
# counted in \uXXXX form, which caps Cyrillic at 10 letters.
VCS = [
    ("boolean", 200, "LoRa Slave Output", {"view": "toggle"}),
    ("boolean", 201, "LoRa Slave Link", {"view": "label"}),
    ("number", 200, "LoRa Slave Power", {"view": "label", "unit": "W"}),
    ("number", 201, "LoRa Slave Voltage", {"view": "label", "unit": "V"}),
    ("number", 202, "LoRa Slave Current", {"view": "label", "unit": "A"}),
    ("number", 203, "LoRa Slave Energy", {"view": "label", "unit": "Wh"}),
    ("number", 204, "LoRa Slave Temperature", {"view": "label", "unit": "°C"}),
    ("number", 205, "LoRa Slave RSSI", {"view": "label", "unit": "dBm"}),
    ("number", 206, "LoRa Slave SNR", {"view": "label", "unit": "dB"}),
    # frame counter: it only moves when a frame lands, so a gap in it is a
    # lost frame. Quieter in the recorder than a ticking "age" sensor, and
    # boolean:201 already covers plain staleness.
    ("number", 207, "LoRa Slave Seq", {"view": "label"}),
]

NUM_RANGE = {
    200: (-20000.0, 20000.0),
    201: (0.0, 500.0),
    202: (-200.0, 200.0),
    203: (0.0, 1e9),
    204: (-50.0, 200.0),
    205: (-200.0, 20.0),
    206: (-50.0, 50.0),
    207: (0.0, 255.0),
}


def rpc(ip, method, params=None, timeout=25, tries=4):
    """One RPC call, retried on transport errors.

    A Shelly's HTTP server accepts very few concurrent connections, so a
    perfectly healthy device will time out if anything else is polling it.
    Retry transport failures; never retry a reply the device actually gave us,
    because some of these calls are not idempotent.
    """
    body = {"id": 1, "method": method}
    if params is not None:
        body["params"] = params
    # raw UTF-8, never \uXXXX: the device's JSON parser rejects escapes
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last = None
    for attempt in range(tries):
        req = urllib.request.Request("http://%s/rpc" % ip, data=data,
                                     headers={"Content-Type": "application/json"})
        try:
            raw = urllib.request.urlopen(req, timeout=timeout).read().decode()
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
        except (TimeoutError, OSError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
            continue
        out = json.loads(raw)
        if "error" in out:
            raise RuntimeError("%s %s -> %s" % (ip, method, out["error"]))
        return out.get("result")
    raise RuntimeError("%s %s unreachable after %d tries: %s"
                       % (ip, method, tries, last))


def escaped_len(name):
    return sum(6 if ord(c) > 127 else 1 for c in name)


def components(ip, dynamic_only=True):
    """Shelly.GetComponents paginates - follow offset/total."""
    out, offset = [], 0
    while True:
        r = rpc(ip, "Shelly.GetComponents",
                {"dynamic_only": dynamic_only, "offset": offset})
        out.extend(r["components"])
        offset = r["offset"] + len(r["components"])
        if offset >= r["total"] or not r["components"]:
            return out


def ensure_radio(ip, addr, key):
    rpc(ip, "Sys.GetConfig")
    info = rpc(ip, "Sys.GetConfig")["device"]
    if (info.get("addon_type") or "").lower() != "lora":
        rpc(ip, "Sys.SetConfig", {"config": {"device": {"addon_type": "lora"}}})
        rpc(ip, "Shelly.Reboot")
        wait_up(ip)
    cfg = dict(RADIO)
    cfg["shelr"] = {"lr_addr": addr, "tx_key_id": 1, "key1": key,
                    "accept": ["user"]}
    rpc(ip, "LoRa.SetConfig", {"id": 100, "config": cfg})
    st = rpc(ip, "LoRa.GetStatus", {"id": 100})
    if not st["shelr"]["key1"]:
        raise RuntimeError("%s: SheLr key1 did not take" % ip)
    return rpc(ip, "LoRa.GetConfig", {"id": 100})


def ensure_vcs(ip):
    """Create the mirror components, or fix up ones that already exist."""
    have = {c["key"]: c["config"] for c in components(ip)}
    wanted = set()
    for typ, cid, name, ui in VCS:
        key = "%s:%d" % (typ, cid)
        wanted.add(key)
        if escaped_len(name) > 64:
            raise RuntimeError("name too long for %s: %r" % (key, name))
        cfg = {"id": cid, "name": name, "meta": {"ui": ui}}
        if typ == "number":
            lo, hi = NUM_RANGE[cid]
            cfg["min"] = lo
            cfg["max"] = hi
        if key not in have:
            got = rpc(ip, "Virtual.Add", {"type": typ, "config": cfg})
            if got["id"] != cid:
                raise RuntimeError("%s got id %s, wanted %s" % (key, got["id"], cid))
            print("  + %-14s %s" % (key, name))
        else:
            rpc(ip, "%s.SetConfig" % typ.capitalize(), {"id": cid, "config": cfg})
            print("  = %-14s %s" % (key, name))

    # drop anything left over from an earlier run
    for key, cfg in have.items():
        if key not in wanted and str(cfg.get("name", "")).startswith(("LoRa Slave", "ZZ ")):
            rpc(ip, "Virtual.Delete", {"key": key})
            print("  - %-14s %s" % (key, cfg.get("name")))


def script_id(ip, name):
    for s in rpc(ip, "Script.List")["scripts"]:
        if s["name"] == name:
            return s["id"]
    return None


def put_script(ip, name, path):
    code = open(path, encoding="utf-8").read()
    sid = script_id(ip, name)
    if sid is None:
        sid = rpc(ip, "Script.Create", {"name": name})["id"]
    else:
        rpc(ip, "Script.Stop", {"id": sid})
    # chunk by characters so a multi-byte char is never split
    first = True
    for i in range(0, len(code), 700):
        rpc(ip, "Script.PutCode",
            {"id": sid, "code": code[i:i + 700], "append": not first})
        first = False
    rpc(ip, "Script.SetConfig", {"id": sid, "config": {"enable": True}})
    rpc(ip, "Script.Start", {"id": sid})
    st = rpc(ip, "Script.GetStatus", {"id": sid})
    print("  %s script %r id=%d running=%s len=%d" %
          (ip, name, sid, st["running"], len(code)))
    if not st["running"]:
        raise RuntimeError("%s: script %r did not start: %s" % (ip, name, st))
    return sid


def drop_script(ip, name):
    sid = script_id(ip, name)
    if sid is not None:
        rpc(ip, "Script.Stop", {"id": sid})
        rpc(ip, "Script.Delete", {"id": sid})
        print("  removed script %r from %s" % (name, ip))


def wait_up(ip, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            rpc(ip, "RPC.Ping", timeout=3)
            return
        except Exception:
            time.sleep(2)
    raise RuntimeError("%s did not come back" % ip)


def check():
    for label, ip, addr in (("gateway", GW_IP, GW_ADDR), ("slave", SL_IP, SL_ADDR)):
        print("== %s %s" % (label, ip))
        try:
            print("   addon   ", rpc(ip, "AddOn.GetInfo"))
            print("   lora cfg", json.dumps(rpc(ip, "LoRa.GetConfig", {"id": 100})))
            print("   lora st ", json.dumps(rpc(ip, "LoRa.GetStatus", {"id": 100})))
            print("   scripts ", rpc(ip, "Script.List"))
        except Exception as e:
            print("   unreachable over IP: %s" % e)
    print("== gateway virtual components")
    for c in components(GW_IP):
        print("   %-14s %-24s %s" % (c["key"], c["config"].get("name"),
                                     json.dumps(c["status"])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.check:
        check()
        return

    key = open(os.path.join(HERE, "aes.key")).read().strip()

    print("radio + SheLr")
    for label, ip, addr in (("gateway", GW_IP, GW_ADDR), ("slave", SL_IP, SL_ADDR)):
        cfg = ensure_radio(ip, addr, key)
        print("  %-7s %s dr=%s freq=%s addr=%s accept=%s" %
              (label, ip, cfg["dr"], cfg["freq"], cfg["shelr"]["lr_addr"],
               cfg["shelr"]["accept"]))

    print("gateway virtual components")
    ensure_vcs(GW_IP)

    print("scripts")
    for stale in ("probe", "vcprobe"):
        drop_script(GW_IP, stale)
        drop_script(SL_IP, stale)
    put_script(SL_IP, "lora-slave", os.path.join(HERE, "lora-slave.js"))
    put_script(GW_IP, "lora-gateway", os.path.join(HERE, "lora-gateway.js"))
    print("done")


if __name__ == "__main__":
    sys.exit(main())
