import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest import TestCase, main
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
IPV4 = "203.0.113.10"
IPV6 = "2001:db8::10"
API_HOSTS = {
    "api.ipify.org", "api6.ipify.org", "api.ip.sb",
    "www.cloudflare.com", "chatgpt.com", "claude.ai",
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class SiteTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT))
        )
        cls.server_thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            headless=True, channel=os.getenv("COFFEE_TEST_BROWSER_CHANNEL")
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={"width": 1280, "height": 900}
        )
        self.page = self.context.new_page()
        self.errors = []
        self.requests = []
        self.api_requests = []
        self.hold_hosts = set()
        self.pending = []
        self.responses = {}
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda request: self.requests.append(request.url))
        self.context.route("https://**/*", self.serve_api)

    def tearDown(self):
        try:
            for route in self.pending:
                route.abort()
            self.assertEqual(self.errors, [], "Unexpected browser exceptions")
        finally:
            self.context.close()

    def serve_api(self, route):
        host = urlparse(route.request.url).hostname
        if host not in API_HOSTS:
            route.abort()
            return
        self.api_requests.append(route.request.url)
        if host in self.hold_hosts:
            self.pending.append(route)
        elif host in self.responses:
            route.fulfill(**self.responses[host])
        elif host == "api.ipify.org":
            route.fulfill(json={"ip": IPV4})
        elif host == "api6.ipify.org":
            route.fulfill(json={"ip": IPV6})
        elif host == "api.ip.sb":
            route.fulfill(json={
                "ip": IPV4, "country_code": "SG", "region": "Singapore",
                "city": "Singapore", "isp": "Example Network", "asn": 64500,
            })
        else:
            route.fulfill(
                content_type="text/plain", body=f"ip={IPV4}\nloc=SG\n"
            )

    def open(self, path="/"):
        self.page.goto(self.origin + path, wait_until="load")

    def navigate(self, section):
        self.page.locator(f'.site-header nav a[data-section="{section}"]').click()
        expect(self.page.locator("main")).to_have_attribute("data-section", section)

    def open_tool(self):
        self.navigate("posts")
        self.page.locator('.post-item[href="post-ip.html"]').click()
        expect(self.page.locator(".ip-tool")).to_be_visible()

    def wait_for_results(self, successes=6):
        expect(self.page.locator("#ip-status")).to_contain_text(
            f"检测完成 · {successes} 项成功，{6 - successes} 项未成功"
        )
        expect(self.page.locator("#ip-progress")).to_have_attribute("value", "6")
        expect(self.page.locator("#ip-refresh")).to_be_enabled()

    def test_ordinary_pages_do_not_load_ip_code_or_call_apis(self):
        for path in ("/", "/posts.html", "/about.html"):
            with self.subTest(path=path):
                self.open(path)
                self.page.wait_for_load_state("networkidle")
                self.assertFalse(any(
                    "/ip-check.js" in url or "/vendor/ipaddr.js/" in url
                    for url in self.requests
                ))
                self.assertEqual(self.api_requests, [])

    def test_website_directory_switches_inside_frame_and_preserves_shell(self):
        self.context.route(
            "https://**/*",
            lambda route: route.fulfill(
                content_type="text/html",
                body=f"<h1>{urlparse(route.request.url).hostname}</h1>",
            ),
        )
        self.open()
        self.page.evaluate("window.originalHeader = document.querySelector('header')")
        self.navigate("websites")
        expect(self.page.locator("main h1")).to_have_text("网页推荐导航")
        expect(self.page.locator("#website-list .card")).to_have_count(3)
        expect(self.page.get_by_role("link", name="新窗口打开 Net.Coffee IP 查询")).to_have_attribute("target", "_blank")
        frame = self.page.frame_locator('iframe[name="recommendation-frame"]')
        expect(frame.locator("h1")).to_have_text("afengy.cash")
        expect(self.page.locator('iframe')).to_have_attribute(
            "src", "https://afengy.cash/zh?ref_id=1af0adb6-6191-4692-992d-64d184fdcfb6"
        )
        self.page.get_by_role("link", name="站内浏览 Brain.fm", exact=True).click()
        expect(frame.locator("h1")).to_have_text("my.brain.fm")
        self.assertEqual(self.page.url, self.origin + "/post-useful-websites.html")
        self.assertTrue(self.page.evaluate(
            "window.originalHeader === document.querySelector('header')"
        ))
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.assertTrue(self.page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth"
        ))
        self.navigate("home")
        expect(self.page.locator("iframe")).to_have_count(0)

    def test_modules_load_once_and_shell_survives_navigation(self):
        self.open()
        header = self.page.locator(".site-header").element_handle()
        self.open_tool()
        self.wait_for_results()
        self.assertEqual(len(self.api_requests), 6)
        self.navigate("about")
        expect(self.page).to_have_title("关于 · 咖啡笔记")
        expect(self.page.locator('meta[name="description"]')).to_have_attribute(
            "content", "关于咖啡笔记这个静态个人博客。"
        )
        self.open_tool()
        self.wait_for_results()
        self.assertEqual(len(self.api_requests), 12)
        for path in ("/ip-check.js", "/vendor/ipaddr.js/ipaddr.mjs"):
            self.assertEqual(sum(urlparse(url).path == path for url in self.requests), 1)
        self.assertTrue(header.evaluate("element => element.isConnected"))
        expect(self.page.locator("main")).to_be_focused()
        expect(self.page.locator('nav a[aria-current="page"]')).to_have_text("文章")

    def test_routes_and_progress_finish_without_waiting_for_ipv6(self):
        self.hold_hosts.add("api6.ipify.org")
        self.open("/post-ip.html")
        expect(self.page.locator("#ip-progress")).to_have_attribute("value", "5")
        expect(self.page.locator("#ip-status")).to_contain_text("5 / 6 项完成")
        expect(self.page.locator("#ip-route-summary")).to_have_text(
            "3 个站点返回 1 个出口 IP；0 个站点未能读取。"
        )
        expect(self.page.locator("#ipv6-panel")).to_have_attribute("data-state", "loading")
        expect(self.page.locator("#ip-refresh")).to_be_disabled()
        self.pending.pop().fulfill(json={"ip": IPV6})
        self.wait_for_results()

    def test_failed_checks_remain_visible_and_refresh_runs_again(self):
        self.responses = {
            "api6.ipify.org": {"json": {"ip": IPV4}},
            "chatgpt.com": {"status": 503, "body": "Unavailable"},
        }
        self.open("/post-ip.html")
        self.wait_for_results(successes=4)
        expect(self.page.locator("#ipv6-panel")).to_have_attribute("data-state", "error")
        expect(self.page.locator("#ipv6-panel .ip-detail")).to_contain_text("IPV6")
        expect(self.page.locator("#ip-routes tr").filter(has_text="ChatGPT")).to_contain_text("503")
        expect(self.page.locator("#ip-route-summary")).to_contain_text("1 个站点未能读取")
        self.responses.clear()
        self.page.locator("#ip-refresh").click()
        self.wait_for_results()
        self.assertEqual(len(self.api_requests), 12)

    def test_invalid_ipv4_does_not_query_geo_or_show_fake_results(self):
        self.responses["api.ipify.org"] = {"json": {"ip": "invalid-address"}}
        self.open("/post-ip.html")
        self.wait_for_results(successes=4)
        expect(self.page.locator("#ipv4-panel")).to_have_attribute("data-state", "error")
        expect(self.page.locator("#geo-panel .ip-detail")).to_have_text(
            "需要先成功取得 IPv4 地址。"
        )
        self.assertFalse(any(urlparse(url).hostname == "api.ip.sb" for url in self.api_requests))

    def test_leaving_during_module_load_does_not_start_stale_checks(self):
        modules = []
        self.context.route("**/ip-check.js", lambda route: modules.append(route))
        self.open()
        self.open_tool()
        self.navigate("about")
        self.assertEqual(len(modules), 1)
        with self.page.expect_response("**/vendor/ipaddr.js/ipaddr.mjs"):
            modules.pop().fulfill(path=str(ROOT / "ip-check.js"), content_type="text/javascript")
        self.page.wait_for_load_state("networkidle")
        self.assertEqual(self.api_requests, [])
        self.open_tool()
        self.wait_for_results()
        self.assertEqual(len(self.api_requests), 6)

    def test_leaving_cancels_requests_and_skips_dependent_geo_query(self):
        self.hold_hosts.add("api.ipify.org")
        self.open("/post-ip.html")
        expect(self.page.locator("#ip-progress")).to_have_attribute("value", "4")
        with self.page.expect_event(
            "requestfailed", predicate=lambda request: urlparse(request.url).hostname == "api.ipify.org"
        ):
            self.navigate("about")
        self.assertFalse(any(urlparse(url).hostname == "api.ip.sb" for url in self.api_requests))
        expect(self.page.locator("main")).to_have_attribute("data-section", "about")

    def test_module_failure_is_explicit_and_manual_reload_recovers(self):
        self.context.route("**/ip-check.js", lambda route: route.abort())
        self.open("/post-ip.html")
        expect(self.page.locator("#ip-status")).to_have_text("检测工具加载失败，请重新加载页面。")
        expect(self.page.locator(".ip-panel[data-state='error']")).to_have_count(3)
        expect(self.page.locator("#ip-refresh")).to_be_enabled()
        expect(self.page.locator("#ip-refresh")).to_have_text("重新加载页面")
        self.assertEqual(self.api_requests, [])
        self.context.unroute("**/ip-check.js")
        with self.page.expect_navigation(wait_until="load"):
            self.page.locator("#ip-refresh").click()
        self.wait_for_results()

    def test_navigation_failure_preserves_page_and_retry_recovers(self):
        self.context.route("**/posts.html", lambda route: route.fulfill(status=503, body="Unavailable"))
        self.open()
        self.page.locator('nav a[data-section="posts"]').click()
        expect(self.page.locator("#navigation-error")).to_be_visible()
        expect(self.page.locator("#navigation-error-message")).to_contain_text("503")
        expect(self.page.locator("main")).to_have_attribute("data-section", "home")
        self.assertEqual(self.page.url, self.origin + "/")
        self.context.unroute("**/posts.html")
        self.page.locator("#navigation-retry").click()
        expect(self.page.locator("main")).to_have_attribute("data-section", "posts")
        expect(self.page.locator("#navigation-error")).to_be_hidden()
        expect(self.page).to_have_url(self.origin + "/posts.html")

    def test_history_restores_content_scroll(self):
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.open("/post-ip.html")
        self.wait_for_results()
        saved_scroll = self.page.locator("#site-content").evaluate(
            "element => { element.scrollTop = 300; return element.scrollTop; }"
        )
        self.assertGreater(saved_scroll, 0)
        self.navigate("about")
        self.page.go_back()
        expect(self.page.locator(".ip-tool")).to_be_visible()
        self.wait_for_results()
        expect(self.page.locator("#site-content")).to_have_js_property("scrollTop", saved_scroll)
        self.page.go_forward()
        expect(self.page.locator("main")).to_have_attribute("data-section", "about")

    def test_keyboard_skip_link_touch_targets_and_mobile_overflow(self):
        self.open()
        self.page.keyboard.press("Tab")
        expect(self.page.locator(".skip-link")).to_be_focused()
        self.assertGreaterEqual(self.page.locator(".skip-link").bounding_box()["y"], 0)
        self.page.keyboard.press("Enter")
        expect(self.page.locator("main")).to_be_focused()
        self.open_tool()
        self.wait_for_results()
        for width in (320, 390, 768, 1280):
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 844})
                self.assertFalse(self.page.evaluate(
                    "document.documentElement.scrollWidth > innerWidth || "
                    "document.getElementById('site-content').scrollWidth > "
                    "document.getElementById('site-content').clientWidth"
                ))
                for link in self.page.locator(".site-header nav a").all():
                    bounds = link.bounding_box()
                    self.assertGreaterEqual(bounds["height"], 44)
                    self.assertGreaterEqual(bounds["width"], 44)

    def test_static_navigation_without_javascript(self):
        with self.browser.new_context(java_script_enabled=False) as context:
            page = context.new_page()
            page.goto(self.origin + "/")
            page.locator('nav a[data-section="posts"]').click()
            expect(page).to_have_url(self.origin + "/posts.html")
            page.locator('.post-item[href="post-ip.html"]').click()
            expect(page.locator(".ip-notice")).to_be_visible()
            expect(page.locator(".ip-notice")).to_contain_text("请启用 JavaScript")
            expect(page.locator("#ip-refresh")).to_be_disabled()


if __name__ == "__main__":
    main()
