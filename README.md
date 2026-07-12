# 考研番茄钟

一个面向考研复习的本地网页应用，把“长期任务库、今日待办、番茄专注、完成确认、每日复盘”串成一个简单闭环。

## 功能

- 长期任务库：创建、编辑、归档，并一键加入今天
- 今日任务：临时添加、排序、编辑、删除和手动完成
- 计时模式：25/5、50/10、自定义
- 沉浸专注：暂停或退出时必须记录原因
- 完成确认：达到预计番茄数后，确认打钩、追加番茄或暂不完成
- 今日概览：任务完成数、专注时长、完整番茄和中断次数
- 异常恢复：网页关闭或电脑休眠后，可按计划完成、重新开始或记为中断
- 本地数据：无需账号，支持 JSON 导出、导入和清空
- 响应式界面：支持桌面和手机浏览器

## 运行源码

推荐安装 Node.js 20 或更新版本。

```bash
npm install
npm run dev
```

浏览器打开终端中显示的地址。数据只保存在当前浏览器中。

Windows 用户也可以双击 `start-windows.bat`。

## 生产构建

```bash
npm run build
npm run preview
```

构建产物在 `dist/`。部署到任意静态网站服务即可。

## 测试

```bash
npm test
npm run build
npm run test:e2e
```

端到端测试使用 Playwright Chromium。普通开发环境首次运行前，可执行：

```bash
npx playwright install chromium
```

## 项目结构

- `src/model.js`：数据结构、计时运算、汇总和持久化
- `src/components.jsx`：通用对话框、任务表单和任务行
- `src/App.jsx`：页面、业务流程和状态管理
- `src/styles.css`：桌面和手机响应式视觉
- `tests/model.test.js`：核心规则测试
- `tests/e2e/`：完整学习流程与视觉验收

## 部署到 GitHub Pages

项目已经包含 `.github/workflows/deploy.yml`，推送到 GitHub 后可自动构建和发布。

1. 在 GitHub 创建一个新仓库，例如 `kaoyan-pomodoro`。
2. 将本项目全部文件推送到仓库的 `main` 分支。
3. 打开仓库的 **Settings → Pages**。
4. 在 **Build and deployment → Source** 中选择 **GitHub Actions**。
5. 打开 **Actions** 页面查看 `Deploy to GitHub Pages` 工作流；部署完成后，访问地址通常是：
   `https://你的用户名.github.io/仓库名/`

以后每次推送到 `main`，GitHub Pages 都会自动重新部署。项目数据保存在访问者自己的浏览器中，不会上传到仓库。
