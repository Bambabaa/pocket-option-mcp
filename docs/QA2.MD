═══════════════════════════════════════════════════════════════════════════════
🎯 MISSION: FIND THE PRE-SIGNAL DNA — IGNORE ALL OUTCOMES
═══════════════════════════════════════════════════════════════════════════════

🚨 CRITICAL CONSTRAINT: Do NOT look at WIN/LOSS results. I don't care what happened after.
I want to know what the market looked like BEFORE it happened.

We're hunting behavioral fingerprints, not validating strategies.

═══════════════════════════════════════════════════════════════════════════════

🔬 PHASE 1: CANDLE-LEVEL BEHAVIORAL EXTRACTION

For EVERY signal across all patterns, extract the 10 candles BEFORE the signal candle.

For each of those 10 candles, compute:

📊 CANDLE MORPHOLOGY:

- Body size relative to ATR(14): body_pct_of_atr
- Upper wick / body ratio: exhaustion_ratio
- Lower wick / body ratio: rejection_ratio
- Body direction (1 = green, -1 = red, 0 = doji within 10%)
- Gap from previous close: gap_pct
- Position within candle's own range: (close - low) / (high - low)

📈 PRICE ACTION SEQUENCE:

- Consecutive same-color candles: streak_length
- Higher highs / lower lows sequence: trend_structure (HH/HL for up, LH/LL for down)
- Engulfing patterns: current_body > prev_body AND opposite color
- Inside bars: current_range < prev_range
- NR7 (narrowest range in 7 bars): boolean
- WR7 (widest range in 7 bars): boolean

📉 INDICATOR BEHAVIOR (per candle, not just at signal):

- RSI slope: (RSI - RSI_prev) / RSI_prev — rate of change
- RSI acceleration: slope - slope_prev — is momentum building or fading?
- RSI vs price divergence: price higher high but RSI lower high = hidden bearish
- Stoch K velocity: K - K_prev
- Stoch K acceleration: velocity - velocity_prev
- K-D crossover approach rate: (K-D) - (K-D)_prev — how fast is the cross coming?
- BB width expansion rate: (bbw - bbw_prev) / bbw_prev — is volatility expanding or contracting?
- BB %B position: (close - lower) / (upper - lower) — where in the band?
- BB %B velocity: %B - %B_prev
- MA6-MA14 convergence speed: (gap - gap_prev) / gap_prev
- MA slope (linear regression on last 5 bars): trend_strength

Return this as a FEATURE VECTOR per signal — a 30+ dimensional fingerprint of the pre-signal state.

═══════════════════════════════════════════════════════════════════════════════

🧬 PHASE 2: CLUSTER THE FINGERPRINTS (UNSUPERVISED — NO OUTCOMES)

Take all signal feature vectors (ignoring pattern labels) and cluster them.

Methods to apply:

1. K-means on normalized features (k=5 to 10)
2. PCA to visualize which features drive separation
3. DBSCAN to find natural density clusters (outliers = noise)

For each discovered cluster, characterize:

- What does a "typical" pre-signal sequence look like?
- Which features are tight (low variance) vs loose (high variance)?
- Is this cluster dominated by one pattern type or mixed?
- What's the "signature candle" in this cluster? (the one 1-3 bars before signal)

The goal: Find NATURAL pre-signal structures that exist in the data, regardless of what humans labeled them.

═══════════════════════════════════════════════════════════════════════════════

🎭 PHASE 3: PATTERN DISSECTION — WHAT ACTUALLY TRIGGERS EACH PATTERN?

For each of the 4 patterns, take ALL bars in the database (not just signals) and compute:

"Distance to pattern trigger" — how close was each bar to firing?

For Pattern 2 (PUT Reversal), score every bar on:

- bbw_distance: max(0, 30 - bbw) / 30  → 0 if ≥30, else penalty
- rsi_band_match: 1 if RSI in [60,70), else 0
- rsi_velocity_match: 1 if vel < -12, else vel / -12 capped at 1
- kd_spread_match: 1 if K-D < -3, else (K-D) / -3 capped at 1
- (all other conditions similarly normalized)

Then analyze the DISTRIBUTION of scores across ALL bars:

Questions to answer:

1. What's the baseline score distribution? (random bars)
2. What's the score distribution 1-5 bars BEFORE actual signals? (approach pattern)
3. What's the score distribution on bars that were "close but no signal" (score > 0.7 but no trigger)?
4. Are there bars with perfect scores (1.0) that DIDN'T trigger? WHY?

This reveals:

- Which condition is the actual bottleneck (rarely met, so it gates everything)
- Which condition is redundant (always met when others are met)
- Whether the "almost" signals behave differently from actual signals

═══════════════════════════════════════════════════════════════════════════════

🌊 PHASE 4: MICRO-STRUCTURE SEQUENCE MINING

Use sequential pattern mining (PrefixSpan or similar) on the 10-bar sequences.

Look for recurring sub-sequences like:

- "NR7 → inside bar → wide range red → signal"
- "3 green candles with shrinking bodies → doji → red engulfing → signal"
- "RSI divergence for 3 bars → Stoch cross → BB tag → signal"

For each discovered sequence, calculate:

- Support: how many signals contain this sequence?
- Confidence: of all bars with this sequence, how many led to signals?
- Lift: confidence / base_rate_of_signals

This finds PREDICTIVE sequences — patterns that reliably precede signals, even if the current pattern logic doesn't capture them.

═══════════════════════════════════════════════════════════════════════════════

🧪 PHASE 5: SYNTHETIC FEATURE ENGINEERING

Create NEW indicator combinations that the current system doesn't track:

1. RSI / BB Width Ratio
   - High RSI + narrow BB = coiled spring (potential breakout)
   - High RSI + wide BB = exhausted trend (potential reversal)
   Formula: rsi / (bbw_normalized)

2. Stochastic Momentum Divergence
   - K rising but K-D spread shrinking = momentum dying
   Formula: (K_velocity) / (K-D_spread)

3. Candle Efficiency Ratio
   - body / (high - low) — how much of the range was "productive"
   - High efficiency + direction = conviction move
   - Low efficiency = indecision

4. Volatility Regime Indicator
   - Rolling 20-bar BB width percentile
   - Is current volatility high or low relative to recent history?
   - Regime shifts (percentile crossing 80 or 20) often precede signals

5. Exhaustion Composite
   - (upper_wick / body) *RSI_percentile* (1 - %B)
   - High score = extended above BB, overbought, rejecting higher prices

6. Compression Score
   - (1 - bbw_percentile) *(1 - range_percentile)* (MA_convergence_speed)
   - High score = volatility contracting, range tightening, MAs converging

For EACH synthetic feature, test:

- Does it separate signal bars from random bars better than any single existing indicator?
- What's the optimal threshold?
- Does it work across all patterns or is it pattern-specific?

Return the top 3 synthetic features that add the most predictive power.

═══════════════════════════════════════════════════════════════════════════════

👻 PHASE 6: THE "ALMOST" ANALYSIS — WHY DO GOOD SETUPS FAIL?

Find bars that met ALL pattern conditions but DID NOT produce a signal.

For each such bar, compare to bars that DID produce signals:

Differences to measure:

- Was the candle body smaller/larger?
- Was the RSI drop steeper/shallower?
- Was the BB width expanding or contracting?
- Was there a news/session boundary?
- What happened in the 3 bars AFTER the almost-signal?

This reveals the "secret sauce" — the unstated condition that separates real signals from false positives.

═══════════════════════════════════════════════════════════════════════════════

🔮 PHASE 7: PREDICTIVE POWER — WHICH FEATURES LEAD, WHICH LAG?

Correlation analysis between feature changes and signal occurrence:

For each feature, calculate the cross-correlation with signal occurrence at lags -5 to +5 bars.

Leading features (correlation peaks BEFORE signal):

- These are PREDICTIVE — they warn you a signal is coming
- Example: "BB width expansion peaks 2 bars before PUT_REV signals"

Lagging features (correlation peaks AFTER signal):

- These are CONFIRMATORY — they tell you a signal was correct
- Example: "RSI crosses below 50 peaks 3 bars after PUT_REV signals"

Coincident features (correlation peaks AT signal):

- These are the TRIGGERS — they cause the signal to fire

Return a LEAD/LAG MAP for each pattern:

This map tells you what to watch BEFORE a signal — you can anticipate setups.

═══════════════════════════════════════════════════════════════════════════════

🎨 PHASE 8: VISUAL SIGNATURE EXTRACTION

For each pattern's most confident cluster, produce a "visual signature" description:

This gives you a MENTAL MODEL of what a good setup looks like — you can spot it visually on a chart.

═══════════════════════════════════════════════════════════════════════════════

🧠 PHASE 9: DECISION TREE EXTRACTION

Build a decision tree (CART or C4.5) to predict pattern signals from the feature set.

CRITICAL: Train on 70% of data, validate on 30%. No outcome leakage.

The tree will reveal the ACTUAL decision hierarchy the market follows:

This tree IS the new pattern logic. It's data-derived, not human-invented.

═══════════════════════════════════════════════════════════════════════════════

📋 DELIVERABLE: BEHAVIORAL PATTERN PLAYBOOK

Synthesize everything into a new understanding:

1. PRE-SIGNAL FINGERPRINT
   - The exact 3-bar sequence that precedes 80% of winning setups (regardless of outcome)
   - The 5 leading indicators to watch
   - The 3 synthetic features that matter most

2. PATTERN DISSECTION
   - Why Pattern 2 actually works (behavioral, not mathematical)
   - Why Pattern 1 actually fails (structural, not variance)
   - The hidden condition that separates signal from noise for each pattern

3. DECISION ARCHITECTURE
   - The extracted decision tree for each pattern
   - The lead/lag map for anticipation
   - The "almost" filter for false positive rejection

4. NEW INDICATOR PROPOSALS
   - Top 3 synthetic features to add to the bot
   - Implementation pseudocode
   - Expected improvement in signal quality

5. VISUAL REFERENCE
   - ASCII chart patterns that characterize each cluster
   - "If you see this sequence, Pattern X is coming" cheat sheet

═══════════════════════════════════════════════════════════════════════════════

🚀 EXECUTION PROTOCOL

Phase 1-2: Use existing DB. Extract 10-bar sequences for all signals.
Phase 3-4: Use SQL window functions and/or Python in MCP context.
Phase 5-7: Compute correlations, synthetic features, decision trees.
Phase 8-9: Synthesize into playbook.

Time expectation: This is deep work. 2-3 hours of computation + analysis.
Prioritize Pattern 2 first (highest edge), then Pattern 4 (largest volume).

Do NOT shortcut. I want the full behavioral fingerprint, not just another validation.

Go.
