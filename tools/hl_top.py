#!/usr/bin/env python3
"""Daftar harian "trader top" Hyperliquid untuk indikator sentimen AInalyzer (read-only).

Unduh leaderboard publik Hyperliquid (~40 MB), saring akun yang konsisten untung, lalu tulis
hl_top.json (dibaca aplikasi). Dengan --snapshot, ambil juga posisi live 50 akun teratas dan
tambahkan agregat harian ke hl_history.json (bahan evaluasi jujur di masa depan).

Pemakaian:
  python3 tool/hl_top.py [--out DIR] [--snapshot]
Tanpa library pihak ketiga (certifi opsional).
"""
import argparse
import json
import os
import ssl
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO_URL = "https://api.hyperliquid.xyz/info"
UA = {"User-Agent": "Mozilla/5.0 (AInalyzer hl_top)"}

MIN_ACCOUNT = 100_000
KEEP = 100
SNAPSHOT_N = 50
MIN_TRADERS = 3
MAX_HISTORY = 730
CRITERIA = ("Akun Hyperliquid bernilai ≥ $100rb yang untung sepanjang waktu dan 30 hari terakhir, "
            "diperingkat rata-rata persentil laba sepanjang waktu & laba 30 hari; 100 teratas.")


def _ssl_context():
    # Python dari python.org di macOS sering tidak punya sertifikat root; pakai certifi / sertifikat sistem.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    if os.path.exists("/etc/ssl/cert.pem"):
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


SSL_CTX = _ssl_context()


def http_json(url, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    headers = dict(UA)
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return json.loads(r.read())


def _f(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x and abs(x) != float("inf") else None


def _perf(row):
    out = {}
    for item in row.get("windowPerformances") or []:
        if isinstance(item, list) and len(item) == 2 and isinstance(item[1], dict):
            out[item[0]] = item[1]
    return out


def _pct_rank(values):
    """Persentil (0..1) tiap nilai; nilai sama dapat rata-rata peringkatnya."""
    n = len(values)
    if n <= 1:
        return [1.0] * n
    order = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        r = (i + j) / 2 / (n - 1)
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def select_top(rows, keep=KEEP):
    cand = []
    for row in rows:
        addr = str(row.get("ethAddress") or "")
        if not (addr.startswith("0x") and len(addr) == 42):
            continue
        av = _f(row.get("accountValue"))
        p = _perf(row)
        m, a = p.get("month") or {}, p.get("allTime") or {}
        pm, pa, ra, rm, vm = _f(m.get("pnl")), _f(a.get("pnl")), _f(a.get("roi")), _f(m.get("roi")), _f(m.get("vlm"))
        if None in (av, pm, pa, ra) or av < MIN_ACCOUNT or pa <= 0 or pm <= 0 or ra <= 0 or not vm:
            continue
        name = row.get("displayName")
        cand.append({"a": addr.lower(), "n": str(name)[:40] if name else None, "av": av,
                     "pm": pm, "rm": rm or 0.0, "pa": pa, "ra": ra})
    ra_ = _pct_rank([c["pa"] for c in cand])
    rm_ = _pct_rank([c["pm"] for c in cand])
    for c, x, y in zip(cand, ra_, rm_):
        c["_s"] = (x + y) / 2
    cand.sort(key=lambda c: (-c["_s"], -c["pm"]))
    out = []
    for c in cand[:keep]:
        out.append({"a": c["a"], "n": c["n"], "av": round(c["av"]), "pm": round(c["pm"]),
                    "rm": round(c["rm"], 4), "pa": round(c["pa"]), "ra": round(c["ra"], 4)})
    return out, len(cand)


def fetch_positions(addr):
    try:
        return http_json(INFO_URL, {"type": "clearinghouseState", "user": addr}, timeout=20)
    except Exception as e:  # satu akun gagal tidak menggagalkan semuanya
        print(f"  gagal {addr[:10]}…: {e}", file=sys.stderr)
        return None


def aggregate(states):
    coins = {}
    for st in states:
        if not st:
            continue
        for ap in st.get("assetPositions") or []:
            p = (ap or {}).get("position") or {}
            coin, szi, val = p.get("coin"), _f(p.get("szi")), _f(p.get("positionValue"))
            if not coin or not szi or val is None or ":" in coin:
                continue
            c = coins.setdefault(coin, {"long": 0, "short": 0, "lv": 0.0, "sv": 0.0})
            if szi > 0:
                c["long"] += 1; c["lv"] += abs(val)
            else:
                c["short"] += 1; c["sv"] += abs(val)
    out = {}
    for k in sorted(coins, key=lambda k: -(coins[k]["lv"] + coins[k]["sv"])):
        c = coins[k]
        if c["long"] + c["short"] >= MIN_TRADERS:
            out[k] = {"long": c["long"], "short": c["short"], "lv": round(c["lv"]), "sv": round(c["sv"])}
    return out


def update_history(path, entry):
    hist = []
    if os.path.exists(path):
        try:
            with open(path) as f:
                hist = json.load(f)
            if not isinstance(hist, list):
                hist = []
        except (OSError, ValueError):
            hist = []
    hist = [h for h in hist if isinstance(h, dict) and h.get("date") != entry["date"]]
    hist.append(entry)
    hist.sort(key=lambda h: h.get("date", ""))
    return hist[-MAX_HISTORY:]


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="hl_data", help="folder output (default ./hl_data)")
    ap.add_argument("--snapshot", action="store_true", help="ambil posisi 50 teratas & catat ke hl_history.json")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)

    print("Mengunduh leaderboard Hyperliquid…", file=sys.stderr)
    lb = http_json(LEADERBOARD_URL, timeout=180)
    rows = lb.get("leaderboardRows") or []
    if len(rows) < 1000:
        raise SystemExit(f"Leaderboard terlalu sedikit ({len(rows)} baris) — batal agar daftar lama tidak tertimpa.")
    traders, n_cand = select_top(rows)
    if len(traders) < 20:
        raise SystemExit(f"Hanya {len(traders)} trader lolos saringan — batal.")
    now = datetime.now(timezone.utc)
    top = {"updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": LEADERBOARD_URL,
           "criteria": CRITERIA, "traders": traders}
    write_json(os.path.join(args.out, "hl_top.json"), top)
    print(f"{len(rows)} baris leaderboard, {n_cand} lolos saringan, {len(traders)} disimpan.", file=sys.stderr)

    if args.snapshot:
        addrs = [t["a"] for t in traders[:SNAPSHOT_N]]
        with ThreadPoolExecutor(max_workers=5) as ex:
            states = list(ex.map(fetch_positions, addrs))
        ok = sum(1 for s in states if s)
        coins = aggregate(states)
        entry = {"date": now.strftime("%Y-%m-%d"), "accounts": ok, "coins": coins}
        hp = os.path.join(args.out, "hl_history.json")
        write_json(hp, update_history(hp, entry))
        print(f"Snapshot: {ok}/{len(addrs)} akun dimuat, {len(coins)} koin (≥{MIN_TRADERS} trader).", file=sys.stderr)
        for k in ("BTC", "ETH", "SOL"):
            c = coins.get(k)
            if c:
                tot = c["lv"] + c["sv"] or 1
                print(f"  {k}: {c['long']} long / {c['short']} short · nilai {c['sv'] / tot:.0%} short", file=sys.stderr)


if __name__ == "__main__":
    main()
