"""
po_data.py — shared, schema-adaptive data layer for the ml4t research skills.

All four skills (alpha-factor-eval, purged-walk-forward-cv, meta-labeling,
directional-momentum-edge) import this so a candidate flows through them on
identical features, AND so they run unchanged across the two DB schemas that
exist in this repo:

  - trading_data.db  : macd_macd/macd_hist, adx_14/adx_plus_di/adx_minus_di,
                       williams_14, psar/psar_bull, kc_*, atr_pct present.
  - agent_*.db       : macd_line/macd_histogram, adx/plus_di/minus_di,
                       williams_r, psar_value/psar_is_bullish, keltner_*,
                       atr_pct ABSENT (derived here).

load() introspects the indicators table and aliases whatever it finds to the
canonical names below; missing canonical columns are filled NaN (and atr_pct is
derived from atr_14/close when absent). READ-ONLY (immutable=1) — never writes.
"""
from __future__ import annotations
import sqlite3
import numpy as np
import pandas as pd

# canonical indicator columns (the trading_data.db vocabulary the skills speak)
IND_COLS = [
    "sma_10","sma_20","sma_50","rsi_14","stoch_k","stoch_d","stoch_prev_d",
    "bb_upper","bb_middle","bb_lower","bb_width_bps","stc_value","stc_signal",
    "stc_prev","stc_delta","cci_20","ema_12","ema_26","macd_macd","macd_signal",
    "macd_hist","kc_upper","kc_middle","kc_lower","adx_14","adx_plus_di",
    "adx_minus_di","williams_14","atr_14","atr_pct","psar","psar_bull",
]

# bounded / stationary feature subset used by models (price levels excluded)
FEATS = ["rsi_14","stoch_k","stoch_d","stoch_prev_d","bb_width_bps","stc_value",
         "stc_signal","stc_prev","stc_delta","cci_20","macd_hist","adx_14",
         "adx_plus_di","adx_minus_di","williams_14","atr_pct","psar_bull"]
META_FEATS = FEATS  # same set; alias kept for readability in meta_label

# canonical -> ordered list of source column names to look for, per schema
_ALIASES = {
    "macd_macd":    ["macd_macd", "macd_line", "macd"],
    "macd_signal":  ["macd_signal"],
    "macd_hist":    ["macd_hist", "macd_histogram"],
    "kc_upper":     ["kc_upper", "keltner_upper"],
    "kc_middle":    ["kc_middle", "keltner_middle"],
    "kc_lower":     ["kc_lower", "keltner_lower"],
    "adx_14":       ["adx_14", "adx"],
    "adx_plus_di":  ["adx_plus_di", "plus_di"],
    "adx_minus_di": ["adx_minus_di", "minus_di"],
    "williams_14":  ["williams_14", "williams_r"],
    "atr_14":       ["atr_14"],
    "atr_pct":      ["atr_pct"],
    "psar":         ["psar", "psar_value"],
    "psar_bull":    ["psar_bull", "psar_is_bullish"],
}

def _table_cols(con, table):
    return {r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()}

def load(db_path: str) -> pd.DataFrame:
    """Indicators joined to candle close, columns aliased to canonical names.
    Read-only / immutable. One row per (asset, timestamp)."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        have = _table_cols(con, "indicators")
        select = ["i.asset", "i.timestamp", "c.open", "c.high", "c.low", "c.close"]
        present = set()
        for canon in IND_COLS:
            srcs = _ALIASES.get(canon, [canon])
            src = next((s for s in srcs if s in have), None)
            if src:
                select.append(f"i.{src} AS {canon}")
                present.add(canon)
        sql = (f"SELECT {', '.join(select)} FROM indicators i "
               f"JOIN candles c ON c.asset=i.asset AND c.timestamp=i.timestamp "
               f"ORDER BY i.asset, i.timestamp")
        df = pd.read_sql_query(sql, con)
    finally:
        con.close()
    # fill any canonical column the schema lacked
    for canon in IND_COLS:
        if canon not in df.columns:
            df[canon] = np.nan
    # derive atr_pct if the schema didn't carry it (agent_*.db)
    if "atr_pct" not in present and "atr_14" in present:
        df["atr_pct"] = np.where(df["close"].abs() > 0, df["atr_14"] / df["close"] * 100.0, np.nan)
    return df

def load_ohlcv(db_path: str) -> pd.DataFrame:
    """Raw candles (OHLC + volume) for export/EDA joins. Read-only.
    Note: volume is the tick count per candle in this project."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        return pd.read_sql_query(
            "SELECT asset, timestamp, open, high, low, close, volume FROM candles "
            "ORDER BY asset, timestamp", con)
    finally:
        con.close()

def load_signals(db_path: str) -> pd.DataFrame:
    """Bot signals if the schema has them, else empty. Read-only."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        if "signals" not in {r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}:
            return pd.DataFrame(columns=["asset", "timestamp", "direction"])
        return pd.read_sql_query("SELECT asset, timestamp, direction FROM signals", con)
    finally:
        con.close()

def build_factor(df: pd.DataFrame, expr: str):
    """Evaluate a factor expression per asset. `d(col,k)` = per-asset k-bar diff."""
    import sys
    out = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        env = {c: g[c].astype(float) for c in IND_COLS if c in g}
        for c in ("open", "high", "low", "close"):
            if c in g: env[c] = g[c].astype(float)
        env["abs"], env["np"] = np.abs, np
        env["d"] = lambda col, k: col - col.shift(k)
        try:
            val = eval(expr, {"__builtins__": {}}, env)  # noqa: S307
        except Exception as e:
            sys.exit(f"ERROR evaluating factor '{expr}': {e}")
        out.append(pd.Series(np.asarray(val, dtype=float), index=g.index))
    return pd.concat(out).reindex(df.index)

def forward_return(df: pd.DataFrame, mins: int, bar_sec: int):
    """Forward return over n contiguous bars, per asset, off candle close."""
    n = (mins * 60) // bar_sec
    fr = pd.Series(np.nan, index=df.index)
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        ret = close.shift(-n) / close - 1.0
        fr.loc[g.index] = ret.where(ts.shift(-n) - ts == n * bar_sec).values
    return fr

def make_folds(times, n_folds: int):
    """Sequential expanding-train folds over unique sorted timestamps."""
    uniq = np.unique(times)
    cut = len(uniq) // (n_folds + 1)
    for tb in np.array_split(uniq[cut:], n_folds):
        if len(tb):
            yield uniq[uniq < tb[0]], tb

# ── family-tagged feature engineering ─────────────────────────────────────────
# Every one of the 32 raw indicators contributes, but ENGINEERED into stationary
# form (ATR-normalized distances/spreads, deltas, ratios) so a model can't just
# fit the price level. Each engineered feature is tagged with exactly one family
# so a per-family ablation restricts cleanly and no single indicator carries a
# verdict. Families: trend, momentum, volatility, breakout.
FAMILIES = ("trend", "momentum", "volatility", "breakout")

def engineer_families(df: pd.DataFrame):
    """Return (X, registry): X is a feature DataFrame aligned to df.index;
    registry maps feature_name -> family. Computed per asset (deltas are causal)."""
    parts = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        atr = g["atr_14"].replace(0, np.nan).astype(float)
        close = g["close"].astype(float)
        def nz(x): return x / atr                          # ATR-normalize a price distance
        def d1(x): return x - x.shift(1)                    # 1-bar delta
        f = {}
        # TREND — where is price vs its trend anchors, and are the anchors stacked
        f["t_close_sma10"] = nz(close - g["sma_10"]);  f["t_close_sma20"] = nz(close - g["sma_20"])
        f["t_close_sma50"] = nz(close - g["sma_50"])
        f["t_close_ema12"] = nz(close - g["ema_12"]);  f["t_close_ema26"] = nz(close - g["ema_26"])
        f["t_ema_spread"]  = nz(g["ema_12"] - g["ema_26"])
        f["t_sma_10_20"]   = nz(g["sma_10"] - g["sma_20"]); f["t_sma_20_50"] = nz(g["sma_20"] - g["sma_50"])
        f["t_close_psar"]  = nz(close - g["psar"]);    f["t_psar_bull"] = g["psar_bull"]
        f["t_macd_cross"]  = nz(g["macd_macd"] - g["macd_signal"])
        # MOMENTUM — oscillators and their motion
        f["m_rsi"] = g["rsi_14"];              f["m_rsi_d"] = d1(g["rsi_14"])
        f["m_stoch_k"] = g["stoch_k"];         f["m_stoch_d"] = g["stoch_d"]
        f["m_stoch_kd"] = g["stoch_k"] - g["stoch_d"]
        f["m_stc"] = g["stc_value"];           f["m_stc_delta"] = g["stc_delta"]
        f["m_stc_gap"] = g["stc_value"] - g["stc_signal"]
        f["m_cci"] = g["cci_20"];              f["m_williams"] = g["williams_14"]
        f["m_macd_hist"] = nz(g["macd_hist"]); f["m_macd_hist_d"] = nz(d1(g["macd_hist"]))
        # VOLATILITY — how wide / how stretched within the envelope
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        kcw  = (g["kc_upper"] - g["kc_lower"]).replace(0, np.nan)
        f["v_bb_width"] = g["bb_width_bps"];   f["v_bb_width_d"] = d1(g["bb_width_bps"])
        f["v_pctB"] = (close - g["bb_lower"]) / band
        f["v_atr_pct"] = g["atr_pct"];         f["v_atr_pct_d"] = d1(g["atr_pct"])
        f["v_squeeze"] = band / kcw                         # <1 = BB inside KC = squeezed
        f["v_close_kc"] = nz(close - g["kc_middle"])
        # BREAKOUT — directional thrust / expansion starting
        f["b_adx"] = g["adx_14"];              f["b_adx_d"] = d1(g["adx_14"])
        f["b_di_spread"] = g["adx_plus_di"] - g["adx_minus_di"]
        f["b_pctB_ext"] = ((close - g["bb_lower"]) / band - 0.5).abs()   # distance from mid-band
        f["b_bbw_expand"] = d1(g["bb_width_bps"])
        f["b_squeeze_rel"] = d1(band / kcw)                 # squeeze releasing (>0) vs tightening
        parts.append(pd.DataFrame(f, index=g.index))
    X = pd.concat(parts).reindex(df.index)
    registry = {c: {"t": "trend", "m": "momentum", "v": "volatility", "b": "breakout"}[c[0]]
                for c in X.columns}
    return X, registry

def family_cols(registry, family):
    """Feature names belonging to one family ('all' returns everything)."""
    if family == "all":
        return list(registry.keys())
    return [c for c, fam in registry.items() if fam == family]
