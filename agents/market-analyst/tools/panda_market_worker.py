import hashlib
import json
import math
import os
import pathlib
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


SDK_VERSION = "0.0.12"
REQUIRED_TRADING_SESSIONS = 60
PROVIDER_ROW_CAP = 500
SAFE_DAILY_ROW_BUDGET = 480
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
SELL_WEIGHTS = {"downside_volume": .25, "lhb_net_sell": .25, "northbound_reduction": .20,
                "margin_contraction": .15, "discount_event": .15}
POTENTIAL_WEIGHTS = {"trend": .25, "theme": .15, "quality": .20, "valuation": .15,
                     "capital": .15, "liquidity_stability": .10}


def _records(result):
    if result is None:
        return []
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
    def __init__(self, module, trace, cache_dir, cache_days):
        self.module = module
        self.trace = trace
        self.cache_dir = cache_dir
        self.cache_days = cache_days
        self.report_date = None
        self.records = []
        self._sequence = 0
        self._cache_transaction = None

    def _emit(self, record):
        self.records.append(record)
        self.trace(record)

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

    def call(self, method, *, expected_max_rows=None, required_date=None,
             required_symbols=None, minimum_symbol_coverage=None, **params):
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
                    len(rows) == PROVIDER_ROW_CAP and
                    int(expected_max_rows) > PROVIDER_ROW_CAP
                )
                if len(rows) > int(expected_max_rows) or cap_shape:
                    truncated = True
                    raise ValueError(
                        f"{method} 响应违反声明上限，疑似截断："
                        f"{len(rows)}/{expected_max_rows}"
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
                _iso_date(row.get("date") or row.get("nature_date") or row.get("info_date"))
                for row in rows
            ]
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
                "fields": sorted({key for row in rows for key in row}),
                "dataAsOf": max((item for item in dates if item), default=None),
                "responseHash": _content_hash(rows) if status == "ok" else None,
                "status": status,
                "error": error,
                "cacheStatus": cache_status,
                "cacheKey": cache_key if cache_status != "disabled" else None,
                "cacheError": cache_error,
                "truncated": truncated,
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
        constituent_count = group.get("constituent_count")
        coverage = group.get("coverage")
        if not _is_finite(constituent_count) or float(constituent_count) < 5:
            excluded.append({"id": group["id"], "reason": "MIN_CONSTITUENTS"})
        elif not _is_finite(coverage) or float(coverage) < .80:
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
        unlock = row.get("unlock_float_pct_30d")
        if _is_finite(unlock) and float(unlock) > 10:
            vetoes.append("LARGE_UNLOCK_30D")
        score, coverage, used = effective_weights(row, POTENTIAL_WEIGHTS, 4)
        status = "VETOED" if vetoes else ("RANKED" if score is not None and coverage >= .70 else "EVIDENCE_INSUFFICIENT")
        risk_penalty = row.get("risk_penalty")
        penalty = float(risk_penalty) if _is_finite(risk_penalty) else 0
        final = None if score is None else max(0, score - penalty)
        output.append({**row, "baseScore": score, "score": final, "weightCoverage": coverage,
                       "componentsUsed": used, "vetoes": vetoes, "status": status})
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
    if any(item.get("section") == section and item.get("method") == method
           for item in missing_data):
        return
    missing = {"method": method, "section": section, "status": status, **details}
    if method == "get_lhb_list":
        missing["weightRemoved"] = HOT_WEIGHTS["lhb_activity"]
    missing_data.append(missing)


def _batches(values, size):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def _daily_metrics(rows):
    by_symbol = defaultdict(list)
    for row in rows:
        by_symbol[str(row.get("symbol", ""))].append(row)
    output = {}
    for symbol, values in by_symbol.items():
        ordered = sorted(values, key=lambda item: _date_text(item.get("date")))
        closes = [float(item["close"]) for item in ordered if _is_finite(item.get("close"))]
        if not closes:
            continue
        latest = ordered[-1]
        pre_close = latest.get("pre_close")
        ret1 = (float(latest["close"]) / float(pre_close) - 1
                if _is_finite(pre_close) and float(pre_close) != 0 else None)
        ret5 = closes[-1] / closes[-6] - 1 if len(closes) >= 6 and closes[-6] else None
        previous5 = closes[-6] / closes[-11] - 1 if len(closes) >= 11 and closes[-11] else None
        amounts = [float(item["amount"]) for item in ordered[-20:]
                   if _is_finite(item.get("amount"))]
        average_amount = sum(amounts) / len(amounts) if amounts else None
        latest_amount = float(latest["amount"]) if _is_finite(latest.get("amount")) else None
        downside = sum(
            float(item.get("volume", 0))
            for item in ordered[-20:]
            if _is_finite(item.get("volume")) and _is_finite(item.get("close")) and
            _is_finite(item.get("pre_close")) and float(item["close"]) < float(item["pre_close"])
        )
        total_volume = sum(
            float(item.get("volume", 0)) for item in ordered[-20:]
            if _is_finite(item.get("volume"))
        )
        output[symbol] = {
            "symbol": symbol,
            "name": latest.get("name"),
            "dataDate": _iso_date(latest.get("date")),
            "ret1": ret1,
            "ret5": ret5,
            "acceleration": ret5 - previous5
            if _is_finite(ret5) and _is_finite(previous5) else None,
            "turnover_heat": latest_amount / average_amount
            if (_is_finite(latest_amount) and _is_finite(average_amount) and average_amount != 0)
            else None,
            "latestAmount": latest_amount,
            "downside_volume": downside / total_volume if total_volume else None,
            "volatility": max(closes[-20:]) / min(closes[-20:]) - 1
            if len(closes) >= 2 and min(closes[-20:]) else None,
            "rowCount": len(ordered),
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


def _mean_present(rows, key):
    values = [float(row[key]) for row in rows if _is_finite(row.get(key))]
    return sum(values) / len(values) if values else None


def _group_metrics(memberships, daily, group_code, group_name, member_code, lhb_symbols):
    grouped = defaultdict(list)
    names = {}
    for row in memberships or []:
        code = str(row.get(group_code, ""))
        symbol = str(row.get(member_code, ""))
        if code and symbol:
            grouped[code].append(symbol)
            names[code] = row.get(group_name) or code
    output = []
    for code, symbols in grouped.items():
        unique = sorted(set(symbols))
        covered = [daily[symbol] for symbol in unique if symbol in daily]
        count = len(unique)
        output.append({
            "id": code,
            "name": names[code],
            "constituent_count": count,
            "coverage": len(covered) / count if count else 0,
            "ret1": _mean_present(covered, "ret1"),
            "ret5": _mean_present(covered, "ret5"),
            "breadth5": (
                sum(float(item["ret5"]) > 0 for item in covered
                    if _is_finite(item.get("ret5"))) /
                max(1, sum(_is_finite(item.get("ret5")) for item in covered))
            ),
            "turnover_heat": _mean_present(covered, "turnover_heat"),
            "acceleration": _mean_present(covered, "acceleration"),
            "lhb_activity": sum(symbol in lhb_symbols for symbol in unique),
            "memberSymbols": unique,
            "representativeSymbols": unique[:3],
        })
    return output


def _rank_columns(rows, keys):
    output = [dict(row) for row in rows]
    for key in keys:
        ranked = percentile_rank(winsorize([row.get(key) for row in output]))
        for row, value in zip(output, ranked):
            row[key] = value
    return output


def _public_ranked(rows, top_n):
    allowed = {
        "symbol", "name", "id", "dataDate", "score", "baseScore", "weightCoverage",
        "componentsUsed", "status", "vetoes", "confidence", "constituent_count",
        "coverage", "representativeSymbols", "financialEvidenceDate",
    }
    return [{key: value for key, value in row.items() if key in allowed}
            for row in rows[:top_n]]


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
    latest_rows = collector.call("get_last_trade_date", exchange="SH")
    latest = max((_date_text(row.get("date")) for row in latest_rows), default="")
    if not latest:
        raise ValueError("Panda latest completed trading date is unavailable")
    calendar_start = (requested - timedelta(days=120)).strftime("%Y%m%d")
    sh_calendar = collector.call(
        "get_trade_cal",
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

    universe_rows = collector.call("get_trade_list", date=report_compact, exchange="SH")
    universe = sorted({str(row.get("symbol")) for row in universe_rows if row.get("symbol")})
    if not universe:
        raise ValueError("在售股票列表为空")

    collector.begin_cache_transaction("get_stock_daily")
    daily_rows = []
    daily_fields = [
        "symbol", "date", "name", "open", "close", "high", "low", "volume", "amount",
        "pre_close", "limit_up", "limit_down", "trade_status",
    ]
    daily_batch_size = max(1, SAFE_DAILY_ROW_BUDGET // len(window_dates))
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
         if _is_finite(item.get("latestAmount")) and item["latestAmount"] >= min_liquidity),
        key=lambda item: (-item["latestAmount"], item["symbol"]),
    )[:MAX_PRELIMINARY_CANDIDATES]
    enriched = preliminary[:MAX_FULL_ENRICHMENT]
    candidate_symbols = [item["symbol"] for item in enriched]

    missing_data = []
    industries = _call_optional(
        collector, missing_data, "hotIndustries", "get_industry_constituents",
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
            concept_memberships = _call_optional(
                collector, missing_data, "hotConcepts", "get_concept_constituents",
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

    lhb = []
    if candidate_symbols:
        lhb = _call_optional(
            collector, missing_data, "lhb", "get_lhb_list",
            symbol=candidate_symbols,
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
        if not lhb:
            _record_missing(
                missing_data, "lhb", "get_lhb_list", "POINT_IN_TIME_INSUFFICIENT"
            )
    lhb_available = bool(lhb)
    lhb_symbols = {str(row.get("symbol")) for row in (lhb or []) if row.get("symbol")}

    financial = []
    if candidate_symbols:
        financial = _call_optional(
            collector, missing_data, "fundamentals", "get_fina_reports",
            symbol=candidate_symbols,
            date=report_compact,
            is_latest=True,
            fields=[
                "symbol", "date", "info_date", "publish_date", "quarter",
                "roe", "net_profit_yoy",
            ],
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

    headline_ineligible = {
        symbol for symbol, item in daily.items()
        if not item.get("isHeadlineEligible")
    }
    headline_daily = {
        symbol: item for symbol, item in daily.items()
        if item.get("isHeadlineEligible")
    }
    industry_groups = _group_metrics(
        [row for row in active_industries
         if str(row.get("stock_symbol")) not in headline_ineligible],
        headline_daily, "l1_code", "l1_name", "stock_symbol", lhb_symbols,
    )
    concept_groups = _group_metrics(
        [row for row in (concept_memberships or [])
         if str(row.get("concept_stock")) not in headline_ineligible],
        headline_daily, "concept", "concept", "concept_stock", lhb_symbols,
    )
    hot_industries = compute_hot_topics(industry_groups, lhb_available=lhb_available)
    hot_concepts = compute_hot_topics(concept_groups, lhb_available=lhb_available)
    if any(item.get("reason") == "MIN_COVERAGE"
           for item in hot_industries["excluded"]):
        _record_missing(
            missing_data, "hotIndustries", "get_industry_constituents",
            "COVERAGE_INSUFFICIENT",
        )
    if any(item.get("reason") == "MIN_COVERAGE"
           for item in hot_concepts["excluded"]):
        _record_missing(
            missing_data, "hotConcepts", "get_concept_constituents",
            "COVERAGE_INSUFFICIENT",
        )

    candidate_rows = []
    for item in enriched:
        fina_rows = financial_by_symbol.get(item["symbol"], [])
        latest_fina = max(fina_rows, key=lambda row: _date_text(row.get("date")),
                          default={})
        quality_values = [
            float(latest_fina[key]) for key in ("roe", "net_profit_yoy")
            if _is_finite(latest_fina.get(key))
        ]
        candidate_rows.append({
            **item,
            "trend": item.get("ret5"),
            "theme": max(
                (group.get("ret5") for group in industry_groups + concept_groups
                 if item["symbol"] in group.get("memberSymbols", []) and
                 _is_finite(group.get("ret5"))),
                default=None,
            ),
            "quality": sum(quality_values) / len(quality_values) if quality_values else None,
            "valuation": None,
            "capital": 1 if item["symbol"] in lhb_symbols else (0 if lhb_available else None),
            "liquidity_stability": (
                -float(item["volatility"]) if _is_finite(item.get("volatility")) else None
            ),
            "financialEvidenceDate": _iso_date(latest_fina.get("date")),
            "st": str(item.get("name") or "").upper().startswith(("*ST", "ST")),
            "nonstandard_audit": False,
            "unlock_float_pct_30d": None,
            "risk_penalty": 0,
        })

    sell_input = _rank_columns([
        {
            **item,
            "lhb_net_sell": (1 if item["symbol"] in lhb_symbols else
                             (0 if lhb_available else None)),
            "northbound_reduction": None,
            "margin_contraction": None,
            "discount_event": None,
        }
        for item in enriched
    ], SELL_WEIGHTS)
    sell_pressure = compute_sell_pressure(sell_input)
    potential_input = _rank_columns(candidate_rows, POTENTIAL_WEIGHTS)
    potential = compute_potential_watchlist(potential_input)

    us_cutoff = requested - timedelta(days=1)
    us_calendar = _call_optional(
        collector, missing_data, "us", "get_trade_cal",
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
            row["confidence"] = round(float(row.get("weightCoverage", 0)), 4)

    source_records = [
        {
            "id": record["id"],
            "method": record["method"],
            "dataAsOf": record["dataAsOf"],
            "rowCount": record["rowCount"],
            "status": record["status"],
            "responseHash": record["responseHash"],
        }
        for record in collector.records
    ]
    run_seed = json.dumps(
        {"date": requested_iso, "operation": request["operation"],
         "topN": top_n, "minLiquidityCny": min_liquidity},
        sort_keys=True, separators=(",", ":"),
    )
    source_ids = [item["id"] for item in source_records if item["status"] == "ok"]
    conclusions = [
        {
            "conclusion_id": "market-hot-industries",
            "formula": "hot-topic-v1",
            "leaderboard": "hotIndustries",
            "sourceIds": source_ids,
            "confidence": (
                hot_industries["ranked"][0].get("confidence", 0)
                if hot_industries["ranked"] else 0
            ),
            "limitations": [item["section"] for item in missing_data],
        },
        {
            "conclusion_id": "market-watchlists",
            "formula": "sell-pressure-v1,potential-v1",
            "leaderboard": "sellPressure,potentialWatchlist",
            "sourceIds": source_ids,
            "confidence": min(
                [row.get("confidence", 0) for row in potential[:top_n]] or [0]
            ),
            "limitations": [item["section"] for item in missing_data],
        },
    ]
    return {
        "schemaVersion": "1.0",
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
        "metricVersion": "1.0",
        "leaderboards": {
            "hotIndustries": _public_ranked(hot_industries["ranked"], 5),
            "hotConcepts": _public_ranked(hot_concepts["ranked"], 5),
            "sellPressure": _public_ranked(sell_pressure, top_n),
            "potentialWatchlist": _public_ranked(potential, top_n),
        },
        "excluded": {
            "hotIndustries": hot_industries["excluded"],
            "hotConcepts": hot_concepts["excluded"],
        },
        "conclusions": conclusions,
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
    panda_data.init_token(
        username=os.environ["PANDA_DATA_USERNAME"],
        password=os.environ["PANDA_DATA_PASSWORD"],
        base_url=os.environ.get(
            "PANDA_DATA_BASE_URL",
            "http://pandadata.pandaaiquant.com",
        ),
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
