# Coffee Compass · 咖啡指南

一个轻量个人站点，分享文章、收藏实用网站，并支持站内浏览。基于原生 HTML、CSS、JavaScript 与 htmx 2.0.11，无需构建。站内沿用「咖啡笔记」作为内容品牌。

## 本地运行

在项目目录执行：

```powershell
python -m http.server 8001 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8001/`。首次加载后，站内链接只更新中间正文；页头、导航和页脚保留，正文区域独立滚动。各 `.html` 地址也支持直接访问和刷新。

## GitHub Pages

在线访问：https://xieguu.github.io/coffee-compass/

网站从 `gh-pages` 分支根目录发布，使用 GitHub 原生分支部署，无需安装依赖或构建。`.nojekyll` 禁用 Jekyll 处理，HTML、CSS、JavaScript 和 vendor 文件直接作为静态资源发布。

更新网站时，将需要发布的改动合入 `gh-pages` 并推送到 GitHub，Pages 会自动部署。`main` 保留为开发主分支；只有推送到 `gh-pages` 才会更新线上网站。

## 页面结构

- `index.html`、`posts.html`、`post-ip.html`、`post-useful-websites.html`、`post-htmx-lazy-loading.html`、`about.html`：完整页面及其正文。
- 每页保留相同的外壳结构；`#page-content > main` 是唯一替换区域，`hx-history-elt` 将前进、后退限定在该区域。
- `navigation.js`：导航高亮、正文焦点与滚动、加载错误提示、页面组件生命周期。
- `ip-check.js`：仅进入 IP 文章时由原生 `import()` 加载，模块在当前文档内复用。`mountIPCheck()` 返回的清理函数在离开文章时取消请求并移除事件监听；加载途中离开文章不会启动过期检测。
- `styles.css`：固定外壳及正文样式。
- `post-useful-websites.html`：网页推荐导航，收录 AI风月、Net.Coffee IP 查询与 Brain.fm。IP 查询站设置了 `X-Frame-Options: SAMEORIGIN`，仅提供新窗口入口；另外两个网站提供站内浏览入口。默认在 iframe 内展示 AI风月，完整保留 `ref_id`；卡片通过原生链接切换站内浏览窗口，也提供新窗口入口。外部网站的嵌入限制或登录策略可能影响站内显示，不代理或改写外部网页。
- `notes/2026-10-09-website-recommendations.md`：网址推荐文章的推文线索、官网核对记录与写作依据。

新增页面时沿用外壳、脚本和 `htmx-config`，为 `main` 设置导航分组 `data-section` 与页面描述 `data-description`。

页面请求失败时显示错误及重试按钮，不自动整页跳转。IP 查询分别使用 ipify、IP.SB 与各站点的 trace 接口，失败项目单独显示原因。

每项检测完成后更新进度；网站出口独立汇总，不等待 IPv6 或归属地查询。检测工具本身加载失败时显示错误，由用户点击「重新加载页面」重试。

页头链接提供至少 44px 的点击区域。键盘首次按 Tab 可使用「跳到正文」，所有交互元素提供可见的焦点提示。

## 开源依赖

- [htmx](https://htmx.org/) 2.0.11，0BSD；文件及来源校验值位于 `vendor/htmx/`。
- [ipaddr.js](https://github.com/whitequark/ipaddr.js) 2.5.0，MIT；源码、浏览器 ES 模块、许可证及 SHA-256 校验值位于 `vendor/ipaddr.js/`。ES 模块由 esbuild 0.28.2 生成，原始源码保持完整。

依赖随项目本地提供，无需 npm 安装或构建。

更新 IP 地址库源码后，可在项目根目录重新生成浏览器模块，并同步 `SOURCE.json` 中的版本和校验值：

```powershell
npx --yes esbuild@0.28.2 vendor/ipaddr.js/ipaddr.js --bundle --format=esm --minify --target=es2022 --outfile=vendor/ipaddr.js/ipaddr.mjs
```

## 验证

浏览器回归测试使用 Playwright，自动启动临时本地服务。IP 接口使用固定测试响应，不依赖外网服务的可用性。

```powershell
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python -m unittest discover -s tests -v
```

也可使用本机已安装的 Chrome：在测试前设置 `$env:COFFEE_TEST_BROWSER_CHANNEL = 'chrome'`。

测试覆盖按需加载、模块复用、分项进度、接口失败、手动重试、异步取消、导航错误、历史滚动恢复、键盘导航、窄屏布局及无 JavaScript 阅读。
