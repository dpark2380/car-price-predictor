# Prints per-split-type tables from the two JSONs written by exp_router_blend.py. Run: python scripts/exp_router_blend_tables.py <dir holding rb_vin.json and rb_dt.json>
import json,sys,numpy as np
S=sys.argv[1]; R={**json.load(open(S+"/rb_vin.json")),**json.load(open(S+"/rb_dt.json"))}
C=["baseline","A_blend_both","B_blend_rest"]
for kind in ["vin","dealer","time"]:
    ks=[k for k in R if k.startswith(kind+":")]
    print(f"\n## {kind} n_test={[R[k]['_n'][2] for k in ks]}")
    print("config | MAE per split | mean MAE | mean mdAPE% | mean mdAPE<10k% | 4+star% | 5star% | 4+star overlap vs base")
    for c in C:
        g=lambda f:np.mean([R[k][c][f] for k in ks])
        print(c,"|",[round(R[k][c]["mae"]) for k in ks],"|",round(g("mae")),"|",round(g("mdape"),2),"|",round(g("mdape_cheap"),2),"|",round(g("flag4")*100,2),"|",round(g("flag5")*100,2),"|",round(g("f4_overlap_vs_base"),2))
    print("4+star rate by tier (lo-hi, mean n, then per config)")
    for t in R[ks[0]]["baseline"]["tier"]:
        print(t, round(np.mean([R[k]["baseline"]["tier"][t][0] for k in ks])), [round(100*np.mean([R[k][c]["tier"][t][1] for k in ks]),1) for c in C], "MAE",[round(np.mean([R[k][c]["tier"][t][2] for k in ks])) for c in C])
    print("fit s (mean):",{m:round(np.mean([R[k]["_fit_s"][m] for k in ks])) for m in R[ks[0]]["_fit_s"]})
    print("paired MAE diff A-base per split",[round(R[k]["A_blend_both"]["mae"]-R[k]["baseline"]["mae"]) for k in ks])
