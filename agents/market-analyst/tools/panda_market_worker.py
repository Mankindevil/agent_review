import hashlib
import json
import math
import os
import pathlib
import re
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


SDK_VERSION = "0.0.12"
APPLICATION_VERSION = "1.0.0"
EVIDENCE_MODEL_VERSION = "2.0"
METRIC_VERSION = "2.0"
SKILL_VERSIONS = {
    "daily-market-report": "1.0.0",
    "hot-topic-analysis": "1.0.0",
    "sell-pressure-scan": "1.0.0",
    "potential-watchlist": "1.0.0",
    "inspect-run-trace": "1.0.0",
}
REQUIRED_TRADING_SESSIONS = 60
PROVIDER_ROW_CAP = 500
CORE_REPORT_DATE_COVERAGE = .95
OPTIONAL_CANDIDATE_COVERAGE = .80
MAX_PRELIMINARY_CANDIDATES = 300
MAX_FULL_ENRICHMENT = 100
US_CONTEXT_SYMBOLS = ["SPY", "QQQ"]
PUBLIC_REQUEST_FIELDS = {
    "operation", "date", "topN", "minLiquidityCny", "cacheDays", "runId",
}
HOT_WEIGHTS = {"ret1": .25, "ret5": .20, "breadth5": .20, "turnover_heat": .15,
               "acceleration": .15, "lhb_activity": .05}
HOT_REQUIRED_COMPONENTS = ("ret1", "ret5", "breadth5", "turnover_heat", "acceleration")
SELL_WEIGHTS = {"downside_volume": .25, "lhb_net_sell": .25, "northbound_reduction": .20,
                "margin_contraction": .15, "discount_event": .15}
POTENTIAL_WEIGHTS = {"trend": .25, "theme": .15, "quality": .20, "valuation": .15,
                     "capital": .15, "liquidity_stability": .10}


def _records(result):
    if result is None:
        return []
    # panda-data get_last_trade_date returns Optional[str], not a frame.
    if isinstance(result, (str, bytes)):
        text = result.decode("utf-8") if isinstance(result, bytes) else result
        return [{"date": text}]
    if hasattr(result, "to_dict"):
        output = result.to_dict(orient="records")
    elif isinstance(result, dict):
        output = [result]
    else:
        output = list(result)
    return [dict(row) for row in output]


def _sanitize_error(error):
    message = str(error)
    for key in ("PANDA_DATA_USERNAME", "PANDA_DATA_PASSWORD"):
        secret = os.environ.get(key)
        if secret:
            message = message.replace(secret, "[REDACTED]")
    message = re.sub(
        r"""(?ix)
        (["']?(?:authorization|proxy-authorization|auth(?:orization)?_header)["']?
        \s*[:=]\s*)
        [^;,\r\n]+
        """,
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+",
        r"\1 [REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)(password|token|jwt|access[_-]?key)\s*[:=]\s*[^\s;,]+",
        r"\1=[REDACTED]",
        message,
    )
    return f"{type(error).__name__}: {message}"[:500]


def _date_text(value):
    text = str(value or "").strip().replace("-", "")
    return text[:8] if len(text) >= 8 and text[:8].isdigit() else ""


def _iso_date(value):
    compact = _date_text(value)
    return f"{compact[:4]}-{compact[4:6]}-{compact[6:8]}" if compact else None


def _parse_now(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _content_hash(rows):
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True, default=str,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class PandaCollector:
    def __init__(self, module, trace, cache_dir, cache_days,
                 provider_max_rows=PROVIDER_ROW_CAP):
        self.module = module
        self.trace = trace
        self.cache_dir = cache_dir
        self.cache_days = cache_days
        self.report_date = None
        self.records = []
        self._sequence = 0
        self._cache_transaction = None
        self.provider_max_rows = int(provider_max_rows)
        if self.provider_max_rows < 2:
            raise ValueError("provider_max_rows must be at least 2")

    def _emit(self, record):
        self.records.append(record)
        self.trace(record)

    def exported(self, method):
        return method.startswith("get_") and callable(getattr(self.module, method, None))

    def validation_failure(self, method, error, row_count):
        now = datetime.now(timezone.utc)
        self._sequence += 1
        self._emit({
            "id": f"panda-call-{self._sequence:03d}",
            "type": "panda-validation",
            "method": method,
            "paramsHash": hashlib.sha256(b"{}").hexdigest(),
            "startedAt": now.isoformat(),
            "endedAt": now.isoformat(),
            "durationMs": 0,
            "rowCount": row_count,
            "fields": [],
            "dataAsOf": None,
            "responseHash": None,
            "status": "error",
            "error": _sanitize_error(error),
            "cacheStatus": "disabled",
            "cacheKey": None,
            "cacheError": None,
            "truncated": True,
        })

    def _cache_key(self, method, params):
        payload = {
            "sdkVersion": str(getattr(self.module, "__version__", SDK_VERSION)),
            "method": method,
            "params": params,
            "reportDate": self.report_date,
        }
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str,
                       separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    def _cache_paths(self, cache_key):
        directory = pathlib.Path(self.cache_dir)
        return directory / f"{cache_key}.parquet", directory / f"{cache_key}.json"

    def _read_cache(self, cache_key):
        if not self.cache_dir or self.cache_days <= 0 or not self.report_date:
            return None, "disabled", None
        parquet_path, metadata_path = self._cache_paths(cache_key)
        if not parquet_path.is_file() or not metadata_path.is_file():
            return None, "miss", None
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            created = datetime.fromisoformat(str(metadata["createdAt"]).replace("Z", "+00:00"))
            age = datetime.now(timezone.utc) - created.astimezone(timezone.utc)
            if age < timedelta(0) or age > timedelta(days=self.cache_days):
                return None, "expired", None
            if metadata.get("contentHash") != _file_hash(parquet_path):
                return None, "invalid", "content hash mismatch"
            import pandas
            frame = pandas.read_parquet(parquet_path)
            rows = json.loads(frame.to_json(orient="records", date_format="iso"))
            if len(rows) != metadata.get("rowCount"):
                return None, "invalid", "row count mismatch"
            if sorted(frame.columns.tolist()) != sorted(metadata.get("fields", [])):
                return None, "invalid", "field list mismatch"
            return rows, "hit", None
        except Exception as error:
            return None, "read-error", _sanitize_error(error)

    def _write_cache(self, cache_key, rows):
        parquet_path, metadata_path = self._cache_paths(cache_key)
        parquet_path.parent.mkdir(parents=True, exist_ok=True)
        parquet_temp = parquet_path.with_name(f"{parquet_path.name}.{os.getpid()}.tmp")
        metadata_temp = metadata_path.with_name(f"{metadata_path.name}.{os.getpid()}.tmp")
        try:
            import pandas
            frame = pandas.DataFrame(rows)
            frame.to_parquet(parquet_temp, index=False)
            data_dates = [
                _iso_date(row.get("date") or row.get("nature_date") or
                          row.get("info_date"))
                for row in rows
            ]
            metadata = {
                "schemaVersion": "1.0",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "dataAsOf": max((value for value in data_dates if value), default=None),
                "fields": sorted(frame.columns.tolist()),
                "rowCount": len(rows),
                "contentHash": _file_hash(parquet_temp),
            }
            metadata_temp.write_text(
                json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            os.replace(parquet_temp, parquet_path)
            os.replace(metadata_temp, metadata_path)
            return None
        except Exception as error:
            for path in (parquet_temp, metadata_temp):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            return _sanitize_error(error)

    def begin_cache_transaction(self, method):
        if self._cache_transaction is not None:
            raise RuntimeError("cache transaction already active")
        self._cache_transaction = {
            "method": method,
            "pending": {},
            "hits": set(),
        }

    def _invalidate_cache(self, cache_key):
        if not self.cache_dir:
            return
        for path in self._cache_paths(cache_key):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def rollback_cache_transaction(self):
        transaction = self._cache_transaction
        self._cache_transaction = None
        if transaction is None:
            return
        for cache_key in transaction["hits"]:
            self._invalidate_cache(cache_key)

    def commit_cache_transaction(self):
        transaction = self._cache_transaction
        self._cache_transaction = None
        if transaction is None:
            return
        pending = transaction["pending"]
        write_errors = {}
        try:
            for cache_key, rows in pending.items():
                write_error = self._write_cache(cache_key, rows)
                if write_error:
                    write_errors[cache_key] = write_error
                    break
        except Exception as error:
            write_errors["transaction"] = _sanitize_error(error)
        if write_errors:
            for cache_key in pending:
                self._invalidate_cache(cache_key)

    def call(self, method, *, expected_max_rows=None,
             allow_over_provider_cap=False, required_date=None,
             required_symbols=None, minimum_symbol_coverage=None,
             batch_index=None, batch_count=None, **params):
        started = datetime.now(timezone.utc)
        rows = []
        status = "error"
        error = None
        truncated = False
        cache_status = "disabled"
        cache_error = None
        cache_key = self._cache_key(method, params)
        provider_fetched = False
        self._sequence += 1
        try:
            operation = getattr(self.module, method, None)
            if not method.startswith("get_") or not callable(operation):
                raise ValueError(f"panda-data=={SDK_VERSION} 未导出方法：{method}")
            cached, cache_status, cache_error = self._read_cache(cache_key)
            if cached is not None:
                rows = cached
                if (self._cache_transaction is not None and
                        self._cache_transaction["method"] == method):
                    self._cache_transaction["hits"].add(cache_key)
            else:
                rows = _records(operation(**params))
                provider_fetched = True
            if expected_max_rows is not None:
                cap_shape = (
                    not allow_over_provider_cap
                    and len(rows) >= self.provider_max_rows
                )
                if len(rows) > int(expected_max_rows) or cap_shape:
                    truncated = True
                    raise ValueError(
                        f"{method} 响应违反声明上限，疑似截断："
                        f"{len(rows)}/{expected_max_rows}"
                    )
            elif not allow_over_provider_cap and len(rows) >= self.provider_max_rows:
                truncated = True
                raise ValueError(
                    f"{method} response is truncated at provider cap: "
                    f"{len(rows)}/{self.provider_max_rows}"
                )
            if required_symbols is not None and required_date is not None:
                expected_symbols = {str(value) for value in required_symbols}
                present_symbols = {
                    str(row.get("symbol"))
                    for row in rows
                    if _date_text(row.get("date")) == _date_text(required_date)
                }
                coverage = (
                    len(expected_symbols & present_symbols) / len(expected_symbols)
                    if expected_symbols else 1
                )
                threshold = float(minimum_symbol_coverage or 1)
                if coverage < threshold:
                    truncated = True
                    raise ValueError(
                        f"{method} 报告日覆盖不足 (symbol coverage)："
                        f"{coverage:.1%} < {threshold:.1%}"
                    )
            if (provider_fetched and self.cache_dir and self.cache_days > 0 and
                    self.report_date):
                if (self._cache_transaction is not None and
                        self._cache_transaction["method"] == method):
                    self._cache_transaction["pending"][cache_key] = rows
                    cache_status = "miss"
                else:
                    write_error = self._write_cache(cache_key, rows)
                    if write_error:
                        cache_status = "write-error"
                        cache_error = write_error
                    else:
                        cache_status = "miss"
            status = "ok"
            return rows
        except Exception as cause:
            error = _sanitize_error(cause)
            raise
        finally:
            ended = datetime.now(timezone.utc)
            dates = [
                _iso_date(
                    row.get("date") or row.get("nature_date")
                    or row.get("info_date") or row.get("publish_date")
                    or row.get("in_date")
                )
                for row in rows
            ]
            scope_value = (
                params.get("symbol") or params.get("stock_symbol")
                or params.get("concept_stock")
            )
            requested_symbols = (
                {str(value) for value in scope_value}
                if isinstance(scope_value, (list, tuple, set))
                else ({str(scope_value)} if scope_value else set())
            )
            present_symbols = {
                str(row.get("symbol") or row.get("stock_symbol")
                    or row.get("concept_stock"))
                for row in rows
                if (row.get("symbol") or row.get("stock_symbol")
                    or row.get("concept_stock"))
            }
            call_coverage = (
                len(requested_symbols & present_symbols) / len(requested_symbols)
                if requested_symbols else (1 if status == "ok" else 0)
            )
            record = {
                "id": f"panda-call-{self._sequence:03d}",
                "type": "panda-call",
                "method": method,
                "paramsHash": hashlib.sha256(
                    json.dumps(params, sort_keys=True, default=str,
                               separators=(",", ":")).encode("utf-8")
                ).hexdigest(),
                "startedAt": started.isoformat(),
                "endedAt": ended.isoformat(),
                "durationMs": round((ended - started).total_seconds() * 1000),
                "rowCount": len(rows) if status == "ok" else None,
                "coverage": call_coverage,
                "fields": sorted({key for row in rows for key in row}),
                "window": (
                    f"{_iso_date(params.get('start_date'))}/"
                    f"{_iso_date(params.get('end_date'))}"
                    if params.get("start_date") and params.get("end_date")
                    else _iso_date(params.get("date"))
                ),
                "dataAsOf": max(
                    (item for item in dates if item),
                    default=_iso_date(
                        params.get("end_date") or params.get("date")
                        or params.get("info_date")
                    ),
                ),
                "responseHash": _content_hash(rows) if status == "ok" else None,
                "status": status,
                "error": error,
                "cacheStatus": cache_status,
                "cacheKey": cache_key if cache_status != "disabled" else None,
                "cacheError": cache_error,
                "retryCount": 0,
                "truncated": truncated,
                "providerMaxRows": self.provider_max_rows,
                "expectedMaxRows": expected_max_rows,
                "batchIndex": batch_index,
                "batchCount": batch_count,
                "_scopeSymbols": (
                    [str(value) for value in scope_value]
                    if isinstance(scope_value, (list, tuple, set))
                    else ([str(scope_value)] if scope_value else [])
                ),
            }
            self._emit(record)


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
    start = 0
    while start < len(finite):
        end = start + 1
        while end < len(finite) and finite[end][0] == finite[start][0]:
            end += 1
        average_rank = (start + end - 1) / 2
        value = 100.0 * average_rank / denominator
        for _, index in finite[start:end]:
            output[index] = value
        start = end
    return output


def effective_weights(values, weights, minimum_components):
    used = [key for key in weights if _is_finite(values.get(key))]
    if len(used) < minimum_components:
        return None, sum(weights[key] for key in used), used
    coverage = sum(weights[key] for key in used)
    score = sum(float(values[key]) * weights[key] for key in used) / coverage
    return score, coverage, used


def _freshness(data_date, report_date):
    try:
        age = max(0, (date.fromisoformat(report_date) - date.fromisoformat(data_date)).days)
    except (TypeError, ValueError):
        return None, .5
    if age <= 7:
        return age, 1
    if age <= 30:
        return age, .8
    return age, .5


def _metric_rows(row, weights, used, base_score, penalty=0):
    evidence = row.get("_metricEvidence") or {}
    available_weight = sum(weights[key] for key in used)
    metrics = []
    for key in used:
        detail = evidence.get(key) or {}
        percentile = float(row[key])
        effective = weights[key] / available_weight
        data_date = detail.get("dataDate") or row.get("dataDate")
        freshness_days, freshness_factor = _freshness(
            data_date, row.get("reportDate") or row.get("dataDate")
        )
        metrics.append({
            "id": detail.get("id") or f"metric-{_identity(row) or 'row'}-{key}",
            "name": key,
            "raw": detail.get("raw", percentile),
            "transformed": detail.get("transformed", detail.get("raw", percentile)),
            "winsorized": detail.get("winsorized", percentile),
            "percentile": percentile,
            "originalWeight": weights[key],
            "effectiveWeight": effective,
            "contribution": percentile * effective,
            "penalty": float(detail.get("penalty", 0) or 0),
            "coverage": float(detail.get("coverage", 1)),
            "dataDate": data_date,
            "freshnessDays": freshness_days,
            "freshnessFactor": freshness_factor,
            "window": detail.get("window") or "cross-section",
            "sourceRole": detail.get("sourceRole") or key,
            "positive": detail.get("positive"),
            "evidenceIds": list(detail.get("evidenceIds") or []),
        })
    # Avoid serialisation drift while making the contribution invariant exact.
    if metrics and base_score is not None:
        metrics[-1]["contribution"] += float(base_score) - sum(
            metric["contribution"] for metric in metrics
        )
    return metrics


def _risk_metric_rows(row):
    evidence = row.get("_riskMetricEvidence") or {}
    penalties = row.get("riskPenalties") or {}
    metrics = []
    for name, value in penalties.items():
        if not _is_finite(value) or float(value) <= 0:
            continue
        penalty = float(value)
        detail = evidence.get(name) or {}
        data_date = detail.get("dataDate") or row.get("dataDate")
        freshness_days, freshness_factor = _freshness(
            data_date, row.get("reportDate") or row.get("dataDate")
        )
        transformed = detail.get("transformed")
        transformed = float(transformed) if _is_finite(transformed) else penalty
        metrics.append({
            "id": detail.get("id") or (
                f"metric-{_identity(row) or 'row'}-risk-{name}"
            ),
            "name": f"risk_{name}",
            "raw": detail.get("raw", penalty),
            "transformed": transformed,
            "winsorized": transformed,
            "percentile": min(100, max(0, penalty * 20)),
            "originalWeight": 0,
            "effectiveWeight": 0,
            "contribution": 0,
            "penalty": penalty,
            "coverage": float(detail.get("coverage", 0)),
            "dataDate": data_date,
            "freshnessDays": freshness_days,
            "freshnessFactor": freshness_factor,
            "window": detail.get("window") or "risk-event",
            "sourceRole": detail.get("sourceRole") or f"risk_{name}",
            "positive": False,
            "evidenceIds": list(detail.get("evidenceIds") or []),
        })
    return metrics


def _percentile_components(rows, keys):
    output = [dict(row) for row in rows]
    for key in keys:
        raw = [row.get(key) for row in output]
        clipped = winsorize(raw)
        ranked = percentile_rank(clipped)
        for row, raw_value, winsorized_value, value in zip(
                output, raw, clipped, ranked):
            row.setdefault("_metricEvidence", {})[key] = {
                **(row.get("_metricEvidence", {}).get(key) or {}),
                "raw": raw_value,
                "transformed": raw_value,
                "winsorized": winsorized_value,
            }
            row[key] = value
    return output


def compute_hot_topics(groups, lhb_available=True):
    eligible, excluded = [], []
    for group in groups:
        constituent_count = group.get("constituent_count")
        coverage = group.get("coverage")
        if not _is_finite(constituent_count) or float(constituent_count) < 5:
            excluded.append({"id": group["id"], "reason": "MIN_CONSTITUENTS"})
        elif not _is_finite(coverage) or float(coverage) < .80:
            excluded.append({"id": group["id"], "reason": "MIN_COVERAGE"})
        elif group.get("membershipDate") and group["membershipDate"] > group.get(
                "reportDate", group["membershipDate"]):
            excluded.append({"id": group["id"], "reason": "FUTURE_MEMBERSHIP"})
        elif any(float((group.get("windowCoverage") or {}).get(key, coverage)) < .80
                 for key in HOT_REQUIRED_COMPONENTS):
            excluded.append({"id": group["id"], "reason": "MIN_WINDOW_COVERAGE"})
        elif not all(_is_finite(group.get(key)) for key in HOT_REQUIRED_COMPONENTS):
            excluded.append({"id": group["id"], "reason": "INSUFFICIENT_REQUIRED_COMPONENTS"})
        else:
            eligible.append(group)
    ranked_rows = _percentile_components(eligible, HOT_WEIGHTS)
    ranked = []
    for row in ranked_rows:
        values = {key: row.get(key) for key in HOT_WEIGHTS}
        if not lhb_available:
            values["lhb_activity"] = None
        score, coverage, used = effective_weights(values, HOT_WEIGHTS, 5)
        ranked.append({
            **row,
            "baseScore": score,
            "score": score,
            "weightCoverage": coverage,
            "componentsUsed": used,
            "componentCount": len(used),
            "metrics": _metric_rows(row, HOT_WEIGHTS, used, score),
            "scoreContributions": {
                item["name"]: item["contribution"]
                for item in _metric_rows(row, HOT_WEIGHTS, used, score)
            },
            "status": "RANKED",
        })
    ranked.sort(key=lambda item: (-(item["score"] if item["score"] is not None else -1), _identity(item)))
    return {"ranked": ranked, "excluded": excluded}


def compute_sell_pressure(rows):
    ranked = []
    for row in rows:
        score, coverage, used = effective_weights(row, SELL_WEIGHTS, 3)
        metrics = _metric_rows(row, SELL_WEIGHTS, used, score)
        fresh_security = (
            not row.get("reportDate")
            or row.get("dataDate") == row.get("reportDate")
        )
        ranked.append({
            **row, "baseScore": score, "score": score, "weightCoverage": coverage,
            "componentsUsed": used, "componentCount": len(used),
            "metrics": metrics,
            "scoreContributions": {
                item["name"]: item["contribution"] for item in metrics
            },
            "eligibilityFailures": (
                [] if fresh_security else ["STALE_SECURITY_DATE"]
            ),
            "status": (
                "RANKED" if score is not None and fresh_security
                else "EVIDENCE_INSUFFICIENT"
            ),
        })
    ranked.sort(key=lambda item: (-(item["score"] if item["score"] is not None else -1), _identity(item)))
    return ranked


def compute_potential_watchlist(rows):
    output = []
    for row in rows:
        vetoes = []
        if row.get("st") or row.get("delisting_risk"):
            vetoes.append("ST_OR_DELISTING_RISK")
        if row.get("tradable") is False or row.get("suspended"):
            vetoes.append("NOT_TRADABLE")
        if row.get("nonstandard_audit"):
            vetoes.append("NONSTANDARD_AUDIT")
        unlock = row.get("unlock_float_pct_30d")
        if _is_finite(unlock) and float(unlock) > 10:
            vetoes.append("LARGE_UNLOCK_30D")
        score, coverage, used = effective_weights(row, POTENTIAL_WEIGHTS, 4)
        evidence = row.get("_metricEvidence") or {}
        positive_used = [
            key for key in used
            if (evidence.get(key) or {}).get("positive") is True
        ]
        evidence_coverage = sum(
            POTENTIAL_WEIGHTS[key] * (
                max(
                    0,
                    min(1, float((evidence.get(key) or {}).get("coverage"))),
                )
                if key in evidence
                and _is_finite((evidence.get(key) or {}).get("coverage"))
                else 0
            )
            for key in used
        )
        candidate_eligible = (
            _is_finite(row.get("rowCount")) and float(row["rowCount"]) >= 20
            and _is_finite(row.get("medianAmount20"))
            and float(row["medianAmount20"]) >= float(row.get(
                "minLiquidityCny", 20_000_000
            ))
        )
        eligibility_failures = []
        if not candidate_eligible:
            eligibility_failures.append("CANDIDATE_GATE_FAILED")
        if (row.get("reportDate") and
                row.get("dataDate") != row.get("reportDate")):
            eligibility_failures.append("STALE_SECURITY_DATE")
        status = (
            "VETOED" if vetoes else
            ("RANKED" if score is not None and coverage >= .70
             and evidence_coverage >= .70 and len(positive_used) >= 4
             and not eligibility_failures
             else "EVIDENCE_INSUFFICIENT")
        )
        risk_penalty = row.get("risk_penalty")
        penalty = float(risk_penalty) if _is_finite(risk_penalty) else 0
        risk_metrics = _risk_metric_rows(row)
        if abs(sum(item["penalty"] for item in risk_metrics) - penalty) > 1e-8:
            eligibility_failures.append("RISK_EVIDENCE_MISSING")
            if status == "RANKED":
                status = "EVIDENCE_INSUFFICIENT"
        final = None if score is None else max(0, score - penalty)
        metrics = _metric_rows(row, POTENTIAL_WEIGHTS, used, score, penalty)
        metrics.extend(risk_metrics)
        output.append({
            **row, "baseScore": score, "score": final, "riskPenalty": penalty,
            "weightCoverage": coverage, "componentsUsed": used,
            "evidenceCoverage": evidence_coverage,
            "positiveFamilies": positive_used,
            "positiveFamilyCount": len(positive_used),
            "eligibilityFailures": eligibility_failures,
            "componentCount": len(used), "metrics": metrics,
            "scoreContributions": {
                **{item["name"]: item["contribution"] for item in metrics},
                "riskPenalty": -penalty,
            },
            "vetoes": vetoes, "status": status,
        })
    output.sort(key=lambda item: (item["status"] != "RANKED", -(item["score"] or -1), _identity(item)))
    return output


def _call_optional(collector, missing_data, section, method, **params):
    try:
        return collector.call(method, **params)
    except Exception as error:
        _record_missing(
            missing_data, section, method, "UNAVAILABLE",
            error=_sanitize_error(error),
        )
        return None


def _record_missing(missing_data, section, method, status, **details):
    duplicate = any(
        item.get("section") == section
        and item.get("method") == method
        and (
            method != "hot-topic-eligibility"
            or item.get("reason") == details.get("reason")
        )
        for item in missing_data
    )
    if duplicate:
        return
    missing = {"method": method, "section": section, "status": status, **details}
    if method == "get_lhb_list":
        missing["weightRemoved"] = HOT_WEIGHTS["lhb_activity"]
    missing_data.append(missing)


def _batches(values, size):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def _call_symbol_batches(collector, missing_data, section, method, symbols,
                         rows_per_symbol=1, symbol_param="symbol", **params):
    symbols = list(dict.fromkeys(str(value) for value in symbols if value))
    if not symbols:
        return [], True
    rows_per_symbol = max(1, int(rows_per_symbol))
    batch_size = max(1, (collector.provider_max_rows - 1) // rows_per_symbol)
    batches = list(_batches(symbols, batch_size))
    output = []
    for index, symbol_batch in enumerate(batches, start=1):
        try:
            call_params = {**params, symbol_param: symbol_batch}
            output.extend(collector.call(
                method,
                expected_max_rows=len(symbol_batch) * rows_per_symbol,
                batch_index=index,
                batch_count=len(batches),
                **call_params,
            ))
        except Exception as error:
            record = collector.records[-1] if collector.records else {}
            _record_missing(
                missing_data, section, method, "INCOMPLETE_RESPONSE",
                reason="provider batch failed or reached its row cap",
                error=_sanitize_error(error),
                batchIndex=index,
                batchCount=len(batches),
                truncated=bool(record.get("truncated")),
                expectedMaxRows=record.get("expectedMaxRows"),
                providerMaxRows=collector.provider_max_rows,
            )
            return [], False
    return output, True


def _daily_metrics(rows):
    by_symbol = defaultdict(list)
    for row in rows:
        by_symbol[str(row.get("symbol", ""))].append(row)
    output = {}
    for symbol, values in by_symbol.items():
        ordered = sorted(values, key=lambda item: _date_text(item.get("date")))
        valid = [
            item for item in ordered
            if _is_finite(item.get("close")) and _is_finite(item.get("pre_close"))
            and float(item["pre_close"]) > 0 and float(item["close"]) > 0
        ]
        closes = [float(item["close"]) for item in valid]
        if not valid:
            continue
        latest = valid[-1]
        pre_close = latest.get("pre_close")
        ret1 = (float(latest["close"]) / float(pre_close) - 1
                if _is_finite(pre_close) and float(pre_close) != 0 else None)
        log_returns = [
            math.log(float(item["close"]) / float(item["pre_close"]))
            for item in valid
        ]
        ret5 = math.exp(sum(log_returns[-5:])) - 1 if len(log_returns) >= 5 else None
        ret20 = math.exp(sum(log_returns[-20:])) - 1 if len(log_returns) >= 20 else None
        avg_log5 = sum(log_returns[-5:]) / 5 if len(log_returns) >= 5 else None
        avg_log20 = sum(log_returns[-20:]) / 20 if len(log_returns) >= 20 else None
        amounts = [float(item["amount"]) for item in ordered[-20:]
                   if _is_finite(item.get("amount"))]
        median_amount = statistics.median(amounts) if amounts else None
        latest_amount = float(latest["amount"]) if _is_finite(latest.get("amount")) else None
        turnover_heat = (
            latest_amount / median_amount
            if _is_finite(latest_amount) and _is_finite(median_amount)
            and median_amount != 0 else None
        )
        output[symbol] = {
            "symbol": symbol,
            "name": latest.get("name"),
            "dataDate": _iso_date(latest.get("date")),
            "ret1": ret1,
            "ret5": ret5,
            "ret20": ret20,
            "acceleration": avg_log5 - avg_log20
            if _is_finite(avg_log5) and _is_finite(avg_log20) else None,
            "turnover_heat": turnover_heat,
            "latestAmount": latest_amount,
            "medianAmount20": median_amount,
            "downside_volume": (
                max(0, -ret1) * turnover_heat
                if _is_finite(ret1) and _is_finite(turnover_heat) else None
            ),
            "volatility": max(closes[-20:]) / min(closes[-20:]) - 1
            if len(closes) >= 2 and min(closes[-20:]) else None,
            "rowCount": len(ordered),
            "dailySeries": [
                {
                    "date": _date_text(row.get("date")),
                    "amount": (
                        float(row["amount"]) if _is_finite(row.get("amount"))
                        else None
                    ),
                }
                for row in ordered[-20:]
                if _date_text(row.get("date"))
            ],
            "windowCoverage": {
                "ret1": min(1, len(log_returns)),
                "ret5": min(1, len(log_returns) / 5),
                "ret20": min(1, len(log_returns) / 20),
                "breadth5": min(1, len(log_returns) / 5),
                "turnover_heat": min(1, len(amounts) / 20),
                "acceleration": min(1, len(log_returns) / 20),
            },
            "isHeadlineEligible": (
                int(latest.get("trade_status", 1)) == 0 and
                not str(latest.get("name") or "").upper().startswith(("*ST", "ST"))
            ),
        }
    return output


def _active_industry_memberships(rows, report_date):
    cutoff = _date_text(report_date)
    output = []
    for row in rows or []:
        in_date = _date_text(row.get("in_date"))
        out_date = _date_text(row.get("out_date"))
        if not in_date or in_date > cutoff:
            continue
        if out_date and out_date <= cutoff:
            continue
        output.append(row)
    return output


def _point_in_time(rows, report_date, fields=("date", "info_date", "publish_date")):
    cutoff = _date_text(report_date)
    output = []
    for row in rows or []:
        availability_dates = [
            _date_text(row.get(field)) for field in fields
            if _date_text(row.get(field))
        ]
        if availability_dates and all(value <= cutoff for value in availability_dates):
            output.append(row)
    return output


def _latest_as_of_by_symbol(rows, report_date, availability_fields,
                            period_fields=()):
    eligible = _point_in_time(rows, report_date, fields=availability_fields)
    grouped = defaultdict(list)
    for row in eligible:
        if row.get("symbol"):
            grouped[str(row["symbol"])].append(row)

    def sort_key(row):
        availability = max(
            (_date_text(row.get(field)) for field in availability_fields),
            default="",
        )
        period = max(
            (_date_text(row.get(field)) for field in period_fields),
            default="",
        )
        return availability, period

    return {
        symbol: max(values, key=sort_key)
        for symbol, values in grouped.items()
    }


def _latest_actual_audit_by_symbol(rows, report_date):
    actual = [
        row for row in _point_in_time(rows, report_date, fields=("date",))
        if str(row.get("opinion") or "").strip() not in {
            "", "no_audit_performed"
        }
    ]
    grouped = defaultdict(list)
    for row in actual:
        if row.get("symbol"):
            grouped[str(row["symbol"])].append(row)
    output = {}
    for symbol, values in grouped.items():
        latest_date = max(_date_text(row.get("date")) for row in values)
        output[symbol] = [
            row for row in values if _date_text(row.get("date")) == latest_date
        ]
    return output


def _quarter_bounds(report_date, years=3):
    current_quarter = (report_date.month - 1) // 3 + 1
    completed_quarter = current_quarter - 1
    end_year = report_date.year
    if completed_quarter == 0:
        completed_quarter = 4
        end_year -= 1
    return (
        f"{report_date.year - int(years)}q1",
        f"{end_year}q{completed_quarter}",
    )


def _quarter_sequence(start_quarter, end_quarter):
    start_year, start_number = int(start_quarter[:4]), int(start_quarter[-1])
    end_year, end_number = int(end_quarter[:4]), int(end_quarter[-1])
    output = []
    year, number = start_year, start_number
    while (year, number) <= (end_year, end_number):
        output.append(f"{year}q{number}")
        number += 1
        if number == 5:
            year += 1
            number = 1
    return output


def _unlock_events_as_of(rows, report_date, days=30):
    cutoff = report_date.strftime("%Y%m%d")
    end = (report_date + timedelta(days=days)).strftime("%Y%m%d")
    return [
        row for row in rows or []
        if _date_text(row.get("date"))
        and _date_text(row.get("date")) <= cutoff
        and cutoff < _date_text(row.get("relieve_date")) <= end
    ]


def _discounted_block_trades(block_rows, daily_rows):
    close_by_symbol_date = {
        (str(row.get("symbol")), _date_text(row.get("date"))): float(row["close"])
        for row in daily_rows or []
        if row.get("symbol") and _date_text(row.get("date"))
        and _is_finite(row.get("close"))
    }
    return [
        row for row in block_rows or []
        if _is_finite(row.get("price"))
        and (
            str(row.get("symbol")), _date_text(row.get("date"))
        ) in close_by_symbol_date
        and float(row["price"]) < close_by_symbol_date[(
            str(row.get("symbol")), _date_text(row.get("date"))
        )]
    ]


def _complete_directional_lhb(buy_rows, sell_rows, buy_complete, sell_complete):
    if not buy_complete or not sell_complete:
        return None
    return _directional_lhb_net_sell(list(buy_rows or []) + list(sell_rows or []))


def _accelerating_groups_for_symbol(groups, symbol):
    return [
        group for group in groups
        if symbol in group.get("memberSymbols", [])
        and group.get("constituent_count", 0) >= 5
        and group.get("coverage", 0) >= .8
        and _is_finite(group.get("acceleration"))
        and float(group["acceleration"]) > 0
    ]


def _record_hot_exclusions(missing_data, section, source_method, exclusions=None):
    if exclusions is None:
        exclusions = source_method
        source_method = "hot-topic-eligibility"
    for exclusion in exclusions:
        reason = exclusion.get("reason") or "UNKNOWN"
        method = source_method if reason == "MIN_COVERAGE" else "hot-topic-eligibility"
        status = (
            "COVERAGE_INSUFFICIENT"
            if reason == "MIN_COVERAGE"
            else "ELIGIBILITY_INSUFFICIENT"
        )
        _record_missing(
            missing_data,
            section,
            method,
            status,
            reason=reason,
            groupId=exclusion.get("id"),
        )


def _mean_present(rows, key):
    values = [float(row[key]) for row in rows if _is_finite(row.get(key))]
    return sum(values) / len(values) if values else None


def _group_metrics(memberships, daily, group_code, group_name, member_code,
                   lhb_symbols, lhb_complete=True, metric_prefix="group"):
    grouped = defaultdict(list)
    names = {}
    membership_dates = defaultdict(list)
    for row in memberships or []:
        code = str(row.get(group_code, ""))
        symbol = str(row.get(member_code, ""))
        if code and symbol:
            grouped[code].append(symbol)
            names[code] = row.get(group_name) or code
            membership_date = _date_text(
                row.get("date") or row.get("in_date") or row.get("info_date")
            )
            if membership_date:
                membership_dates[code].append(membership_date)
    output = []
    for code, symbols in grouped.items():
        unique = sorted(set(symbols))
        covered = [daily[symbol] for symbol in unique if symbol in daily]
        count = len(unique)
        factor_coverage = {}
        for factor, daily_factor in {
            "ret1": "ret1",
            "ret5": "ret5",
            "breadth5": "ret5",
            "turnover_heat": "turnover_heat",
            "acceleration": "acceleration",
        }.items():
            factor_coverage[factor] = (
                sum(
                    _is_finite(item.get(daily_factor))
                    and float((item.get("windowCoverage") or {}).get(factor, 0)) >= .8
                    for item in covered
                ) / count if count else 0
            )
        ret1_values = [
            item.get("ret1") for item in covered if _is_finite(item.get("ret1"))
        ]
        ret5_values = [
            item.get("ret5") for item in covered if _is_finite(item.get("ret5"))
        ]
        daily_group_amount = defaultdict(float)
        for item in covered:
            for daily_row in item.get("dailySeries") or []:
                if (_date_text(daily_row.get("date"))
                        and _is_finite(daily_row.get("amount"))):
                    daily_group_amount[_date_text(daily_row["date"])] += float(
                        daily_row["amount"]
                    )
        aggregate_amounts = [
            value for _, value in sorted(daily_group_amount.items())[-20:]
        ]
        group_median_amount = (
            statistics.median(aggregate_amounts) if aggregate_amounts else None
        )
        group_latest_amount = aggregate_amounts[-1] if aggregate_amounts else None
        raw_metrics = {
            "ret1": (
                sum(winsorize(ret1_values)) / len(ret1_values)
                if ret1_values else None
            ),
            "ret5": (
                sum(winsorize(ret5_values)) / len(ret5_values)
                if ret5_values else None
            ),
            "breadth5": (
                sum(float(item["ret5"]) > 0 for item in covered
                    if _is_finite(item.get("ret5"))) /
                max(1, sum(_is_finite(item.get("ret5")) for item in covered))
            ),
            "turnover_heat": (
                group_latest_amount / group_median_amount
                if _is_finite(group_latest_amount)
                and _is_finite(group_median_amount)
                and float(group_median_amount) > 0 else None
            ),
            "acceleration": (
                sum(winsorize([
                    float(item["acceleration"]) for item in covered
                    if _is_finite(item.get("acceleration"))
                ])) / len([
                    item for item in covered
                    if _is_finite(item.get("acceleration"))
                ])
                if any(_is_finite(item.get("acceleration")) for item in covered)
                else None
            ),
            "lhb_activity": (
                sum(symbol in lhb_symbols for symbol in unique if symbol in daily)
                / len(covered)
                if lhb_complete and covered else None
            ),
        }
        data_date = max(
            (item.get("dataDate") for item in covered if item.get("dataDate")),
            default=None,
        )
        output.append({
            "id": code,
            "name": names[code],
            "constituent_count": count,
            "coverage": len(covered) / count if count else 0,
            "windowCoverage": factor_coverage,
            "membershipDate": max(membership_dates.get(code) or [None]),
            **raw_metrics,
            "dataDate": data_date,
            "_metricEvidence": {
                key: {
                    "raw": value,
                    "id": f"metric-{metric_prefix}-{code}-{key}",
                    "transformed": value,
                    "dataDate": data_date,
                    "window": (
                        "1d" if key == "ret1" else
                        "5d" if key in {"ret5", "breadth5"} else "20d"
                    ),
                    "coverage": (
                        factor_coverage.get(key, len(covered) / count if count else 0)
                    ),
                    "evidenceIds": [],
                }
                for key, value in raw_metrics.items()
            },
            "memberSymbols": unique,
            "representativeSymbols": unique[:3],
        })
    return output


def _rank_columns(rows, keys):
    output = [dict(row) for row in rows]
    for key in keys:
        raw = [row.get(key) for row in output]
        clipped = winsorize(raw)
        ranked = percentile_rank(clipped)
        for row, raw_value, winsorized_value, value in zip(
                output, raw, clipped, ranked):
            row.setdefault("_metricEvidence", {})[key] = {
                **(row.get("_metricEvidence", {}).get(key) or {}),
                "raw": raw_value,
                "transformed": raw_value,
                "winsorized": winsorized_value,
            }
            row[key] = value
    return output


def _public_ranked(rows, top_n):
    allowed = {
        "symbol", "name", "id", "dataDate", "score", "baseScore", "weightCoverage",
        "componentsUsed", "status", "vetoes", "confidence", "constituent_count",
        "coverage", "representativeSymbols", "financialEvidenceDate",
        "componentCount", "metrics", "scoreContributions", "riskPenalty",
        "riskPenalties", "medianAmount20", "membershipDate", "windowCoverage",
        "evidenceCoverage", "positiveFamilies", "positiveFamilyCount",
        "eligibilityFailures",
    }
    eligible = [row for row in rows if row.get("status", "RANKED") == "RANKED"]
    return [
        {
            "rank": rank,
            **{key: value for key, value in row.items() if key in allowed},
        }
        for rank, row in enumerate(eligible[:top_n], start=1)
    ]


def _directional_lhb_net_sell(rows):
    output = defaultdict(float)
    for row in rows or []:
        if str(row.get("side") or "").lower() not in {"buy", "sell"}:
            continue
        if not _is_finite(row.get("s_value")) or not _is_finite(row.get("b_value")):
            continue
        output[str(row.get("symbol"))] += (
            float(row["s_value"]) - float(row["b_value"])
        )
    return dict(output)


def _dated_delta(rows, field):
    grouped = defaultdict(list)
    for row in rows or []:
        if row.get("symbol") and _is_finite(row.get(field)):
            grouped[str(row["symbol"])].append(row)
    output = {}
    for symbol, values in grouped.items():
        ordered = sorted(values, key=lambda item: _date_text(
            item.get("date") or item.get("info_date")
        ))
        if len(ordered) >= 2:
            output[symbol] = float(ordered[-1][field]) - float(ordered[0][field])
    return output


def _latest_by_symbol(rows, date_fields=("date", "info_date")):
    grouped = defaultdict(list)
    for row in rows or []:
        if row.get("symbol"):
            grouped[str(row["symbol"])].append(row)
    return {
        symbol: max(values, key=lambda item: max(
            (_date_text(item.get(field)) for field in date_fields), default=""
        ))
        for symbol, values in grouped.items()
    }


def _collector_call_ids(collector, *methods, symbols=None):
    wanted = set(methods)
    relevant_symbols = {str(value) for value in (symbols or [])}
    return [
        record["id"] for record in collector.records
        if record.get("method") in wanted and record.get("status") == "ok"
        and (
            not relevant_symbols
            or not record.get("_scopeSymbols")
            or bool(relevant_symbols & set(record["_scopeSymbols"]))
        )
    ]


def _listing_date(row):
    for field in ("listing_date", "list_date", "ipo_date"):
        value = _date_text(row.get(field))
        if value:
            return value
    return ""


def _skipped_evidence_pack(request, requested, reason):
    run_seed = json.dumps(
        {
            "operation": request.get("operation"),
            "date": requested.isoformat(),
            "topN": request.get("topN", 10),
            "status": "skipped",
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return {
        "schemaVersion": "1.0",
        "evidenceModelVersion": EVIDENCE_MODEL_VERSION,
        "runId": request.get("runId") or hashlib.sha256(run_seed.encode()).hexdigest()[:16],
        "reportDate": requested.isoformat(),
        "status": "skipped",
        "skipReason": reason,
        "markets": {},
        "conclusions": [],
        "leaderboards": {},
        "sources": [],
        "missingData": [],
    }


def build_evidence_pack(request, collector, now):
    for required_method in (
            "get_trade_cal", "get_last_trade_date", "get_trade_list",
            "get_stock_daily"):
        if not collector.exported(required_method):
            raise ValueError(
                f"panda-data=={SDK_VERSION} missing required export: {required_method}"
            )
    if request.get("operation") != "daily-market-report":
        raise ValueError("不支持的 operation")
    current = _parse_now(now)
    shanghai_now = current.astimezone(ZoneInfo("Asia/Shanghai"))
    requested_iso = request.get("date") or shanghai_now.date().isoformat()
    try:
        requested = date.fromisoformat(requested_iso)
    except (TypeError, ValueError) as error:
        raise ValueError("date 必须为 YYYY-MM-DD") from error
    if requested > shanghai_now.date():
        raise ValueError("报告日期尚未完成")
    report_compact = requested.strftime("%Y%m%d")
    collector.report_date = report_compact
    target_calendar = collector.call(
        "get_trade_cal",
        expected_max_rows=2,
        start_date=report_compact,
        end_date=report_compact,
        exchange="SH",
        is_trading_day=None,
        fields=["nature_date", "exchange", "is_trade"],
    )
    target_rows = [
        row for row in target_calendar
        if _date_text(row.get("nature_date")) == report_compact
    ]
    if not target_rows:
        raise ValueError("Panda trading calendar omitted the report date")
    if not any(int(row.get("is_trade", 0)) == 1 for row in target_rows):
        return _skipped_evidence_pack(
            request,
            requested,
            "Panda SH exchange calendar reports a non-trading day",
        )
    if requested == shanghai_now.date() and shanghai_now.hour < 15:
        raise ValueError("报告日期交易时段尚未完成")
    latest_rows = collector.call(
        "get_last_trade_date", expected_max_rows=10, exchange="SH"
    )
    latest = max((_date_text(row.get("date")) for row in latest_rows), default="")
    if not latest:
        raise ValueError("Panda latest completed trading date is unavailable")
    calendar_start = (requested - timedelta(days=120)).strftime("%Y%m%d")
    sh_calendar = collector.call(
        "get_trade_cal",
        expected_max_rows=200,
        start_date=calendar_start,
        end_date=report_compact,
        exchange="SH",
        is_trading_day=1,
        fields=["nature_date", "exchange", "is_trade"],
    )
    trade_dates = sorted({
        _date_text(row.get("nature_date"))
        for row in sh_calendar
        if int(row.get("is_trade", 0)) == 1 and _date_text(row.get("nature_date"))
    })
    if not latest or report_compact > latest or report_compact not in trade_dates:
        raise ValueError("报告日期不是已完成交易日")
    if len(trade_dates) < REQUIRED_TRADING_SESSIONS:
        raise ValueError(
            f"交易日历覆盖不足：需要 {REQUIRED_TRADING_SESSIONS} 个已完成交易日"
        )
    window_dates = trade_dates[-REQUIRED_TRADING_SESSIONS:]
    window_date_set = set(window_dates)

    universe_rows = collector.call(
        "get_trade_list",
        expected_max_rows=20_000,
        allow_over_provider_cap=True,
        date=report_compact,
        exchange="SH",
    )
    universe = sorted({str(row.get("symbol")) for row in universe_rows if row.get("symbol")})
    if not universe:
        raise ValueError("在售股票列表为空")

    collector.begin_cache_transaction("get_stock_daily")
    daily_rows = []
    daily_fields = [
        "symbol", "date", "name", "open", "close", "high", "low", "volume", "amount",
        "pre_close", "limit_up", "limit_down", "trade_status",
    ]
    daily_batch_size = max(
        1, (collector.provider_max_rows - 1) // len(window_dates)
    )
    try:
        for symbol_batch in _batches(universe, daily_batch_size):
            batch_rows = collector.call(
                "get_stock_daily",
                expected_max_rows=len(symbol_batch) * len(window_dates),
                start_date=window_dates[0],
                end_date=window_dates[-1],
                symbol=symbol_batch,
                fields=daily_fields,
                st=True,
            )
            daily_rows.extend(batch_rows)
    except Exception:
        collector.rollback_cache_transaction()
        raise
    daily_rows = [
        row for row in daily_rows
        if str(row.get("symbol")) in universe and
        _date_text(row.get("date")) in window_date_set
    ]
    covered_symbols = {
        str(row.get("symbol"))
        for row in daily_rows
        if _date_text(row.get("date")) == report_compact
    }
    daily_coverage = len(covered_symbols) / len(universe)
    if daily_coverage < CORE_REPORT_DATE_COVERAGE:
        error = ValueError(
            f"A股报告日日线覆盖不足：{daily_coverage:.1%} < "
            f"{CORE_REPORT_DATE_COVERAGE:.1%}"
        )
        collector.validation_failure("get_stock_daily", error, len(daily_rows))
        collector.rollback_cache_transaction()
        raise error

    universe_by_symbol = {
        str(row.get("symbol")): row for row in universe_rows if row.get("symbol")
    }
    expected_pairs = set()
    window_start, window_end = window_dates[0], window_dates[-1]
    for symbol in universe:
        listing = _listing_date(universe_by_symbol.get(symbol, {}))
        expected_dates = (
            [value for value in window_dates if value >= listing]
            if window_start <= listing <= window_end else window_dates
        )
        expected_pairs.update((symbol, value) for value in expected_dates)
    actual_pairs = {
        (str(row.get("symbol")), _date_text(row.get("date")))
        for row in daily_rows
        if str(row.get("symbol")) in universe and
        _date_text(row.get("date")) in window_date_set
    }
    historical_coverage = (
        len(actual_pairs & expected_pairs) / len(expected_pairs)
        if expected_pairs else 0
    )
    if historical_coverage < CORE_REPORT_DATE_COVERAGE:
        error = ValueError(
            f"A股历史 symbol-session 覆盖不足：{historical_coverage:.1%} < "
            f"{CORE_REPORT_DATE_COVERAGE:.1%}"
        )
        collector.validation_failure("get_stock_daily", error, len(daily_rows))
        collector.rollback_cache_transaction()
        raise error

    collector.commit_cache_transaction()

    daily = _daily_metrics(daily_rows)
    min_liquidity = float(request.get("minLiquidityCny", 20_000_000))
    preliminary = sorted(
        (item for item in daily.values()
         if item.get("isHeadlineEligible")
         and item.get("rowCount", 0) >= 20
         and _is_finite(item.get("medianAmount20"))
         and item["medianAmount20"] >= min_liquidity),
        key=lambda item: (-item["medianAmount20"], item["symbol"]),
    )[:MAX_PRELIMINARY_CANDIDATES]
    enriched = preliminary[:MAX_FULL_ENRICHMENT]
    candidate_symbols = [item["symbol"] for item in enriched]

    missing_data = []
    for section in ("hk", "futures", "funds", "options", "macro"):
        _record_missing(
            missing_data, section, "not-implemented", "NOT_IMPLEMENTED",
            reason="required Panda context query plan is not implemented",
        )
    industries, industries_complete = _call_symbol_batches(
        collector, missing_data, "hotIndustries", "get_industry_constituents",
        universe, rows_per_symbol=4, symbol_param="stock_symbol",
        level="L1",
        fields=["stock_symbol", "l1_code", "l1_name", "in_date", "out_date"],
    )
    active_industries = _active_industry_memberships(industries, report_compact)
    if not active_industries:
        _record_missing(
            missing_data, "hotIndustries", "get_industry_constituents",
            "POINT_IN_TIME_INSUFFICIENT",
        )
    concepts = _call_optional(
        collector, missing_data, "hotConcepts", "get_concept_list",
        expected_max_rows=collector.provider_max_rows - 1,
        end_date=report_compact,
    )
    concept_memberships = None
    if concepts is not None:
        concept_names = sorted({
            str(row.get("name")) for row in concepts
            if row.get("name") and _date_text(row.get("date")) and
            _date_text(row.get("date")) <= report_compact
        })
        if not concept_names:
            _record_missing(
                missing_data, "hotConcepts", "get_concept_list",
                "POINT_IN_TIME_INSUFFICIENT",
            )
        else:
            concept_memberships, concept_memberships_complete = _call_symbol_batches(
                collector, missing_data, "hotConcepts", "get_concept_constituents",
                universe, rows_per_symbol=20, symbol_param="concept_stock",
                concept=concept_names,
                date=report_compact,
                fields=["concept", "concept_stock", "date"],
            )
            concept_memberships = _point_in_time(concept_memberships, report_compact)
            if not concept_memberships:
                _record_missing(
                    missing_data, "hotConcepts", "get_concept_constituents",
                    "POINT_IN_TIME_INSUFFICIENT",
                )

    lhb_query_symbols = sorted(covered_symbols) if candidate_symbols else []
    lhb, lhb_complete = _call_symbol_batches(
        collector,
        missing_data,
        "lhb",
        "get_lhb_list",
        lhb_query_symbols,
        rows_per_symbol=20,
        start_date=window_dates[-20],
        end_date=report_compact,
        fields=[
            "symbol", "date", "start_date", "end_date", "type",
            "amount", "volume", "change_rate",
        ],
    )
    lhb = _point_in_time(
        lhb, report_compact, fields=("date", "start_date", "end_date")
    )
    lhb_available = lhb_complete and bool(lhb_query_symbols) and bool(lhb)
    if lhb_query_symbols and not lhb:
        _record_missing(
            missing_data,
            "lhb",
            "get_lhb_list",
            "POINT_IN_TIME_INSUFFICIENT",
        )
    lhb_symbols = {str(row.get("symbol")) for row in (lhb or []) if row.get("symbol")}

    enrichment_start = window_dates[-20]
    enrichment_end = report_compact
    lhb_by_side = {}
    lhb_side_complete = {}
    for side in ("buy", "sell"):
        lhb_by_side[side], lhb_side_complete[side] = _call_symbol_batches(
            collector, missing_data, "sellPressure", "get_lhb_detail",
            candidate_symbols, rows_per_symbol=100,
            start_date=enrichment_start, end_date=enrichment_end, side=side,
            fields=[
                "symbol", "date", "type", "side", "rank", "agency",
                "b_value", "s_value", "reason",
            ],
        )
        lhb_by_side[side] = _point_in_time(
            lhb_by_side[side], report_compact, fields=("date",)
        )
    directional_lhb = _complete_directional_lhb(
        lhb_by_side["buy"], lhb_by_side["sell"],
        lhb_side_complete["buy"], lhb_side_complete["sell"],
    )
    directional_lhb_complete = directional_lhb is not None
    directional_lhb = directional_lhb or {}
    hsgt, hsgt_complete = _call_symbol_batches(
        collector, missing_data, "capital", "get_hsgt_hold",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=enrichment_end,
        fields=["symbol", "date", "shares_num", "holding_ratio",
                "adjusted_holding_ratio"],
    )
    hsgt_delta = _dated_delta(hsgt, "holding_ratio")
    margin, margin_complete = _call_symbol_batches(
        collector, missing_data, "capital", "get_margin",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=enrichment_end,
        margin_type="cash",
        fields=["symbol", "date", "margin_balance", "buy_on_margin_value",
                "total_balance", "margin_type"],
    )
    margin_delta = _dated_delta(margin, "margin_balance")
    block_trades, block_complete = _call_symbol_batches(
        collector, missing_data, "capital", "get_block_trade",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=enrichment_end,
        fields=["symbol", "date", "price", "volume", "amount", "buyer", "seller"],
    )
    block_trades = _point_in_time(block_trades, report_compact, fields=("date",))
    shareholder_changes, shareholder_complete = _call_symbol_batches(
        collector, missing_data, "events", "get_stock_shareholder_change",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=enrichment_end,
        fields=["symbol", "info_date", "begin_date", "end_date", "direction",
                "ratio_up_limit", "change_up_limit", "progress"],
    )
    shareholder_changes = _point_in_time(
        shareholder_changes, report_compact, fields=("info_date",)
    )
    investor_activity, activity_complete = _call_symbol_batches(
        collector, missing_data, "capital", "get_investor_activity",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=enrichment_end,
        fields=["symbol", "date", "participant", "institute"],
    )
    investor_activity = _point_in_time(
        investor_activity, report_compact, fields=("date",)
    )

    start_quarter, end_quarter = _quarter_bounds(requested, years=3)
    financial, financial_complete = _call_symbol_batches(
        collector, missing_data, "fundamentals", "get_fina_reports",
        candidate_symbols, rows_per_symbol=16,
        start_quarter=start_quarter,
        end_quarter=end_quarter,
        date=report_compact,
        is_latest=False,
        fields=["symbol", "date", "quarter"],
    )
    financial = _point_in_time(financial, report_compact)
    if candidate_symbols and not financial:
        _record_missing(
            missing_data, "fundamentals", "get_fina_reports",
            "POINT_IN_TIME_INSUFFICIENT",
        )
    financial_symbols = {
        str(row.get("symbol")) for row in (financial or []) if row.get("symbol")
    }
    financial_coverage = (
        len(financial_symbols & set(candidate_symbols)) / len(candidate_symbols)
        if candidate_symbols else 1
    )
    if candidate_symbols and financial_coverage < OPTIONAL_CANDIDATE_COVERAGE:
        _record_missing(
            missing_data, "fundamentals", "get_fina_reports",
            "COVERAGE_INSUFFICIENT", coverage=financial_coverage,
        )
    financial_by_symbol = defaultdict(list)
    for row in financial or []:
        financial_by_symbol[str(row.get("symbol"))].append(row)

    performance = []
    performance_complete = True
    performance_quarters = _quarter_sequence(start_quarter, end_quarter)[-8:]
    for performance_quarter in performance_quarters:
        quarter_rows, quarter_complete = _call_symbol_batches(
            collector, missing_data, "fundamentals", "get_fina_performance",
            candidate_symbols, rows_per_symbol=2,
            end_quarter=performance_quarter,
            fields=[
                "symbol", "info_date", "end_date", "roe_weighted",
                "net_profit_parent_yoy", "net_cash_flow_operating_yoy",
            ],
        )
        if not quarter_complete:
            performance_complete = False
            performance = []
            break
        performance.extend(quarter_rows)
    performance = _point_in_time(
        performance, report_compact, fields=("info_date",)
    )
    if candidate_symbols and not performance:
        _record_missing(
            missing_data, "fundamentals", "get_fina_performance",
            "POINT_IN_TIME_INSUFFICIENT",
        )
    performance_by_symbol = _latest_as_of_by_symbol(
        performance, report_compact, ("info_date",), ("end_date",)
    )

    audit, audit_complete = _call_symbol_batches(
        collector, missing_data, "events", "get_audit_opinion",
        candidate_symbols, rows_per_symbol=16,
        start_quarter=start_quarter, end_quarter=end_quarter,
        market="cn",
        fields=["symbol", "date", "quarter", "audit_type", "opinion"],
    )
    audit_by_symbol = _latest_actual_audit_by_symbol(audit, report_compact)

    unlock_end = (requested + timedelta(days=30)).strftime("%Y%m%d")
    restricted, restricted_complete = _call_symbol_batches(
        collector, missing_data, "events", "get_restricted_list",
        candidate_symbols, rows_per_symbol=20,
        start_date=(requested - timedelta(days=365)).strftime("%Y%m%d"),
        end_date=unlock_end,
        market="cn",
        fields=["symbol", "date", "relieve_date", "relieve_shares",
                "actual_relieve_shares"],
    )
    restricted = _unlock_events_as_of(restricted, requested, days=30)
    share_float, float_complete = _call_symbol_batches(
        collector, missing_data, "events", "get_share_float",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=report_compact,
        fields=["symbol", "date", "free_circulation", "circulation_a", "total"],
    )
    float_by_symbol = _latest_as_of_by_symbol(
        share_float, report_compact, ("date",)
    )
    unlock_shares = defaultdict(float)
    for row in restricted or []:
        if report_compact < _date_text(row.get("relieve_date")) <= unlock_end:
            value = row.get("actual_relieve_shares")
            if not _is_finite(value):
                value = row.get("relieve_shares")
            if _is_finite(value):
                unlock_shares[str(row.get("symbol"))] += float(value)
    status_changes, status_complete = _call_symbol_batches(
        collector, missing_data, "events", "get_stock_status_change",
        candidate_symbols, rows_per_symbol=20,
        start_date=window_dates[0], end_date=report_compact,
        fields=["symbol", "date", "change_date", "description", "name", "type"],
    )
    status_by_symbol = _latest_as_of_by_symbol(
        status_changes, report_compact, ("date",), ("change_date",)
    )
    pledges, pledge_complete = _call_symbol_batches(
        collector, missing_data, "events", "get_stock_pledge",
        candidate_symbols, rows_per_symbol=20,
        start_date=enrichment_start, end_date=report_compact,
        fields=["symbol", "publish_date", "acc_pledge_total_ratio",
                "acc_pledged_hold_ratio", "is_released"],
    )
    pledge_by_symbol = _latest_as_of_by_symbol(
        pledges, report_compact, ("publish_date",)
    )
    forecasts = []
    forecast_complete = True
    for forecast_quarter in _quarter_sequence(start_quarter, end_quarter)[-4:]:
        quarter_rows, quarter_complete = _call_symbol_batches(
            collector, missing_data, "events", "get_fina_forecast",
            candidate_symbols, rows_per_symbol=1,
            end_quarter=forecast_quarter,
            fields=["symbol", "info_date", "end_date", "forecast_type",
                    "forecast_growth_rate_floor", "forecast_growth_rate_ceiling",
                    "forecast_np_floor", "forecast_np_ceiling"],
        )
        if not quarter_complete:
            forecast_complete = False
            forecasts = []
            break
        forecasts.extend(quarter_rows)
    forecast_by_symbol = _latest_as_of_by_symbol(
        forecasts, report_compact, ("info_date",), ("end_date",)
    )

    headline_ineligible = {
        symbol for symbol, item in daily.items()
        if (not item.get("isHeadlineEligible")
            or item.get("dataDate") != requested.isoformat())
    }
    headline_daily = {
        symbol: item for symbol, item in daily.items()
        if item.get("isHeadlineEligible")
        and item.get("dataDate") == requested.isoformat()
    }
    industry_groups = _group_metrics(
        [row for row in active_industries
         if str(row.get("stock_symbol")) not in headline_ineligible],
        headline_daily, "l1_code", "l1_name", "stock_symbol", lhb_symbols,
        lhb_available, "industry",
    )
    concept_groups = _group_metrics(
        [row for row in (concept_memberships or [])
         if str(row.get("concept_stock")) not in headline_ineligible],
        headline_daily, "concept", "concept", "concept_stock", lhb_symbols,
        lhb_available, "concept",
    )
    for group in industry_groups:
        group["reportDate"] = requested.isoformat()
        for name, detail in group.get("_metricEvidence", {}).items():
            detail["evidenceIds"] = _collector_call_ids(
                collector,
                "get_stock_daily",
                "get_industry_constituents",
                *(["get_lhb_list"] if name == "lhb_activity" else []),
                symbols=group.get("memberSymbols"),
            )
    for group in concept_groups:
        group["reportDate"] = requested.isoformat()
        for name, detail in group.get("_metricEvidence", {}).items():
            detail["evidenceIds"] = _collector_call_ids(
                collector,
                "get_stock_daily",
                "get_concept_list",
                "get_concept_constituents",
                *(["get_lhb_list"] if name == "lhb_activity" else []),
                symbols=group.get("memberSymbols"),
            )
    hot_industries = compute_hot_topics(industry_groups, lhb_available=lhb_available)
    hot_concepts = compute_hot_topics(concept_groups, lhb_available=lhb_available)
    _record_hot_exclusions(
        missing_data,
        "hotIndustries",
        "get_industry_constituents",
        hot_industries["excluded"],
    )
    _record_hot_exclusions(
        missing_data,
        "hotConcepts",
        "get_concept_constituents",
        hot_concepts["excluded"],
    )

    _record_missing(
        missing_data, "valuation", "get_factor", "METRIC_UNAVAILABLE",
        reason=(
            "panda-data==0.0.12 documentation does not define an approved "
            "point-in-time valuation factor"
        ),
    )

    def evidence_ids(*methods, symbols=None):
        return _collector_call_ids(collector, *methods, symbols=symbols)

    def evidence_date(*methods, symbol=None):
        ids = set(evidence_ids(
            *methods, symbols=([symbol] if symbol else None)
        ))
        values = [
            record.get("dataAsOf") for record in collector.records
            if record.get("id") in ids and record.get("dataAsOf")
        ]
        return min(values) if values else None

    block_by_symbol = defaultdict(list)
    for row in block_trades or []:
        block_by_symbol[str(row.get("symbol"))].append(row)
    change_by_symbol = defaultdict(list)
    for row in shareholder_changes or []:
        change_by_symbol[str(row.get("symbol"))].append(row)
    activity_symbols = {
        str(row.get("symbol")) for row in (investor_activity or [])
        if row.get("symbol")
    }
    market_ret20_values = [
        float(item["ret20"]) for item in headline_daily.values()
        if _is_finite(item.get("ret20"))
    ]
    market_ret20 = (
        sum(market_ret20_values) / len(market_ret20_values)
        if market_ret20_values else None
    )

    candidate_rows = []
    for item in enriched:
        latest_fina = performance_by_symbol.get(item["symbol"], {})
        quality_values = [
            float(latest_fina[key]) for key in (
                "roe_weighted", "net_profit_parent_yoy",
                "net_cash_flow_operating_yoy",
            )
            if _is_finite(latest_fina.get(key))
        ]
        symbol = item["symbol"]
        broad_groups = _accelerating_groups_for_symbol(
            industry_groups + concept_groups, symbol
        )
        trend_value = (
            float(item["ret20"]) - float(market_ret20)
            + max(-.05, min(.05, float(item.get("acceleration") or 0)))
            if _is_finite(item.get("ret20")) and _is_finite(market_ret20)
            else None
        )
        theme_value = (
            sum(float(group["acceleration"]) for group in broad_groups)
            / len(broad_groups) if broad_groups else None
        )
        capital_signals = []
        if symbol in hsgt_delta:
            capital_signals.append(hsgt_delta[symbol])
        if symbol in directional_lhb:
            capital_signals.append(-directional_lhb[symbol])
        if symbol in margin_delta:
            capital_signals.append(margin_delta[symbol])
        if symbol in activity_symbols:
            capital_signals.append(1)
        capital_value = (
            sum(1 if value > 0 else -1 if value < 0 else 0
                for value in capital_signals)
            if len(capital_signals) >= 2 else None
        )
        discounted_blocks = _discounted_block_trades(
            block_by_symbol.get(symbol, []), daily_rows
        )
        reductions = [
            row for row in change_by_symbol.get(symbol, [])
            if "减持" in str(row.get("direction") or "")
        ] if shareholder_complete else []
        float_row = float_by_symbol.get(symbol, {})
        free_float = float_row.get("free_circulation")
        unlock_pct = (
            unlock_shares[symbol] / float(free_float) * 100
            if _is_finite(free_float) and float(free_float) > 0
            and unlock_shares.get(symbol)
            and restricted_complete and float_complete else None
        )
        latest_audit_rows = audit_by_symbol.get(symbol, [])
        nonstandard_audit = (
            audit_complete and bool(latest_audit_rows)
            and any(
                str(row.get("opinion") or "") not in {
                    "", "unqualified_opinion", "no_audit_performed"
                }
                for row in latest_audit_rows
            )
        )
        status_row = status_by_symbol.get(symbol, {})
        status_text = " ".join(str(status_row.get(field) or "")
                               for field in ("type", "description", "name"))
        active_delisting_risk = (
            any(marker in status_text.upper() for marker in ("ST", "退市", "DELIST"))
            and "撤销" not in status_text
        )
        pledge_row = pledge_by_symbol.get(symbol, {})
        pledge_ratio = pledge_row.get("acc_pledge_total_ratio")
        forecast_row = (
            forecast_by_symbol.get(symbol, {}) if forecast_complete else {}
        )
        forecast_floor = forecast_row.get("forecast_growth_rate_floor")
        risk_penalties = {
            "crowding": (
                5 if _is_finite(item.get("turnover_heat"))
                and float(item["turnover_heat"]) >= 3 else 0
            ),
            "extremeVolatility": (
                5 if _is_finite(item.get("volatility"))
                and float(item["volatility"]) > .35 else 0
            ),
            "pledge": (
                5 if _is_finite(pledge_ratio) and float(pledge_ratio) >= 30 else 0
            ),
            "unlock": (
                5 if _is_finite(unlock_pct) and float(unlock_pct) > 5 else 0
            ),
            "reduction": 5 if reductions else 0,
            "forecastEvent": (
                5 if _is_finite(forecast_floor) and float(forecast_floor) < 0 else 0
            ),
        }
        risk_penalty = min(30, sum(risk_penalties.values()))
        risk_metric_evidence = {
            "crowding": {
                "raw": {"turnoverHeat": item.get("turnover_heat")},
                "transformed": item.get("turnover_heat"),
                "dataDate": item.get("dataDate"), "window": "20d",
                "coverage": item["windowCoverage"]["turnover_heat"],
                "sourceRole": "risk_crowding",
                "evidenceIds": evidence_ids("get_stock_daily", symbols=[symbol]),
            },
            "extremeVolatility": {
                "raw": {"volatility20": item.get("volatility")},
                "transformed": item.get("volatility"),
                "dataDate": item.get("dataDate"), "window": "20d",
                "coverage": item["windowCoverage"]["ret20"],
                "sourceRole": "risk_extreme_volatility",
                "evidenceIds": evidence_ids("get_stock_daily", symbols=[symbol]),
            },
            "pledge": {
                "raw": {"accPledgeTotalRatio": pledge_ratio},
                "transformed": pledge_ratio,
                "dataDate": evidence_date("get_stock_pledge", symbol=symbol),
                "window": "latest-as-of", "coverage": 1 if pledge_complete else 0,
                "sourceRole": "risk_pledge",
                "evidenceIds": evidence_ids(
                    "get_stock_pledge", symbols=[symbol]
                ),
            },
            "unlock": {
                "raw": {
                    "unlockFloatPct30d": unlock_pct,
                    "unlockShares": unlock_shares.get(symbol),
                    "freeCirculation": free_float,
                },
                "transformed": unlock_pct,
                "dataDate": evidence_date(
                    "get_restricted_list", "get_share_float", symbol=symbol
                ),
                "window": f"{requested.isoformat()}/{_iso_date(unlock_end)}",
                "coverage": 1 if restricted_complete and float_complete else 0,
                "sourceRole": "risk_unlock",
                "evidenceIds": evidence_ids(
                    "get_restricted_list", "get_share_float", symbols=[symbol]
                ),
            },
            "reduction": {
                "raw": {"eventCount": len(reductions)},
                "transformed": len(reductions),
                "dataDate": evidence_date(
                    "get_stock_shareholder_change", symbol=symbol
                ),
                "window": "365d", "coverage": 1 if shareholder_complete else 0,
                "sourceRole": "risk_reduction",
                "evidenceIds": evidence_ids(
                    "get_stock_shareholder_change", symbols=[symbol]
                ),
            },
            "forecastEvent": {
                "raw": {"forecastGrowthRateFloor": forecast_floor},
                "transformed": forecast_floor,
                "dataDate": evidence_date("get_fina_forecast", symbol=symbol),
                "window": "latest-as-of",
                "coverage": 1 if forecast_complete else 0,
                "sourceRole": "risk_forecast",
                "evidenceIds": evidence_ids(
                    "get_fina_forecast", symbols=[symbol]
                ),
            },
        }
        metric_evidence = {
            "trend": {
                "raw": {"relativeStrength20": (
                    float(item["ret20"]) - float(market_ret20)
                    if _is_finite(item.get("ret20")) and _is_finite(market_ret20)
                    else None
                ), "acceleration5": item.get("acceleration")},
                "transformed": trend_value, "dataDate": item.get("dataDate"),
                "window": "20d+5d", "coverage": item["windowCoverage"]["ret20"],
                "positive": _is_finite(trend_value) and trend_value > 0,
                "sourceRole": "trend",
                "evidenceIds": evidence_ids("get_stock_daily", symbols=[symbol]),
            },
            "theme": {
                "raw": {
                    group["id"]: float(group["acceleration"])
                    for group in broad_groups
                },
                "transformed": theme_value, "dataDate": item.get("dataDate"),
                "window": "membership-snapshot", "coverage": 1 if broad_groups else 0,
                "positive": _is_finite(theme_value) and theme_value > 0,
                "sourceRole": "theme",
                "evidenceIds": evidence_ids(
                    "get_industry_constituents", "get_concept_constituents",
                    symbols=[symbol],
                ),
            },
            "quality": {
                "raw": {
                    key: latest_fina.get(key) for key in (
                        "roe_weighted", "net_profit_parent_yoy",
                        "net_cash_flow_operating_yoy",
                    )
                },
                "transformed": (
                    sum(quality_values) / len(quality_values)
                    if quality_values else None
                ),
                "dataDate": _iso_date(latest_fina.get("info_date")),
                "window": "point-in-time", "coverage": len(quality_values) / 3,
                "positive": (
                    len(quality_values) >= 2
                    and sum(value > 0 for value in quality_values) >= 2
                ),
                "sourceRole": "quality",
                "evidenceIds": evidence_ids(
                    "get_fina_performance", symbols=[symbol]
                ),
            },
            "capital": {
                "raw": capital_signals, "transformed": capital_value,
                "dataDate": evidence_date(
                    "get_hsgt_hold", "get_lhb_detail", "get_margin",
                    "get_investor_activity", symbol=symbol
                ), "window": "20d",
                "coverage": min(1, len(capital_signals) / 2),
                "positive": _is_finite(capital_value) and capital_value > 0,
                "sourceRole": "capital",
                "evidenceIds": evidence_ids(
                    "get_hsgt_hold", "get_lhb_detail", "get_margin",
                    "get_investor_activity", symbols=[symbol]
                ),
            },
            "liquidity_stability": {
                "raw": {"medianAmount20": item.get("medianAmount20"),
                        "volatility20": item.get("volatility")},
                "transformed": (
                    -float(item["volatility"])
                    if _is_finite(item.get("volatility")) else None
                ),
                "dataDate": item.get("dataDate"), "window": "20d",
                "coverage": item["windowCoverage"]["ret20"],
                "positive": (
                    _is_finite(item.get("medianAmount20"))
                    and float(item["medianAmount20"]) >= min_liquidity
                    and _is_finite(item.get("volatility"))
                    and float(item["volatility"]) <= .35
                ),
                "sourceRole": "liquidity_stability",
                "evidenceIds": evidence_ids("get_stock_daily", symbols=[symbol]),
            },
        }
        discount_event_raw = (
            len(discounted_blocks) + len(reductions)
            if block_complete and shareholder_complete
            else None
        )
        candidate_rows.append({
            **item,
            "reportDate": requested.isoformat(),
            "trend": trend_value,
            "theme": theme_value,
            "quality": sum(quality_values) / len(quality_values) if quality_values else None,
            "valuation": None,
            "capital": capital_value,
            "liquidity_stability": (
                -float(item["volatility"]) if _is_finite(item.get("volatility")) else None
            ),
            "financialEvidenceDate": _iso_date(latest_fina.get("info_date")),
            "st": str(item.get("name") or "").upper().startswith(("*ST", "ST")),
            "delisting_risk": active_delisting_risk,
            "tradable": item.get("isHeadlineEligible"),
            "suspended": not item.get("isHeadlineEligible"),
            "nonstandard_audit": nonstandard_audit,
            "unlock_float_pct_30d": unlock_pct,
            "risk_penalty": risk_penalty,
            "riskPenalties": risk_penalties,
            "minLiquidityCny": min_liquidity,
            "_metricEvidence": metric_evidence,
            "_riskMetricEvidence": risk_metric_evidence,
            "_discountEventRaw": discount_event_raw,
        })

    sell_input = _rank_columns([
        {
            **item,
            "lhb_net_sell": (
                directional_lhb.get(item["symbol"], 0)
                if directional_lhb_complete else None
            ),
            "northbound_reduction": (
                -hsgt_delta[item["symbol"]]
                if item["symbol"] in hsgt_delta else None
            ),
            "margin_contraction": (
                -margin_delta[item["symbol"]]
                if item["symbol"] in margin_delta else None
            ),
            "discount_event": item.get("_discountEventRaw"),
            "_metricEvidence": {
                "downside_volume": {
                    "raw": {
                        "downsideMagnitude": max(0, -float(item.get("ret1") or 0)),
                        "relativeAmount20Median": item.get("turnover_heat"),
                    },
                    "transformed": item.get("downside_volume"),
                    "dataDate": item.get("dataDate"), "window": "20d",
                    "coverage": item["windowCoverage"]["turnover_heat"],
                    "sourceRole": "downside_volume",
                    "evidenceIds": evidence_ids(
                        "get_stock_daily", symbols=[item["symbol"]]
                    ),
                },
                "lhb_net_sell": {
                    "raw": (
                        directional_lhb.get(item["symbol"], 0)
                        if directional_lhb_complete else None
                    ),
                    "transformed": (
                        directional_lhb.get(item["symbol"], 0)
                        if directional_lhb_complete else None
                    ),
                    "dataDate": evidence_date(
                        "get_lhb_detail", symbol=item["symbol"]
                    ), "window": "20d",
                    "coverage": 1 if directional_lhb_complete else 0,
                    "sourceRole": "lhb_net_sell",
                    "evidenceIds": evidence_ids(
                        "get_lhb_detail", symbols=[item["symbol"]]
                    ),
                },
                "northbound_reduction": {
                    "raw": hsgt_delta.get(item["symbol"]),
                    "transformed": (
                        -hsgt_delta[item["symbol"]]
                        if item["symbol"] in hsgt_delta else None
                    ),
                    "dataDate": evidence_date(
                        "get_hsgt_hold", symbol=item["symbol"]
                    ), "window": "20d",
                    "coverage": 1 if item["symbol"] in hsgt_delta else 0,
                    "sourceRole": "northbound_reduction",
                    "evidenceIds": evidence_ids(
                        "get_hsgt_hold", symbols=[item["symbol"]]
                    ),
                },
                "margin_contraction": {
                    "raw": margin_delta.get(item["symbol"]),
                    "transformed": (
                        -margin_delta[item["symbol"]]
                        if item["symbol"] in margin_delta else None
                    ),
                    "dataDate": evidence_date(
                        "get_margin", symbol=item["symbol"]
                    ), "window": "20d",
                    "coverage": 1 if item["symbol"] in margin_delta else 0,
                    "sourceRole": "margin_contraction",
                    "evidenceIds": evidence_ids(
                        "get_margin", symbols=[item["symbol"]]
                    ),
                },
                "discount_event": {
                    "raw": item.get("_discountEventRaw"),
                    "transformed": item.get("_discountEventRaw"),
                    "dataDate": evidence_date(
                        "get_block_trade", "get_stock_shareholder_change",
                        symbol=item["symbol"]
                    ), "window": "20d",
                    "coverage": (
                        1 if block_complete and shareholder_complete else 0
                    ),
                    "sourceRole": "discount_event",
                    "evidenceIds": evidence_ids(
                        "get_block_trade", "get_stock_shareholder_change",
                        symbols=[item["symbol"]],
                    ),
                },
            },
        }
        for item in candidate_rows
    ], SELL_WEIGHTS)
    sell_pressure = compute_sell_pressure(sell_input)
    potential_input = _rank_columns(candidate_rows, POTENTIAL_WEIGHTS)
    potential = compute_potential_watchlist(potential_input)

    us_cutoff = requested - timedelta(days=1)
    us_calendar = _call_optional(
        collector, missing_data, "us", "get_trade_cal",
        expected_max_rows=20,
        start_date=(us_cutoff - timedelta(days=14)).strftime("%Y%m%d"),
        end_date=us_cutoff.strftime("%Y%m%d"),
        exchange="US",
        is_trading_day=1,
        fields=["nature_date", "exchange", "is_trade"],
    )
    us_date = max(
        (_date_text(row.get("nature_date")) for row in (us_calendar or [])
         if int(row.get("is_trade", 0)) == 1 and
         _date_text(row.get("nature_date")) <= us_cutoff.strftime("%Y%m%d")),
        default="",
    )
    if not us_date:
        _record_missing(
            missing_data, "us", "get_trade_cal", "POINT_IN_TIME_INSUFFICIENT"
        )
    us_rows = None
    if us_date:
        us_rows = _call_optional(
            collector, missing_data, "us", "get_us_daily",
            expected_max_rows=len(US_CONTEXT_SYMBOLS),
            start_date=us_date,
            end_date=us_date,
            symbol=US_CONTEXT_SYMBOLS,
            fields=["symbol", "date", "name", "close", "pre_close"],
        )
        us_rows = [
            row for row in (us_rows or [])
            if _date_text(row.get("date")) == us_date
        ]
        if not us_rows:
            _record_missing(
                missing_data, "us", "get_us_daily", "POINT_IN_TIME_INSUFFICIENT"
            )
        else:
            us_symbols = {
                str(row.get("symbol")) for row in us_rows if row.get("symbol")
            }
            us_coverage = len(us_symbols & set(US_CONTEXT_SYMBOLS)) / len(US_CONTEXT_SYMBOLS)
            if us_coverage < 1:
                _record_missing(
                    missing_data, "us", "get_us_daily",
                    "COVERAGE_INSUFFICIENT", coverage=us_coverage,
                )

    top_n = max(1, min(50, int(request.get("topN", 10))))
    for collection in (hot_industries["ranked"], hot_concepts["ranked"],
                       sell_pressure, potential):
        for row in collection:
            freshness = [
                float(metric.get("freshnessFactor", .5))
                for metric in row.get("metrics", [])
            ]
            row["confidence"] = round(
                float(row.get("weightCoverage", 0)) * min(freshness or [.5]),
                4,
            )

    source_records = [
        {
            "id": record["id"],
            "traceCallId": record["id"],
            "method": record["method"],
            "paramsHash": record.get("paramsHash"),
            "window": record.get("window") or record.get("dataAsOf"),
            "fields": record.get("fields", []),
            "dataDate": record["dataAsOf"],
            "dataAsOf": record["dataAsOf"],
            "rowCount": record["rowCount"],
            "coverage": record.get("coverage", 0),
            "status": record["status"],
            "responseHash": record["responseHash"],
            "cacheStatus": record.get("cacheStatus", "disabled"),
            "cacheError": record.get("cacheError"),
            "retryCount": record.get("retryCount", 0),
            "truncated": bool(record.get("truncated")),
            "providerMaxRows": record.get("providerMaxRows"),
            "expectedMaxRows": record.get("expectedMaxRows"),
            "batchIndex": record.get("batchIndex"),
            "batchCount": record.get("batchCount"),
        }
        for record in collector.records
    ]
    run_seed = json.dumps(
        {"date": requested_iso, "operation": request["operation"],
         "topN": top_n, "minLiquidityCny": min_liquidity},
        sort_keys=True, separators=(",", ":"),
    )
    public_boards = {
        "hotIndustries": _public_ranked(hot_industries["ranked"], 5),
        "hotConcepts": _public_ranked(hot_concepts["ranked"], 5),
        "sellPressure": _public_ranked(sell_pressure, top_n),
        "potentialWatchlist": _public_ranked(potential, top_n),
    }

    formula_by_board = {
        "hotIndustries": "hot-topic-v2",
        "hotConcepts": "hot-topic-v2",
        "sellPressure": "sell-pressure-v2",
        "potentialWatchlist": "potential-v2",
    }
    sections_by_board = {
        "hotIndustries": {"hotIndustries", "lhb"},
        "hotConcepts": {"hotConcepts", "lhb"},
        "sellPressure": {"sellPressure", "capital", "events"},
        "potentialWatchlist": {
            "fundamentals", "capital", "events", "valuation",
        },
    }
    conclusions = []
    for board_name, rows in public_boards.items():
        for row in rows:
            metrics = list(row.get("metrics") or [])
            if not metrics:
                continue
            metric_ids = [metric["id"] for metric in metrics]
            call_ids = sorted({
                evidence_id for metric in metrics
                for evidence_id in metric.get("evidenceIds", [])
            })
            identity = str(row.get("symbol") or row.get("id") or row.get("name"))
            relevant_missing = [
                item for item in missing_data
                if item.get("section") in sections_by_board[board_name]
            ]
            conclusions.append({
                "conclusion_id": f"{board_name}:{identity}",
                "formula": formula_by_board[board_name],
                "leaderboard": board_name,
                "entryId": identity,
                "rank": row.get("rank"),
                "metricIds": metric_ids,
                "evidenceIds": call_ids,
                "pandaCalls": call_ids,
                "sourceIds": call_ids,
                "dataDates": sorted({
                    metric["dataDate"] for metric in metrics
                    if metric.get("dataDate")
                }),
                "windows": sorted({
                    metric["window"] for metric in metrics
                    if metric.get("window")
                }),
                "stale": any(
                    float(metric.get("freshnessFactor", 0)) < 1
                    for metric in metrics
                ),
                "missing": [
                    {
                        "method": item.get("method"),
                        "status": item.get("status"),
                        "reason": item.get("reason"),
                    }
                    for item in relevant_missing
                ],
                "confidence": row.get("confidence", 0),
                "limitations": sorted({
                    f"{item.get('method')}:{item.get('status')}"
                    for item in relevant_missing
                }),
            })
    return {
        "schemaVersion": "1.0",
        "evidenceModelVersion": EVIDENCE_MODEL_VERSION,
        "runId": request.get("runId") or hashlib.sha256(run_seed.encode()).hexdigest()[:16],
        "reportDate": requested.isoformat(),
        "status": "degraded" if missing_data else "complete",
        "markets": {
            "aShare": {"dataDate": requested.isoformat(), "rowCount": len(daily_rows)},
            "us": {
                "dataDate": _iso_date(us_date),
                "rowCount": len(us_rows or []),
                "sessionRule": "previous-completed-session",
            },
        },
        "universe": {
            "aShare": len(universe),
            "dailyCovered": len(covered_symbols),
            "preliminaryCandidates": len(preliminary),
            "fullEnrichment": len(enriched),
        },
        "coverage": {
            "aShareDaily": daily_coverage,
            "aShareHistorical": historical_coverage,
            "historicalActualPairs": len(actual_pairs & expected_pairs),
            "historicalExpectedPairs": len(expected_pairs),
        },
        "missingData": missing_data,
        "applicationVersion": APPLICATION_VERSION,
        "skillVersions": SKILL_VERSIONS,
        "metricVersion": METRIC_VERSION,
        "configFingerprint": hashlib.sha256(json.dumps({
            "sdkVersion": SDK_VERSION,
            "topN": top_n,
            "minLiquidityCny": min_liquidity,
            "preliminaryBound": MAX_PRELIMINARY_CANDIDATES,
            "fullEnrichmentBound": MAX_FULL_ENRICHMENT,
            "hotWeights": HOT_WEIGHTS,
            "sellWeights": SELL_WEIGHTS,
            "potentialWeights": POTENTIAL_WEIGHTS,
        }, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "leaderboards": public_boards,
        "excluded": {
            "hotIndustries": hot_industries["excluded"],
            "hotConcepts": hot_concepts["excluded"],
        },
        "conclusions": conclusions,
        "lineageSummary": {
            "conclusionCount": len(conclusions),
            "metricCount": len({
                metric_id for item in conclusions for metric_id in item["metricIds"]
            }),
            "pandaCallCount": len({
                call_id for item in conclusions for call_id in item["pandaCalls"]
            }),
        },
        "sources": source_records,
        "conventions": [
            "Scores are deterministic cross-sectional percentile aggregates.",
            "Suspended and ST securities are excluded from headline breadth.",
            "Dragon-Tiger evidence is optional and its weight is redistributed when unavailable.",
        ],
    }


def emit_trace(value):
    print(
        "TRACE " + json.dumps(value, ensure_ascii=False, default=str),
        file=sys.stderr,
        flush=True,
    )


def _validate_public_request(value):
    if not isinstance(value, dict):
        raise ValueError("worker 请求必须是 JSON 对象")
    unknown = sorted(set(value) - PUBLIC_REQUEST_FIELDS)
    if unknown:
        raise ValueError(f"worker 请求包含不允许的字段：{', '.join(unknown)}")
    return dict(value)


def main():
    request = _validate_public_request(json.loads(sys.stdin.read() or "{}"))
    import panda_data
    auth = {
        "username": os.environ["PANDA_DATA_USERNAME"],
        "password": os.environ["PANDA_DATA_PASSWORD"],
    }
    base_url = os.environ.get("PANDA_DATA_BASE_URL", "").strip()
    if base_url:
        auth["base_url"] = base_url
    panda_data.init_token(
        **auth,
    )
    collector = PandaCollector(
        panda_data,
        emit_trace,
        os.environ.get("MARKET_REPORT_CACHE_DIR", "").strip() or None,
        int(request.get("cacheDays", 30)),
    )
    pack = build_evidence_pack(
        request,
        collector,
        datetime.now(timezone.utc).isoformat(),
    )
    print(json.dumps(
        pack,
        ensure_ascii=False,
        allow_nan=False,
        default=str,
        separators=(",", ":"),
    ))


def run():
    try:
        main()
        return 0
    except Exception as error:
        emit_trace({"type": "worker-error", "error": _sanitize_error(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
