# AssetMate

AssetMate, also known as 资产助手, is a browser extension for personal portfolio tracking, market monitoring, AI-assisted investment research, and local strategy backtesting. It does not require an AssetMate backend server.

> AssetMate is for personal record keeping and market reference only. It does not provide investment advice and does not execute trades.

## Features

- Portfolio overview with market value, daily profit and loss, total profit and loss, and estimated trend data.
- Holdings management for stocks, funds, crypto assets, cash-like assets, and custom groups.
- Market quote pages for multiple asset types, including stocks, funds, crypto, FX, and common indexes.
- Recurring investment plan tracking with execution preview, settlement status, and historical records.
- A unified Research Center combining AI research, strategy backtests, and saved-result comparison.
- AI Berkshire-aligned 20-skill catalog grouped into Deep Research, Earnings Analysis, Industry Screening, Portfolio Management, and Thinking Tools, plus local backtest interpretation.
- Per-connection model roles for research, fast tasks, synthesis, and optional independent report audit, with role-aware connection testing and deterministic local checks.
- Direct browser access to OpenAI Chat Completions, Responses, Anthropic Messages, Gemini native GenerateContent, and Ollama APIs with multiple bring-your-own-key connection profiles.
- Resumable research jobs, a local report library, Markdown export, source extraction, and report audit labels.
- Exact decimal helpers for valuation calculations and multi-source deviation checks.
- Privacy mode to hide sensitive values such as amounts and share quantities.
- Chinese and English interface switching.
- Chrome extension build output with Manifest V3 support.

## Tech Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Framer Motion
- Recharts
- Lucide React
- React Markdown + remark-gfm
- decimal.js-light
- pnpm

## Research Center (No Backend)

The original Backtest navigation item is now the Research Center. Its three views share one workflow:

1. Start from a holding, market-detail page, or custom symbol.
2. Choose a research workflow. Income Investment adds decision role, target yield, tax residence, and holding-horizon context; WeChat Article executes content research, drafting, editor/reader review, and a final rewrite.
3. Review the generated report, detected links, cutoff date, and local audit status.
4. Send the same target to the local backtest engine, save scenarios for comparison, and ask AI to interpret a completed backtest.

Research execution runs entirely in the extension UI. Long-running tasks are persisted in IndexedDB and interrupted tasks can resume from completed analyst steps. Reports are also kept in IndexedDB, while small provider settings use Chrome extension storage.

No AssetMate server receives prompts, portfolio data, reports, or API keys. Requests go directly from the extension to the model endpoint selected by the user. The model provider remains a third party and receives the fields shown in the research screen.

### Configure a model

Open **Settings → AI Research Connections**, then use the **Models**, **Web search**, and **Professional data** tabs; the Research Center gear remains available for quick access. API connections appear as an accordion list: expand one row to edit it, or create, duplicate, rename, delete, and switch between profiles. Each profile keeps its own endpoint, protocol, authentication, models, thinking depth, API key, and web-search setting.

- Provider presets for OpenAI, Anthropic Claude, xAI Grok, Volcengine Ark/Agent Plan, DeepSeek, Alibaba Qwen, Zhipu GLM, Moonshot/Kimi, MiniMax, SiliconFlow, OpenRouter, Gemini, Groq, Mistral, Perplexity, Ollama, and LM Studio.
- Protocol-aware custom connections: OpenAI Chat Completions, Responses, Anthropic Messages, Gemini native GenerateContent, or Ollama Chat. Base URLs and full endpoints are normalized automatically.
- Bearer Token, `x-api-key`, `x-goog-api-key`, no-auth, or a custom authentication header.
- A per-connection model library. Models can be added manually or imported from the protocol's model-list endpoint (`/models` or Ollama `/api/tags`), then assigned as the primary or optional fast model.
- Model-aware thinking controls. Available choices are derived from model-list reasoning metadata when provided, then from the selected protocol/model family: OpenAI supports values such as `minimal` through `xhigh`, newer Claude models can expose `xhigh`/`max`, Gemini 2.5 uses token budgets while Gemini 3 uses native levels, and most Ollama models use on/off unless they declare effort levels.
- A discrete output-token slider with 1K, 2K, 4K, 8K, 16K, 32K, 64K, and 128K nodes.
- An API key/token when the selected authentication method requires one.
- Four web-access strategies: automatic fallback (recommended), provider-native only, independent external search only, or offline. Native Chat Completions uses `web_search_options`; Responses uses `tools: [{ "type": "web_search" }]`.
- Independent external search presets for Tavily, Brave Search, and Exa, plus a custom JSON search API. Search connections use the same multi-profile list pattern as model connections: each has its own endpoint, key, limits and enrichment settings, while an explicit **Use** action selects the active connection. Provider-aware budgets allow up to 20 results for Tavily/Brave, up to 100 for Exa/custom search, up to 100 retained sources, and up to 50 enriched pages. These budgets apply only to the independent search connection and never truncate citations returned by a model provider's native web-search tool. Search evidence is normalized into structured sources, injected as untrusted context, cited in reports, and retained in the research audit trail. Optional rich content is retrieved through Tavily Extract, Exa Contents, or Brave extra snippets, so the extension never requests per-source website permissions.

External search is configured at **Settings → AI Research Connections → Web search**. It uses a separate API endpoint and key from the model connection. Automatic mode uses native browsing when supported and external evidence as the fallback; models without browsing support can therefore still produce web-backed research without an AssetMate server.

Volcengine Agent Plan professional datasets are configured implicitly at **Settings → AI Research Connections → Professional data**. The extension connects directly to the official DataPro MCP endpoint and reuses the selected Agent Plan connection's `X-Agent-Plan-Key`; there is no duplicate credential field and no AssetMate backend. Research queries are automatically batched at up to three securities, injected as separately labeled `[D…]` professional-data evidence, preserved in the report trace, and covered by deterministic audit checks. DataPro errors degrade to the existing market-data and web-evidence paths instead of failing the research task.

Research jobs persist cancellation immediately, can be restarted from the interrupted task card, and re-use the workflow originally attached to that job. The report library supports direct deletion from the list, individual Markdown downloads, and a single combined Markdown export when multiple reports are present.

Anthropic Claude uses the Messages API and requires an Anthropic API key. A Claude Code subscription login is not itself a reusable Anthropic API credential. Local Ollama connections require no key; LM Studio can run without a key or use a Bearer token when its API-token option is enabled.

Built-in Volcengine presets:

- Standard Ark: Base URL `https://ark.cn-beijing.volces.com/api/v3`, with either a supported Model ID or Endpoint ID.
- Agent Plan: Base URL `https://ark.cn-beijing.volces.com/api/plan/v3`, Responses API, an Agent Plan API Key, and a model name included in the subscribed plan.

An Agent Plan key and a standard Ark inference key are different credential types. Select the preset matching where the key was created.

The extension requests access only to the configured model origin at connection time. HTTPS endpoints are supported generally; local development endpoints can use `localhost` or `127.0.0.1`.

API keys are session-only by default. The user can explicitly opt into saving each connection's key in Chrome local extension storage. Existing single-API settings are migrated automatically to the multi-profile and model-library format. Keys are excluded from portfolio exports. Chrome storage is not a system keychain, so session-only mode is recommended.

### Research integrity boundaries

- Public symbol, market, asset type, quote context, and cutoff time are sent by default.
- Quantity, cost basis, market value, portfolio weight, and recurring-plan context are sent only after an explicit per-run opt-in.
- Without native or external search, prompts require the model to disclose that current facts were not verified.
- Source links are extracted and counted, but a detected link is not proof that its contents are correct.
- A report is never labeled fully verified unless source/structure checks and an explicit local calculation check all pass.
- AI output and historical backtests are research aids, not investment advice or evidence of future returns.

## Getting Started

Install dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm run dev
```

Run checks:

```bash
pnpm run lint
pnpm run test
pnpm run typecheck
```

## Build

Build the extension:

```bash
pnpm run build:extension
```

Build the Chrome Web Store package output with production minification:

```bash
pnpm run build:store
```

The generated extension files are written to `dist/`.

## Load In Chrome

1. Run `pnpm run build:extension`.
2. Open `chrome://extensions`.
3. Turn on Developer mode.
4. Click Load unpacked.
5. Select the generated `dist` folder.

Chrome will read `dist/manifest.json` and use `dist/index.html` as the popup entry.

## Repository Notes

Generated files are intentionally excluded from source control:

- `node_modules/`
- `dist/`
- `release/`
- `.DS_Store`
- local assistant or environment files

Only source code, configuration, public assets, scripts, tests, and documentation should be committed.

## Privacy

AssetMate stores user-entered portfolio data, research tasks, and reports locally in the browser extension environment. The privacy mode is designed to reduce accidental exposure on screen by masking sensitive numbers.

Market data is requested from configured third-party public market data sources. AI research requests are sent directly to the user-configured model provider. Clearing local data also clears the research library, model settings, and any saved API key.

## Disclaimer

AssetMate is not a broker, financial advisor, or trading platform. All displayed prices, profit/loss values, recurring investment records, and historical estimates are for personal reference only. Users are responsible for verifying data accuracy before making any financial decision.

## License

This project is licensed under the Apache License 2.0.
