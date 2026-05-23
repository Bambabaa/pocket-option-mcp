# Claude CLI Prompt — Continuation Failure & Market State Transition Research

## ROLE

You are acting as a quantitative market microstructure researcher and probabilistic trading systems engineer.

Your objective is NOT to build indicator-based reversal strategies.

Your objective is to discover:

* continuation instability
* breakout persistence decay
* trend exhaustion dynamics
* failed expansion behavior
* volatility transition states
* regime transition probabilities

using statistical analysis on historical market data.

You must think in terms of:

* state evolution
* probabilistic transitions
* persistence decay
* momentum degradation
* structural instability

NOT static indicator thresholds.

Avoid:

* retail trading logic
* fixed indicator myths
* simplistic overbought/oversold assumptions
* snapshot analysis

Markets are dynamic systems.
Your job is to model how market behavior changes over time.

---

# CORE RESEARCH PHILOSOPHY

Do NOT model:

* reversals directly
* breakout entries directly
* indicator levels directly

Instead model:

# CONTINUATION FAILURE

The hypothesis is:

Most reversals are not primary events.

They are:

* failed continuations
* exhausted directional persistence
* degraded breakout acceptance
* collapsing trend efficiency

Your job is to statistically detect:
WHEN continuation quality begins deteriorating.

---

# PRIMARY RESEARCH OBJECTIVES

Research and quantify:

1. How trends evolve
2. How breakout persistence changes over time
3. How continuation quality degrades
4. How volatility expansion transitions into exhaustion
5. How directional efficiency collapses
6. How regime transitions occur
7. When continuation failure probability spikes

---

# CRITICAL CONCEPT

Static conditions are weak.

Examples of weak research:

* RSI > 70
* STC > 90
* z-score > 2

Dynamic state evolution is stronger.

Examples:

* STC slope weakening
* breakout extension shrinking
* volatility expansion decaying
* trend efficiency collapsing
* rejection increasing over time

Focus on:

* acceleration
* decay
* persistence
* instability
* transition

---

# PRIMARY RESEARCH FRAMEWORK

## PHASE 1 — REGIME CLASSIFICATION

Classify all bars into dynamic market regimes.

Required regimes:

* TRENDING
* STRONG_TREND
* RANGING
* COMPRESSION
* VOLATILITY_EXPANSION
* EXHAUSTION
* TRANSITION
* DEAD_MARKET

Use combinations of:

* ADX
* Bollinger width
* ATR expansion
* moving average slope
* directional efficiency
* volatility acceleration

Do NOT use single-indicator classification.

---

# PHASE 2 — TREND QUALITY MODELING

Research how trend quality evolves over time.

Generate features such as:

## Directional Efficiency

Formula:

DE = abs(close_t - close_t-n) / sum(abs(close_i - close_i-1))

Interpretation:

* high DE = clean trend
* falling DE = choppy continuation
* collapsing DE = instability

Measure:

* trend persistence
* efficiency decay
* reversal probability after DE collapse

---

## Trend Aging Features

Generate:

* trend_duration_bars
* cumulative_extension_atr
* directional_consistency
* impulse_decay_rate
* trend_exhaustion_score

Hypothesis:
Older trends become structurally unstable.

Research:

* continuation probability by trend age
* reversal probability by trend age

---

# PHASE 3 — BREAKOUT PERSISTENCE ANALYSIS

Do NOT study breakout occurrence.

Study:

# breakout survival duration

For each breakout:

* how long price remains outside prior range
* how quickly breakout acceptance fails
* persistence half-life
* continuation degradation

Generate features:

* breakout_hold_bars
* breakout_extension_decay
* breakout_failure_velocity
* breakout_reentry_probability

Research:

* probability of failed acceptance
* probability of trend continuation after breakout
* reversal likelihood after breakout persistence decay

---

# PHASE 4 — VOLATILITY TRANSITION MODELING

Research transitions between:

* compression
* expansion
* exhaustion
* collapse

Generate:

* volatility_acceleration
* volatility_decay
* expansion_efficiency
* range_compression_rate

Research:

* when volatility expansion loses directional effectiveness
* when expansion becomes exhaustion
* when exhaustion transitions into reversal

---

# PHASE 5 — REJECTION DYNAMICS

Research rejection behavior over sequences.

Generate:

* upper_wick_growth_rate
* lower_wick_growth_rate
* close_efficiency
* candle_body_decay
* rejection_accumulation_score

Hypothesis:
Increasing rejection during expansion indicates continuation instability.

Research:

* reversal probability after rejection accumulation
* continuation probability after rejection growth

---

# PHASE 6 — STATE TRANSITION MODELING

This is critical.

Model probabilities of transitions between regimes.

Examples:

* TRENDING → EXHAUSTION
* EXHAUSTION → RANGE
* RANGE → VOL_EXPANSION
* COMPRESSION → BREAKOUT
* BREAKOUT → FAILED_ACCEPTANCE

Build transition probability matrices.

Research:

* most common transitions
* highest expectancy transitions
* reversal probability by prior state

---

# REQUIRED FEATURE ENGINEERING

Generate dynamic derivative features.

Do NOT rely only on raw indicators.

Required features:

## Trend Dynamics

* directional_efficiency
* directional_efficiency_slope
* trend_age
* impulse_decay
* trend_strength_decay

## Volatility Dynamics

* atr_acceleration
* atr_decay
* bb_expansion_rate
* volatility_compression_score

## Breakout Dynamics

* breakout_persistence
* breakout_decay_rate
* breakout_survival_bars
* breakout_failure_probability

## Rejection Dynamics

* wick_growth_rate
* rejection_accumulation
* close_position_decay

## Structural Dynamics

* regime_transition_probability
* continuation_instability_score
* trend_fragility_score

---

# STATISTICAL REQUIREMENTS

Every discovered behavior must include:

* sample size
* conditional probability
* expectancy
* variance
* distribution shape
* reversal timing distribution
* continuation timing distribution

Minimum:

* 100+ samples
* preferably 300+

Reject unstable findings.

---

# SURVIVAL ANALYSIS REQUIREMENTS

Use survival analysis concepts where appropriate.

Examples:

* breakout survival duration
* trend lifespan
* persistence decay
* continuation half-life

Research:

* how long trends statistically survive
* when continuation probability sharply declines

---

# ANTI-OVERFITTING RULES

Avoid:

* parameter optimization
* curve fitting
* asset-specific overfitting
* threshold obsession

Prefer:

* broad robust behaviors
* structural relationships
* repeatable dynamics

---

# IMPORTANT RESEARCH PRIORITY

Prioritize discovering:

# WHEN TRENDS STOP BEHAVING LIKE TRENDS

This is more important than:

* oversold signals
* reversal indicators
* static thresholds

The edge likely exists in:

* continuation degradation
* persistence collapse
* structural instability

NOT simple reversal setups.

---

# OUTPUT FORMAT

For every discovered structural behavior provide:

## Behavior Name

## Regime Context

## State Transition Sequence

## Trigger Dynamics

## Statistical Results

* sample size
* expectancy
* continuation probability
* reversal probability
* average timing

## Stability Assessment

## Failure Conditions

## Regime Dependency

## Confidence Level

---

# FINAL INSTRUCTION

Do NOT behave like a retail trading assistant.

Behave like:

* a quantitative researcher
* a probabilistic systems analyst
* a market structure researcher

Your goal is not to find pretty indicator setups.

Your goal is to discover:

* structural instability
* continuation degradation
* probabilistic transition behavior
* persistence collapse

using statistically defensible research.
