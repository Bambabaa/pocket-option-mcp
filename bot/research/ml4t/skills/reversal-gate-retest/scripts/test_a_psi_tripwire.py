#!/usr/bin/env python3
"""
test_a_psi_tripwire.py — Test A: counterfactual PSI trip-wire (no retraining).

Replays days chronologically. Each day D: compute the gate-fired bars, score the day's
covariate drift as max PSI across the 4 features vs ALL strictly-prior fired bars (the
reference you'd actually have had live), and apply a size rule:
    maxPSI < 0.10  -> size 1.0 (trade)
    0.10 - 0.25    -> size 0.5 (half)
    > 0.25         -> size 0.0 (PAUSE)

Two arms, because money needs settlement but the predictive proof needs n:
  PREDICTIVE (agent.db): realized fade-WR (candle decay) ungated vs trip-wire-gated.
                         Big n (15 assets x ~15 days) -> tests if the wire separates
                         good-decay days from bad. No payout/P-L here.
  MONEY (trade DBs):     each day's ACTUAL broker P/L x that day's size -> counterfactual
                         book vs the real frozen book. Real payout/settlement, thin n.

Reference uses ONLY strictly-prior days (no look-ahead). First day(s) trade full until
>=MINREF prior fired bars exist.

Usage: python test_a_psi_tripwire.py
"""
from __future__ import annotations
import json, os, sys, sqlite3
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", ".."))
P = json.load(open(os.path.join(HERE, "..", "ml_gate_params_deployed.json")))
GATE = P["thresholds"]["gate"]; FEATS = P["features"]; BAR, N = 300, 3
BREAKEVEN = 0.59      # decay rate needed at ~69% live payout
MINREF = 30           # min prior fired bars before the wire is allowed to act
def R(p): return os.path.join(ROOT, p)
MONEY_DBS = ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db",
             "data/trading_data_08220.db","data/trading_data.db"]
AGENT_DB  = "agent/data/agent.db"

def tree_p(x):
    n = P["tree"]
    while not n["leaf"]:
        n = n["left"] if x[n["feature"]] <= n["threshold"] else n["right"]
    return n["proba"]
def logreg_p(x):
    lr = P["logreg"]
    z = (np.array(x) - lr["scaler_mean"]) / lr["scaler_scale"]
    return 1.0/(1.0+np.exp(-(np.dot(z, lr["coef"]) + lr["intercept"])))

def feats_decay(dbs):
    """Per-bar 4 features + realized decay + day, for every fired bar across dbs."""
    parts = [po_data.load(R(db)) for db in dbs]
    df = pd.concat(parts, ignore_index=True)
    rows = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        close, ts = g["close"].astype(float), g["timestamp"]
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        g["BB_Deviation"]     = (close - g["bb_lower"]) / band
        g["CCI_Velocity"]     = g["cci_20"].diff(2) / 2.0
        g["Stoch_Divergence"] = (g["stoch_k"] - g["stoch_d"]).abs()
        g["STC_Momentum"]     = g["stc_value"].diff(1)
        recent = close - close.shift(N); fwd = close.shift(-N) - close
        contig = (ts.shift(-N) - ts == N*BAR) & (ts - ts.shift(N) == N*BAR)
        g["decay"] = ((np.sign(fwd) != np.sign(recent)) & contig & (recent != 0)).astype(float)
        g.loc[~(contig & (recent != 0)), "decay"] = np.nan
        g["day"] = pd.to_datetime(ts, unit="s").dt.strftime("%Y-%m-%d")
        rows.append(g)
    d = pd.concat(rows).dropna(subset=FEATS + ["decay"])
    X = d[FEATS].values
    d["fired"] = [(tree_p(x) >= GATE) or (logreg_p(x) >= GATE) for x in X]
    return d[d["fired"]].copy()

def psi(ref, tgt, bins=10):
    edges = np.unique(np.quantile(ref, np.linspace(0, 1, bins+1)))
    if len(edges) < 3: return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    r = np.clip(np.histogram(ref, edges)[0]/len(ref), 1e-4, None)
    t = np.clip(np.histogram(tgt, edges)[0]/len(tgt), 1e-4, None)
    return float(np.sum((t-r)*np.log(t/r)))

def size_for(maxpsi):
    if maxpsi is None: return 1.0, "full (no ref)"
    if maxpsi < 0.10:  return 1.0, "full"
    if maxpsi < 0.25:  return 0.5, "half"
    return 0.0, "PAUSE"

def day_psis(fired):
    """For each day in order, maxPSI vs all strictly-prior fired bars, + size."""
    days = sorted(fired["day"].unique())
    out = []
    for i, day in enumerate(days):
        cur = fired[fired["day"] == day]
        prior = fired[fired["day"] < day]
        if len(prior) < MINREF:
            mp = None
        else:
            mp = max(psi(prior[f].values, cur[f].values) for f in FEATS)
        sz, lab = size_for(mp)
        out.append((day, len(cur), mp, sz, lab, cur))
    return out

def predictive():
    fired = feats_decay([AGENT_DB])
    print(f"\n## PREDICTIVE arm — agent.db (15 assets, candle-realized decay, big n)")
    print(f"fired bars total {len(fired)} | break-even decay {BREAKEVEN:.0%}\n")
    print("| day | fired n | maxPSI | size | day decay-WR |")
    print("|---|---|---|---|---|")
    tot_n = tot_w = 0; g_n = g_w = 0.0
    for day, n, mp, sz, lab, cur in day_psis(fired):
        wr = cur["decay"].mean()
        tot_n += n; tot_w += cur["decay"].sum()
        g_n += sz*n; g_w += sz*cur["decay"].sum()
        mps = "—" if mp is None else f"{mp:.2f}"
        print(f"| {day} | {n} | {mps} | {lab} | {wr*100:.0f}% |")
    print(f"\nUNGATED: n={tot_n}  decay-WR={tot_w/tot_n*100:.1f}%  (edge vs {BREAKEVEN:.0%}: {(tot_w/tot_n-BREAKEVEN)*100:+.1f}pts)")
    if g_n > 0:
        print(f"GATED:   eff-n={g_n:.0f}  decay-WR={g_w/g_n*100:.1f}%  (edge: {(g_w/g_n-BREAKEVEN)*100:+.1f}pts)")
    print("(decay-WR = realized fade win rate. Trip-wire should RAISE WR and lift edge above break-even.)")

def money():
    fired = feats_decay(MONEY_DBS)            # fired bars for PSI day-score
    # actual broker P/L per day from trades_ordered
    pls = []
    for db in MONEY_DBS:
        con = sqlite3.connect(f"file:{R(db)}?mode=ro&immutable=1", uri=True)
        try:
            t = pd.read_sql_query("SELECT entry_timestamp, result, profit_loss FROM trades_ordered "
                                  "WHERE result IN ('WIN','LOSS')", con)
        finally: con.close()
        if len(t): pls.append(t)
    T = pd.concat(pls, ignore_index=True)
    T["day"] = pd.to_datetime(T["entry_timestamp"], unit="s").dt.strftime("%Y-%m-%d")
    daypl = T.groupby("day")["profit_loss"].agg(["sum","count"])
    sizes = {d: (sz, lab, mp) for d, n, mp, sz, lab, cur in day_psis(fired)}
    print(f"\n## MONEY arm — trade DBs (broker-settled P/L x trip-wire size)")
    print("| day | trades | actual P/L | maxPSI | size | counterfactual P/L |")
    print("|---|---|---|---|---|---|")
    act = cf = 0.0
    for day in sorted(daypl.index):
        s = daypl.loc[day, "sum"]; n = int(daypl.loc[day, "count"])
        sz, lab, mp = sizes.get(day, (1.0, "full (no fires)", None))
        act += s; cf += sz*s
        mps = "—" if mp is None else f"{mp:.2f}"
        print(f"| {day} | {n} | {s:+.0f} | {mps} | {lab} | {sz*s:+.0f} |")
    print(f"\nACTUAL frozen book: {act:+.0f}   |   PSI-gated book: {cf:+.0f}   "
          f"|   delta: {cf-act:+.0f}")

def main():
    print(f"# Test A — PSI trip-wire counterfactual (gate {GATE}, no retrain)")
    print(f"size rule: PSI<0.10 full | 0.10-0.25 half | >0.25 PAUSE | ref=strictly-prior fired bars (>={MINREF})")
    predictive()
    money()

if __name__ == "__main__":
    main()
