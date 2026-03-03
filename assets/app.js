const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_PREFIX = "eodhd_cache_v1";
const TOKEN_KEY = "eodhd_api_token";
const PROXY_BASE_KEY = "eodhd_proxy_base_url";
const DIRECT_EODHD_BASE_URL = "https://eodhd.com/api/eod";

const state = {
  portfolioRows: [],
  portfolioSource: null,
};

const el = {
  apiToken: document.getElementById("apiToken"),
  saveTokenBtn: document.getElementById("saveTokenBtn"),
  proxyBase: document.getElementById("proxyBase"),
  connectionModeHint: document.getElementById("connectionModeHint"),
  portfolioFile: document.getElementById("portfolioFile"),
  loadDefaultBtn: document.getElementById("loadDefaultBtn"),
  portfolioMeta: document.getElementById("portfolioMeta"),
  indexSymbol: document.getElementById("indexSymbol"),
  lookbackDays: document.getElementById("lookbackDays"),
  useAdjusted: document.getElementById("useAdjusted"),
  hedgeFraction: document.getElementById("hedgeFraction"),
  hedgeFractionLabel: document.getElementById("hedgeFractionLabel"),
  runCalcBtn: document.getElementById("runCalcBtn"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  status: document.getElementById("status"),
  resultsSection: document.getElementById("resultsSection"),
  messages: document.getElementById("messages"),
  hedgeCard: document.getElementById("hedgeCard"),
  regressionTable: document.getElementById("regressionTable"),
  portfolioTable: document.getElementById("portfolioTable"),
};

init();

function init() {
  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (savedToken) el.apiToken.value = savedToken;
  const savedProxy = localStorage.getItem(PROXY_BASE_KEY);
  if (savedProxy) el.proxyBase.value = savedProxy;
  refreshConnectionModeHint();

  el.saveTokenBtn.addEventListener("click", onSaveToken);
  el.proxyBase.addEventListener("input", refreshConnectionModeHint);
  el.portfolioFile.addEventListener("change", onUploadFile);
  el.loadDefaultBtn.addEventListener("click", onLoadDefaultPortfolio);
  el.hedgeFraction.addEventListener("input", () => {
    el.hedgeFractionLabel.textContent = `${el.hedgeFraction.value}%`;
  });
  el.runCalcBtn.addEventListener("click", onRunCalculation);
  el.clearCacheBtn.addEventListener("click", clearPriceCache);
}

function onSaveToken() {
  const token = el.apiToken.value.trim();
  const proxyBase = normalizeProxyBase(el.proxyBase.value);

  if (proxyBase) {
    localStorage.setItem(PROXY_BASE_KEY, proxyBase);
  } else {
    localStorage.removeItem(PROXY_BASE_KEY);
  }

  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else if (!proxyBase) {
    setStatus("Please provide a token (direct mode) or proxy base URL (proxy mode).");
    return;
  }

  refreshConnectionModeHint();
  setStatus(proxyBase ? "Proxy mode enabled. Token input is optional." : "Direct mode enabled. Token saved to localStorage.");
}

function refreshConnectionModeHint() {
  const proxyBase = normalizeProxyBase(el.proxyBase?.value);
  if (proxyBase) {
    el.connectionModeHint.textContent = `Proxy mode: browser calls ${proxyBase}/api/eod/... (token can stay server-side env var).`;
    return;
  }
  el.connectionModeHint.textContent = "Direct mode: browser calls EODHD using your token.";
}

function normalizeProxyBase(input) {
  return String(input || "").trim().replace(/\/+$/, "");
}

async function onUploadFile(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  loadPortfolioFromCsv(text, `uploaded file: ${file.name}`);
}

async function onLoadDefaultPortfolio() {
  try {
    const res = await fetch("./data/portfolio.csv", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    loadPortfolioFromCsv(text, "default /data/portfolio.csv");
  } catch (err) {
    setStatus(`Failed to load default portfolio: ${err.message}`);
  }
}

function loadPortfolioFromCsv(csvText, sourceLabel) {
  try {
    const rows = parseCsv(csvText);
    const normalized = validatePortfolioRows(rows);
    state.portfolioRows = normalized;
    state.portfolioSource = sourceLabel;
    el.portfolioMeta.textContent = `Loaded ${normalized.length} rows from ${sourceLabel}`;
    setStatus("Portfolio loaded successfully.");
  } catch (err) {
    state.portfolioRows = [];
    el.portfolioMeta.textContent = "";
    setStatus(`Portfolio load error: ${err.message}`);
  }
}

async function onRunCalculation() {
  clearMessages();
  if (!state.portfolioRows.length) {
    addMessage("error", "No portfolio loaded. Upload CSV or load default first.");
    return;
  }

  const token = el.apiToken.value.trim();
  const proxyBase = normalizeProxyBase(el.proxyBase.value);
  if (!token && !proxyBase) {
    addMessage("error", "Provide EODHD API token (direct mode) or proxy base URL (proxy mode).");
    return;
  }

  const indexSymbol = el.indexSymbol.value.trim() || "NDX.INDX";
  const lookback = Number(el.lookbackDays.value);
  const useAdjusted = el.useAdjusted.checked;
  const hedgeFraction = Number(el.hedgeFraction.value) / 100;

  const symbols = [...new Set([...state.portfolioRows.map((r) => r.ticker), indexSymbol])];
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - Math.max(lookback * 3, 365));

  setStatus(`Fetching prices for ${symbols.length} symbols...`);

  const symbolData = {};
  const symbolStatus = {};

  await mapWithConcurrency(symbols, 5, async (sym, i) => {
    setStatus(`Fetching ${i + 1}/${symbols.length}: ${sym}`);
    try {
      const series = await fetchPriceSeries({
        symbol: sym,
        from: formatDate(fromDate),
        to: formatDate(toDate),
        token,
        useAdjusted,
        proxyBase,
      });
      symbolData[sym] = series;
      symbolStatus[sym] = `ok (${series.length} rows)`;
    } catch (err) {
      symbolStatus[sym] = `error: ${err.message}`;
    }
  });

  const indexSeries = symbolData[indexSymbol];
  if (!indexSeries?.length) {
    addMessage("error", `No usable data for hedge symbol ${indexSymbol}. Try QQQ.US.`);
    renderStatusMap(symbolStatus);
    return;
  }

  const warnings = [];
  const usableRows = [];
  for (const row of state.portfolioRows) {
    const series = symbolData[row.ticker];
    if (!series?.length) {
      warnings.push(`${row.ticker}: missing/failed data, excluded.`);
      continue;
    }
    if (series.length < lookback + 1) {
      warnings.push(`${row.ticker}: limited history (${series.length} rows), may reduce overlap.`);
    }
    usableRows.push({ ...row, series });
  }

  if (!usableRows.length) {
    addMessage("error", "No portfolio symbols had usable price data.");
    renderStatusMap(symbolStatus);
    return;
  }

  const V = usableRows.reduce((acc, r) => acc + r.amount_usd, 0);
  const G = usableRows.reduce((acc, r) => acc + Math.abs(r.amount_usd), 0);
  const denom = Math.abs(V) > 1e-12 ? V : G;
  if (Math.abs(V) <= 1e-12) {
    warnings.push("Net portfolio value V is ~0, so returns are normalized by gross exposure G.");
  }

  const mergedPriceDates = intersectDates([
    indexSeries,
    ...usableRows.map((r) => r.series),
  ]);

  if (mergedPriceDates.length < lookback + 1) {
    addMessage("error", `Insufficient overlapping dates across series (${mergedPriceDates.length}).`);
    renderStatusMap(symbolStatus);
    return;
  }

  const usedDates = mergedPriceDates.slice(-1 * (lookback + 1));
  const indexByDate = indexSeriesToMap(indexSeries, usedDates);

  const portfolioByDate = {};
  const tableRows = [];

  for (const row of usableRows) {
    const m = indexSeriesToMap(row.series, usedDates);
    const lastDate = usedDates[usedDates.length - 1];
    const lastPrice = m[lastDate];
    const coverage = Object.keys(m).length / usedDates.length;
    const weight = row.amount_usd / denom;
    tableRows.push({ ...row, weight, lastPrice, coverage });

    for (const d of usedDates) {
      portfolioByDate[d] = (portfolioByDate[d] || 0) + weight * m[d];
    }
  }

  const rp = calcReturnsFromPriceMap(portfolioByDate, usedDates);
  const rm = calcReturnsFromPriceMap(indexByDate, usedDates);
  const aligned = alignReturnPairs(rp, rm);

  if (aligned.length < Math.max(30, Math.floor(lookback * 0.5))) {
    addMessage("error", `Insufficient aligned return observations: ${aligned.length}`);
    renderStatusMap(symbolStatus);
    return;
  }

  const reg = ols(aligned.map((x) => x.rm), aligned.map((x) => x.rp));
  const indexLevel = indexByDate[usedDates[usedDates.length - 1]];
  const hedgeNotional = V * reg.beta * hedgeFraction;
  const mnqPerContract = indexLevel * 2;
  const rawContracts = hedgeNotional / mnqPerContract;
  const recContracts = Math.round(rawContracts);
  const direction = hedgeNotional >= 0 ? "SHORT MNQ" : "LONG MNQ";

  for (const w of warnings) addMessage("warn", w);
  addMessage("warn", "Hedge is approximate; consider basis risk and beta instability.");

  renderHedgeCard({
    direction,
    recContracts: Math.abs(recContracts),
    rawContracts,
    hedgeNotional,
    mnqPerContract,
    indexLevel,
    V,
    G,
    h: hedgeFraction,
    indexSymbol,
  });
  renderRegressionTable(reg, aligned.length);
  renderPortfolioTable(tableRows);
  renderStatusMap(symbolStatus);
  el.resultsSection.hidden = false;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must contain header and at least one row.");
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (vals[i] || "").trim()));
    return obj;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function validatePortfolioRows(rows) {
  const required = ["ticker", "amount_usd"];
  const missing = required.filter((k) => !(k in rows[0]));
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}`);
  const cleaned = rows.map((r, i) => {
    const ticker = (r.ticker || "").trim();
    const amount = Number(r.amount_usd);
    if (!ticker) throw new Error(`Row ${i + 2}: ticker is empty.`);
    if (!Number.isFinite(amount)) throw new Error(`Row ${i + 2}: amount_usd is invalid.`);
    return {
      ticker,
      amount_usd: amount,
      name: r.name || "",
      notes: r.notes || "",
    };
  });
  return cleaned;
}

async function fetchPriceSeries({ symbol, from, to, token, useAdjusted, proxyBase }) {
  const cacheKey = `${CACHE_PREFIX}:${proxyBase || "direct"}:${symbol}:${from}:${to}:${useAdjusted}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.savedAt < CACHE_TTL_MS) return parsed.data;
    } catch {
      // ignore broken cache
    }
  }

  let url;
  if (proxyBase) {
    url = new URL(`${proxyBase}/api/eod/${encodeURIComponent(symbol)}`);
  } else {
    url = new URL(`${DIRECT_EODHD_BASE_URL}/${encodeURIComponent(symbol)}`);
    url.searchParams.set("api_token", token);
  }
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("fmt", "json");

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    throw new Error(normalizeFetchError(err));
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${proxyBase ? " via proxy" : ""}`);
  }

  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error("empty response");

  const normalized = data
    .map((d) => ({
      date: d.date,
      price: choosePrice(d, useAdjusted),
    }))
    .filter((d) => d.date && Number.isFinite(d.price) && d.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!normalized.length) throw new Error("no valid price rows");

  localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), data: normalized }));
  return normalized;
}

function normalizeFetchError(err) {
  const msg = String(err?.message || err || "unknown error");
  if (msg.toLowerCase().includes("failed to fetch")) {
    return "Failed to fetch (check CORS/network; or use proxy mode with backend env token)";
  }
  return msg;
}

function choosePrice(row, useAdjusted) {
  const adjusted = Number(row.adjusted_close);
  const close = Number(row.close);
  if (useAdjusted && Number.isFinite(adjusted) && adjusted > 0) return adjusted;
  return close;
}

function intersectDates(seriesList) {
  if (!seriesList.length) return [];
  let set = new Set(seriesList[0].map((x) => x.date));
  for (let i = 1; i < seriesList.length; i += 1) {
    const next = new Set(seriesList[i].map((x) => x.date));
    set = new Set([...set].filter((d) => next.has(d)));
  }
  return [...set].sort();
}

function indexSeriesToMap(series, allowedDates) {
  const allowed = new Set(allowedDates);
  const m = {};
  for (const row of series) {
    if (allowed.has(row.date)) m[row.date] = row.price;
  }
  return m;
}

function calcReturnsFromPriceMap(priceMap, sortedDates) {
  const out = [];
  for (let i = 1; i < sortedDates.length; i += 1) {
    const prev = priceMap[sortedDates[i - 1]];
    const curr = priceMap[sortedDates[i]];
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(curr) && curr > 0) {
      out.push({ date: sortedDates[i], r: curr / prev - 1 });
    }
  }
  return out;
}

function alignReturnPairs(rp, rm) {
  const m = new Map(rm.map((x) => [x.date, x.r]));
  return rp
    .filter((x) => m.has(x.date) && Number.isFinite(x.r))
    .map((x) => ({ date: x.date, rp: x.r, rm: m.get(x.date) }))
    .filter((x) => Number.isFinite(x.rm));
}

function ols(x, y) {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let sst = 0;
  const eps = [];

  for (let i = 0; i < n; i += 1) {
    sxx += (x[i] - meanX) ** 2;
    sxy += (x[i] - meanX) * (y[i] - meanY);
  }

  const beta = sxx === 0 ? 0 : sxy / sxx;
  const alpha = meanY - beta * meanX;

  let ssr = 0;
  for (let i = 0; i < n; i += 1) {
    const yHat = alpha + beta * x[i];
    const e = y[i] - yHat;
    eps.push(e);
    ssr += e ** 2;
    sst += (y[i] - meanY) ** 2;
  }

  const r2 = sst === 0 ? 0 : 1 - ssr / sst;
  const residualStd = Math.sqrt(ssr / Math.max(1, n - 2));

  return { alpha, beta, r2, residualStd };
}

async function mapWithConcurrency(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      await fn(items[current], current);
    }
  });
  await Promise.all(workers);
}

function renderStatusMap(statusMap) {
  const lines = Object.entries(statusMap).map(([k, v]) => `${k}: ${v}`);
  setStatus(lines.join("\n"));
}

function renderHedgeCard({ direction, recContracts, rawContracts, hedgeNotional, mnqPerContract, indexLevel, V, G, h, indexSymbol }) {
  const cls = direction.includes("SHORT") ? "short" : "long";
  el.hedgeCard.innerHTML = `
    <div class="direction ${cls}">${direction}</div>
    <div>Recommended contracts: <strong>${recContracts}</strong> (raw ${fmt(rawContracts, 2)}; floor ${Math.floor(Math.abs(rawContracts))}, ceil ${Math.ceil(Math.abs(rawContracts))})</div>
    <div>Hedge notional = V × beta × h = <strong>${fmtMoney(hedgeNotional)}</strong></div>
    <div>MNQ notional/contract ≈ index level × 2 = <strong>${fmtMoney(mnqPerContract)}</strong></div>
    <div>Index level used (${indexSymbol}): <strong>${fmt(indexLevel, 2)}</strong></div>
    <div>Portfolio value V: <strong>${fmtMoney(V)}</strong>; Gross exposure G: <strong>${fmtMoney(G)}</strong>; h: <strong>${fmt(h * 100, 0)}%</strong></div>
    <div class="muted">Conservative approach: start with 1 contract, then scale.</div>
  `;
}

function renderRegressionTable(reg, nObs) {
  el.regressionTable.innerHTML = `
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Observations</td><td>${nObs}</td></tr>
    <tr><td>Alpha (daily)</td><td>${fmt(reg.alpha, 6)}</td></tr>
    <tr><td>Beta</td><td>${fmt(reg.beta, 4)}</td></tr>
    <tr><td>R²</td><td>${fmt(reg.r2, 4)}</td></tr>
    <tr><td>Residual Std Dev (daily)</td><td>${fmt(reg.residualStd, 6)}</td></tr>
  `;
}

function renderPortfolioTable(rows) {
  const head = `<tr><th>Ticker</th><th>Amount (USD)</th><th>Weight</th><th>Last Price</th><th>Data Coverage</th></tr>`;
  const body = rows
    .map((r) => `<tr>
      <td>${escapeHtml(r.ticker)}</td>
      <td>${fmtMoney(r.amount_usd)}</td>
      <td>${fmt(r.weight, 4)}</td>
      <td>${fmt(r.lastPrice, 2)}</td>
      <td>${fmt(r.coverage * 100, 1)}%</td>
    </tr>`)
    .join("");
  el.portfolioTable.innerHTML = head + body;
}

function clearMessages() {
  el.messages.innerHTML = "";
}

function addMessage(kind, text) {
  const div = document.createElement("div");
  div.className = `message ${kind}`;
  div.textContent = text;
  el.messages.appendChild(div);
}

function setStatus(text) {
  el.status.textContent = text;
}

function clearPriceCache() {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
  keys.forEach((k) => localStorage.removeItem(k));
  setStatus(`Cleared ${keys.length} cache entries.`);
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmt(v, digits = 2) {
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtMoney(v) {
  return Number(v).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
