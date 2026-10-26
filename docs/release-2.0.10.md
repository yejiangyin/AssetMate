# 资产助手 2.0.10

发布日期：2026-10-26

## 中文版本描述

本次更新优化了 AI 研究的连接配置与使用流程。

- 新增 Codex 账号登录连接方式、模型列表获取及分步连接诊断，便于查看权限、登录状态和请求结果。
- 重新整理 AI 连接设置，优化模型、联网搜索和专业数据的配置体验。
- AI 研究页按步骤组织研究流程，并分别展示新建研究、报告库和任务记录，支持查看思考、检索及输出进度。
- 改进流式响应解析和超时处理，为网络失败及输出中断增加有限次数的自动重试；重新生成时清理未完成输出，避免内容重复。
- 修正部分设置控件的显示和返回导航问题。

## English release notes

This update improves AI research setup and the research workflow.

- Adds a Codex account connection option, model discovery, and step-by-step connection diagnostics.
- Refines connection settings for models, web search, and professional data.
- Organizes research into clear steps with separate views for new research, saved reports, and task history, and shows reasoning, search, and output progress.
- Improves streaming response parsing and timeout handling. Limited automatic retries handle network failures and interrupted output, clearing incomplete content before regeneration to prevent duplication.
- Fixes display and back-navigation issues in settings.

## 上架说明

- 上传文件：`release/asset-helper-2.0.10-chrome-store-minified.zip`。ZIP 根目录直接包含 `manifest.json`。
- 使用生产压缩（空白移除、标识符缩短和打包），不使用控制流混淆、字符串加密、运行时解码或远程脚本加载。Google 规则允许 minification，禁止隐藏功能的 obfuscation：<https://developer.chrome.com/docs/webstore/program-policies/code-readability>。
- 商店详细说明使用 `store/listing/zh-CN.txt` 和 `store/listing/en.txt`，在 Developer Dashboard 对应语言中完整替换。上传 ZIP 不会自动修改商店文案。
- 上面的版本描述用于说明本次更新；商店详细说明保持对当前功能的完整介绍，不追加历次更新列表。
- 新账号连接方式涉及登录凭据；提交时应核对后台隐私披露与隐私政策是否反映实际处理方式。最终审核结果以 Google 为准。

## 验证范围

发布前检查：611 项测试通过，ESLint、TypeScript 检查和生产构建通过。已检查 Manifest V3、版本一致性、入口文件与规则文件引用、无 source map、无 `eval` / `new Function` / 远程脚本入口，以及 ZIP 完整性和解压后文件逐字节一致性。

上架包大小：633,963 字节；共 31 个文件。SHA-256：`f017eb2f5d4d23be4d8a7e07ac22a5e793cdfeb2d36d7a8ad8c6e98397cd0a81`。

自动化测试使用模拟响应；生产构建、静态检查和打包验证不代表真实账号登录、联网研究或商店审核已通过。实际模型可用性仍受账号权限、网络和服务端行为影响。
