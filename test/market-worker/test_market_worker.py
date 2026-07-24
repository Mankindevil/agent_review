import importlib.util
import math
import pathlib
import unittest

WORKER = pathlib.Path("agents/market-analyst/tools/panda_market_worker.py")
spec = importlib.util.spec_from_file_location("panda_market_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MarketWorkerTests(unittest.TestCase):
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
