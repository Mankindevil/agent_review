import math


HOT_WEIGHTS = {"ret1": .25, "ret5": .20, "breadth5": .20, "turnover_heat": .15,
               "acceleration": .15, "lhb_activity": .05}
SELL_WEIGHTS = {"downside_volume": .25, "lhb_net_sell": .25, "northbound_reduction": .20,
                "margin_contraction": .15, "discount_event": .15}
POTENTIAL_WEIGHTS = {"trend": .25, "theme": .15, "quality": .20, "valuation": .15,
                     "capital": .15, "liquidity_stability": .10}


def _identity(row):
    return str(row.get("symbol", row.get("id", "")))


def _is_finite(value):
    try:
        return value is not None and math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def winsorize(values, lower=.025, upper=.975):
    finite = sorted(float(v) for v in values if _is_finite(v))
    if not finite:
        return [None for _ in values]
    lo = finite[max(0, math.ceil((len(finite) - 1) * lower))]
    hi = finite[min(len(finite) - 1, math.floor((len(finite) - 1) * upper))]
    return [None if not _is_finite(v) else min(hi, max(lo, float(v))) for v in values]


def percentile_rank(values):
    finite = sorted((float(v), index) for index, v in enumerate(values) if _is_finite(v))
    output = [None] * len(values)
    denominator = max(1, len(finite) - 1)
    for rank, (_, index) in enumerate(finite):
        output[index] = 100.0 * rank / denominator
    return output


def effective_weights(values, weights, minimum_components):
    used = [key for key in weights if _is_finite(values.get(key))]
    if len(used) < minimum_components:
        return None, sum(weights[key] for key in used), used
    coverage = sum(weights[key] for key in used)
    score = sum(float(values[key]) * weights[key] for key in used) / coverage
    return score, coverage, used


def _percentile_components(rows, keys):
    output = [dict(row) for row in rows]
    for key in keys:
        ranked = percentile_rank(winsorize([row.get(key) for row in output]))
        for row, value in zip(output, ranked):
            row[key] = value
    return output


def compute_hot_topics(groups, lhb_available=True):
    eligible, excluded = [], []
    for group in groups:
        if group["constituent_count"] < 5:
            excluded.append({"id": group["id"], "reason": "MIN_CONSTITUENTS"})
        elif group["coverage"] < .80:
            excluded.append({"id": group["id"], "reason": "MIN_COVERAGE"})
        else:
            eligible.append(group)
    ranked_rows = _percentile_components(eligible, HOT_WEIGHTS)
    ranked = []
    for row in ranked_rows:
        values = {key: row.get(key) for key in HOT_WEIGHTS}
        if not lhb_available:
            values["lhb_activity"] = None
        score, coverage, used = effective_weights(values, HOT_WEIGHTS, 5)
        ranked.append({**row, "score": score, "weightCoverage": coverage, "componentsUsed": used})
    ranked.sort(key=lambda item: (-(item["score"] if item["score"] is not None else -1), _identity(item)))
    return {"ranked": ranked, "excluded": excluded}


def compute_sell_pressure(rows):
    ranked = []
    for row in rows:
        score, coverage, used = effective_weights(row, SELL_WEIGHTS, 3)
        ranked.append({**row, "score": score, "weightCoverage": coverage,
                       "componentsUsed": used,
                       "status": "RANKED" if score is not None else "EVIDENCE_INSUFFICIENT"})
    ranked.sort(key=lambda item: (-(item["score"] if item["score"] is not None else -1), _identity(item)))
    return ranked


def compute_potential_watchlist(rows):
    output = []
    for row in rows:
        vetoes = []
        if row.get("st"):
            vetoes.append("ST_OR_DELISTING_RISK")
        if row.get("nonstandard_audit"):
            vetoes.append("NONSTANDARD_AUDIT")
        if (row.get("unlock_float_pct_30d") or 0) > 10:
            vetoes.append("LARGE_UNLOCK_30D")
        score, coverage, used = effective_weights(row, POTENTIAL_WEIGHTS, 4)
        status = "VETOED" if vetoes else ("RANKED" if score is not None and coverage >= .70 else "EVIDENCE_INSUFFICIENT")
        final = None if score is None else max(0, score - float(row.get("risk_penalty") or 0))
        output.append({**row, "baseScore": score, "score": final, "weightCoverage": coverage,
                       "componentsUsed": used, "vetoes": vetoes, "status": status})
    output.sort(key=lambda item: (item["status"] != "RANKED", -(item["score"] or -1), _identity(item)))
    return output
