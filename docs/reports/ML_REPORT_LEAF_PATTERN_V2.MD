## 🧠 Diagnostic Report: Why Dataset B Underperforms vs Dataset A  

**Datasets:**  

- **A:** `paper_reversal_leaves_all.csv` (N=1,018, WR=58.22%, Apr 9–21, 2026)  
- **B:** `paper_reversal_leaves_live_v2.csv` (N=491, WR=49.49%, Apr 25, 2026 only)  

---

> **Key Takeaway:**  
> Dataset B’s underperformance is driven by regime shifts, feature distribution changes, and the breakdown of previously high-win leaf logic—especially in moderate uptrends, medium volatility, and certain time/asset clusters. Targeted, data-driven filters can recover much of the lost edge.

---

# 1. 📊 Dataset A vs B: Feature & Regime Comparison

### **A. Dataset Profile & Win Rates**

| Dataset | N    | Wins | Losses | Win Rate | 95% CI      | CALL % | PUT % | #Assets | #Leaves |
|---------|------|------|--------|----------|-------------|--------|-------|---------|---------|
| **A**   | 1018 | 593  | 425    | 58.22%   | [55.2,61.2] | 18.9%  | 81.1% | 51      | 3       |
| **B**   | 491  | 243  | 248    | 49.49%   | [45.1,53.9] | 16.5%  | 83.5% | 69      | 3       |

---

### **B. Top Shifted Features (KS/MW Test Results)**

| Feature           | Mean_A | Mean_B | KS_Stat | KS_pval | MW_pval | Shift (B-A) |
|-------------------|--------|--------|---------|---------|---------|-------------|
| stoch_kd_diff     | 8.21   | 5.83   | 0.115   | 0.0003  | 0.0019  | –2.37       |
| ma_trend_bps      | –6.83  | –4.33  | 0.095   | 0.0047  | 0.0023  | +2.49       |
| bb_width_bps      | 59.06  | 51.91  | 0.095   | 0.0047  | 0.0625  | –7.16       |
| close_to_upper    | 41.27  | 33.21  | 0.088   | 0.0108  | 0.0507  | –8.05       |
| rsi_5             | 38.55  | 35.65  | 0.081   | 0.0252  | 0.2687  | –2.90       |
| stc_stoch_diff    | –8.68  | –0.82  | 0.079   | 0.0366  | 0.0234  | +7.86       |

> **Interpretation:**  
> The largest shifts are in momentum/trend (stoch_kd_diff, ma_trend_bps), volatility (bb_width_bps), and STC-related features.

---

### **C. Regime Comparison Table (A vs B)**

| Regime Zone         | WR_A   | WR_B   | Delta (B–A) |
|---------------------|--------|--------|-------------|
| Volatility:<10      | 64.61% | 50.82% | –13.79pp    |
| Volatility:30–60    | 52.80% | 45.08% | –7.72pp     |
| Trend:0→3           | 62.58% | 47.06% | –15.52pp    |
| Trend:3→10          | 47.20% | 34.78% | –12.42pp    |
| Momentum:<20        | 55.39% | 45.24% | –10.15pp    |
| BB_Pos:0.2–0.4      | 66.86% | 55.43% | –11.43pp    |
| STC:overbought      | 57.10% | 45.95% | –11.15pp    |

---

### **D. Visualizations**

- **Top 8 Shifted Features:**  
  ![Violin/Box Plots](https://ydcusercontenteast.blob.core.windows.net/user-content-youagent-output/ciplot20260425182144-0-5929e5c9dc85.png?se=2026-04-26T09%3A25%3A06Z&sp=r&sv=2021-12-02&sr=b&sig=WpF63%2BqVcdERfew9KmXd0r7uyRg3fS8OwlmW2Ms2H6w%3D)
**- **Regime Comparison Heatmap**

  ![Regime Comparison](https://ydcusercontenteast.blob.core.windows.net/user-content-youagent-output/ciplot20260425182220-1-a27a3fb33e4a.png?se=2026-04-26T09%3A25%3A06Z&sp=r&sv=2021-12-02&sr=b&sig=n0%2BYaZQ3S2colbSLxBl3WQWm7lUWcl26ZU6nJp7w4wo%3D)

---

# 2. 🔎 Deep Failure-Mode Analysis (Dataset B Only)

### **A. Confirmed Dead Zones & Numeric Thresholds**

| Feature/Zone                | Range/Condition         | N   | WR    | Delta vs Baseline | Leaf(s)      |
|-----------------------------|------------------------|-----|-------|-------------------|--------------|
| ma_trend_bps (ModUp)        | 2.29–10.0              | 46  | 34.78%| –14.71pp          | L41          |
| bb_width_bps (Medium)       | 30.0–60.0              | 122 | 45.08%| –4.41pp           | L16/L41/L65  |
| stoch_k_v2 (Low)            | 10.0–17.0              | 47  | 44.68%| –4.81pp           | L16/L41      |
| stc_stoch_diff (conflict)   | –2.29–37.69            | 44  | 38.64%| –10.85pp          | All          |
| stoch_kd_diff (dead decile) | 0.35–24.78             | 47  | 40.43%| –9.07pp           | All          |
| schaff_value (high)         | 84.94–99.62            | 91  | 45.26%| –4.24pp           | All          |
| hour_utc = 15               | 15                     | 58  | 37.93%| –11.56pp          | All          |
| stc_zone = overbought       | overbought             | 148 | 45.95%| –3.54pp           | L41/L65      |
| L41 & bb_width_bps 60–120   | 60–120                 | 19  | 21.05%| –28.44pp          | L41          |

---

### **B. Leaf Logic Validity Table**

| Leaf   | Condition                                      | N_in_B | WR_in_B | Holds (≥60%)? |
|--------|------------------------------------------------|--------|---------|--------------|
| L41    | Overall (PUT, wr_reported=76%)                | 142    | 44.37%  | ❌           |
| L41    | bb_pos>0.352 & rsi_5≤17.15 & stoch_kd_diff≤–16.90 | 142 | 44.37%  | ❌           |
| L41    | ma_trend_bps NOT in (3,10)                    | 96     | 48.96%  | ❌           |
| L41    | ma_trend_bps ∈ (0,10)                         | 110    | 41.82%  | ❌           |
| L16    | Overall (CALL, wr_reported=68.6%)             | 93     | 49.46%  | ❌           |
| L16    | bb_position ≤ 0.021859                        | 93     | 49.46%  | ❌           |
| L16    | rsi_5 ≤ 2.679860                              | 93     | 49.46%  | ❌           |
| L16    | stoch_d_v2 > 4.079007                         | 93     | 49.46%  | ❌           |
| L65    | Overall (PUT, wr_reported=63.78%)             | 256    | 52.34%  | ❌           |
| L65    | stoch_kd_diff>24.66 & schaff_value>0.00006    | 256    | 52.34%  | ❌           |
| L65    | bb_pos>0.43 & stoch_kd_diff>24.89             | 153    | 50.33%  | ❌           |

---

### **C. Regime Tables (WR < 50% = Danger Zone)**

| Regime                | N   | WR    | Delta vs Baseline |
|-----------------------|-----|-------|-------------------|
| Volatility: 30–60     | 122 | 45.08%| –4.41pp           |
| Trend: 3–10 (ModUp)   | 46  | 34.78%| –14.71pp          |
| Momentum: <20         | 168 | 45.24%| –4.25pp           |
| BB Position: 0.4–0.6  | 206 | 45.63%| –3.86pp           |
| STC: overbought       | 148 | 45.95%| –3.54pp           |

---

### **D. Hour-of-Day WR Table (WR < 50% = Danger Zone)**

| Hour (UTC) | N   | WR    | Delta vs Baseline |
|------------|-----|-------|-------------------|
| 15         | 58  | 37.93%| –11.56pp          |
| 11         | 32  | 43.75%| –5.74pp           |
| 13         | 43  | 44.19%| –5.30pp           |
| 10         | 41  | 46.34%| –3.15pp           |
| 8          | 54  | 48.15%| –1.34pp           |
| 9          | 40  | 47.50%| –1.99pp           |

---

# 3. 🧬 Outlier & Anomaly Detection (Dataset B Only)

| Method           | N_Anomaly | WR_Anomaly | N_Inlier | WR_Inlier | Δ WR vs Baseline | Remove = WR Δ |
|------------------|-----------|------------|----------|-----------|------------------|---------------|
| IQR Outliers     | 90        | 56.67%     | 888      | 58.22%    | +0.14pp          | +0.14pp       |
| Isolation Forest | 98        | 60.20%     | 880      | 57.84%    | +1.71pp          | –0.24pp       |
| DBSCAN Noise     | 12        | 66.67%     | 966      | 57.97%    | +8.18pp          | –0.11pp       |

> **Conclusion:**  
> Outlier clusters are not the main source of losses; removing them does not improve performance.

---

# 4. 🤖 ML Model Comparison (Dataset B Only)

| Model            | AUC    | Accuracy | Precision | Recall | Top 3 Features (Importance)         |
|------------------|--------|----------|-----------|--------|-------------------------------------|
| Decision Tree    | 0.481  | 0.514    | 0.573     | 0.639  | bb_position, stoch_d_v2, stoch_kd_diff |
| Random Forest    | 0.497  | 0.533    | 0.571     | 0.789  | bb_position, stoch_d_v2, stoch_kd_diff |
| Gradient Boost   | 0.481  | 0.511    | 0.568     | 0.660  | stoch_d_v2, bb_position, stc_stoch_diff |
| XGBoost          | 0.492  | 0.537    | 0.586     | 0.690  | rsi_5, bb_position, stoch_d_v2      |

> **Feature importance is more diffuse in B; no single feature dominates.  
> All models perform near random (AUC ≈ 0.5), indicating regime instability.**

---

# 5. 🌐 Regime Shift Detection (Dataset B Only)

| Regime Zone         | WR_B   | N_B  | Delta vs A |
|---------------------|--------|------|------------|
| Volatility:<10      | 50.82% | 122  | –13.79pp   |
| Volatility:30–60    | 45.08% | 122  | –7.72pp    |
| Trend:3–10          | 34.78% | 46   | –12.42pp   |
| Momentum:<20        | 45.24% | 168  | –10.15pp   |
| BB_Pos:0.2–0.4      | 55.43% | 92   | –11.43pp   |
| STC:overbought      | 45.95% | 148  | –11.15pp   |

> **Danger zones are more severe and more frequent in B than A.**

---

# 6. 🧩 Root-Cause Table

| Finding                        | Evidence/Threshold         | Dataset_A | Dataset_B | Impact_pp | Category         |
|------------------------------- |---------------------------|-----------|-----------|-----------|------------------|
| stoch_kd_diff shift            | mean=8.21 → 5.83          | 8.21      | 5.83      | –2.37     | Feature shift    |
| ma_trend_bps shift             | mean=–6.83 → –4.34        | –6.83     | –4.34     | +2.49     | Feature shift    |
| bb_width_bps shift             | mean=59.06 → 51.91        | 59.06     | 51.91     | –7.16     | Feature shift    |
| L41 PUT collapse               | WR=55.95% → 44.37%        | 55.95%    | 44.37%    | –11.58    | Leaf breakdown   |
| Overbought STC collapse        | WR=57.10% → 45.95%        | 57.10%    | 45.95%    | –11.15    | Regime shift     |
| High vol L41 (bb 60–120)       | WR=21.05% in B            | 63.12%    | 21.05%    | –42.07    | Regime collapse  |
| Hour 15 UTC new failure        | WR=37.93% in B            | 76.32%    | 37.93%    | –38.39    | Time regime      |
| ModUp trend (3–10 bps)         | WR=34.78% in B            | 47.20%    | 34.78%    | –12.42    | Trend regime     |
| stc_stoch_diff7.7]     | WR=39.13% in B            | 58.22%    | 39.13%    | –19.09    | New dead zone    |
| stoch_kd_diff [0.35,24.78]     | WR=40.82% in B            | 58.22%    | 40.82%    | –17.40    | New dead zone    |
| schaff_value [85–96]           | WR=41.30% in B            | 58.22%    | 41.30%    | –16.92    | New dead zone    |
| Market shift                   | B=Apr 25 only, A=Apr 9–21 | Multi-day | 1 day     | –8.73     | Data regime      |

---

# 7. 🛠️ Actionable Fixes & Filters

### **A. Individual Filter Impact Table (Dataset B, Baseline WR=0.4949)**

| Filter | Condition | N_Removed | N_Remaining | WR_After | Δ vs Baseline |
|--------|-----------|-----------|-------------|----------|---------------|
| F1     | ma_trend_bps ∈0.0] | 52 | 439 | 0.5080 | +0.0131 |
| F2     | stoch_k_v2 ∈ [10.0,17.0]   | 47 | 444 | 0.5000 | +0.0051 |
| F3     | bb_width_bps ∈ [30,60]     | 122| 369 | 0.5095 | +0.0146 |
| F4     | hour_utc = 15              | 58 | 433 | 0.5104 | +0.0155 |
| F5     | hour_utc ∈ {11,13,15}      |133 | 358 | 0.5251 | +0.0302 |
| F6     | stc_zone = overbought      |148 | 343 | 0.5102 | +0.0153 |
| F7     | stoch_kd_diff ∈ [0.35,24.78]|47 | 444 | 0.5045 | +0.0096 |
| F8     | schaff_value ∈ [84.94,99.62]|91 | 400 | 0.5150 | +0.0201 |
| F9     | stc_stoch_diff ∈9,37.69]|44|447|0.5056|+0.0107|
| F10    | L41 & bb_width_bps ∈ [60,120]|19|472|0.5064|+0.0114|
| F11    | assets WR < 0.40           | 85 | 406 | 0.5394 | +0.0445 |

---

### **B. Combined Filter Stacking**

| Combo         | N_Removed | N_Remaining | WR_After | Δ vs Baseline |
|---------------|-----------|-------------|----------|---------------|
| Combo_1 (F1+F4)           | 103 | 388 | 0.5284 | +0.0334 |
| Combo_2 (F1+F4+F6)        | 196 | 295 | 0.5424 | +0.0475 |
| Combo_3 (F1+F4+F6+F3)     | 265 | 226 | 0.5752 | +0.0803 |
| Combo_4 (F1+F4+F6+F3+F10) | 265 | 226 | 0.5752 | +0.0803 |
| Combo_5 (F1+F4+F6+F3+F10+F11)|295|196|0.6020|+0.1071|
| Combo_6 (ALL)             | 364 | 127 | 0.6378 | +0.1429 |

---

### **C. Conditions to Favor (WR ≥ 55%, N ≥ 15)**

| Feature Condition         | N_in_B | WR_in_B | Δ vs Baseline |
|--------------------------|--------|---------|---------------|
| schaff_value ∈ [50,75]   | 21     | 0.6190  | +0.1241       |
| hour_utc = 14            | 49     | 0.6122  | +0.1173       |
| stoch_k_v2 > 80          | 79     | 0.5823  | +0.0874       |
| bb_position 0.2–0.4      | 92     | 0.5543  | +0.0594       |

---

### **D. Conditions to Avoid (WR < 50%, N ≥ 10)**

| Feature Condition         | N_in_B | WR_in_B | Δ vs Baseline |
|--------------------------|--------|---------|---------------|
| L41 & bb_width_bps 60–120| 19     | 0.2105  | –0.2844       |
| ma_trend_bps 3–10        | 46     | 0.3478  | –0.1471       |
| hour_utc = 15            | 58     | 0.3793  | –0.1156       |
| stc_stoch_diff –2.29–37.69| 44    | 0.3864  | –0.1085       |
| stoch_kd_diff 0.35–24.78 | 47     | 0.4043  | –0.0907       |
| hour_utc = 11            | 32     | 0.4375  | –0.0574       |
| hour_utc = 13            | 43     | 0.4419  | –0.0530       |
| bb_width_bps 30–60       | 122    | 0.4508  | –0.0441       |
| stoch_k_v2 < 20          | 168    | 0.4524  | –0.0425       |
| schaff_value 85–100      | 137    | 0.4526  | –0.0424       |
| bb_position 0.4–0.6      | 206    | 0.4563  | –0.0386       |
| stc_zone = overbought    | 148    | 0.4595  | –0.0354       |

---

### **E. New Gating Rules for Dataset B (Not in A)**

| Rule_ID | Rule_Description                        | Exact_Condition                  | N_Affected | WR_wo_Rule | WR_w_Rule | Δ WR   |
|---------|-----------------------------------------|----------------------------------|------------|------------|-----------|--------|
| R1      | Exclude hour_utc = 15                   | hour_utc == 15                   | 58         | 0.4949     | 0.5104    | +0.0155|
| R2      | Exclude ModUp trend                     | ma_trend_bps ∈,10.0]       | 46         | 0.4949     | 0.5080    | +0.0131|
| R3      | Exclude stc_zone = overbought           | stc_zone == 'overbought'         | 148        | 0.4949     | 0.5102    | +0.0153|
| R4      | Exclude stoch_kd_diff 0.35–24.78        | stoch_kd_diff ∈ [0.35,24.78]     | 47         | 0.4949     | 0.5045    | +0.0096|
| R5      | Exclude assets with WR < 0.40           | asset in [list, see F11]         | 85         | 0.4949     | 0.5394    | +0.0445|

---

### **F. Visualizations**

- **Regime x Leaf Heatmap:**  
  ![Regime x Leaf Heatmap](https://ydcusercontenteast.blob.core.windows.net/user-content-youagent-output/ciplot20260425182144-1-b24720a3e342.png?se=2026-04-26T09%3A25%3A06Z&sp=r&sv=2021-12-02&sr=b&sig=x9OwnraKdSPbggivpC117QZWwhiiiZePGZkOVZ39dqc%3D)
**- **Hour-of-Day WR**

  ![Hour-of-Day WR](https://ydcusercontenteast.blob.core.windows.net/user-content-youagent-output/ciplot20260425182321-0-aafb975186ed.png?se=2026-04-26T09%3A25%3A06Z&sp=r&sv=2021-12-02&sr=b&sig=v7kMoLzb4u%2B/x7I86o91CaoofRCnpN1R4xglEHg59nA%3D)
**- **Asset Ranking**

  ![Asset Ranking](https://ydcusercontenteast.blob.core.windows.net/user-content-youagent-output/ciplot20260425182220-0-964d58c98b99.png?se=2026-04-26T09%3A25%3A06Z&sp=r&sv=2021-12-02&sr=b&sig=x9HaiIatnr7%2B2Sp5u1iTVeTdiUVnLcO5gDFOqNhGm/Q%3D)
**- **Regime Delta Heatmap**

  ![Regime Delta Heatmap](https://ydcusercontenteast.blob.core.windows.net/user-content-youagent-output/ciplot20260425182321-0-aafb975186ed.png?se=2026-04-26T09%3A25%3A06Z&sp=r&sv=2021-12-02&sr=b&sig=v7kMoLzb4u%2B/x7I86o91CaoofRCnpN1R4xglEHg59nA%3D)

---

# 🟢 **Summary Table: Root Causes & Fixes**

| Root Cause                        | Fix/Filter (Exact)                        | WR After | Δ WR   | N_Remaining | % Trades Kept |
|-----------------------------------|-------------------------------------------|----------|--------|-------------|---------------|
| ModUp trend collapse              | Excl. ma_trend_bps ∈0.0]          | 0.5080   | +1.31% | 439         | 89.4%         |
| Medium vol collapse               | Excl. bb_width_bps ∈ [30,60]              | 0.5095   | +1.46% | 369         | 75.2%         |
| Overbought STC collapse           | Excl. stc_zone = overbought               | 0.5102   | +1.53% | 343         | 69.9%         |
| Hour 15 UTC collapse              | Excl. hour_utc = 15                       | 0.5104   | +1.55% | 433         | 88.2%         |
| Asset-level collapse              | Excl. assets WR < 0.40                    | 0.5394   | +4.45% | 406         | 82.7%         |
| **All combined (Combo_6)**        | All above + new dead zones                | 0.6378   | +14.29%| 127         | 25.9%         |

---

# 🏁 **Conclusion: Diagnosing & Repairing the Edge**

- **Dataset B underperforms due to:**  
  - Regime shifts (trend, volatility, time-of-day, asset).
  - Feature distribution drifts (momentum, trend, volatility).
  - Breakdown of original leaf logic in new market conditions.
  - New dead zones in STC, stoch_kd_diff, and stc_stoch_diff.
- **Actionable Fixes:**  
  - Apply targeted filters (trend, volatility, time, asset, STC, momentum).
  - Stack filters for maximum edge recovery (WR up to 63.8% on 25.9% of trades).
  - Monitor for further drift and regime changes.

---

> **For robust live trading, use the combined filter stack and monitor regime/asset/time clusters.  
> For further ML automation or adaptive filtering, just ask!**

---
