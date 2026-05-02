#!/usr/bin/env python3
"""
Asset-Level Pattern Analysis
Quantitative research: identify top/bottom assets and their winning/losing patterns
"""

import sqlite3
import pandas as pd
import numpy as np
from scipy import stats
import json
import re

print("="*80)
print("  ASSET-LEVEL PATTERN ANALYSIS")
print("="*80)

# Connect to database
db_path = 'data/trading_data.db'
conn = sqlite3.connect(db_path)

# Load trades with signals
query = """
SELECT 
    t.id as trade_id,
    t.asset,
    t.direction as side,
    t.result,
    t.profit_loss,
    t.entry_timestamp,
    t.exit_timestamp,
    s.reasons,
    s.timestamp as signal_timestamp
FROM trades_ordered t
LEFT JOIN signals s ON t.signal_id = s.id
WHERE t.result IN ('WIN', 'LOSS')
ORDER BY t.entry_timestamp
"""

print(f"\nLoading trades from {db_path}...")
df = pd.read_sql_query(query, conn)
conn.close()

print(f"Loaded {len(df)} trades")

# Parse indicator values from reasons JSON
def parse_indicators(reasons_str):
    """Extract indicator values from signal reasons"""
    if not reasons_str or pd.isna(reasons_str):
        return {}
    
    try:
        reasons = json.loads(reasons_str)
        if not reasons or len(reasons) == 0:
            return {}
        
        # Parse first reason string (contains all indicators)
        reason = reasons[0]
        
        # Extract values using regex
        indicators = {}
        patterns = {
            'stc': r'stc=([\d.]+)',
            'stc_prev': r'prev=([\d.]+)',
            'rsi': r'rsi(?:Max|Min)?5?=([\d.]+)',
            'k': r'k=([\d.]+)',
            'd': r'd=([\d.]+)',
            'bb_bps': r'bbBps=([\d.]+)',
        }
        
        for key, pattern in patterns.items():
            match = re.search(pattern, reason)
            if match:
                indicators[key] = float(match.group(1))
        
        # Derived indicators
        if 'stc' in indicators and 'stc_prev' in indicators:
            indicators['stc_delta'] = indicators['stc'] - indicators['stc_prev']
        
        if 'k' in indicators and 'd' in indicators:
            indicators['k_minus_d'] = indicators['k'] - indicators['d']
        
        return indicators
    except:
        return {}

print("\nParsing indicator values...")
indicator_data = df['reasons'].apply(parse_indicators)
indicator_df = pd.DataFrame(indicator_data.tolist())

# Merge with trade data
df = pd.concat([df, indicator_df], axis=1)

# Convert result to binary
df['win'] = (df['result'] == 'WIN').astype(int)

print(f"Parsed indicators for {len(df[df['stc'].notna()])} trades")

# ============================================================================
# 1. ASSET-LEVEL PERFORMANCE RANKING
# ============================================================================

MIN_TRADES = 5  # Lower threshold for small dataset (199 trades total)

print("\n" + "="*80)
print(f"1. ASSET PERFORMANCE RANKING (min {MIN_TRADES} trades)")
print("="*80)

asset_stats = df.groupby('asset').agg({
    'trade_id': 'count',
    'win': ['sum', 'mean'],
    'profit_loss': 'sum'
}).round(4)

asset_stats.columns = ['n', 'wins', 'wr', 'total_pnl']
asset_stats['wr_pct'] = asset_stats['wr'] * 100
asset_stats = asset_stats[asset_stats['n'] >= MIN_TRADES]
asset_stats = asset_stats.sort_values('wr', ascending=False)

print(f"\nAssets with >={MIN_TRADES} trades: {len(asset_stats)}")
print(f"\nTop 5 Assets by Win Rate:")
print(asset_stats.head(5).to_string())

print(f"\nBottom 5 Assets by Win Rate:")
print(asset_stats.tail(5).to_string())

top_assets = asset_stats.head(5).index.tolist()
bottom_assets = asset_stats.tail(5).index.tolist()

# ============================================================================
# 2. PATTERN ANALYSIS FOR TOP ASSETS
# ============================================================================

print("\n" + "="*80)
print("2. PATTERN ANALYSIS: TOP ASSETS (Winning Patterns)")
print("="*80)

indicators_to_analyze = ['stc', 'stc_prev', 'stc_delta', 'rsi', 'bb_bps', 'k', 'd', 'k_minus_d']

def analyze_indicator_patterns(asset_df, asset_name):
    """Analyze win vs loss patterns for all indicators"""
    
    wins = asset_df[asset_df['win'] == 1]
    losses = asset_df[asset_df['win'] == 0]
    
    print(f"\n{asset_name} ({len(asset_df)} trades, {len(wins)}W / {len(losses)}L, {len(wins)/len(asset_df)*100:.1f}% WR)")
    print("-" * 80)
    
    patterns = []
    
    for indicator in indicators_to_analyze:
        if indicator not in asset_df.columns or asset_df[indicator].isna().all():
            continue
        
        win_vals = wins[indicator].dropna()
        loss_vals = losses[indicator].dropna()
        
        if len(win_vals) < 5 or len(loss_vals) < 5:
            continue
        
        # Statistics
        win_mean = win_vals.mean()
        win_median = win_vals.median()
        win_std = win_vals.std()
        
        loss_mean = loss_vals.mean()
        loss_median = loss_vals.median()
        loss_std = loss_vals.std()
        
        # Effect size (Cohen's d)
        pooled_std = np.sqrt(((len(win_vals)-1)*win_std**2 + (len(loss_vals)-1)*loss_std**2) / (len(win_vals) + len(loss_vals) - 2))
        cohens_d = (win_mean - loss_mean) / pooled_std if pooled_std > 0 else 0
        
        # KS test
        ks_stat, ks_pval = stats.ks_2samp(win_vals, loss_vals)
        
        # Determine if significant
        is_sig = ks_pval < 0.05
        effect_marker = '***' if abs(cohens_d) >= 0.5 else '**' if abs(cohens_d) >= 0.3 else '*' if abs(cohens_d) >= 0.2 else ''
        
        print(f"  {indicator:12s}: WIN mean={win_mean:6.2f} med={win_median:6.2f} | LOSS mean={loss_mean:6.2f} med={loss_median:6.2f} | d={cohens_d:+.3f}{effect_marker} p={ks_pval:.4f}")
        
        if is_sig or abs(cohens_d) >= 0.3:
            direction = "HIGHER" if win_mean > loss_mean else "LOWER"
            patterns.append({
                'indicator': indicator,
                'win_mean': win_mean,
                'win_median': win_median,
                'loss_mean': loss_mean,
                'loss_median': loss_median,
                'cohens_d': cohens_d,
                'ks_pval': ks_pval,
                'direction': direction
            })
    
    # Look for invariants (95%+ in wins)
    print(f"\n  Invariants (conditions true in >=95% of wins):")
    invariants_found = False
    
    for indicator in indicators_to_analyze:
        if indicator not in wins.columns or wins[indicator].isna().all():
            continue
        
        win_vals = wins[indicator].dropna()
        if len(win_vals) < 10:
            continue
        
        # Check various thresholds
        thresholds_to_test = []
        
        if indicator in ['stc', 'stc_prev']:
            thresholds_to_test = [('≤', 5), ('≤', 10), ('≤', 15), ('≤', 20), ('≥', 75), ('≥', 80), ('≥', 85), ('≥', 90)]
        elif indicator == 'rsi':
            thresholds_to_test = [('≤', 15), ('≤', 20), ('≤', 30), ('≥', 70), ('≥', 80), ('≥', 90)]
        elif indicator == 'bb_bps':
            thresholds_to_test = [('≥', 10), ('≥', 20), ('≥', 30), ('≥', 50), ('≤', 5), ('≤', 10)]
        elif indicator == 'k':
            thresholds_to_test = [('≤', 30), ('≤', 40), ('≤', 50), ('≥', 50), ('≥', 60), ('≥', 70)]
        elif indicator == 'stc_delta':
            thresholds_to_test = [('≥', 1), ('≥', 2), ('≥', 3), ('≤', -1), ('≤', -2), ('≤', -3)]
        
        for op, threshold in thresholds_to_test:
            if op == '≤':
                pct = (win_vals <= threshold).mean() * 100
            else:
                pct = (win_vals >= threshold).mean() * 100
            
            if pct >= 95:
                print(f"    - {indicator} {op} {threshold}: {pct:.1f}% of wins")
                invariants_found = True
    
    if not invariants_found:
        print(f"    - None found (no condition >=95% in wins)")
    
    return patterns

# Analyze each top asset
top_patterns = {}
for asset in top_assets:
    asset_df = df[df['asset'] == asset].copy()
    top_patterns[asset] = analyze_indicator_patterns(asset_df, asset)

# ============================================================================
# 3. PATTERN ANALYSIS FOR BOTTOM ASSETS
# ============================================================================

print("\n" + "="*80)
print("3. PATTERN ANALYSIS: BOTTOM ASSETS (Losing Patterns & Gate Leaks)")
print("="*80)

def analyze_failure_patterns(asset_df, asset_name):
    """Analyze failure patterns and gate leaks"""
    
    wins = asset_df[asset_df['win'] == 1]
    losses = asset_df[asset_df['win'] == 0]
    
    print(f"\n{asset_name} ({len(asset_df)} trades, {len(wins)}W / {len(losses)}L, {len(wins)/len(asset_df)*100:.1f}% WR)")
    print("-" * 80)
    
    # Check for gate leaks
    print(f"  Gate Leak Analysis:")
    
    call_trades = asset_df[asset_df['side'] == 'CALL']
    put_trades = asset_df[asset_df['side'] == 'PUT']
    
    leaks = []
    
    # CALL leaks
    if len(call_trades) > 0:
        # STC > 25
        stc_leak = call_trades[call_trades['stc'] > 25]
        if len(stc_leak) > 0:
            leak_wr = stc_leak['win'].mean() * 100
            print(f"    - CALL STC > 25: {len(stc_leak)}/{len(call_trades)} trades ({len(stc_leak)/len(call_trades)*100:.1f}%), WR={leak_wr:.1f}%")
            leaks.append(('CALL_STC>25', len(stc_leak), leak_wr))
        
        # K ≥ 50
        k_leak = call_trades[call_trades['k'] >= 50]
        if len(k_leak) > 0:
            leak_wr = k_leak['win'].mean() * 100
            print(f"    - CALL K >= 50: {len(k_leak)}/{len(call_trades)} trades ({len(k_leak)/len(call_trades)*100:.1f}%), WR={leak_wr:.1f}%")
            leaks.append(('CALL_K≥50', len(k_leak), leak_wr))
        
        # BB < 10
        bb_leak = call_trades[call_trades['bb_bps'] < 10]
        if len(bb_leak) > 0:
            leak_wr = bb_leak['win'].mean() * 100
            print(f"    - CALL BB < 10 bps: {len(bb_leak)}/{len(call_trades)} trades ({len(bb_leak)/len(call_trades)*100:.1f}%), WR={leak_wr:.1f}%")
            leaks.append(('CALL_BB<10', len(bb_leak), leak_wr))
    
    # PUT leaks
    if len(put_trades) > 0:
        # STC < 75
        stc_leak = put_trades[put_trades['stc'] < 75]
        if len(stc_leak) > 0:
            leak_wr = stc_leak['win'].mean() * 100
            print(f"    - PUT STC < 75: {len(stc_leak)}/{len(put_trades)} trades ({len(stc_leak)/len(put_trades)*100:.1f}%), WR={leak_wr:.1f}%")
            leaks.append(('PUT_STC<75', len(stc_leak), leak_wr))
        
        # K ≤ 50
        k_leak = put_trades[put_trades['k'] <= 50]
        if len(k_leak) > 0:
            leak_wr = k_leak['win'].mean() * 100
            print(f"    - PUT K <= 50: {len(k_leak)}/{len(put_trades)} trades ({len(k_leak)/len(put_trades)*100:.1f}%), WR={leak_wr:.1f}%")
            leaks.append(('PUT_K≤50', len(k_leak), leak_wr))
        
        # BB < 10
        bb_leak = put_trades[put_trades['bb_bps'] < 10]
        if len(bb_leak) > 0:
            leak_wr = bb_leak['win'].mean() * 100
            print(f"    - PUT BB < 10 bps: {len(bb_leak)}/{len(put_trades)} trades ({len(bb_leak)/len(put_trades)*100:.1f}%), WR={leak_wr:.1f}%")
            leaks.append(('PUT_BB<10', len(bb_leak), leak_wr))
    
    if not leaks:
        print(f"    - No gate leaks detected")
    
    # Indicator patterns for losses
    print(f"\n  Loss Clustering Patterns:")
    patterns = analyze_indicator_patterns(asset_df, "  ")
    
    return leaks

# Analyze each bottom asset
bottom_leaks = {}
for asset in bottom_assets:
    asset_df = df[df['asset'] == asset].copy()
    bottom_leaks[asset] = analyze_failure_patterns(asset_df, asset)

# ============================================================================
# 4. CROSS-ASSET COMPARISON
# ============================================================================

print("\n" + "="*80)
print("4. CROSS-ASSET COMPARISON: Top vs Bottom Assets")
print("="*80)

print("\nComparing winning conditions across TOP assets:")

# Aggregate patterns across top assets
top_asset_data = df[df['asset'].isin(top_assets) & df['win'] == 1]
bottom_asset_data = df[df['asset'].isin(bottom_assets) & df['win'] == 1]

print(f"\nTop assets (wins): n={len(top_asset_data)}")
print(f"Bottom assets (wins): n={len(bottom_asset_data)}")

for indicator in indicators_to_analyze:
    if indicator not in df.columns:
        continue
    
    top_wins = top_asset_data[indicator].dropna()
    bottom_wins = bottom_asset_data[indicator].dropna()
    
    if len(top_wins) < 10 or len(bottom_wins) < 10:
        continue
    
    top_mean = top_wins.mean()
    bottom_mean = bottom_wins.mean()
    
    # KS test
    ks_stat, ks_pval = stats.ks_2samp(top_wins, bottom_wins)
    
    sig_marker = '***' if ks_pval < 0.001 else '**' if ks_pval < 0.01 else '*' if ks_pval < 0.05 else 'ns'
    
    print(f"  {indicator:12s}: TOP mean={top_mean:6.2f} | BOTTOM mean={bottom_mean:6.2f} | diff={top_mean-bottom_mean:+6.2f} | p={ks_pval:.4f} {sig_marker}")

# Volatility regime comparison
print("\nVolatility Regime Comparison:")

top_bb = top_asset_data['bb_bps'].dropna()
bottom_bb = bottom_asset_data['bb_bps'].dropna()

if len(top_bb) > 0 and len(bottom_bb) > 0:
    print(f"  Top assets (wins): BB mean={top_bb.mean():.2f} bps, med={top_bb.median():.2f} bps")
    print(f"  Bottom assets (wins): BB mean={bottom_bb.mean():.2f} bps, med={bottom_bb.median():.2f} bps")
    
    # Distribution
    top_high_vol = (top_bb >= 30).mean() * 100
    bottom_high_vol = (bottom_bb >= 30).mean() * 100
    
    print(f"  Top assets: {top_high_vol:.1f}% of wins in high vol (BB>=30)")
    print(f"  Bottom assets: {bottom_high_vol:.1f}% of wins in high vol (BB>=30)")

# ============================================================================
# 5. PATTERN SUMMARY
# ============================================================================

print("\n" + "="*80)
print("5. PATTERN SUMMARY & RECOMMENDATIONS")
print("="*80)

print("\n[WIN] WINNING PATTERNS (favor these conditions):")

# Aggregate winning patterns from top assets
winning_conditions = []

for asset in top_assets:
    asset_wins = df[(df['asset'] == asset) & (df['win'] == 1)]
    
    # Check common winning conditions
    if len(asset_wins) > 0:
        stc_mean = asset_wins['stc'].mean()
        rsi_mean = asset_wins['rsi'].mean()
        bb_mean = asset_wins['bb_bps'].mean()
        k_mean = asset_wins['k'].mean()
        
        print(f"\n  {asset}:")
        print(f"    - STC: mean={stc_mean:.1f} (wins favor {'deep oversold' if stc_mean < 15 else 'deep overbought' if stc_mean > 85 else 'moderate'})")
        print(f"    - RSI: mean={rsi_mean:.1f}")
        print(f"    - BB: mean={bb_mean:.1f} bps ({'high volatility' if bb_mean >= 30 else 'moderate volatility' if bb_mean >= 15 else 'low volatility'})")
        print(f"    - K: mean={k_mean:.1f}")

print("\n[AVOID] LOSING PATTERNS (avoid these conditions):")

for asset in bottom_assets:
    asset_losses = df[(df['asset'] == asset) & (df['win'] == 0)]
    
    if len(asset_losses) > 0:
        stc_mean = asset_losses['stc'].mean()
        rsi_mean = asset_losses['rsi'].mean()
        bb_mean = asset_losses['bb_bps'].mean()
        k_mean = asset_losses['k'].mean()
        
        print(f"\n  {asset}:")
        print(f"    - STC: mean={stc_mean:.1f} (losses cluster in {'boundary zone' if 20 < stc_mean < 80 else 'extreme'})")
        print(f"    - RSI: mean={rsi_mean:.1f}")
        print(f"    - BB: mean={bb_mean:.1f} bps ({'high volatility' if bb_mean >= 30 else 'low volatility'})")
        print(f"    - K: mean={k_mean:.1f}")

print("\n[INSIGHTS] KEY INSIGHTS:")

# Overall top vs bottom comparison
top_overall = df[df['asset'].isin(top_assets)]
bottom_overall = df[df['asset'].isin(bottom_assets)]

top_wr = top_overall['win'].mean() * 100
bottom_wr = bottom_overall['win'].mean() * 100

top_bb_mean = top_overall['bb_bps'].mean()
bottom_bb_mean = bottom_overall['bb_bps'].mean()

print(f"  1. Top assets average {top_wr:.1f}% WR vs bottom assets {bottom_wr:.1f}% WR")
print(f"  2. Top assets trade in mean={top_bb_mean:.1f} bps BB vs bottom assets mean={bottom_bb_mean:.1f} bps")
print(f"  3. {'Top assets favor higher volatility' if top_bb_mean > bottom_bb_mean else 'Top assets favor lower volatility'}")

# Check for shared patterns
print(f"\n  Recommended asset filters:")
print(f"    - FAVOR: {', '.join(top_assets[:3])}")
print(f"    - AVOID: {', '.join(bottom_assets[:3])}")

print("\n" + "="*80)
print("ANALYSIS COMPLETE")
print("="*80)


