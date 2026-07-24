import importlib.util
import io
import json
import math
import os
import pathlib
import sys
import tempfile
import unittest
from datetime import date, timedelta
from unittest import mock

WORKER = pathlib.Path("agents/market-analyst/tools/panda_market_worker.py")
SNAPSHOT = pathlib.Path("test/fixtures/market-worker/snapshot.json")
spec = importlib.util.spec_from_file_location("panda_market_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient="records"):
        if orient != "records":
            raise ValueError("FakeFrame only supports record output")
        return [dict(row) for row in self.rows]


class FakePanda:
    __version__ = "0.0.12"
    symbols = [f"00000{value}.SZ" for value in range(1, 7)]

    @staticmethod
    def _weekdays(start, end):
        current = start
        output = []
        while current <= end:
            if current.weekday() < 5:
                output.append(current)
            current += timedelta(days=1)
        return output

    def get_trade_cal(self, start_date=None, end_date=None, exchange="SH",
                      is_trading_day=None, fields=None):
        start = date.fromisoformat(f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:]}")
        end = date.fromisoformat(f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:]}")
        rows = [
            {"nature_date": day.strftime("%Y%m%d"), "exchange": exchange, "is_trade": 1}
            for day in self._weekdays(start, end)
        ]
        return FakeFrame(rows)

    def get_last_trade_date(self, exchange="SH"):
        return FakeFrame([{"date": "20260723" if exchange == "SH" else "20260722"}])

    def get_trade_list(self, date, exchange="SH"):
        return FakeFrame([{"symbol": symbol, "date": date} for symbol in self.symbols])

    def get_stock_daily(self, start_date, end_date, symbol=None, fields=None,
                        indicator=None, st=True):
        days = self._weekdays(
            date.fromisoformat(f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:]}"),
            date.fromisoformat(f"{end_date[:4]}-{end_date[4:6]}-{end_date[6:]}"),
        )[-60:]
        rows = []
        for symbol_index, stock_symbol in enumerate(symbol or self.symbols):
            previous = 10.0 + symbol_index
            for day_index, day in enumerate(days):
                close = previous * (1.0 + (symbol_index + 1) / 1000.0)
                rows.append({
                    "symbol": stock_symbol,
                    "date": day.strftime("%Y%m%d"),
                    "name": f"股票{symbol_index + 1}",
                    "open": previous,
                    "close": close,
                    "high": close * 1.01,
                    "low": previous * .99,
                    "volume": 3_000_000 + day_index,
                    "amount": 30_000_000 + symbol_index * 1_000_000,
                    "pre_close": previous,
                    "limit_up": previous * 1.1,
                    "limit_down": previous * .9,
                    "trade_status": 0,
                })
                previous = close
        return FakeFrame(rows)

    def get_industry_constituents(self, industry_code=None, stock_symbol=None,
                                  level="L1", fields=None):
        return FakeFrame([
            {"stock_symbol": symbol, "l1_code": "801010", "l1_name": "农林牧渔",
             "in_date": "20200101", "out_date": None}
            for symbol in self.symbols
        ])

    def get_concept_list(self, concept=None, start_date=None, end_date=None):
        return FakeFrame([{"name": "人工智能", "date": "20200101"}])

    def get_concept_constituents(self, concept=None, concept_stock=None, date=None, fields=None):
        return FakeFrame([
            {"concept": "人工智能", "concept_stock": symbol, "date": "20200101"}
            for symbol in self.symbols
        ])

    def get_lhb_list(self, symbol=None, type=None, start_date=None, end_date=None, fields=None):
        return FakeFrame([
            {"symbol": stock_symbol, "date": end_date, "type": "G0007", "amount": 1_000_000}
            for stock_symbol in (symbol or self.symbols[:2])
        ])

    def get_fina_reports(self, symbol=None, start_quarter=None, end_quarter=None, date=None,
                         is_latest=True, fields=None):
        return FakeFrame([
            {"symbol": stock_symbol, "date": date, "quarter": "2026q2",
             "roe": 10 + index, "net_profit_yoy": 20 + index}
            for index, stock_symbol in enumerate(symbol or [])
        ])

    def get_us_daily(self, start_date, end_date, symbol=None, fields=None):
        return FakeFrame([
            {"symbol": stock_symbol, "date": end_date, "close": 100 + index,
             "pre_close": 99 + index, "name": stock_symbol}
            for index, stock_symbol in enumerate(symbol or [])
        ])


class MarketWorkerTests(unittest.TestCase):
    def test_build_evidence_pack_uses_completed_trade_date_and_traces_every_call(self):
        trace = []
        collector = worker.PandaCollector(FakePanda(), trace.append, None, 0)
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000, "cacheDir": None},
            collector,
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["schemaVersion"], "1.0")
        self.assertEqual(pack["reportDate"], "2026-07-23")
        self.assertIn("hotIndustries", pack["leaderboards"])
        self.assertTrue(all("durationMs" in item and "rowCount" in item for item in trace))
        self.assertNotIn("password", json.dumps(pack).lower())

    def test_future_report_date_is_rejected(self):
        collector = worker.PandaCollector(FakePanda(), lambda _: None, None, 0)
        with self.assertRaisesRegex(ValueError, "未完成"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-25", "topN": 10,
                 "minLiquidityCny": 20_000_000, "cacheDir": None},
                collector,
                now="2026-07-24T10:30:00Z",
            )

    def test_authoritative_sh_calendar_marks_exchange_holiday_as_skipped(self):
        class HolidayPanda(FakePanda):
            def __init__(self):
                self.trade_list_calls = 0

            def get_trade_cal(self, start_date=None, end_date=None, exchange="SH",
                              is_trading_day=None, fields=None):
                if exchange == "SH" and start_date == end_date == "20260724":
                    return FakeFrame([{
                        "nature_date": "20260724",
                        "exchange": "SH",
                        "is_trade": 0,
                    }])
                return super().get_trade_cal(
                    start_date=start_date,
                    end_date=end_date,
                    exchange=exchange,
                    is_trading_day=is_trading_day,
                    fields=fields,
                )

            def get_trade_list(self, date, exchange="SH"):
                self.trade_list_calls += 1
                return super().get_trade_list(date, exchange)

        provider = HolidayPanda()
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-24", "topN": 10,
             "minLiquidityCny": 20_000_000, "runId": "holiday-run"},
            worker.PandaCollector(provider, lambda _: None, None, 0),
            now="2026-07-25T10:30:00Z",
        )
        self.assertEqual(pack["status"], "skipped")
        self.assertEqual(pack["runId"], "holiday-run")
        self.assertEqual(pack["reportDate"], "2026-07-24")
        self.assertIn("Panda", pack["skipReason"])
        self.assertEqual(provider.trade_list_calls, 0)

    def test_open_shanghai_session_is_rejected(self):
        collector = worker.PandaCollector(FakePanda(), lambda _: None, None, 0)
        with self.assertRaisesRegex(ValueError, "未完成"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
                 "minLiquidityCny": 20_000_000},
                collector,
                now="2026-07-23T02:30:00Z",
            )

    def test_calendar_with_fewer_than_sixty_completed_sessions_fails(self):
        class ShortCalendarPanda(FakePanda):
            def get_trade_cal(self, *args, **kwargs):
                rows = super().get_trade_cal(*args, **kwargs).to_dict()
                if kwargs.get("exchange", "SH") == "SH":
                    rows = rows[-30:]
                return FakeFrame(rows)

        with self.assertRaisesRegex(ValueError, "60|覆盖不足"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
                 "minLiquidityCny": 20_000_000},
                worker.PandaCollector(ShortCalendarPanda(), lambda _: None, None, 0),
                now="2026-07-24T10:30:00Z",
            )

    def test_stale_history_does_not_satisfy_report_date_core_coverage(self):
        class StaleLatestPanda(FakePanda):
            def get_stock_daily(self, *args, **kwargs):
                rows = super().get_stock_daily(*args, **kwargs).to_dict()
                stale_symbol = self.symbols[-1]
                end_date = kwargs["end_date"]
                return FakeFrame([
                    row for row in rows
                    if not (row["symbol"] == stale_symbol and row["date"] == end_date)
                ])

        trace = []
        with self.assertRaisesRegex(ValueError, "报告日|覆盖不足|截断"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
                 "minLiquidityCny": 20_000_000},
                worker.PandaCollector(StaleLatestPanda(), trace.append, None, 0),
                now="2026-07-24T10:30:00Z",
            )
        self.assertTrue(any(
            item["method"] == "get_stock_daily" and item["truncated"]
            for item in trace
        ))

    def test_one_row_per_symbol_fails_sixty_session_historical_coverage(self):
        class OneRowPerSymbolPanda(FakePanda):
            def get_stock_daily(self, start_date, end_date, symbol=None, fields=None,
                                indicator=None, st=True):
                return FakeFrame([
                    {"symbol": stock_symbol, "date": end_date, "name": stock_symbol,
                     "open": 10, "close": 10.1, "high": 10.2, "low": 9.9,
                     "volume": 3_000_000, "amount": 30_000_000, "pre_close": 10,
                     "limit_up": 11, "limit_down": 9, "trade_status": 0}
                    for stock_symbol in (symbol or [])
                ])

        with self.assertRaisesRegex(ValueError, "历史|session|覆盖"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
                 "minLiquidityCny": 20_000_000},
                worker.PandaCollector(OneRowPerSymbolPanda(), lambda _: None, None, 0),
                now="2026-07-24T10:30:00Z",
            )

    def test_listing_date_inside_window_reduces_expected_historical_sessions(self):
        class NewlyListedPanda(FakePanda):
            def get_trade_list(self, date, exchange="SH"):
                rows = super().get_trade_list(date, exchange).to_dict()
                rows[-1]["listing_date"] = "20260710"
                return FakeFrame(rows)

            def get_stock_daily(self, *args, **kwargs):
                rows = super().get_stock_daily(*args, **kwargs).to_dict()
                return FakeFrame([
                    row for row in rows
                    if row["symbol"] != self.symbols[-1] or row["date"] >= "20260710"
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(NewlyListedPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertAlmostEqual(pack["coverage"]["aShareHistorical"], 1)

    def test_duplicate_and_out_of_window_rows_do_not_inflate_historical_coverage(self):
        class InflatedRowsPanda(FakePanda):
            def get_stock_daily(self, *args, **kwargs):
                rows = super().get_stock_daily(*args, **kwargs).to_dict()
                by_symbol = {}
                for row in rows:
                    by_symbol.setdefault(row["symbol"], []).append(row)
                output = []
                for symbol_rows in by_symbol.values():
                    kept = symbol_rows[-50:]
                    output.extend(kept)
                    output.extend(dict(row) for row in kept[:5])
                    output.extend({**row, "date": "20260401"} for row in kept[:5])
                return FakeFrame(output)

        with self.assertRaisesRegex(ValueError, "历史|session|覆盖"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
                 "minLiquidityCny": 20_000_000},
                worker.PandaCollector(InflatedRowsPanda(), lambda _: None, None, 0),
                now="2026-07-24T10:30:00Z",
            )

    def test_failed_daily_cache_transaction_does_not_poison_complete_retry(self):
        class IncompleteCountingPanda(FakePanda):
            def __init__(self):
                self.daily_calls = 0

            def get_stock_daily(self, *args, **kwargs):
                self.daily_calls += 1
                rows = super().get_stock_daily(*args, **kwargs).to_dict()
                return FakeFrame([
                    row for index, row in enumerate(rows)
                    if index % worker.REQUIRED_TRADING_SESSIONS >= 10
                ])

        class CompleteCountingPanda(FakePanda):
            def __init__(self):
                self.daily_calls = 0

            def get_stock_daily(self, *args, **kwargs):
                self.daily_calls += 1
                return super().get_stock_daily(*args, **kwargs)

        request = {
            "operation": "daily-market-report",
            "date": "2026-07-23",
            "topN": 10,
            "minLiquidityCny": 20_000_000,
        }
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as cache_dir:
            incomplete = IncompleteCountingPanda()
            failed_trace = []
            with self.assertRaisesRegex(ValueError, "鍘嗗彶|session|瑕嗙洊"):
                worker.build_evidence_pack(
                    request,
                    worker.PandaCollector(
                        incomplete, failed_trace.append, cache_dir, 30
                    ),
                    now="2026-07-24T10:30:00Z",
                )

            daily_keys = {
                item["cacheKey"] for item in failed_trace
                if item["method"] == "get_stock_daily" and item["cacheKey"]
            }
            self.assertTrue(daily_keys)
            for cache_key in daily_keys:
                self.assertFalse(
                    (pathlib.Path(cache_dir) / f"{cache_key}.parquet").exists()
                )
                self.assertFalse(
                    (pathlib.Path(cache_dir) / f"{cache_key}.json").exists()
                )

            complete = CompleteCountingPanda()
            pack = worker.build_evidence_pack(
                request,
                worker.PandaCollector(complete, lambda _: None, cache_dir, 30),
                now="2026-07-24T10:30:00Z",
            )
            self.assertEqual(pack["coverage"]["aShareHistorical"], 1)
            self.assertGreater(complete.daily_calls, 0)

    def test_successful_daily_cache_transaction_commits_for_later_hit(self):
        class CountingPanda(FakePanda):
            def __init__(self):
                self.daily_calls = 0

            def get_stock_daily(self, *args, **kwargs):
                self.daily_calls += 1
                return super().get_stock_daily(*args, **kwargs)

        request = {
            "operation": "daily-market-report",
            "date": "2026-07-23",
            "topN": 10,
            "minLiquidityCny": 20_000_000,
        }
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as cache_dir:
            provider = CountingPanda()
            first_trace = []
            worker.build_evidence_pack(
                request,
                worker.PandaCollector(
                    provider, first_trace.append, cache_dir, 30
                ),
                now="2026-07-24T10:30:00Z",
            )
            first_call_count = provider.daily_calls
            self.assertGreater(first_call_count, 0)

            second_trace = []
            worker.build_evidence_pack(
                request,
                worker.PandaCollector(
                    provider, second_trace.append, cache_dir, 30
                ),
                now="2026-07-24T10:30:00Z",
            )
            self.assertEqual(provider.daily_calls, first_call_count)
            daily_traces = [
                item for item in second_trace
                if item["method"] == "get_stock_daily"
            ]
            self.assertTrue(daily_traces)
            self.assertTrue(all(
                item["cacheStatus"] == "hit" for item in daily_traces
            ))

    def test_failed_daily_validation_invalidates_existing_daily_cache_hit(self):
        class CountingPanda(FakePanda):
            def __init__(self):
                self.daily_calls = 0

            def get_stock_daily(self, *args, **kwargs):
                self.daily_calls += 1
                return super().get_stock_daily(*args, **kwargs)

        request = {
            "operation": "daily-market-report",
            "date": "2026-07-23",
            "topN": 10,
            "minLiquidityCny": 20_000_000,
        }
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as cache_dir:
            seed_trace = []
            seed_collector = worker.PandaCollector(
                FakePanda(), seed_trace.append, cache_dir, 30
            )
            worker.build_evidence_pack(
                request, seed_collector, now="2026-07-24T10:30:00Z"
            )
            daily_key = next(
                item["cacheKey"] for item in seed_trace
                if item["method"] == "get_stock_daily"
            )
            complete_rows = FakePanda().get_stock_daily(
                "20260430", "20260723", FakePanda.symbols
            ).to_dict()
            report_date_only = [
                row for row in complete_rows if row["date"] == "20260723"
            ]
            self.assertIsNone(
                seed_collector._write_cache(daily_key, report_date_only)
            )

            cached_failure_provider = CountingPanda()
            with self.assertRaisesRegex(ValueError, "鍘嗗彶|session|瑕嗙洊"):
                worker.build_evidence_pack(
                    request,
                    worker.PandaCollector(
                        cached_failure_provider, lambda _: None, cache_dir, 30
                    ),
                    now="2026-07-24T10:30:00Z",
                )
            self.assertEqual(cached_failure_provider.daily_calls, 0)
            self.assertFalse(
                (pathlib.Path(cache_dir) / f"{daily_key}.parquet").exists()
            )
            self.assertFalse(
                (pathlib.Path(cache_dir) / f"{daily_key}.json").exists()
            )

            retry_provider = CountingPanda()
            pack = worker.build_evidence_pack(
                request,
                worker.PandaCollector(
                    retry_provider, lambda _: None, cache_dir, 30
                ),
                now="2026-07-24T10:30:00Z",
            )
            self.assertEqual(pack["coverage"]["aShareHistorical"], 1)
            self.assertGreater(retry_provider.daily_calls, 0)

    def test_empty_candidate_set_does_not_expand_optional_calls_to_all_stocks(self):
        class NoUnboundedEnrichmentPanda(FakePanda):
            def get_lhb_list(self, **params):
                raise AssertionError("empty symbol list must not call provider")

            def get_fina_reports(self, **params):
                raise AssertionError("empty symbol list must not call provider")

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 999_000_000_000},
            worker.PandaCollector(NoUnboundedEnrichmentPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertFalse(any(
            item["method"] in {"get_lhb_list", "get_fina_reports"}
            for item in pack["missingData"]
        ))

    def test_concept_membership_after_report_date_is_excluded(self):
        class LateConceptPanda(FakePanda):
            def get_concept_list(self, concept=None, start_date=None, end_date=None):
                return FakeFrame([
                    {"name": "人工智能", "date": "20200101"},
                    {"name": "未来概念", "date": "20260724"},
                ])

            def get_concept_constituents(self, concept=None, concept_stock=None,
                                         date=None, fields=None):
                return FakeFrame([
                    {"concept": name, "concept_stock": symbol,
                     "date": "20200101" if name == "人工智能" else "20260724"}
                    for name in ("人工智能", "未来概念")
                    for symbol in self.symbols
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(LateConceptPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(
            [item["id"] for item in pack["leaderboards"]["hotConcepts"]],
            ["人工智能"],
        )

    def test_concept_definition_without_date_is_excluded(self):
        class UndatedConceptPanda(FakePanda):
            def __init__(self):
                self.constituent_calls = 0

            def get_concept_list(self, concept=None, start_date=None, end_date=None):
                return FakeFrame([{"name": "无日期概念", "date": None}])

            def get_concept_constituents(self, **params):
                self.constituent_calls += 1
                return super().get_concept_constituents(**params)

        provider = UndatedConceptPanda()
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(provider, lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(provider.constituent_calls, 0)
        self.assertTrue(any(item["method"] == "get_concept_list"
                            for item in pack["missingData"]))

    def test_empty_concept_set_never_calls_constituent_endpoint(self):
        class EmptyConceptPanda(FakePanda):
            def __init__(self):
                self.constituent_calls = 0

            def get_concept_list(self, concept=None, start_date=None, end_date=None):
                return FakeFrame([])

            def get_concept_constituents(self, **params):
                self.constituent_calls += 1
                raise AssertionError("concept=[] must not reach provider")

        provider = EmptyConceptPanda()
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(provider, lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(provider.constituent_calls, 0)
        concept_missing = [item for item in pack["missingData"]
                           if item["section"] == "hotConcepts"]
        self.assertEqual([item["method"] for item in concept_missing], ["get_concept_list"])

    def test_financial_publication_after_report_date_is_excluded(self):
        class LateFinancialPanda(FakePanda):
            def get_fina_reports(self, symbol=None, start_quarter=None, end_quarter=None,
                                 date=None, is_latest=True, fields=None):
                return FakeFrame([
                    {"symbol": stock_symbol, "date": publication, "quarter": "2026q2",
                     "roe": 10 if publication == "20260722" else 99,
                     "net_profit_yoy": 20 if publication == "20260722" else 999}
                    for stock_symbol in (symbol or [])
                    for publication in ("20260722", "20260724")
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(LateFinancialPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertTrue(pack["leaderboards"]["potentialWatchlist"])
        self.assertTrue(all(
            item["financialEvidenceDate"] == "2026-07-22"
            for item in pack["leaderboards"]["potentialWatchlist"]
        ))

    def test_later_publish_date_excludes_row_even_when_generic_date_is_earlier(self):
        class ConflictingDatesPanda(FakePanda):
            def get_fina_reports(self, symbol=None, **params):
                return FakeFrame([
                    {"symbol": stock_symbol, "date": "20260722",
                     "publish_date": "20260724", "quarter": "2026q2",
                     "roe": 99, "net_profit_yoy": 999}
                    for stock_symbol in (symbol or [])
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(ConflictingDatesPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertTrue(all(
            "quality" not in item["componentsUsed"]
            for item in pack["leaderboards"]["potentialWatchlist"]
        ))

    def test_undated_industry_memberships_are_excluded(self):
        class UndatedIndustryPanda(FakePanda):
            def get_industry_constituents(self, **params):
                return FakeFrame([
                    {"stock_symbol": symbol, "l1_code": "801010",
                     "l1_name": "农林牧渔", "in_date": None, "out_date": None}
                    for symbol in self.symbols
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(UndatedIndustryPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["leaderboards"]["hotIndustries"], [])
        self.assertTrue(any(item["method"] == "get_industry_constituents"
                            for item in pack["missingData"]))

    def test_future_lhb_rows_are_filtered_and_recorded_as_insufficient(self):
        class FutureLhbPanda(FakePanda):
            def get_lhb_list(self, symbol=None, **params):
                return FakeFrame([
                    {"symbol": stock_symbol, "date": "20260724",
                     "type": "G0007", "amount": 1_000_000}
                    for stock_symbol in (symbol or [])
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(FutureLhbPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertTrue(any(item["method"] == "get_lhb_list"
                            for item in pack["missingData"]))
        self.assertEqual(pack["status"], "degraded")

    def test_undated_financial_rows_do_not_contribute_quality_evidence(self):
        class UndatedFinancialPanda(FakePanda):
            def get_fina_reports(self, symbol=None, start_quarter=None, end_quarter=None,
                                 date=None, is_latest=True, fields=None):
                return FakeFrame([
                    {"symbol": stock_symbol, "date": None, "quarter": "2026q2",
                     "roe": 99, "net_profit_yoy": 999}
                    for stock_symbol in (symbol or [])
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(UndatedFinancialPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertTrue(pack["leaderboards"]["potentialWatchlist"])
        self.assertTrue(all(
            "quality" not in item["componentsUsed"]
            for item in pack["leaderboards"]["potentialWatchlist"]
        ))

    def test_truncated_broad_daily_data_fails_instead_of_ranking(self):
        class TruncatedPanda(FakePanda):
            def get_stock_daily(self, start_date, end_date, symbol=None, fields=None,
                                indicator=None, st=True):
                return super().get_stock_daily(
                    start_date, end_date, (symbol or [])[:1], fields, indicator, st
                )

        with self.assertRaisesRegex(ValueError, "覆盖不足|截断"):
            worker.build_evidence_pack(
                {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
                 "minLiquidityCny": 20_000_000},
                worker.PandaCollector(TruncatedPanda(), lambda _: None, None, 0),
                now="2026-07-24T10:30:00Z",
            )

    def test_hot_topic_coverage_under_eighty_percent_is_excluded(self):
        class LowCoveragePanda(FakePanda):
            def get_industry_constituents(self, industry_code=None, stock_symbol=None,
                                          level="L1", fields=None):
                symbols = self.symbols + ["900001.SZ", "900002.SZ"]
                return FakeFrame([
                    {"stock_symbol": symbol, "l1_code": "801010", "l1_name": "农林牧渔",
                     "in_date": "20200101", "out_date": None}
                    for symbol in symbols
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(LowCoveragePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["leaderboards"]["hotIndustries"], [])
        self.assertEqual(
            pack["excluded"]["hotIndustries"],
            [{"id": "801010", "reason": "MIN_COVERAGE"}],
        )
        self.assertEqual(pack["status"], "degraded")
        self.assertTrue(any(item["method"] == "get_industry_constituents"
                            for item in pack["missingData"]))

    def test_nonempty_but_insufficient_concept_coverage_degrades(self):
        class LowConceptCoveragePanda(FakePanda):
            def get_concept_constituents(self, **params):
                symbols = self.symbols + ["900001.SZ", "900002.SZ"]
                return FakeFrame([
                    {"concept": "人工智能", "concept_stock": symbol, "date": "20200101"}
                    for symbol in symbols
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(LowConceptCoveragePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["leaderboards"]["hotConcepts"], [])
        self.assertEqual(pack["status"], "degraded")
        self.assertTrue(any(item["method"] == "get_concept_constituents"
                            for item in pack["missingData"]))

    def test_partial_group_coverage_degrades_even_when_another_group_ranks(self):
        class MixedGroupCoveragePanda(FakePanda):
            def get_industry_constituents(self, **params):
                valid = [
                    {"stock_symbol": symbol, "l1_code": "valid-industry",
                     "l1_name": "有效行业", "in_date": "20200101", "out_date": None}
                    for symbol in self.symbols
                ]
                low = [
                    {"stock_symbol": symbol, "l1_code": "low-industry",
                     "l1_name": "低覆盖行业", "in_date": "20200101", "out_date": None}
                    for symbol in self.symbols + ["900001.SZ", "900002.SZ"]
                ]
                return FakeFrame(valid + low)

            def get_concept_list(self, **params):
                return FakeFrame([
                    {"name": "有效概念", "date": "20200101"},
                    {"name": "低覆盖概念", "date": "20200101"},
                ])

            def get_concept_constituents(self, **params):
                valid = [
                    {"concept": "有效概念", "concept_stock": symbol, "date": "20200101"}
                    for symbol in self.symbols
                ]
                low = [
                    {"concept": "低覆盖概念", "concept_stock": symbol, "date": "20200101"}
                    for symbol in self.symbols + ["900001.SZ", "900002.SZ"]
                ]
                return FakeFrame(valid + low)

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(MixedGroupCoveragePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual([item["id"] for item in pack["leaderboards"]["hotIndustries"]],
                         ["valid-industry"])
        self.assertEqual([item["id"] for item in pack["leaderboards"]["hotConcepts"]],
                         ["有效概念"])
        self.assertEqual(pack["status"], "degraded")
        missing_methods = {item["method"] for item in pack["missingData"]}
        self.assertIn("get_industry_constituents", missing_methods)
        self.assertIn("get_concept_constituents", missing_methods)

    def test_min_constituents_exclusion_alone_does_not_imply_provider_gap(self):
        class SmallIndustryPanda(FakePanda):
            def get_industry_constituents(self, **params):
                return FakeFrame([
                    {"stock_symbol": symbol, "l1_code": "small",
                     "l1_name": "小行业", "in_date": "20200101", "out_date": None}
                    for symbol in self.symbols[:4]
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(SmallIndustryPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["excluded"]["hotIndustries"],
                         [{"id": "small", "reason": "MIN_CONSTITUENTS"}])
        self.assertFalse(any(item["method"] == "get_industry_constituents"
                             for item in pack["missingData"]))
        self.assertEqual(pack["status"], "complete")

    def test_theme_component_applies_to_all_group_members_not_only_representatives(self):
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(FakePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        last_member = next(
            item for item in pack["leaderboards"]["potentialWatchlist"]
            if item["symbol"] == "000006.SZ"
        )
        self.assertIn("theme", last_member["componentsUsed"])

    def test_suspended_and_st_rows_are_excluded_from_headline_groups(self):
        class IneligibleHeadlinePanda(FakePanda):
            def get_stock_daily(self, *args, **kwargs):
                rows = super().get_stock_daily(*args, **kwargs).to_dict()
                end_date = kwargs["end_date"]
                for row in rows:
                    if row["symbol"] == self.symbols[0]:
                        row["name"] = "ST风险"
                    if row["symbol"] == self.symbols[1] and row["date"] == end_date:
                        row["trade_status"] = 1
                return FakeFrame(rows)

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(IneligibleHeadlinePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["leaderboards"]["hotIndustries"], [])
        self.assertEqual(
            pack["excluded"]["hotIndustries"],
            [{"id": "801010", "reason": "MIN_CONSTITUENTS"}],
        )

    def test_optional_lhb_failure_redistributes_weight_and_lowers_confidence(self):
        class NoLhbPanda(FakePanda):
            def get_lhb_list(self, **params):
                raise RuntimeError("password=hunter2")

        trace = []
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(NoLhbPanda(), trace.append, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        top = pack["leaderboards"]["hotIndustries"][0]
        self.assertAlmostEqual(top["weightCoverage"], .95)
        self.assertAlmostEqual(top["confidence"], .95)
        lhb_missing = next(item for item in pack["missingData"]
                           if item["method"] == "get_lhb_list")
        self.assertEqual(lhb_missing["weightRemoved"], .05)
        self.assertNotIn("hunter2", json.dumps(trace))

    def test_us_data_date_is_previous_completed_us_session(self):
        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(FakePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["markets"]["us"]["dataDate"], "2026-07-22")
        self.assertEqual(pack["markets"]["us"]["sessionRule"], "previous-completed-session")

    def test_fixed_query_plan_batches_broad_daily_requests(self):
        class ManyStocksPanda(FakePanda):
            symbols = [f"{value:06d}.SZ" for value in range(1, 402)]

            def __init__(self):
                self.daily_batch_sizes = []

            def get_stock_daily(self, start_date, end_date, symbol=None, fields=None,
                                indicator=None, st=True):
                self.daily_batch_sizes.append(len(symbol or []))
                return super().get_stock_daily(
                    start_date, end_date, symbol, fields, indicator, st
                )

        provider = ManyStocksPanda()
        worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(provider, lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(sum(provider.daily_batch_sizes), 401)
        self.assertTrue(all(size * 60 <= 480 for size in provider.daily_batch_sizes))

    def test_report_date_coverage_is_global_not_per_small_batch(self):
        class AggregateCoveragePanda(FakePanda):
            symbols = [f"{value:06d}.SZ" for value in range(1, 42)]

            def get_stock_daily(self, *args, **kwargs):
                rows = super().get_stock_daily(*args, **kwargs).to_dict()
                return FakeFrame([
                    row for row in rows
                    if not (row["symbol"] == self.symbols[8] and
                            row["date"] == kwargs["end_date"])
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(AggregateCoveragePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["universe"]["dailyCovered"], 40)
        self.assertGreaterEqual(pack["coverage"]["aShareDaily"], .95)

    def test_collector_marks_trace_truncated_before_contract_failure(self):
        class OverLimitPanda:
            __version__ = "0.0.12"

            def get_stock_daily(self, **params):
                return FakeFrame([{"symbol": "000001.SZ", "date": "20260723"}] * 11)

        trace = []
        collector = worker.PandaCollector(OverLimitPanda(), trace.append, None, 0)
        with self.assertRaisesRegex(ValueError, "截断|上限|coverage"):
            collector.call(
                "get_stock_daily",
                expected_max_rows=10,
                start_date="20260701",
                end_date="20260723",
                symbol=["000001.SZ"],
            )
        self.assertEqual(len(trace), 1)
        self.assertEqual(trace[0]["status"], "error")
        self.assertTrue(trace[0]["truncated"])

    def test_collector_accepts_legitimate_response_at_declared_bound(self):
        class ExactBoundPanda:
            __version__ = "0.0.12"

            def get_stock_daily(self, **params):
                return FakeFrame([
                    {"symbol": "000001.SZ", "date": "20260723", "sequence": index}
                    for index in range(500)
                ])

        trace = []
        rows = worker.PandaCollector(ExactBoundPanda(), trace.append, None, 0).call(
            "get_stock_daily",
            expected_max_rows=500,
            start_date="20260101",
            end_date="20260723",
            symbol=["000001.SZ"],
        )
        self.assertEqual(len(rows), 500)
        self.assertFalse(trace[0]["truncated"])

    def test_collector_traces_exception_paths_without_secrets(self):
        class FailingPanda:
            def get_lhb_list(self, **params):
                raise RuntimeError("password=hunter2")

        trace = []
        collector = worker.PandaCollector(FailingPanda(), trace.append, None, 0)
        with self.assertRaises(RuntimeError):
            collector.call("get_lhb_list", start_date="20260701", end_date="20260723")
        self.assertEqual(trace[0]["status"], "error")
        self.assertIsNone(trace[0]["rowCount"])
        self.assertIn("durationMs", trace[0])
        self.assertNotIn("hunter2", json.dumps(trace))

    def test_collector_redacts_authorization_header_forms(self):
        class AuthFailurePanda:
            def get_lhb_list(self, **params):
                raise RuntimeError(
                    "Authorization: Bearer bearer-secret; "
                    "authorization=Basic basic-secret; auth_header: header-secret"
                )

        trace = []
        with self.assertRaises(RuntimeError):
            worker.PandaCollector(AuthFailurePanda(), trace.append, None, 0).call(
                "get_lhb_list", start_date="20260701", end_date="20260723"
            )
        serialized = json.dumps(trace)
        for secret in ("bearer-secret", "basic-secret", "header-secret"):
            self.assertNotIn(secret, serialized)
        self.assertIn("[REDACTED]", serialized)

    def test_optional_error_redacts_authorization_text_in_missing_data(self):
        class AuthFailurePanda(FakePanda):
            def get_lhb_list(self, **params):
                raise RuntimeError("Authorization: Bearer missing-secret")

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(AuthFailurePanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertNotIn("missing-secret", json.dumps(pack))

    def test_parquet_cache_has_metadata_and_prevents_repeat_provider_call(self):
        class CountingPanda(FakePanda):
            def __init__(self):
                self.calls = 0

            def get_trade_list(self, date, exchange="SH"):
                self.calls += 1
                return super().get_trade_list(date, exchange)

        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as cache_dir:
            provider = CountingPanda()
            first_trace = []
            first = worker.PandaCollector(provider, first_trace.append, cache_dir, 30)
            first.report_date = "20260723"
            expected = first.call("get_trade_list", date="20260723", exchange="SH")

            metadata_files = list(pathlib.Path(cache_dir).glob("*.json"))
            parquet_files = list(pathlib.Path(cache_dir).glob("*.parquet"))
            self.assertEqual(len(metadata_files), 1)
            self.assertEqual(len(parquet_files), 1)
            metadata = json.loads(metadata_files[0].read_text(encoding="utf-8"))
            self.assertEqual(metadata["rowCount"], len(expected))
            self.assertEqual(metadata["dataAsOf"], "2026-07-23")
            self.assertEqual(metadata["fields"], ["date", "symbol"])
            self.assertEqual(len(metadata["contentHash"]), 64)

            second_trace = []
            second = worker.PandaCollector(provider, second_trace.append, cache_dir, 30)
            second.report_date = "20260723"
            self.assertEqual(
                second.call("get_trade_list", date="20260723", exchange="SH"),
                expected,
            )
            self.assertEqual(provider.calls, 1)
            self.assertEqual(second_trace[0]["cacheStatus"], "hit")

    def test_cache_mixed_valid_and_undated_rows_round_trips(self):
        class MixedDatePanda(FakePanda):
            def __init__(self):
                self.calls = 0

            def get_trade_list(self, date, exchange="SH"):
                self.calls += 1
                return FakeFrame([
                    {"symbol": self.symbols[0], "date": date},
                    {"symbol": self.symbols[1], "date": None},
                ])

        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as cache_dir:
            provider = MixedDatePanda()
            first = worker.PandaCollector(provider, lambda _: None, cache_dir, 30)
            first.report_date = "20260723"
            expected = first.call("get_trade_list", date="20260723", exchange="SH")
            second_trace = []
            second = worker.PandaCollector(provider, second_trace.append, cache_dir, 30)
            second.report_date = "20260723"
            self.assertEqual(
                second.call("get_trade_list", date="20260723", exchange="SH"),
                expected,
            )
            self.assertEqual(provider.calls, 1)
            self.assertEqual(second_trace[0]["cacheStatus"], "hit")

    def test_empty_optional_results_degrade_without_duplicate_entries(self):
        class EmptyOptionalPanda(FakePanda):
            def get_industry_constituents(self, **params):
                return FakeFrame([])

            def get_concept_list(self, **params):
                return FakeFrame([])

            def get_lhb_list(self, **params):
                return FakeFrame([])

            def get_fina_reports(self, **params):
                return FakeFrame([])

            def get_trade_cal(self, *args, **kwargs):
                if kwargs.get("exchange") == "US":
                    return FakeFrame([])
                return super().get_trade_cal(*args, **kwargs)

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(EmptyOptionalPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["status"], "degraded")
        missing_methods = [item["method"] for item in pack["missingData"]]
        for method in ("get_industry_constituents", "get_concept_list", "get_lhb_list",
                       "get_fina_reports", "get_trade_cal"):
            self.assertIn(method, missing_methods)
        self.assertEqual(
            len(pack["missingData"]),
            len({(item["section"], item["method"]) for item in pack["missingData"]}),
        )

    def test_empty_us_daily_result_degrades_report(self):
        class EmptyUsDailyPanda(FakePanda):
            def get_us_daily(self, **params):
                return FakeFrame([])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(EmptyUsDailyPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["status"], "degraded")
        self.assertTrue(any(item["method"] == "get_us_daily"
                            for item in pack["missingData"]))

    def test_partial_financial_and_us_symbol_coverage_degrades_report(self):
        class PartialOptionalPanda(FakePanda):
            def get_fina_reports(self, symbol=None, **params):
                return super().get_fina_reports(symbol=(symbol or [])[:2], **params)

            def get_us_daily(self, start_date, end_date, symbol=None, fields=None):
                return super().get_us_daily(
                    start_date, end_date, (symbol or [])[:1], fields
                )

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(PartialOptionalPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["status"], "degraded")
        missing_methods = {item["method"] for item in pack["missingData"]}
        self.assertIn("get_fina_reports", missing_methods)
        self.assertIn("get_us_daily", missing_methods)

    def test_us_rows_must_match_resolved_completed_session_date(self):
        class WrongDateUsPanda(FakePanda):
            def get_us_daily(self, start_date, end_date, symbol=None, fields=None):
                dates = ["20260721", "20260723"]
                return FakeFrame([
                    {"symbol": stock_symbol, "date": dates[index],
                     "close": 100 + index, "pre_close": 99 + index,
                     "name": stock_symbol}
                    for index, stock_symbol in enumerate(symbol or [])
                ])

        pack = worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
             "minLiquidityCny": 20_000_000},
            worker.PandaCollector(WrongDateUsPanda(), lambda _: None, None, 0),
            now="2026-07-24T10:30:00Z",
        )
        self.assertEqual(pack["markets"]["us"]["dataDate"], "2026-07-22")
        self.assertEqual(pack["markets"]["us"]["rowCount"], 0)
        self.assertEqual(pack["status"], "degraded")
        self.assertTrue(any(item["method"] == "get_us_daily"
                            for item in pack["missingData"]))

    def test_worker_protocol_stdout_only_json_and_stderr_only_trace_lines(self):
        class ProtocolPanda(FakePanda):
            def __init__(self):
                self.auth = None

            def init_token(self, username, password, base_url):
                self.auth = (username, password, base_url)

        fixture = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        provider = ProtocolPanda()
        stdin = io.StringIO(json.dumps(fixture["request"], ensure_ascii=False))
        stdout = io.StringIO()
        stderr = io.StringIO()
        environment = {
            "PANDA_DATA_USERNAME": "8613800000000",
            "PANDA_DATA_PASSWORD": "protocol-secret",
            "PANDA_DATA_BASE_URL": "http://panda.invalid",
        }
        with mock.patch.dict(sys.modules, {"panda_data": provider}), \
                mock.patch.dict(os.environ, environment, clear=False), \
                mock.patch.object(sys, "stdin", stdin), \
                mock.patch.object(sys, "stdout", stdout), \
                mock.patch.object(sys, "stderr", stderr):
            worker.main()

        output_lines = stdout.getvalue().splitlines()
        self.assertEqual(len(output_lines), 1)
        pack = json.loads(output_lines[0])
        self.assertEqual(pack["schemaVersion"], fixture["expected"]["schemaVersion"])
        self.assertEqual(pack["reportDate"], fixture["expected"]["reportDate"])
        trace_lines = stderr.getvalue().splitlines()
        self.assertTrue(trace_lines)
        self.assertTrue(all(line.startswith("TRACE ") for line in trace_lines))
        self.assertTrue(all(json.loads(line[6:]) for line in trace_lines))
        self.assertNotIn("protocol-secret", stdout.getvalue() + stderr.getvalue())
        self.assertEqual(provider.auth, (
            "8613800000000", "protocol-secret", "http://panda.invalid"
        ))

    def test_protocol_rejects_request_controlled_cache_path_without_writing(self):
        class ProtocolPanda(FakePanda):
            def init_token(self, **params):
                pass

        fixture = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as parent:
            attacker_path = pathlib.Path(parent) / "request-controlled-cache"
            request = {**fixture["request"], "cacheDir": str(attacker_path)}
            with mock.patch.dict(sys.modules, {"panda_data": ProtocolPanda()}), \
                    mock.patch.dict(os.environ, {
                        "PANDA_DATA_USERNAME": "8613800000000",
                        "PANDA_DATA_PASSWORD": "protocol-secret",
                        "MARKET_REPORT_CACHE_DIR": "",
                    }, clear=False), \
                    mock.patch.object(sys, "stdin", io.StringIO(json.dumps(request))), \
                    mock.patch.object(sys, "stdout", io.StringIO()), \
                    mock.patch.object(sys, "stderr", io.StringIO()):
                with self.assertRaisesRegex(ValueError, "cacheDir|字段|路径"):
                    worker.main()
            self.assertFalse(attacker_path.exists())

    def test_protocol_rejects_other_request_controlled_path_fields(self):
        fixture = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        request = {**fixture["request"], "outputPath": "O:\\attacker\\report.json"}
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(request))):
            with self.assertRaisesRegex(ValueError, "outputPath|字段|路径"):
                worker.main()

    def test_protocol_uses_only_environment_controlled_cache_root(self):
        class ProtocolPanda(FakePanda):
            def init_token(self, **params):
                pass

        fixture = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        request = {key: value for key, value in fixture["request"].items()
                   if key != "cacheDir"}
        with tempfile.TemporaryDirectory(dir=pathlib.Path.cwd()) as parent:
            cache_path = pathlib.Path(parent) / "deployment-cache"
            with mock.patch.dict(sys.modules, {"panda_data": ProtocolPanda()}), \
                    mock.patch.dict(os.environ, {
                        "PANDA_DATA_USERNAME": "8613800000000",
                        "PANDA_DATA_PASSWORD": "protocol-secret",
                        "MARKET_REPORT_CACHE_DIR": str(cache_path),
                    }, clear=False), \
                    mock.patch.object(sys, "stdin", io.StringIO(json.dumps(request))), \
                    mock.patch.object(sys, "stdout", io.StringIO()), \
                    mock.patch.object(sys, "stderr", io.StringIO()):
                worker.main()
            self.assertTrue(list(cache_path.glob("*.parquet")))
            self.assertTrue(list(cache_path.glob("*.json")))

    def test_worker_failure_boundary_is_nonzero_single_trace_and_no_stdout(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(
                worker,
                "main",
                side_effect=RuntimeError("Authorization: Bearer outer-secret"),
        ), mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", stderr):
            exit_code = worker.run()

        self.assertNotEqual(exit_code, 0)
        self.assertEqual(stdout.getvalue(), "")
        lines = stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("TRACE "))
        payload = json.loads(lines[0][6:])
        self.assertEqual(payload["type"], "worker-error")
        self.assertNotIn("outer-secret", lines[0])

    def test_effective_weights_renormalize_without_treating_missing_as_zero(self):
        values = {"downside_volume": 90.0, "lhb_net_sell": None, "northbound_reduction": 70.0,
                  "margin_contraction": 50.0, "discount_event": None}
        score, coverage, used = worker.effective_weights(
            values,
            {"downside_volume": .25, "lhb_net_sell": .25, "northbound_reduction": .20,
             "margin_contraction": .15, "discount_event": .15},
            minimum_components=3,
        )
        self.assertAlmostEqual(score, (90*.25 + 70*.20 + 50*.15) / .60)
        self.assertAlmostEqual(coverage, .60)
        self.assertEqual(set(used), {"downside_volume", "northbound_reduction", "margin_contraction"})

    def test_hot_topic_requires_constituent_and_coverage_thresholds(self):
        result = worker.compute_hot_topics([
            {"id": "eligible", "constituent_count": 10, "coverage": .9, "ret1": 2, "ret5": 5,
             "breadth5": .8, "turnover_heat": 1.7, "acceleration": .03, "lhb_activity": 4},
            {"id": "too-small", "constituent_count": 4, "coverage": 1, "ret1": 8, "ret5": 9,
             "breadth5": 1, "turnover_heat": 3, "acceleration": .09, "lhb_activity": 8},
        ])
        self.assertEqual([item["id"] for item in result["ranked"]], ["eligible"])
        self.assertEqual(result["excluded"][0]["reason"], "MIN_CONSTITUENTS")

    def test_sell_pressure_requires_three_independent_components(self):
        result = worker.compute_sell_pressure([
            {"symbol": "000001.SZ", "downside_volume": 90, "lhb_net_sell": 80,
             "northbound_reduction": None, "margin_contraction": None, "discount_event": None}
        ])
        self.assertEqual(result[0]["status"], "EVIDENCE_INSUFFICIENT")

    def test_sell_pressure_ties_break_by_symbol(self):
        result = worker.compute_sell_pressure([
            {"symbol": "000002.SZ", "downside_volume": 90, "lhb_net_sell": 80,
             "northbound_reduction": 70, "margin_contraction": 60, "discount_event": 50},
            {"symbol": "000001.SZ", "downside_volume": 90, "lhb_net_sell": 80,
             "northbound_reduction": 70, "margin_contraction": 60, "discount_event": 50},
        ])
        self.assertEqual([item["symbol"] for item in result], ["000001.SZ", "000002.SZ"])

    def test_nan_is_missing_evidence_not_a_ranked_component(self):
        result = worker.compute_sell_pressure([
            {"symbol": "000001.SZ", "downside_volume": 90, "lhb_net_sell": math.nan,
             "northbound_reduction": 70, "margin_contraction": None, "discount_event": None}
        ])
        self.assertEqual(result[0]["status"], "EVIDENCE_INSUFFICIENT")
        self.assertEqual(result[0]["componentsUsed"], ["downside_volume", "northbound_reduction"])

    def test_potential_watchlist_floors_risk_adjusted_score_at_zero(self):
        ranked = worker.compute_potential_watchlist([
            {"symbol": "000001.SZ", "trend": 10, "theme": 10, "quality": 10, "valuation": 10,
             "capital": 10, "liquidity_stability": 10, "risk_penalty": 20}
        ])
        self.assertAlmostEqual(ranked[0]["baseScore"], 10)
        self.assertEqual(ranked[0]["score"], 0)

    def test_hot_topics_redistributes_missing_lhb_weight(self):
        groups = [
            {"id": f"{value:02d}", "constituent_count": 5, "coverage": .8, "ret1": value,
             "ret5": value, "breadth5": value, "turnover_heat": value,
             "acceleration": value, "lhb_activity": value}
            for value in range(1, 42)
        ]
        result = worker.compute_hot_topics(groups, lhb_available=False)
        high = result["ranked"][0]
        self.assertEqual(high["id"], "41")
        self.assertAlmostEqual(high["score"], 100)
        self.assertAlmostEqual(high["weightCoverage"], .95)
        self.assertNotIn("lhb_activity", high["componentsUsed"])

    def test_hot_topics_excludes_nonfinite_constituent_count(self):
        groups = [
            {"id": "missing", "coverage": 1},
            {"id": "text", "constituent_count": "five", "coverage": 1},
            {"id": "nan", "constituent_count": math.nan, "coverage": 1},
        ]
        result = worker.compute_hot_topics(groups)
        self.assertEqual(result["ranked"], [])
        self.assertEqual(
            result["excluded"],
            [{"id": "missing", "reason": "MIN_CONSTITUENTS"},
             {"id": "text", "reason": "MIN_CONSTITUENTS"},
             {"id": "nan", "reason": "MIN_CONSTITUENTS"}],
        )

    def test_hot_topics_excludes_nonfinite_coverage(self):
        groups = [
            {"id": "missing", "constituent_count": 5},
            {"id": "text", "constituent_count": 5, "coverage": "complete"},
            {"id": "infinite", "constituent_count": 5, "coverage": math.inf},
        ]
        result = worker.compute_hot_topics(groups)
        self.assertEqual(result["ranked"], [])
        self.assertEqual(
            result["excluded"],
            [{"id": "missing", "reason": "MIN_COVERAGE"},
             {"id": "text", "reason": "MIN_COVERAGE"},
             {"id": "infinite", "reason": "MIN_COVERAGE"}],
        )

    def test_potential_watchlist_ignores_unavailable_unlock_percentages(self):
        base = {"trend": 80, "theme": 80, "quality": 80, "valuation": 80,
                "capital": 80, "liquidity_stability": 80}
        rows = [
            {**base, "symbol": "missing", "unlock_float_pct_30d": None},
            {**base, "symbol": "text", "unlock_float_pct_30d": "unknown"},
            {**base, "symbol": "nan", "unlock_float_pct_30d": math.nan},
            {**base, "symbol": "large", "unlock_float_pct_30d": 10.01},
        ]
        ranked = {row["symbol"]: row for row in worker.compute_potential_watchlist(rows)}
        self.assertEqual(ranked["missing"]["vetoes"], [])
        self.assertEqual(ranked["text"]["vetoes"], [])
        self.assertEqual(ranked["nan"]["vetoes"], [])
        self.assertEqual(ranked["large"]["vetoes"], ["LARGE_UNLOCK_30D"])

    def test_potential_watchlist_defaults_invalid_risk_penalty_to_zero(self):
        base = {"trend": 80, "theme": 80, "quality": 80, "valuation": 80,
                "capital": 80, "liquidity_stability": 80}
        rows = [
            {**base, "symbol": "missing", "risk_penalty": None},
            {**base, "symbol": "text", "risk_penalty": "unknown"},
            {**base, "symbol": "infinite", "risk_penalty": math.inf},
            {**base, "symbol": "finite", "risk_penalty": 5},
        ]
        ranked = {row["symbol"]: row for row in worker.compute_potential_watchlist(rows)}
        self.assertAlmostEqual(ranked["missing"]["score"], 80)
        self.assertAlmostEqual(ranked["text"]["score"], 80)
        self.assertAlmostEqual(ranked["infinite"]["score"], 80)
        self.assertAlmostEqual(ranked["finite"]["score"], 75)

    def test_potential_watchlist_applies_audit_and_unlock_vetoes(self):
        rows = [
            {"symbol": "000001.SZ", "trend": 80, "theme": 80, "quality": 80, "valuation": 80,
             "capital": 80, "liquidity_stability": 80, "risk_penalty": 0, "st": False,
             "nonstandard_audit": False, "unlock_float_pct_30d": 0, "coverage": 1},
            {"symbol": "000002.SZ", "trend": 99, "theme": 99, "quality": 99, "valuation": 99,
             "capital": 99, "liquidity_stability": 99, "risk_penalty": 0, "st": False,
             "nonstandard_audit": True, "unlock_float_pct_30d": 0, "coverage": 1},
        ]
        ranked = worker.compute_potential_watchlist(rows)
        self.assertEqual(ranked[0]["symbol"], "000001.SZ")
        self.assertEqual(ranked[1]["status"], "VETOED")
        self.assertIn("NONSTANDARD_AUDIT", ranked[1]["vetoes"])


if __name__ == "__main__":
    unittest.main()
