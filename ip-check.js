import ipaddr from "./vendor/ipaddr.js/ipaddr.mjs";

export function mountIPCheck(tool) {

  const TIMEOUT_MS = 8000;
  const lifecycle = new AbortController();
  let disposed = false;
  const routes = [
    { name: "Cloudflare", url: "https://www.cloudflare.com/cdn-cgi/trace" },
    { name: "ChatGPT", url: "https://chatgpt.com/cdn-cgi/trace" },
    { name: "Claude", url: "https://claude.ai/cdn-cgi/trace" },
  ];
  const refresh = tool.querySelector("#ip-refresh");
  const status = tool.querySelector("#ip-status");
  const progress = tool.querySelector("#ip-progress");
  const routeSummary = tool.querySelector("#ip-route-summary");
  const countryNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
  let running = false;

  function panel(id) {
    const element = tool.querySelector(`#${id}`);
    return {
      element,
      value: element.querySelector(".ip-value"),
      detail: element.querySelector(".ip-detail"),
    };
  }

  const ipv4 = panel("ipv4-panel");
  const ipv6 = panel("ipv6-panel");
  const geo = panel("geo-panel");
  const routeBody = tool.querySelector("#ip-routes");
  routeBody.replaceChildren();
  const routeViews = routes.map((route) => {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = route.name;
    const address = document.createElement("td");
    address.className = "ip-route-address";
    const country = document.createElement("td");
    const result = document.createElement("td");
    result.className = "ip-route-result";
    row.append(label, address, country, result);
    routeBody.append(row);
    return { row, address, country, result };
  });

  function setPanel(view, state, value, detail) {
    if (disposed) return;
    view.element.dataset.state = state;
    view.element.setAttribute("aria-busy", String(state === "loading"));
    view.value.textContent = value;
    view.detail.textContent = detail;
  }

  function normalizeIP(value, expectedKind) {
    if (typeof value !== "string" || !ipaddr.isValid(value)) {
      throw new Error("接口未返回有效的 IP 地址。");
    }
    const address = ipaddr.parse(value);
    if (expectedKind && address.kind() !== expectedKind) {
      throw new Error(`接口未返回 ${expectedKind.toUpperCase()} 地址。`);
    }
    return address.toString();
  }

  function countryName(code) {
    if (typeof code !== "string" || !/^[A-Z]{2}$/.test(code)) {
      throw new Error("接口未返回有效的国家或地区。");
    }
    return countryNames.of(code);
  }

  async function request(url) {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!response.ok) {
      throw new Error(`服务返回 HTTP ${response.status}。`);
    }
    return response;
  }

  function errorMessage(error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "请求超时，请检查网络后重新检测。";
    }
    if (error instanceof TypeError) {
      return "请求失败，网络连接或跨域读取受限。";
    }
    if (error instanceof SyntaxError) {
      return "接口返回的数据格式无效。";
    }
    return error.message;
  }

  async function checkAddress(view, url, kind) {
    try {
      const response = await request(url);
      const data = await response.json();
      const ip = normalizeIP(data?.ip, kind);
      setPanel(view, "success", ip, "由 ipify 实时返回。");
      return { ok: true, ip };
    } catch (error) {
      setPanel(view, "error", "未取得地址", errorMessage(error));
      return { ok: false };
    }
  }

  async function checkGeo(addressResult) {
    if (disposed) return { ok: false };
    if (!addressResult.ok) {
      setPanel(geo, "error", "无法查询", "需要先成功取得 IPv4 地址。");
      return { ok: false };
    }
    try {
      setPanel(geo, "loading", "查询中…", "正在查询 IPv4 对应的地区和运营商。");
      const response = await request(`https://api.ip.sb/geoip/${encodeURIComponent(addressResult.ip)}`);
      const data = await response.json();
      if (normalizeIP(data?.ip) !== addressResult.ip) {
        throw new Error("归属地接口返回的 IP 与本次查询不一致。");
      }
      const location = [countryName(data.country_code), data.region, data.city]
        .filter((part) => typeof part === "string" && part.length > 0);
      const network = [
        typeof data.isp === "string" && data.isp ? `运营商：${data.isp}` : "运营商：接口未提供",
        Number.isSafeInteger(data.asn) ? `AS${data.asn}` : "ASN：接口未提供",
      ];
      setPanel(geo, "success", [...new Set(location)].join(" · "), network.join(" · "));
      return { ok: true };
    } catch (error) {
      setPanel(geo, "error", "查询失败", errorMessage(error));
      return { ok: false };
    }
  }

  async function checkRoute(route, view) {
    const started = performance.now();
    try {
      const response = await request(route.url);
      const text = await response.text();
      const trace = Object.fromEntries(text.trim().split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }));
      const ip = normalizeIP(trace.ip);
      const country = countryName(trace.loc);
      if (disposed) return { ok: false };
      view.row.dataset.state = "success";
      view.row.setAttribute("aria-busy", "false");
      view.address.textContent = ip;
      view.country.textContent = country;
      view.result.textContent = `已读取 · ${Math.round(performance.now() - started)} ms`;
      return { ok: true, ip };
    } catch (error) {
      if (disposed) return { ok: false };
      view.row.dataset.state = "error";
      view.row.setAttribute("aria-busy", "false");
      view.address.textContent = errorMessage(error);
      view.country.textContent = "—";
      view.result.textContent = "读取失败";
      return { ok: false };
    }
  }

  async function run() {
    if (running || disposed) return;
    running = true;
    refresh.disabled = true;
    refresh.textContent = "检测中…";
    const total = 3 + routes.length;
    let completed = 0;
    let successful = 0;
    const routeResults = new Array(routes.length);
    progress.max = total;
    progress.value = 0;
    status.textContent = `正在检测 · 0 / ${total} 项完成`;
    routeSummary.textContent = "正在对比网站出口…";
    setPanel(ipv4, "loading", "检测中…", "正在读取 IPv4 出口。");
    setPanel(ipv6, "loading", "检测中…", "正在读取 IPv6 出口。");
    setPanel(geo, "loading", "等待 IPv4…", "取得地址后查询地区和运营商。");
    for (const view of routeViews) {
      view.row.dataset.state = "loading";
      view.row.setAttribute("aria-busy", "true");
      view.address.textContent = "检测中…";
      view.country.textContent = "—";
      view.result.textContent = "等待结果";
    }

    function recordResult(result) {
      if (disposed) return result;
      completed += 1;
      if (result.ok) successful += 1;
      progress.value = completed;
      status.textContent = `正在检测 · ${completed} / ${total} 项完成 · ${successful} 项成功`;
      return result;
    }

    function updateRouteSummary() {
      if (disposed) return;
      const finished = routeResults.filter(Boolean);
      const readable = finished.filter((result) => result.ok);
      const uniqueIPs = new Set(readable.map((result) => ipaddr.process(result.ip).toString()));
      if (finished.length < routes.length) {
        routeSummary.textContent = `已完成 ${finished.length} / ${routes.length} 个站点 · ${readable.length} 个可读取 · ${uniqueIPs.size} 个出口 IP`;
      } else {
        routeSummary.textContent = readable.length
          ? `${readable.length} 个站点返回 ${uniqueIPs.size} 个出口 IP；${routes.length - readable.length} 个站点未能读取。`
          : "本次未能取得网站出口，请查看各项错误后重新检测。";
      }
    }

    try {
      const ipv4Request = checkAddress(ipv4, "https://api.ipify.org?format=json", "ipv4").then(recordResult);
      await Promise.all([
        ipv4Request,
        checkAddress(ipv6, "https://api6.ipify.org?format=json", "ipv6").then(recordResult),
        ipv4Request.then(checkGeo).then(recordResult),
        ...routes.map((route, index) => checkRoute(route, routeViews[index]).then((result) => {
          routeResults[index] = result;
          updateRouteSummary();
          return recordResult(result);
        })),
      ]);
      if (disposed) return;
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      status.textContent = `检测完成 · ${successful} 项成功，${total - successful} 项未成功 · ${time}`;
    } catch (error) {
      if (disposed) return;
      status.textContent = `检测中断：${errorMessage(error)}`;
      routeSummary.textContent = "本次检测未完成。";
    } finally {
      running = false;
      if (!disposed) {
        refresh.disabled = false;
        refresh.textContent = "重新检测";
      }
    }
  }

  refresh.addEventListener("click", run);
  run();
  return () => {
    disposed = true;
    lifecycle.abort();
    refresh.removeEventListener("click", run);
  };
}
