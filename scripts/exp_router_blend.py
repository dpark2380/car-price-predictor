"""Production PriceRouted (artifact-tuned XGB params, 5 seeds) vs router with XGB+CatBoost+LightGBM blends, on VIN/dealer/time splits.
Usage: PYTHONPATH=/Users/danielpark/car-intel python exp_router_blend.py <db copy> <out.json> <kind:seed> ...   (kind = vin|dealer|time; time ignores seed)"""
import sys, time, json, warnings
import numpy as np, pandas as pd
from sqlalchemy import create_engine, text
warnings.filterwarnings("ignore")
from ml import pipeline as P
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.model_selection import GroupShuffleSplit
from xgboost import XGBRegressor
from catboost import CatBoostRegressor
import lightgbm as lgb

db, out = sys.argv[1], sys.argv[2]; specs = [a.split(":") for a in sys.argv[3:]]
# Tuned params from models/price_predictor.joblib v20261030_2312 (read-only): cheap lr .05 n 1405, rest lr .03 n 1479.
TUNED = {"cheap": (0.05, 1405), "rest": (0.03, 1479)}
XFIX = dict(max_depth=6, subsample=0.8, colsample_bytree=0.7, min_child_weight=3, gamma=0.05, reg_alpha=0.05,
            reg_lambda=1.0, verbosity=0, objective="reg:squarederror")
eng = create_engine(f"sqlite:///{db}")
with eng.connect() as c:
    ts = c.execute(text("select max(last_seen) from car_listings")).scalar()
    cut = str(pd.Timestamp(ts) - pd.Timedelta(days=180))
    df = pd.read_sql(text("select * from training_pool_v where last_seen >= :c order by id"), c, params={"c": cut},
                     parse_dates=["first_seen", "last_seen"])
print("rows", len(df), flush=True)
Xr = P._build_features_raw(df); y = df["price"]; dealers = P._dealer_keys(df)
NUM = ["year","vehicle_age","age_sq","log_age","mileage","log_mileage","miles_per_year","is_luxury","is_truck","is_sports",
       "lux_age","lux_mpy","trim_rank","cohort_median_price","cohort_count","comp_price"]
CAT = ["make","model","state","trim","body_type","zip3","exterior_color"]

def split(kind, seed):
    if kind == "vin": return P._vin_split(df, seed)
    idx = np.arange(len(df))
    if kind == "dealer":
        g = dealers.to_numpy()
        rest, te = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed).split(idx, groups=g))
        tr, va = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed).split(rest, groups=g[rest]))
        return rest[tr], rest[va], te
    o = np.argsort(df["first_seen"].to_numpy(), kind="stable"); n = len(o)   # time: oldest 64% train, next 16% val, newest 20% test
    return o[:int(.64*n)], o[int(.64*n):int(.8*n)], o[int(.8*n):]

def models(side, X, yl, nums):
    """returns {name: (val_log, test_log, fit_s)} for xgb bag / cat / lgb on the given numeric set."""
    r = {}
    pre = ColumnTransformer([("n", Pipeline([("i", SimpleImputer(strategy="median"))]), nums),
                             ("c", Pipeline([("i", SimpleImputer(strategy="most_frequent")), ("o", OneHotEncoder(handle_unknown="ignore"))]), CAT)]).fit(X["tr"])
    A = {k: pre.transform(X[k]) for k in X}
    lr, n = TUNED[side]; t0 = time.time(); pv = pt = 0
    for s in range(42, 47):
        m = XGBRegressor(n_estimators=n, learning_rate=lr, random_state=s, **XFIX).fit(A["tr"], yl["tr"])
        pv = pv + m.predict(A["va"]) / 5; pt = pt + m.predict(A["te"]) / 5
    r["xgb"] = (pv, pt, time.time() - t0)
    def cf(k):
        f = X[k][nums + CAT].copy()
        for c in CAT: f[c] = f[c].fillna("").astype(str)
        return f
    t0 = time.time()
    cb = CatBoostRegressor(iterations=3000, learning_rate=0.06, depth=7, loss_function="RMSE", random_seed=42, verbose=0,
                           thread_count=8, early_stopping_rounds=100, cat_features=CAT)
    cb.fit(cf("tr"), yl["tr"], eval_set=(cf("va"), yl["va"]))
    r["cat"] = (cb.predict(cf("va")), cb.predict(cf("te")), time.time() - t0)
    def lf(k):
        f = X[k][nums + CAT].copy()
        for c in CAT: f[c] = pd.Categorical(f[c].fillna("").astype(str), categories=sorted(set(X["tr"][c].fillna("").astype(str))))
        return f
    t0 = time.time()
    lm = lgb.LGBMRegressor(n_estimators=3000, learning_rate=0.05, num_leaves=31, min_child_samples=10, subsample=0.8,
                           subsample_freq=1, colsample_bytree=0.7, cat_smooth=20, random_state=42, verbose=-1)
    lm.fit(lf("tr"), yl["tr"], eval_set=[(lf("va"), yl["va"])], callbacks=[lgb.early_stopping(100, verbose=False)])
    r["lgb"] = (lm.predict(lf("va")), lm.predict(lf("te")), time.time() - t0)
    return r

TIERS = [(0,10e3),(10e3,20e3),(20e3,35e3),(35e3,60e3),(60e3,np.inf)]
def evaluate(name, pv, pt, yv, yt, cc_v, cc_t):
    off = np.median(pv - np.log1p(yv))                 # production: subtract median(val_log - y_val_log)
    pred_v, pred_t = np.expm1(pv - off), np.expm1(pt - off)
    ape = np.abs(pred_t - yt) / yt; ch = yt < 1e4
    seg = P._segment_errors(yv, pred_v, cc_v)          # production yardstick from val
    err = np.array([P._segment_error_for(p, seg, c) for p, c in zip(yt, cc_t)])
    score = np.array([P._deal_score_from_prices(a, p, e) for a, p, e in zip(yt, pred_t, err)])
    f4, f5 = score >= 75, score >= 90
    tier = {}
    for lo, hi in TIERS:
        m = (yt >= lo) & (yt < hi)
        tier[f"{lo:.0f}-{hi:.0f}"] = (int(m.sum()), float(f4[m].mean()) if m.sum() else None, float(np.abs(pred_t - yt)[m].mean()) if m.sum() else None)
    return dict(mae=float(np.abs(pred_t - yt).mean()), mdape=float(np.median(ape) * 100), mdape_cheap=float(np.median(ape[ch]) * 100),
                flag4=float(f4.mean()), flag5=float(f5.mean()), tier=tier, f4_idx=np.flatnonzero(f4).tolist())

res = {}
try: res = json.load(open(out))
except Exception: pass
for kind, seed in specs:
    key = f"{kind}:{seed}"; seed = int(seed)
    if key in res: continue
    T0 = time.time()
    tr, va, te = split(kind, seed)
    ref = P._cohort_ref(Xr.iloc[tr], dealers.iloc[tr], y.iloc[tr])
    X = {k: P._cohort_features(Xr.iloc[i], dealers.iloc[i], ref) for k, i in [("tr",tr),("va",va),("te",te)]}
    yl = {k: np.log1p(y.iloc[i].to_numpy()) for k, i in [("tr",tr),("va",va),("te",te)]}
    yv, yt = y.iloc[va].to_numpy(), y.iloc[te].to_numpy()
    cc_v, cc_t = X["va"]["cohort_count"].to_numpy(), X["te"]["cohort_count"].to_numpy()
    ch = models("cheap", X, yl, [n for n in NUM if n != "comp_price"]); print(key, "cheap done", round(time.time()-T0), flush=True)
    rs = models("rest", X, yl, NUM); print(key, "rest done", round(time.time()-T0), flush=True)
    bl = lambda d, i: (d["xgb"][i] + d["cat"][i] + d["lgb"][i]) / 3
    cut = np.log1p(10_000)
    route = lambda c_v, c_t, r_v, r_t: (np.where(c_v < cut, c_v, r_v), np.where(c_t < cut, c_t, r_t))
    cfg = {"baseline": route(ch["xgb"][0], ch["xgb"][1], rs["xgb"][0], rs["xgb"][1]),
           "A_blend_both": route(bl(ch,0), bl(ch,1), bl(rs,0), bl(rs,1)),
           "B_blend_rest": route(ch["xgb"][0], ch["xgb"][1], bl(rs,0), bl(rs,1))}
    r = {k: evaluate(k, *v[:2], yv, yt, cc_v, cc_t) for k, v in cfg.items()}
    base = set(r["baseline"]["f4_idx"])
    for k in r:
        s = set(r[k]["f4_idx"]); r[k]["f4_overlap_vs_base"] = len(s & base) / max(1, len(s | base))
        del r[k]["f4_idx"]
    r["_fit_s"] = {f"{s}_{m}": v[2] for s, d in [("cheap", ch), ("rest", rs)] for m, v in d.items()}
    r["_n"] = [len(tr), len(va), len(te)]
    res[key] = r; json.dump(res, open(out, "w"), indent=1)
    print(key, {k: round(v["mae"]) for k, v in r.items() if not k.startswith("_")}, "total s", round(time.time()-T0), flush=True)
