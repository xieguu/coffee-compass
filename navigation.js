(() => {
  "use strict";

  const viewport = document.getElementById("site-content");
  const content = document.getElementById("page-content");
  const errorBox = document.getElementById("navigation-error");
  const errorText = document.getElementById("navigation-error-message");
  const retry = document.getElementById("navigation-retry");
  const scrollPositions = new Map();
  let currentPath = location.pathname + location.search;
  let activeTool = null;
  let disposeIP = null;
  let mountVersion = 0;

  function saveScroll() {
    scrollPositions.set(currentPath, viewport.scrollTop);
  }

  function unmount() {
    mountVersion += 1;
    if (disposeIP) disposeIP();
    disposeIP = null;
    activeTool = null;
  }

  async function mount({ restoreScroll = false, focus = true } = {}) {
    unmount();
    const version = mountVersion;
    const main = content.querySelector("main");
    currentPath = location.pathname + location.search;
    errorBox.hidden = true;
    content.removeAttribute("aria-busy");

    for (const link of document.querySelectorAll(".site-header nav a[data-section]")) {
      const active = link.dataset.section === main.dataset.section;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    document.querySelector('meta[name="description"]').content = main.dataset.description;
    activeTool = main.querySelector(".ip-tool");
    viewport.scrollTop = restoreScroll ? (scrollPositions.get(currentPath) ?? 0) : 0;
    if (focus) main.focus({ preventScroll: true });

    if (!activeTool) return;
    const tool = activeTool;
    try {
      const { mountIPCheck } = await import("./ip-check.js");
      if (version !== mountVersion) return;
      disposeIP = mountIPCheck(tool);
    } catch (error) {
      if (version !== mountVersion) return;
      console.error("IP 检测工具加载失败。", error);
      tool.querySelector("#ip-status").textContent = "检测工具加载失败，请重新加载页面。";
      tool.querySelector("#ip-route-summary").textContent = "检测尚未开始。";
      for (const panel of tool.querySelectorAll(".ip-panel")) {
        panel.dataset.state = "error";
        panel.setAttribute("aria-busy", "false");
        panel.querySelector(".ip-value").textContent = "未能检测";
        panel.querySelector(".ip-detail").textContent = "请检查网络连接后重新加载页面。";
      }
      const reload = () => location.reload();
      const button = tool.querySelector("#ip-refresh");
      button.disabled = false;
      button.textContent = "重新加载页面";
      button.addEventListener("click", reload);
      disposeIP = () => button.removeEventListener("click", reload);
    }
  }

  function showError(url, message) {
    errorText.textContent = message;
    errorBox.hidden = false;
    content.removeAttribute("aria-busy");
    retry.setAttribute("hx-get", url);
    htmx.process(retry);
    viewport.scrollTop = 0;
  }

  function requestPath(detail) {
    return detail.pathInfo.requestPath;
  }

  document.addEventListener("htmx:beforeRequest", (event) => {
    if (event.detail.target !== content) return;
    errorBox.hidden = true;
    content.setAttribute("aria-busy", "true");
  });

  document.addEventListener("htmx:beforeSwap", (event) => {
    if (event.detail.target !== content || !event.detail.shouldSwap) return;
    const incoming = new DOMParser().parseFromString(event.detail.serverResponse, "text/html");
    if (incoming.querySelectorAll("#page-content > main[data-section]").length !== 1) {
      event.detail.shouldSwap = false;
      event.preventDefault();
      showError(requestPath(event.detail), "页面内容不完整，未能切换，请重试。");
      return;
    }
    saveScroll();
    unmount();
  });

  document.addEventListener("htmx:afterSwap", (event) => {
    if (event.detail.target === content && event.detail.xhr) mount();
  });

  document.addEventListener("htmx:afterRequest", (event) => {
    if (event.detail.target === content) content.removeAttribute("aria-busy");
  });

  document.addEventListener("htmx:beforeCleanupElement", (event) => {
    if (activeTool && event.detail.elt.contains(activeTool)) unmount();
  });

  document.addEventListener("htmx:beforeHistorySave", saveScroll);
  document.addEventListener("htmx:historyRestore", () => mount({ restoreScroll: true }));

  document.addEventListener("htmx:responseError", (event) => {
    if (event.detail.target === content) {
      showError(requestPath(event.detail), `页面加载失败（HTTP ${event.detail.xhr.status}），请重试。`);
    }
  });

  for (const [name, message] of [
    ["htmx:sendError", "网络请求失败，请检查连接后重试。"],
    ["htmx:timeout", "页面加载超时，请重试。"],
  ]) {
    document.addEventListener(name, (event) => {
      if (event.detail.target === content) showError(requestPath(event.detail), message);
    });
  }

  document.addEventListener("htmx:historyCacheMissLoadError", (event) => {
    showError(event.detail.path, `历史页面加载失败（HTTP ${event.detail.xhr.status}），请重试。`);
  });

  mount({ focus: false });
})();
