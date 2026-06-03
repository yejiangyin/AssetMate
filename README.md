# AssetMate

AssetMate, also known as 资产助手, is a browser extension for personal portfolio tracking and market monitoring. It helps users organize holdings, view market quotes, manage recurring investment plans, and hide sensitive asset data when needed.

> AssetMate is for personal record keeping and market reference only. It does not provide investment advice and does not execute trades.

## Features

- Portfolio overview with market value, daily profit and loss, total profit and loss, and estimated trend data.
- Holdings management for stocks, funds, crypto assets, cash-like assets, and custom groups.
- Market quote pages for multiple asset types, including stocks, funds, crypto, FX, and common indexes.
- Recurring investment plan tracking with execution preview, settlement status, and historical records.
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
- pnpm

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

Build the Chrome Web Store package output with app bundle obfuscation:

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

AssetMate stores user-entered portfolio data locally in the browser extension environment. The privacy mode is designed to reduce accidental exposure on screen by masking sensitive numbers.

Market data is requested from configured third-party public market data sources. Users should review the extension permissions and data sources before use.

## Disclaimer

AssetMate is not a broker, financial advisor, or trading platform. All displayed prices, profit/loss values, recurring investment records, and historical estimates are for personal reference only. Users are responsible for verifying data accuracy before making any financial decision.

## License

This project is licensed under the Apache License 2.0.
