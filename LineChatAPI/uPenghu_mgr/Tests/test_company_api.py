"""test_company_api.py -- company_api 的單元/整合測試 (內建 unittest, 離線可跑).

離線單元測試: 用 unittest.mock 存根 requests.get, 不打真實 API。
整合測試(會打真實 uPenghu API): 需設環境變數 MGR_TEST_INTEGRATION=1 才會跑,
預設自動跳過, 避免 CI/離線環境誤連外部服務。

執行(在 LineChatAPI 目錄下):
  python -m unittest uPenghu_mgr.Tests.test_company_api -v
  # 或含真實 API 整合:
  $env:MGR_TEST_INTEGRATION="1"; python -m unittest uPenghu_mgr.Tests.test_company_api -v
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from ..api_clients import company_api as ca

# 一組貼近真實結構的 Company 假資料 (含完全重複一筆, 驗證去重)
_FAKE_COMPANIES = [
    {"CPID": 2, "CPName": "藍海天晴", "CPTypeName": "民宿業者", "CPOnline": 1,
     "Tel": "06-9952369", "Tel2": "", "WebSite": "http://ocean", "LocationType": "山水沙灘",
     "ExCPID": "1,105", "EPName": "民宿", "Fax": "x", "CPImg": "y", "CPTypeID": 1},
    {"CPID": 1, "CPName": "藍海風晴", "CPTypeName": "民宿業者", "CPOnline": 1,
     "Tel": "06-9952115", "Tel2": "", "WebSite": "http://sb", "LocationType": "山水沙灘",
     "ExCPID": "2,105", "EPName": "民宿"},
    {"CPID": 3, "CPName": "發現藍海", "CPTypeName": "租車行", "CPOnline": 0,
     "Tel": "06-9952736", "Tel2": "", "WebSite": "", "LocationType": "", "ExCPID": ""},
    {"CPID": 1, "CPName": "藍海風晴", "CPTypeName": "民宿業者", "CPOnline": 1,
     "Tel": "06-9952115", "Tel2": "", "WebSite": "http://sb", "LocationType": "山水沙灘",
     "ExCPID": "2,105", "EPName": "民宿"},  # 與上頭 CPID=1 完全重複(精簡後)
]


def _resp(payload, status=200, text=""):
    """建一個假的 requests.Response (payload 給 .json(), text 供非 200 的錯誤訊息)."""
    m = mock.Mock()
    m.status_code = status
    m.text = text
    m.json.return_value = payload
    return m


class QueryCompaniesTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(ca.requests, "get", return_value=_resp(_FAKE_COMPANIES))
        self.mock_get = patcher.start()
        self.addCleanup(patcher.stop)

    def test_dedup_and_sort(self):
        data = ca.query_companies()
        ids = [c["CPID"] for c in data["companies"]]
        self.assertEqual(data["count"], 3)          # 重複的 CPID=1 被去掉
        self.assertEqual(ids, [1, 2, 3])            # 依 CPID 排序
        self.assertNotIn("Fax", data["companies"][0])  # 精簡欄位未保留 Fax

    def test_online_only(self):
        data = ca.query_companies(online_only=True)
        self.assertEqual({c["CPID"] for c in data["companies"]}, {1, 2})

    def test_cp_type_filter(self):
        data = ca.query_companies(cp_type="民宿")
        self.assertEqual(data["count"], 2)

    def test_query_by_name(self):
        data = ca.query_companies(query="發現")
        self.assertEqual([c["CPID"] for c in data["companies"]], [3])

    def test_url_and_endpoint(self):
        ca.query_companies()
        called_url = self.mock_get.call_args.args[0]
        self.assertTrue(called_url.endswith(ca.ENDPOINT))


class QueryByPdTypeTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(ca.requests, "get", return_value=_resp(_FAKE_COMPANIES))
        self.mock_get = patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_params(self):
        data = ca.query_companies_by_pdtype()
        self.assertEqual(data["params"], {"pdtypeid": 1, "cpids": "1,2,105", "include": 1})
        kwargs = self.mock_get.call_args.kwargs
        self.assertEqual(kwargs["params"], {"pdtypeid": 1, "cpids": "1,2,105", "include": 1})
        self.assertTrue(self.mock_get.call_args.args[0].endswith(ca.PDTYPE_ENDPOINT))

    def test_include_zero_forwarded(self):
        data = ca.query_companies_by_pdtype(pdtypeid=1, cpids="1,2", include=0)
        self.assertEqual(data["params"]["include"], 0)
        self.assertEqual(self.mock_get.call_args.kwargs["params"]["include"], 0)

    def test_empty_cpids_raises_before_http(self):
        with self.assertRaises(ca.CompanyApiError):
            ca.query_companies_by_pdtype(cpids="   ")
        self.mock_get.assert_not_called()

    def test_bad_include_raises_before_http(self):
        with self.assertRaises(ca.CompanyApiError):
            ca.query_companies_by_pdtype(include=5)
        self.mock_get.assert_not_called()

    def test_result_dedup(self):
        data = ca.query_companies_by_pdtype()
        self.assertEqual(data["count"], 3)


class HttpErrorTest(unittest.TestCase):
    def test_non_200_raises(self):
        with mock.patch.object(ca.requests, "get", return_value=_resp(None, status=400, text="Bad")):
            with self.assertRaises(ca.CompanyApiError):
                ca.query_companies_by_pdtype()

    def test_network_error_wrapped(self):
        with mock.patch.object(ca.requests, "get", side_effect=ca.requests.RequestException("boom")):
            with self.assertRaises(ca.CompanyApiError):
                ca.query_companies()

    def test_non_list_payload_raises(self):
        with mock.patch.object(ca.requests, "get", return_value=_resp({"oops": 1})):
            with self.assertRaises(ca.CompanyApiError):
                ca.query_companies()


class FormatterTest(unittest.TestCase):
    def test_pdtype_report_includes_mode(self):
        data = {"count": 1, "params": {"pdtypeid": 1, "cpids": "1,2,105", "include": 1},
                "companies": [_FAKE_COMPANIES[1]]}
        text = ca.format_pdtype_report(data)
        self.assertIn("只列 cpids 內", text)
        self.assertIn("藍海風晴", text)


@unittest.skipUnless(os.environ.get("MGR_TEST_INTEGRATION") == "1",
                     "設 MGR_TEST_INTEGRATION=1 才跑真實 API 整合測試")
class IntegrationTest(unittest.TestCase):
    def test_real_company_list(self):
        data = ca.query_companies(cp_type="民宿", online_only=True)
        self.assertGreater(data["count"], 0)

    def test_real_pdtype_default(self):
        data = ca.query_companies_by_pdtype()
        self.assertEqual(data["params"], {"pdtypeid": 1, "cpids": "1,2,105", "include": 1})
        self.assertIsInstance(data["companies"], list)


if __name__ == "__main__":
    unittest.main()
