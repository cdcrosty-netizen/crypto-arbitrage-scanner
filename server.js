const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const FEES = {
  OKX: 0.001,
  KuCoin: 0.001,
  BingX: 0.001,
  Kraken: 0.0026
};

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 CryptoArbitrageScanner/1.0",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ======================================================
// OKX
// ======================================================

async function getOKX() {
  const data = await getJson(
    "https://www.okx.com/api/v5/market/tickers?instType=SPOT"
  );

  const result = {};

  for (const item of data.data || []) {
    if (!item.instId.endsWith("-USDT")) continue;

    const symbol = item.instId.replace("-", "");
    const bid = Number(item.bidPx);
    const ask = Number(item.askPx);

    if (!bid || !ask) continue;

    result[symbol] = {
      exchange: "OKX",
      symbol,
      bid,
      ask
    };
  }

  return result;
}

// ======================================================
// KUCOIN
// ======================================================

async function getKuCoin() {
  const data = await getJson(
    "https://api.kucoin.com/api/v1/market/allTickers"
  );

  const result = {};

  for (const item of data.data?.ticker || []) {
    if (!item.symbol.endsWith("-USDT")) continue;

    const symbol = item.symbol.replace("-", "");
    const bid = Number(item.buy);
    const ask = Number(item.sell);

    if (!bid || !ask) continue;

    result[symbol] = {
      exchange: "KuCoin",
      symbol,
      bid,
      ask
    };
  }

  return result;
}

// ======================================================
// BINGX
// ======================================================

async function getBingX() {
  const data = await getJson(
    "https://open-api.bingx.com/openApi/spot/v1/ticker/bookTicker"
  );

  const result = {};

  const list = Array.isArray(data.data)
    ? data.data
    : [];

  for (const item of list) {
    if (!item.symbol?.endsWith("-USDT")) continue;

    const symbol = item.symbol.replace("-", "");
    const bid = Number(item.bidPrice);
    const ask = Number(item.askPrice);

    if (!bid || !ask) continue;

    result[symbol] = {
      exchange: "BingX",
      symbol,
      bid,
      ask
    };
  }

  return result;
}

// ======================================================
// KRAKEN
// ======================================================

async function getKraken() {
  const pairsData = await getJson(
    "https://api.kraken.com/0/public/AssetPairs"
  );

  const result = {};
  const pairs = [];

  for (const [key, info] of Object.entries(pairsData.result || {})) {
    const wsname = info.wsname || "";

    if (!wsname.endsWith("/USDT")) continue;

    pairs.push({
      key,
      wsname
    });
  }

  // Kraken permite consultar múltiples pares.
  // Los dividimos en bloques para evitar URLs excesivamente largas.
  const chunks = [];

  for (let i = 0; i < pairs.length; i += 50) {
    chunks.push(pairs.slice(i, i + 50));
  }

  for (const chunk of chunks) {
    const pairNames = chunk
      .map(x => x.key)
      .join(",");

    const data = await getJson(
      "https://api.kraken.com/0/public/Ticker?pair=" +
      encodeURIComponent(pairNames)
    );

    const tickerData = data.result || {};

    for (const pair of chunk) {
      const base = pair.wsname
        .replace("/USDT", "")
        .replace("XBT", "BTC");

      const symbol = base + "USDT";

      let ticker = tickerData[pair.key];

      if (!ticker) {
        const possibleKey = Object.keys(tickerData).find(
          key =>
            key === pair.key ||
            key.includes(base)
        );

        if (possibleKey) {
          ticker = tickerData[possibleKey];
        }
      }

      if (!ticker) continue;

      const ask = Number(ticker.a?.[0]);
      const bid = Number(ticker.b?.[0]);

      if (!bid || !ask) continue;

      result[symbol] = {
        exchange: "Kraken",
        symbol,
        bid,
        ask
      };
    }
  }

  return result;
}

// ======================================================
// ARBITRAJE
// ======================================================

function calculateOpportunities(markets) {
  const symbols = new Set();

  for (const market of Object.values(markets)) {
    Object.keys(market).forEach(symbol => symbols.add(symbol));
  }

  const opportunities = [];

  for (const symbol of symbols) {
    const quotes = [];

    for (const market of Object.values(markets)) {
      if (market[symbol]) {
        quotes.push(market[symbol]);
      }
    }

    if (quotes.length < 2) continue;

    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.exchange === sell.exchange) continue;

        const buyPrice = buy.ask;
        const sellPrice = sell.bid;

        if (!buyPrice || !sellPrice) continue;
        if (sellPrice <= buyPrice) continue;

        const grossPercent =
          ((sellPrice - buyPrice) / buyPrice) * 100;

        const totalFees =
          ((FEES[buy.exchange] || 0) +
           (FEES[sell.exchange] || 0)) * 100;

        const netPercent =
          grossPercent - totalFees;

        opportunities.push({
          symbol,
          buyExchange: buy.exchange,
          buyPrice,
          sellExchange: sell.exchange,
          sellPrice,
          grossPercent,
          totalFees,
          netPercent
        });
      }
    }
  }

  return opportunities.sort(
    (a, b) => b.netPercent - a.netPercent
  );
}

// ======================================================
// API
// ======================================================

app.get("/api/opportunities", async (req, res) => {
  const names = [
    "OKX",
    "KuCoin",
    "BingX",
    "Kraken"
  ];

  const functions = [
    getOKX(),
    getKuCoin(),
    getBingX(),
    getKraken()
  ];

  const results = await Promise.allSettled(functions);

  const markets = {};
  const status = {};
  const counts = {};

  results.forEach((result, index) => {
    const name = names[index];

    if (result.status === "fulfilled") {
      markets[name] = result.value;
      status[name] = "OK";
      counts[name] = Object.keys(result.value).length;
    } else {
      markets[name] = {};
      status[name] = "NO DISPONIBLE";
      counts[name] = 0;

      console.error(
        `${name} no disponible:`,
        result.reason?.message
      );
    }
  });

  const opportunities =
    calculateOpportunities(markets);

  res.json({
    updatedAt: new Date().toISOString(),
    exchanges: counts,
    status,
    opportunities: opportunities.slice(0, 100)
  });
});

// ======================================================
// WEB
// ======================================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>

<html lang="es">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Crypto Arbitrage Scanner</title>

<style>

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #0b1220;
  color: white;
}

header {
  background: #111a2c;
  padding: 24px;
}

h1 {
  margin: 0 0 8px 0;
}

.subtitle {
  color: #9ca9bd;
}

.container {
  padding: 20px;
}

.cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.card {
  background: #162136;
  padding: 15px 20px;
  border-radius: 10px;
  min-width: 150px;
}

.exchange-status {
  font-size: 12px;
  margin-top: 5px;
  color: #9ca9bd;
}

.status {
  color: #9ca9bd;
  margin-bottom: 15px;
}

button {
  background: white;
  border: 0;
  padding: 10px 18px;
  border-radius: 7px;
  font-weight: bold;
  cursor: pointer;
  margin-bottom: 15px;
}

.table-wrapper {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  background: #111a2c;
  min-width: 850px;
}

th,
td {
  padding: 12px;
  border-bottom: 1px solid #25324a;
  text-align: right;
}

th:first-child,
td:first-child {
  text-align: left;
}

th {
  color: #9ca9bd;
}

.buy {
  color: #55e68a;
  font-weight: bold;
}

.sell {
  color: #ff7373;
  font-weight: bold;
}

.good {
  color: #55e68a;
  font-weight: bold;
}

.bad {
  color: #ff7373;
}

.note {
  color: #9ca9bd;
  font-size: 13px;
  margin-top: 20px;
  line-height: 1.5;
}

</style>

</head>

<body>

<header>

<h1>
Crypto Arbitrage Scanner
</h1>

<div class="subtitle">
OKX · KuCoin · BingX · Kraken — Spot USDT
</div>

</header>

<div class="container">

<div class="cards" id="cards"></div>

<button onclick="loadData()">
Actualizar ahora
</button>

<div class="status" id="status">
Cargando precios...
</div>

<div class="table-wrapper">

<table>

<thead>

<tr>

<th>Moneda</th>
<th>COMPRAR</th>
<th>Precio compra</th>
<th>VENDER</th>
<th>Precio venta</th>
<th>Spread</th>
<th>Comisiones</th>
<th>NETO</th>

</tr>

</thead>

<tbody id="rows"></tbody>

</table>

</div>

<div class="note">

El scanner usa el mejor precio de venta (ask) para comprar
y el mejor precio de compra (bid) para vender.

La ganancia indicada todavía es una estimación.
Antes de operar dinero real agregaremos profundidad del libro,
volumen disponible, slippage y costes de transferencia.

</div>

</div>

<script>

function formatPrice(value) {

  if (value >= 1000) {
    return value.toLocaleString(
      "en-US",
      { maximumFractionDigits: 2 }
    );
  }

  if (value >= 1) {
    return value.toFixed(4);
  }

  return Number(value).toPrecision(6);
}

async function loadData() {

  const statusElement =
    document.getElementById("status");

  statusElement.textContent =
    "Actualizando precios...";

  try {

    const response =
      await fetch("/api/opportunities");

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Error de servidor"
      );
    }

    const cards =
      document.getElementById("cards");

    cards.innerHTML = "";

    const exchangeNames = [
      "OKX",
      "KuCoin",
      "BingX",
      "Kraken"
    ];

    for (const name of exchangeNames) {

      const card =
        document.createElement("div");

      card.className = "card";

      card.innerHTML = \`
        \${name}:
        <strong>
          \${data.exchanges[name] || 0}
        </strong>
        pares

        <div class="exchange-status">
          \${data.status[name]}
        </div>
      \`;

      cards.appendChild(card);
    }

    const rows =
      document.getElementById("rows");

    rows.innerHTML = "";

    const visible =
      data.opportunities.filter(
        item => item.netPercent > 0
      );

    for (const item of visible.slice(0, 50)) {

      const row =
        document.createElement("tr");

      row.innerHTML = \`

<td>
<strong>
\${item.symbol}
</strong>
</td>

<td class="buy">
\${item.buyExchange}
</td>

<td>
\${formatPrice(item.buyPrice)}
</td>

<td class="sell">
\${item.sellExchange}
</td>

<td>
\${formatPrice(item.sellPrice)}
</td>

<td>
\${item.grossPercent.toFixed(3)}%
</td>

<td>
\${item.totalFees.toFixed(3)}%
</td>

<td class="\${
  item.netPercent >= 0.20
    ? "good"
    : "bad"
}">
\${item.netPercent.toFixed(3)}%
</td>

      \`;

      rows.appendChild(row);
    }

    if (!visible.length) {

      rows.innerHTML =
        '<tr><td colspan="8">No hay oportunidades netas positivas en este momento.</td></tr>';

    }

    statusElement.textContent =
      "Última actualización: " +
      new Date(
        data.updatedAt
      ).toLocaleTimeString();

  } catch (error) {

    statusElement.textContent =
      "Error: " + error.message;

  }
}

loadData();

// Actualización automática cada 10 segundos.

setInterval(loadData, 10000);

</script>

</body>

</html>
  `);
});

// ======================================================
// SERVIDOR
// ======================================================

app.listen(PORT, () => {
  console.log(
    "Crypto Arbitrage Scanner funcionando en puerto " +
    PORT
  );
});
