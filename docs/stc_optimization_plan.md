# STC Indicator Optimization Plan

Based on the performance data extracted from `edgefinder_ALL.csv` (specifically comparing high-performing assets like `USDPKR_otc` against failing assets like `EURRUB_otc`), we have identified a critical flaw in the standard STC (Schaff Trend Cycle) trigger logic. 

The standard trigger (`STC < 25` for CALL, `STC > 85` for PUT) is vulnerable to "Death Grinds"—situations where a strong trend pins the STC flat against the extreme (0 or 100), and microscopic twitches generate false "hook" signals.

To eliminate these false signals and improve the 2-minute expiry win rate across all assets, we will implement the following advanced STC analytical filters.

---

## 1. Velocity Analysis (The "Delta" Requirement)

**The Concept:** Measure the *speed* and *violence* of the reversal rather than just the direction. 
**The Rationale:** A hook from `1.0` to `2.5` is weak (Delta of 1.5) and usually indicates a false pause. A hook from `1.0` to `15.0` (Delta of 14) is a decisive shift in momentum.
**Implementation Logic:**
* Calculate: `Delta = Current_STC - Previous_STC`
* **CALL Requirement:** `Current_STC > Previous_STC` AND `Delta >= 10.0`
* **PUT Requirement:** `Current_STC < Previous_STC` AND `|Delta| >= 10.0`

## 2. The "Goldilocks" Trigger Zone

**The Concept:** Force the indicator to prove it has actually left the absolute extreme baseline before triggering.
**The Rationale:** In our analysis, winning assets like USDPKR triggered at an average STC of `14.2` (Calls) and `92.5` (Puts). Losing assets like EURRUB triggered at `6.4` (Calls) and `98.0` (Puts). 
**Implementation Logic:**
Replace the standard `< 25` / `> 85` bounds with a strict floor/ceiling range.
* **CALL Trigger Zone:** `STC >= 10` AND `STC <= 30`
* **PUT Trigger Zone:** `STC <= 90` AND `STC >= 70`

## 3. "Pin Time" (Duration at Extremes)

**The Concept:** Track how many consecutive candles the STC has been completely flatlined before the hook occurred.
**The Rationale:** The longer an asset's STC stays at `0.00` or `100.00`, the stronger the underlying trend is. True V-shaped reversals usually only touch the extreme for 1 or 2 candles. If it is pinned for 5 candles, any subsequent hook is highly likely to be a "Dead Cat Bounce" (a 1-minute false reversal).
**Implementation Logic:**
* Count consecutive candles where `STC < 5` (for downtrends) or `STC > 95` (for uptrends).
* **Requirement:** `Pin_Time <= 3`. If the STC was pinned for 4 or more candles, invalidate the setup and wait for the cycle to fully reset.

## 4. Underlying MACD Alignment

**The Concept:** Cross-reference the STC hook with its own underlying mathematical components.
**The Rationale:** Because STC is a smoothed Stochastic of a MACD, it can sometimes produce a directional hook even while the underlying MACD momentum is still expanding in the wrong direction.
**Implementation Logic:**
* Utilize the `stc_macd` data column.
* **CALL Requirement:** MACD histogram must be shrinking upward (Current MACD > Previous MACD) simultaneously with the STC hook.
* **PUT Requirement:** MACD histogram must be shrinking downward (Current MACD < Previous MACD) simultaneously with the STC hook.

---

### Execution Strategy

When we move to implementation, we should layer these filters progressively:
1. **Phase 1:** Implement **Velocity (Delta)** and the **Goldilocks Zone**. These are mathematically simple, require zero extra lookback arrays, and directly address the data discrepancies we found.
2. **Phase 2:** If false signals persist on heavy trending pairs, implement the **Pin Time** array tracker to explicitly filter out "Death Grinds."
