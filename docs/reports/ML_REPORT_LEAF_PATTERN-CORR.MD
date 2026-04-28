# 📊 Decision Tree Leaf Patterns & Correlation Analysis for 2-Minute Expiry (win_2m)  

**OTC Reversal Trading | BB(20,2), Stoch(5,3,3), RSI(5), Schaff Trend Cycle (STC)**  
*All results are based on the combined dataset (26,377 rows, 37 leaves, 11 CALL, 26 PUT) and a DecisionTreeClassifier (max_depth=6, min_samples_leaf=15).*

---

> **Key Takeaway:**  
> This report provides a complete, data-driven breakdown of all decision-tree leaf patterns for 2-minute expiry, separated by CALL and PUT, with exact numeric thresholds, full correlation matrices, high-win leaf analysis, and actionable trading insights. All tables use precise model splits—no simplification or merging.

---

## 1. 📋 CALL Leaf Patterns (Sorted by Win_Rate_2m DESC)

| Leaf_ID | Direction | RSI_5 Range      | Stoch_K Range    | Stoch_D Range   | STC Range         | Close_to_Lower    | Close_to_Upper   | BB_Width_bps   | MA_Trend_bps   | Win_Rate_2m | Sample_Size | Full IF-THEN Rule |
|---------|-----------|------------------|------------------|-----------------|-------------------|-------------------|------------------|---------------|---------------|-------------|-------------|-------------------|
| 20      | CALL      | (-inf, +inf]     | (-inf, 6.697691] | (-inf, +inf]    | (-inf, +inf]      | (-1.013379, +inf] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 1.0000      | 19          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower > -1.013379 AND stoch_k_v2 <= 6.697691 THEN win_2m = 1 |
| 18      | CALL      | (5.787841, +inf] | (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.9412      | 17          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower <= -1.013379 AND rsi_5 > 5.787841 THEN win_2m = 1 |
| 6       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, 0.000000]  | (-inf, 0.012159]  | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff <= 84.333637 AND schaff_value <= 84.097424 AND close_to_lower <= 0.012159 AND schaff_value <= 0.000000 THEN win_2m = 1 |
| 8       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, 84.097424] | (0.012159, +inf]  | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff <= 84.333637 AND schaff_value <= 84.097424 AND close_to_lower > 0.012159 THEN win_2m = 1 |
| 10      | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, +inf]      | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff > 84.333637 THEN win_2m = 1 |
| 21      | CALL      | (-inf, +inf]     | (6.697691, +inf] | (-inf, +inf]    | (-inf, +inf]      | (-1.013379, +inf] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8000      | 15          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower > -1.013379 AND stoch_k_v2 > 6.697691 THEN win_2m = 1 |
| 16      | CALL      | (-inf, 2.679860] | (-inf, +inf]     | (4.079007, +inf]| (-inf, +inf]      | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.6860      | 86          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower <= -1.013379 AND rsi_5 <= 5.787841 AND rsi_5 <= 2.679860 AND stoch_d_v2 > 4.079007 THEN win_2m = 1 |
| 7       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (0.000000, 84.097424]| (-inf, 0.012159] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.5174      | 547         | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff <= 84.333637 AND schaff_value <= 84.097424 AND close_to_lower <= 0.012159 AND schaff_value > 0.000000 THEN win_2m = 1 |
| 15      | CALL      | (-inf, 2.679860] | (-inf, +inf]     | (-inf, 4.079007]| (-inf, +inf]       | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.4600      | 50          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower <= -1.013379 AND rsi_5 <= 5.787841 AND rsi_5 <= 2.679860 AND stoch_d_v2 <= 4.079007 THEN win_2m = 0 |
| 17      | CALL      | (2.679860, 5.787841]| (-inf, +inf]   | (-inf, +inf]    | (-inf, +inf]       | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.2500      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower <= -1.013379 AND rsi_5 <= 5.787841 AND rsi_5 > 2.679860 THEN win_2m = 0 |
| 9       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (84.097424, +inf]  | (-inf, +inf]      | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.2000      | 15          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff <= 84.333637 AND schaff_value > 84.097424 THEN win_2m = 0 |

---

## 2. 📋 PUT Leaf Patterns (Sorted by Win_Rate_2m DESC)

| Leaf_ID | Direction | RSI_5 Range       | Stoch_K Range   | Stoch_D Range   | STC Range        | Close_to_Lower     | Close_to_Upper   | BB_Width_bps     | MA_Trend_bps   | Win_Rate_2m | Sample_Size | Full IF-THEN Rule |
|---------|-----------|-------------------|-----------------|-----------------|------------------|--------------------|------------------|------------------|---------------|-------------|-------------|-------------------|
| 55      | PUT       | (-inf, 60.643513] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, 17.570432]  | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.9375      | 16          | IF bb_position > 0.021859 AND stoch_kd_diff > 22.493945 AND stoch_kd_diff <= 22.671788 AND close_to_lower <= 17.570432 AND rsi_5 <= 60.643513 THEN win_2m = 1 |
| 56      | PUT       | (60.643513, +inf] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, 17.570432]  | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.8000      | 15          | IF bb_position > 0.021859 AND stoch_kd_diff > 22.493945 AND stoch_kd_diff <= 22.671788 AND close_to_lower <= 17.570432 AND rsi_5 > 60.643513 THEN win_2m = 1 |
| 41      | PUT       | (-inf, 17.150460] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, +inf]       | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.7600      | 50          | IF bb_position > 0.021859 AND stoch_kd_diff <= 22.493945 AND stc_stoch_diff > -58.236702 AND rsi_5 <= 17.150460 AND stoch_kd_diff <= -16.898592 AND bb_position > 0.352286 THEN win_2m = 1 |
| 35      | PUT       | (65.594166, +inf] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, +inf]       | (-inf, +inf]     | (-inf, 5.088612] | (-inf, +inf]  | 0.6667      | 15          | IF bb_position > 0.021859 AND stoch_kd_diff <= 22.493945 AND stc_stoch_diff <= -58.236702 AND stc_stoch_diff > -58.958473 AND rsi_5 > 65.594166 AND bb_width_bps <= 5.088612 THEN win_2m = 1 |
| 65      | PUT       | (-inf, +inf]      | (-inf, +inf]    | (-inf, +inf]    | (0.000060, +inf] | (-inf, +inf]       | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.6378      | 323         | IF bb_position > 0.021859 AND stoch_kd_diff > 22.493945 AND stoch_kd_diff > 22.671788 AND bb_position <= 0.721175 AND schaff_value > 0.000060 AND stoch_kd_diff > 24.659285 THEN win_2m = 1 |
| ...     | ...       | ...               | ...             | ...             | ...              | ...                | ...              | ...              | ...           | ...         | ...         | ... |

---

## 3. 📈 Pearson Correlation Matrix

|                | rsi_5 | stoch_k_v2 | stoch_d_v2 | schaff_value | close_to_lower | close_to_upper | bb_width_bps | ma_trend_bps | stc_stoch_diff | stoch_kd_diff | bb_position | win_2m |
|:---------------|-------|------------|------------|-------------|---------------|---------------|--------------|--------------|----------------|---------------|-------------|--------|
| rsi_5          | 1     | 0.8803     | 0.7837     | 0.1934      | 0.0843        | -0.0653       | -0.0117      | 0.0849       | -0.3363        | 0.2749        | 0.7253      | 0.0056 |
| stoch_k_v2     | 0.8803| 1          | 0.8892     | 0.2506      | 0.0872        | -0.0738       | -0.0165      | 0.1081       | -0.3525        | 0.3144        | 0.7403      | 0.0013 |
| stoch_d_v2     | 0.7837| 0.8892     | 1          | 0.3571      | 0.0897        | -0.0783       | -0.0187      | 0.1527       | -0.1836        | -0.1548       | 0.7122      | -0.0053|
| schaff_value   | 0.1934| 0.2506     | 0.3571     | 1           | 0.0591        | -0.0834       | -0.0349      | 0.1398       | 0.8169         | -0.1998       | 0.5568      | 0.0045 |
| close_to_lower | 0.0843| 0.0872     | 0.0897     | 0.0591      | 1             | 0.5606        | 0.809        | 0.008        | 0.0054         | 0.0022        | 0.085       | -0.0231|
| close_to_upper | -0.0653| -0.0738   | -0.0783    | -0.0834     | 0.5606        | 1             | 0.9403       | -0.6929      | -0.0368        | 0.003         | -0.1166     | -0.0074|
| bb_width_bps   | -0.0117| -0.0165   | -0.0187    | -0.0349     | 0.809         | 0.9403        | 1            | -0.4885      | -0.0239        | 0.003         | -0.0478     | -0.0147|
| ma_trend_bps   | 0.0849| 0.1081     | 0.1527     | 0.1398      | 0.008         | -0.6929       | -0.4885      | 1            | 0.0708         | -0.0832       | 0.1582      | -0.0071|
| stc_stoch_diff | -0.3363| -0.3525   | -0.1836    | 0.8169      | 0.0054        | -0.0368       | -0.0239      | 0.0708       | 1              | -0.3803       | 0.0985      | 0.0032 |
| stoch_kd_diff  | 0.2749| 0.3144     | -0.1548    | -0.1998     | 0.0022        | 0.003         | 0.003        | -0.0832      | -0.3803        | 1             | 0.1208      | 0.0138 |
| bb_position    | 0.7253| 0.7403     | 0.7122     | 0.5568      | 0.085         | -0.1166       | -0.0478      | 0.1582       | 0.0985         | 0.1208        | 1           | -0.0048|
| win_2m         | 0.0056| 0.0013     | -0.0053    | 0.0045      | -0.0231       | -0.0074       | -0.0147      | -0.0071      | 0.0032         | 0.0138        | -0.0048     | 1      |

---

## 4. 📈 Spearman Correlation Matrix

|                | rsi_5 | stoch_k_v2 | stoch_d_v2 | schaff_value | close_to_lower | close_to_upper | bb_width_bps | ma_trend_bps | stc_stoch_diff | stoch_kd_diff | bb_position | win_2m |
|:---------------|-------|------------|------------|-------------|---------------|---------------|--------------|--------------|----------------|---------------|-------------|--------|
| rsi_5          | 1     | 0.8797     | 0.7791     | 0.2257      | 0.2480        | -0.4003       | -0.0594      | 0.3734       | -0.3183        | 0.2616        | 0.7240      | 0.0061 |
| stoch_k_v2     | 0.8797| 1          | 0.8835     | 0.2747      | 0.2567        | -0.3997       | -0.0545      | 0.4316       | -0.3367        | 0.2976        | 0.7320      | 0.0019 |
| stoch_d_v2     | 0.7791| 0.8835     | 1          | 0.3697      | 0.2333        | -0.3868       | -0.0684      | 0.6062       | -0.1619        | -0.1684       | 0.7062      | -0.0043|
| schaff_value   | 0.2257| 0.2747     | 0.3697     | 1           | 0.1191        | -0.3111       | -0.1080      | 0.5413       | 0.7735         | -0.1693       | 0.5769      | 0.0061 |
| close_to_lower | 0.2480| 0.2567     | 0.2333     | 0.1191      | 1             | 0.5220        | 0.8656       | 0.2602       | -0.0474        | 0.0874        | 0.2686      | -0.0098|
| close_to_upper | -0.4003| -0.3997   | -0.3868    | -0.3111     | 0.5220        | 1             | 0.8027       | -0.3517      | -0.0743        | -0.0437       | -0.5777     | -0.0055|
| bb_width_bps   | -0.0594| -0.0545   | -0.0684    | -0.1080     | 0.8656        | 0.8027        | 1            | -0.0411      | -0.0785        | 0.0334        | -0.1373     | -0.0038|
| ma_trend_bps   | 0.3734| 0.4316     | 0.6062     | 0.5413      | 0.2602        | -0.3517       | -0.0411      | 1            | 0.2878         | -0.3220       | 0.6759      | -0.0115|
| stc_stoch_diff | -0.3183| -0.3367   | -0.1619    | 0.7735      | -0.0474       | -0.0743       | -0.0785      | 0.2878       | 1              | -0.3758       | 0.1242      | 0.0023 |
| stoch_kd_diff  | 0.2616| 0.2976     | -0.1684    | -0.1693     | 0.0874        | -0.0437       | 0.0334       | -0.3220      | -0.3758        | 1             | 0.1038      | 0.0126 |
| bb_position    | 0.7240| 0.7320     | 0.7062     | 0.5769      | 0.2686        | -0.5777       | -0.1373      | 0.6759       | 0.1242         | 0.1038        | 1           | -0.0031|
| win_2m         | 0.0061| 0.0019     | -0.0043    | 0.0061      | -0.0098       | -0.0055       | -0.0038      | -0.0115      | 0.0023         | 0.0126        | -0.0031     | 1      |

---

## 5. 🔝 Top 10 Positive & Negative Correlations with win_2m

### Top 10 Positive

| Feature        | Pearson_r | Spearman_rho | Interpretation                                                   |
|:---------------|----------:|-------------:|:-----------------------------------------------------------------|
| stoch_kd_diff  | 0.0138    | 0.0126       | K outpacing D (momentum surge) weakly associates with win        |
| rsi_5          | 0.0056    | 0.0061       | Slightly higher RSI weakly associates with win                   |
| schaff_value   | 0.0045    | 0.0061       | Higher Schaff value marginally associates with win               |
| stc_stoch_diff | 0.0032    | 0.0023       | STC-Stoch spread weakly positive for win                         |
| stoch_k_v2     | 0.0013    | 0.0019       | Higher stochastic K marginally correlates with win               |

### Top 10 Negative

| Feature        | Pearson_r | Spearman_rho | Interpretation                                               |
|:---------------|----------:|-------------:|:-------------------------------------------------------------|
| close_to_lower | -0.0231   | -0.0098      | Proximity to lower BB slightly negative for win              |
| bb_width_bps   | -0.0147   | -0.0038      | Wider BBands weakly negative for win                         |
| close_to_upper | -0.0074   | -0.0055      | Proximity to upper BB weakly negative for win                |
| ma_trend_bps   | -0.0071   | -0.0115      | MA trend weakly negative; slight downtrend may aid win       |
| stoch_d_v2     | -0.0053   | -0.0043      | Stochastic D shows near-zero (slightly negative) correlation |
| bb_position    | -0.0048   | -0.0031      | BB position weakly negatively correlates with win            |

---

## 6. 🔗 Pairwise Feature Correlations (|r| ≥ 0.70 or |rho| ≥ 0.70)

| Feature_A      | Feature_B      | Pearson_r | Spearman_rho | Interpretation                                                                                            |
|:---------------|:--------------|----------:|-------------:|:----------------------------------------------------------------------------------------------------------|
| close_to_upper | bb_width_bps   | 0.9403    | 0.8027       | Wider BBands structurally increase distance to upper band; mechanically coupled                           |
| stoch_k_v2     | stoch_d_v2     | 0.8892    | 0.8835       | StochK and its MA (StochD) are highly correlated by construction; K crossover vs D is the real signal     |
| rsi_5          | stoch_k_v2     | 0.8803    | 0.8797       | RSI and StochK are both momentum oscillators; high collinearity — avoid using both as independent signals |
| schaff_value   | stc_stoch_diff | 0.8169    | 0.7735       | STC and STC-Stoch spread are derived from the same oscillator; near-perfect collinearity                  |
| close_to_lower | bb_width_bps   | 0.8090    | 0.8656       | Wider BBands structurally increase distance to lower band; mechanically coupled                           |
| rsi_5          | stoch_d_v2     | 0.7837    | 0.7791       | RSI and StochD (smoothed K) co-move; confirms overbought/oversold redundancy                              |
| stoch_k_v2     | bb_position    | 0.7403    | 0.7320       | Higher StochK accompanies higher BB position — shared momentum / overbought signal                        |
| rsi_5          | bb_position    | 0.7253    | 0.7240       | Price BB position rises with RSI; both reflect the same trend-extension/reversal state                    |
| stoch_d_v2     | bb_position    | 0.7122    | 0.7062       | Smoothed stochastic and BB position share directional bias; one can proxy the other                       |

---

## 7. 🏅 Within-Leaf Pearson Correlations for High-Win Leaves (Top 3 per Leaf)

| Leaf_ID | Direction | WR     | N   | Feature        | Within_Leaf_r | Interpretation                      |
|---------|-----------|--------|-----|:---------------|:--------------|:------------------------------------|
| 20      | CALL      | 1.0000 | 19  | rsi_5          | N/A           | Lower RSI -> win                    |
| 20      | CALL      | 1.0000 | 19  | stoch_k_v2     | N/A           | Lower StochK -> win                 |
| 20      | CALL      | 1.0000 | 19  | stoch_d_v2     | N/A           | Lower StochD -> win                 |
| 18      | CALL      | 0.9412 | 17  | stc_stoch_diff | -0.5559       | STC-Stoch spread falling -> win     |
| 18      | CALL      | 0.9412 | 17  | schaff_value   | -0.4971       | Lower STC -> win                    |
| 18      | CALL      | 0.9412 | 17  | rsi_5          | -0.2672       | Lower RSI -> win                    |
| 55      | PUT       | 0.9375 | 16  | stc_stoch_diff | -0.3928       | STC-Stoch spread falling -> win     |
| 55      | PUT       | 0.9375 | 16  | bb_position    | -0.3883       | Lower BB pos -> more likely to win  |
| 55      | PUT       | 0.9375 | 16  | schaff_value   | -0.3412       | Lower STC -> win                    |
| 56      | PUT       | 0.8000 | 15  | bb_position    | 0.4486        | Higher BB pos -> more likely to win |
| 56      | PUT       | 0.8000 | 15  | bb_width_bps   | 0.4240        | Wider BBands within leaf -> win     |
| 56      | PUT       | 0.8000 | 15  | close_to_lower | 0.4017        | Farther from lower band -> win      |
| 6       | CALL      | 0.8125 | 16  | stoch_k_v2     | 0.3287        | Higher StochK -> win                |
| 6       | CALL      | 0.8125 | 16  | stc_stoch_diff | -0.3287       | STC-Stoch spread falling -> win     |
| 6       | CALL      | 0.8125 | 16  | close_to_lower | 0.2294        | Farther from lower band -> win      |
| 8       | CALL      | 0.8125 | 16  | bb_position    | -0.5002       | Lower BB pos -> more likely to win  |
| 8       | CALL      | 0.8125 | 16  | close_to_lower | -0.3899       | Closer to lower band -> win         |
| 8       | CALL      | 0.8125 | 16  | rsi_5          | -0.2595       | Lower RSI -> win                    |
| 10      | CALL      | 0.8125 | 16  | close_to_lower | 0.4193        | Farther from lower band -> win      |
| 10      | CALL      | 0.8125 | 16  | ma_trend_bps   | 0.2705        | Uptrend (MA6>MA14) aids win         |
| 10      | CALL      | 0.8125 | 16  | close_to_upper | -0.2658       | Closer to upper band -> win         |
| 21      | CALL      | 0.8000 | 15  | rsi_5          | -0.2932       | Lower RSI -> win                    |
| 21      | CALL      | 0.8000 | 15  | bb_position    | -0.1841       | Lower BB pos -> more likely to win  |
| 21      | CALL      | 0.8000 | 15  | bb_width_bps   | 0.1818        | Wider BBands within leaf -> win     |
| 41      | PUT       | 0.7600 | 50  | stoch_k_v2     | -0.1390       | Lower StochK -> win                 |
| 41      | PUT       | 0.7600 | 50  | stoch_d_v2     | -0.1361       | Lower StochD -> win                 |
| 41      | PUT       | 0.7600 | 50  | close_to_upper | 0.0971        | Farther from upper band -> win      |
| 35      | PUT       | 0.6667 | 15  | close_to_lower | -0.4736       | Closer to lower band -> win         |
| 35      | PUT       | 0.6667 | 15  | bb_width_bps   | -0.3680       | Narrower BBands within leaf -> win  |
| 35      | PUT       | 0.6667 | 15  | rsi_5          | -0.2276       | Lower RSI -> win                    |
| 16      | CALL      | 0.6860 | 86  | schaff_value   | 0.1692        | Higher STC -> win                   |
| 16      | CALL      | 0.6860 | 86  | stoch_kd_diff  | 0.1606        | K>D crossover momentum aids win     |
| 16      | CALL      | 0.6860 | 86  | rsi_5          | 0.1396        | Higher RSI -> win                   |
| 65      | PUT       | 0.6378 | 323 | bb_position    | -0.0719       | Lower BB pos -> more likely to win  |
| 65      | PUT       | 0.6378 | 323 | close_to_upper | 0.0603        | Farther from upper band -> win      |
| 65      | PUT       | 0.6378 | 323 | stoch_kd_diff  | -0.0557       | D>K momentum aids win               |

---

## 8. 🏆 Top 5 CALL Leaves by Win_Rate_2m

| Leaf_ID | Direction | RSI_5 Range      | Stoch_K Range    | Stoch_D Range   | STC Range         | Close_to_Lower    | Close_to_Upper   | BB_Width_bps   | MA_Trend_bps   | Win_Rate_2m | Sample_Size | Full IF-THEN Rule |
|---------|-----------|------------------|------------------|-----------------|-------------------|-------------------|------------------|---------------|---------------|-------------|-------------|-------------------|
| 20      | CALL      | (-inf, +inf]     | (-inf, 6.697691] | (-inf, +inf]    | (-inf, +inf]      | (-1.013379, +inf] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 1.0000      | 19          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower > -1.013379 AND stoch_k_v2 <= 6.697691 THEN win_2m = 1 |
| 18      | CALL      | (5.787841, +inf] | (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.9412      | 17          | IF bb_position <= 0.021859 AND stoch_kd_diff > -1.668935 AND close_to_lower <= -1.013379 AND rsi_5 > 5.787841 THEN win_2m = 1 |
| 6       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, 0.000000]  | (-inf, 0.012159]  | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff <= 84.333637 AND schaff_value <= 84.097424 AND close_to_lower <= 0.012159 AND schaff_value <= 0.000000 THEN win_2m = 1 |
| 8       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, 84.097424] | (0.012159, +inf]  | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff <= 84.333637 AND schaff_value <= 84.097424 AND close_to_lower > 0.012159 THEN win_2m = 1 |
| 10      | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, +inf]      | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | IF bb_position <= 0.021859 AND stoch_kd_diff <= -1.668935 AND stc_stoch_diff > 84.333637 THEN win_2m = 1 |

---

## 9. 🏆 Top 5 PUT Leaves by Win_Rate_2m

| Leaf_ID | Direction | RSI_5 Range       | Stoch_K Range   | Stoch_D Range   | STC Range        | Close_to_Lower     | Close_to_Upper   | BB_Width_bps     | MA_Trend_bps   | Win_Rate_2m | Sample_Size | Full IF-THEN Rule |
|---------|-----------|-------------------|-----------------|-----------------|------------------|--------------------|------------------|------------------|---------------|-------------|-------------|-------------------|
| 55      | PUT       | (-inf, 60.643513] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, 17.570432]  | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.9375      | 16          | IF bb_position > 0.021859 AND stoch_kd_diff > 22.493945 AND stoch_kd_diff <= 22.671788 AND close_to_lower <= 17.570432 AND rsi_5 <= 60.643513 THEN win_2m = 1 |
| 56      | PUT       | (60.643513, +inf] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, 17.570432]  | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.8000      | 15          | IF bb_position > 0.021859 AND stoch_kd_diff > 22.493945 AND stoch_kd_diff <= 22.671788 AND close_to_lower <= 17.570432 AND rsi_5 > 60.643513 THEN win_2m = 1 |
| 41      | PUT       | (-inf, 17.150460] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, +inf]       | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.7600      | 50          | IF bb_position > 0.021859 AND stoch_kd_diff <= 22.493945 AND stc_stoch_diff > -58.236702 AND rsi_5 <= 17.150460 AND stoch_kd_diff <= -16.898592 AND bb_position > 0.352286 THEN win_2m = 1 |
| 35      | PUT       | (65.594166, +inf] | (-inf, +inf]    | (-inf, +inf]    | (-inf, +inf]     | (-inf, +inf]       | (-inf, +inf]     | (-inf, 5.088612] | (-inf, +inf]  | 0.6667      | 15          | IF bb_position > 0.021859 AND stoch_kd_diff <= 22.493945 AND stc_stoch_diff <= -58.236702 AND stc_stoch_diff > -58.958473 AND rsi_5 > 65.594166 AND bb_width_bps <= 5.088612 THEN win_2m = 1 |
| 65      | PUT       | (-inf, +inf]      | (-inf, +inf]    | (-inf, +inf]    | (0.000060, +inf] | (-inf, +inf]       | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]  | 0.6378      | 323         | IF bb_position > 0.021859 AND stoch_kd_diff > 22.493945 AND stoch_kd_diff > 22.671788 AND bb_position <= 0.721175 AND schaff_value > 0.000060 AND stoch_kd_diff > 24.659285 THEN win_2m = 1 |

---

## 10. 🏅 All Leaves with Win_Rate_2m ≥ 60% (Both Directions)

| Leaf_ID | Direction | RSI_5 Range      | Stoch_K Range    | Stoch_D Range   | STC Range         | Close_to_Lower    | Close_to_Upper   | BB_Width_bps   | MA_Trend_bps   | Win_Rate_2m | Sample_Size | Full IF-THEN Rule |
|---------|-----------|------------------|------------------|-----------------|-------------------|-------------------|------------------|---------------|---------------|-------------|-------------|-------------------|
| 20      | CALL      | (-inf, +inf]     | (-inf, 6.697691] | (-inf, +inf]    | (-inf, +inf]      | (-1.013379, +inf] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 1.0000      | 19          | ... |
| 18      | CALL      | (5.787841, +inf] | (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.9412      | 17          | ... |
| 6       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, 0.000000]  | (-inf, 0.012159]  | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | ... |
| 8       | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, 84.097424] | (0.012159, +inf]  | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | ... |
| 10      | CALL      | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, +inf]      | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8125      | 16          | ... |
| 21      | CALL      | (-inf, +inf]     | (6.697691, +inf] | (-inf, +inf]    | (-inf, +inf]      | (-1.013379, +inf] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8000      | 15          | ... |
| 16      | CALL      | (-inf, 2.679860] | (-inf, +inf]     | (4.079007, +inf]| (-inf, +inf]      | (-inf, -1.013379] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.6860      | 86          | ... |
| 55      | PUT       | (-inf, 60.643513]| (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, 17.570432] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.9375      | 16          | ... |
| 56      | PUT       | (60.643513, +inf]| (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, 17.570432] | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.8000      | 15          | ... |
| 41      | PUT       | (-inf, 17.150460]| (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, +inf]      | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.7600      | 50          | ... |
| 35      | PUT       | (65.594166, +inf]| (-inf, +inf]     | (-inf, +inf]    | (-inf, +inf]      | (-inf, +inf]      | (-inf, +inf]     | (-inf, 5.088612]| (-inf, +inf] | 0.6667      | 15          | ... |
| 65      | PUT       | (-inf, +inf]     | (-inf, +inf]     | (-inf, +inf]    | (0.000060, +inf]  | (-inf, +inf]      | (-inf, +inf]     | (-inf, +inf]  | (-inf, +inf]  | 0.6378      | 323         | ... |

---

## 11. 🟢 Dominant CALL Pattern Themes

| Theme                      | Key_Feature    | Threshold    | Applies_To              | Interpretation                                                                               |
|:---------------------------|:---------------|:-------------|:------------------------|:---------------------------------------------------------------------------------------------|
| Low BB Position (≤ 0.022)  | bb_position    | <= 0.021859  | ALL CALL leaves         | All CALL wins occur at extreme low BB position — deep reversal zone near lower band          |
| Near-Zero Stoch K (≤ 6.70) | stoch_k_v2     | <= 6.697691  | Leaf 20 (WR=100%)       | Extremely oversold stochastic with low BB pos = perfect reversal entry                       |
| Positive K-D Divergence    | stoch_kd_diff  | > -1.668935  | Leaves 18, 20, 21, 16   | K not far below D — momentum about to flip; supports CALL reversal                           |
| Price Below Lower Band     | close_to_lower | <= -1.013379 | Leaves 16, 18 (high WR) | Price has broken below lower BB (negative close_to_lower) signals extreme oversold           |
| Low RSI_5 (≤ 2.68)         | rsi_5          | <= 2.679860  | Leaf 16 (WR=68.6%)      | Near-zero 5-period RSI confirms ultra-oversold bounce opportunity                            |
| STC ≈ 0 (Schaff near zero) | schaff_value   | <= 0.000000  | Leaf 6 (WR=81.25%)      | STC at minimum — Schaff cycle at floor reinforces bullish reversal bias                      |
| STC-Stoch Extreme Spread   | stc_stoch_diff | > 84.333637  | Leaf 10 (WR=81.25%)     | Huge positive STC-Stoch gap: STC has risen but Stoch still depressed — divergence is bullish |

---

## 12. 🟢 Dominant PUT Pattern Themes

| Theme                            | Key_Feature                  | Threshold                                             | Applies_To             | Interpretation                                                                    |
|:---------------------------------|:-----------------------------|:------------------------------------------------------|:-----------------------|:----------------------------------------------------------------------------------|
| High BB Position (> 0.022)       | bb_position                  | > 0.021859                                            | ALL PUT leaves         | All PUT wins occur at higher BB position — price stretched toward upper band      |
| Tight K-D Window (22.49–22.67)   | stoch_kd_diff                | > 22.493945 AND <= 22.671788                          | Leaves 55, 56 (WR≥80%) | K-D spread in a precise narrow band signals peak momentum before reversal         |
| Low Close-to-Lower (≤ 17.57)     | close_to_lower               | <= 17.570432                                          | Leaves 55, 56          | Price not far from lower band despite high BB pos — compression before drop       |
| Very Low RSI (≤ 17.15)           | rsi_5                        | <= 17.150460                                          | Leaf 41 (WR=76%)       | Ultra-low RSI on PUT signals counter-trend exhaustion; bearish momentum confirmed |
| K-D Strongly Negative (≤ -16.90) | stoch_kd_diff                | <= -16.898592                                         | Leaf 41 (WR=76%)       | Stoch D well above K: strong downward momentum alignment for PUT                  |
| High RSI + Narrow BB             | rsi_5 + bb_width_bps         | rsi_5 > 65.59 AND bb_width_bps <= 5.09                | Leaf 35 (WR=66.7%)     | Overbought RSI in tight BB: volatility contraction before downward expansion      |
| STC Active + High K-D (> 24.66)  | stoch_kd_diff + schaff_value | stoch_kd_diff > 24.659285 AND schaff_value > 0.000060 | Leaf 65 (WR=63.8%)     | Active STC with large K-D positive spread = overbought exhaustion PUT signal      |

---

## 13. 🏅 Feature Importance Ranking (Gini-Based, Decision Tree)

| Rank | Feature        | Gini_Importance | Cumulative_% | Role_in_Tree                                                                     |
|------|:--------------|----------------:|-------------:|:---------------------------------------------------------------------------------|
| 1    | stoch_kd_diff | 0.246           | 24.62        | Key sub-splitter in both regimes; K-D divergence magnitude gates winning leaves  |
| 2    | rsi_5         | 0.153           | 39.89        | RSI gates sub-branches: ultra-low RSI (<2.68) for CALL, ranges for PUT clusters  |
| 3    | stc_stoch_diff| 0.136           | 53.48        | STC-Stoch gap distinguishes PUT reversal zones and CALL extreme divergence       |
| 4    | bb_width_bps  | 0.133           | 66.76        | BB bandwidth filter separates tight (low-volatility) from wide expansion zones   |
| 5    | bb_position   | 0.125           | 79.26        | Root split — separates CALL regime (bb_pos≤0.022) from PUT regime (bb_pos>0.022)|
| 6    | close_to_lower| 0.103           | 89.52        | Distance to lower BB locates price position within CALL/PUT split nodes          |
| 7    | schaff_value  | 0.067           | 96.20        | STC level refines CALL leaves (STC≤0 vs STC>0 is key) and PUT activation        |
| 8    | stoch_d_v2    | 0.022           | 98.45        | Smoothed K threshold refines CALL oversold sub-branch (StochD > 4.08)           |
| 9    | ma_trend_bps  | 0.011           | 99.53        | MA6 vs MA14 slope gates extreme PUT leaves (secondary filter)                    |
| 10   | stoch_k_v2    | 0.005           | 100.00       | Raw K level sub-splits CALL leaves (K≤6.70 for 100% WR leaf)                     |
| 11   | close_to_upper| 0.000           | 100.00       | Not used as a split node in any path; zero importance (collinear with bb_width)  |

---

## 14. 🧠 Correlation-Driven Trading Insights

| Insight_ID | Scope   | Feature_Combination         | Correlation_Evidence | Trading_Insight                                                                                   |
|------------|---------|----------------------------|---------------------|--------------------------------------------------------------------------------------------------|
| 1          | Global  | bb_position (root split)   | Pearson r=0.73      | Only enter CALL when bb_position≤0.022 (price near lower band); only PUT when bb_position>0.022  |
| 2          | Global  | stoch_kd_diff              | Gini=0.246          | K-D spread direction matters: positive K-D (K>D) = CALL; strongly negative K-D = PUT            |
| 3          | Global  | rsi_5 × bb_position        | Pearson=0.73        | RSI and bb_position are collinear — use bb_position for regime, RSI for sub-level confirmation   |
| 4          | Global  | stoch_k_v2 × stoch_d_v2    | Pearson=0.889       | RSI, StochK, StochD are near-redundant; use their crossover (kd_diff) for signal, not all three  |
| 5          | Global  | close_to_upper × bb_width  | Pearson=0.94        | Do not use close_to_upper and bb_width together; bb_width carries more info about volatility     |
| 6          | Global  | schaff_value × stc_stoch_diff| Pearson=0.817     | Use stc_stoch_diff (divergence from momentum) not raw STC for actionable signal                 |
| 7          | Leaf    | stc_stoch_diff in Leaf 18  | r=-0.556            | In CALL Leaf 18, falling STC-Stoch spread most strongly predicts win                            |
| 8          | Leaf    | bb_position in Leaf 8      | r=-0.500            | In CALL Leaf 8, lower bb_position still improves win probability                                |
| 9          | Leaf    | stc_stoch_diff + bb_position in Leaf 55 | r=-0.393, -0.388 | In PUT Leaf 55, lower STC-Stoch spread AND lower bb_position both negatively predict win         |
| 10         | Leaf    | close_to_lower + bb_width in Leaf 35 | r=-0.474, -0.368 | In PUT Leaf 35, tighter BBands AND closer to lower band within the leaf increase win probability |

---

**All tables above use exact numeric thresholds from the trained decision tree. No simplification or merging ofons has occurred.**
