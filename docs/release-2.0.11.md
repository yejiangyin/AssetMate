# 资产助手 2.0.11

发布日期：2026-11-10

## 中文版本描述

本次更新改进了 AI 研究中的长期估值方法与报告检查。

- 综合投资研究中，十年折现估值改为仓位压力测试，不再单独决定研究结论；同时列出折现率上下调整后的结果，并说明结论是否改变。
- 三年估值与十年测试方向不一致时，报告会单独说明分歧及最终判断依据。
- 综合决策按生意、护城河、管理层、风险、长期趋势和估值六个维度并列呈现。
- 引用投资大师观点时须给出可核验的原话与出处，缺少资料时不代为表态。
- 报告检查新增折现率区间核对，并要求列出完整的折现率敏感性结果。

## English release notes

This update improves long-term valuation and report checks in AI research.

- In investment research, the ten-year discounted valuation now serves as a position-sizing stress test rather than deciding the conclusion on its own. Reports show results with the discount rate moved up and down, and state whether the conclusion changes.
- When the three-year valuation and the ten-year test point in different directions, reports explain the disagreement and how the final view was reached.
- The decision summary presents business, moat, management, risk, long-term trends, and valuation side by side.
- Quoted views from well-known investors must cite verifiable original statements; without sources, the report does not speak for them.
- Report checks now verify the discount-rate range and require complete discount-rate sensitivity results.

## 上架说明

- 上传文件：`release/asset-helper-2.0.11-chrome-store-minified.zip`。ZIP 根目录直接包含 `manifest.json`。
- 使用生产压缩（空白移除、标识符缩短和打包），不使用控制流混淆、字符串加密、运行时解码或远程脚本加载。Google 规则允许 minification，禁止隐藏功能的 obfuscation：<https://developer.chrome.com/docs/webstore/program-policies/code-readability>。
- 本次不涉及权限、数据处理方式或商店详细说明变更，`store/listing/` 文案沿用 2.0.10。

## 验证范围

发布前检查：613 项测试通过，ESLint、TypeScript 检查和生产构建通过。已检查 Manifest V3、版本一致性（`package.json`、`manifest.json`、请求标识规则）、Manifest 引用的文件均存在、无 source map、无 `eval` / `new Function` / 远程脚本入口，以及 ZIP 完整性和解压后文件逐字节一致性。

上架包大小：638,817 字节；共 31 个文件。SHA-256：`0e97af8682a40239c5169138d57f3f5253e101b950ce8cdad982668c0fa221eb`。

自动化测试使用模拟响应；生产构建、静态检查和打包验证不代表真实模型研究输出或商店审核已通过。
