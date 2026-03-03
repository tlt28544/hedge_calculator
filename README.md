# MNQ Hedge Calculator (GitHub Pages, Method B)

Static web app that estimates portfolio beta to Nasdaq-100 (NDX proxy) using **OLS regression on daily returns**, then computes a directional hedge size using **CME Micro E-mini Nasdaq-100 (MNQ)** contracts.

## Features

- Pure static front-end (HTML/CSS/JS), no backend.
- Supports two connection modes:
  - **Direct mode (GitHub Pages friendly):** browser calls EODHD with user token.
  - **Proxy mode (recommended):** browser calls your backend proxy; backend uses env var token.
- In direct mode, token is stored in browser `localStorage` only (never committed).
- Portfolio source options:
  - Upload CSV file
  - Load default `/data/portfolio.csv`
- Settings:
  - Hedge symbol (default `NDX.INDX`, fallback proxy `QQQ.US`)
  - Lookback window (60/90/120/252)
  - Adjusted close toggle
  - Hedge fraction `h` slider (0–100%)
- Outputs:
  - Portfolio value `V` and gross exposure `G`
  - Portfolio weights and latest prices
  - OLS alpha, beta, `R^2`, residual stdev
  - Hedge notional and recommended MNQ contracts
- Local cache for price data with 6-hour TTL and concurrency-limited downloads.

## File Structure

- `/index.html`
- `/assets/app.js`
- `/assets/app.css`
- `/data/portfolio.csv`
- `/data/samples/portfolio_example.csv`

## Portfolio CSV format

Required columns:

- `ticker` (string): EODHD symbol (`AAPL.US`, `MSFT.US`, `0700.HK`, etc.)
- `amount_usd` (number): USD market value (`+` long, `-` short)

Optional columns: `name`, `notes`

Example:

```csv
ticker,amount_usd,name
AAPL.US,50000,Apple
MSFT.US,40000,Microsoft
NVDA.US,30000,Nvidia
```

## Method B math

1. Pull daily price series for all portfolio tickers + hedge symbol:
   - Direct mode: `GET https://eodhd.com/api/eod/{SYMBOL}?from=YYYY-MM-DD&to=YYYY-MM-DD&api_token={TOKEN}&fmt=json`
   - Proxy mode: `GET {YOUR_BACKEND}/api/eod/{SYMBOL}?from=YYYY-MM-DD&to=YYYY-MM-DD&fmt=json`
2. Build portfolio-level daily price index from weighted constituent prices.
3. Compute daily returns:
   - `r_p,t` (portfolio)
   - `r_m,t` (market / hedge symbol)
4. Run OLS:
   - `r_p,t = alpha + beta * r_m,t + eps_t`
5. Hedge sizing:
   - Portfolio value: `V = sum(amount_usd)`
   - Gross exposure: `G = sum(abs(amount_usd))`
   - Weights for return aggregation:
     - Use `w_i = amount_i / V` when `V != 0`
     - If `V ≈ 0`, use `w_i = amount_i / G` to avoid divide-by-zero (app warns)
   - Hedge notional: `H = V * beta * h`
   - MNQ notional/contract: `N = IndexLevel * 2`
   - Contracts: `round(H / N)`
   - Direction:
     - If `V*beta > 0`: recommend **SHORT MNQ**
     - If `V*beta < 0`: recommend **LONG MNQ**

## Run locally

Because `fetch()` loads local files and calls API endpoints, run with a local static server:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000>.

## Windows desktop app (no manual local server needed)

This repo now includes an Electron desktop wrapper so you can launch the calculator as a native Windows app.

### For users (download and run)

1. Go to your GitHub repo **Releases** page.
2. Download the generated portable app file:
   - `MNQ Hedge Calculator <version>.exe`
3. Double-click to run.
4. In the app, paste your EODHD API token, upload local CSV, and run calculation.

### For maintainers (build Windows executable)

```bash
npm install
npm run dist:win
```

Build output will be in:

- `release/`

Notes:

- The desktop app starts an internal local static server automatically.
- Existing features remain unchanged, including local CSV upload and default sample loading.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In repository settings: **Pages** → **Deploy from branch**.
3. Select `main` branch and `/ (root)` folder.
4. Save. GitHub Pages will publish `index.html` as a static site.

## How to use

1. Open app URL.
2. Paste EODHD token and click **Save Token**.
3. Upload your portfolio CSV or click **Load default /data/portfolio.csv**.
4. Adjust hedge settings if needed (`NDX.INDX` / `QQQ.US`, lookback, `h`).
5. Click **Run Calculation**.
6. Review outputs:
   - Hedge recommendation (direction, contract count, floor/ceil range)
   - Regression summary (alpha/beta/R²/residual stdev)
   - Portfolio table (weights, last price, coverage)

## Caching and rate-limit friendliness

- Price data cache key includes symbol + date range + adjusted-close flag.
- TTL default: 6 hours.
- Requests run in parallel with concurrency limit 5.
- Progress and per-symbol status are shown in UI.

## Troubleshooting `Failed to fetch`

If every symbol shows `Failed to fetch` even with a valid token in **direct mode**, it is usually a browser/network issue (not token format):

- Cross-origin (CORS) policy blocked by network path.
- DNS/firewall restrictions to `eodhd.com`.
- Browser extensions (ad/privacy blockers) intercepting requests.

If this is persistent, switch to **proxy mode**:

1. Deploy a small backend endpoint `/api/eod/:symbol`.
2. Store `EODHD_API_KEY` as a server environment variable.
3. In app UI, fill `Proxy Base URL` (e.g. `https://your-domain.com`) and save.

This keeps GitHub Pages available (direct mode), while giving you a backend escape hatch when direct browser fetch is blocked.

## Disclaimers

- This hedge is approximate, not a guarantee of P/L neutrality.
- **Basis risk** exists (MNQ futures vs cash index or ETF proxy).
- Beta can drift over time; use rolling recalibration and judgment.
- Corporate actions, missing data, and symbol-specific quirks can affect estimates.
- Not investment advice.
