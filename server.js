const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Comisiones estimadas.
// Más adelante conviene reemplazarlas por las comisiones reales de tu cuenta.
const FEES = {
  OKX: 0.001,
  KuCoin: 0.001,
  BingX: 0.001,
  Kraken: 0.0026
};

// Por ahora, spreads superiores a este valor no se muestran
// como oportunidades normales. Quedan clasificados como sospechosos.
const MAX_NORMAL_GROSS_PERCENT = 10;

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 CryptoArbitrageScanner/1.0",
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}`
    );
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
    if (!item.instId?.endsWith("-USDT")) continue;

    const symbol = item.instId.replace("-", "");
    const bid = Number(item.bidPx);
    const ask = Number(item.askPx);

    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0
    ) {
      continue;
    }

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
    if (!item.symbol?.endsWith("-USDT")) continue;

    const symbol = item.symbol.replace("-", "");
    const bid = Number(item.buy);
    const ask = Number(item.sell);

    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0
    ) {
      continue;
    }

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

    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0
    ) {
      continue;
    }

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

  for (const [key, info] of Object.entries(
    pairsData.result || {}
  )) {
    const wsname = info.wsname || "";

    if (!wsname.endsWith("/USDT")) continue;

    pairs.push({
      key,
      wsname
    });
  }

  // Consultamos Kraken en grupos para no generar
  // una URL excesivamente larga.
  for (let i = 0; i < pairs.length; i += 50) {
    const chunk = pairs.slice(i, i + 50);

    const pairNames = chunk
      .map(item => item.key)
      .join(",");

    const data = await getJson(
      "https://api.kraken.com/0/public/Ticker?pair=" +
        encodeURIComponent(pairNames)
    );

    const tickerData = data.result || {};

    for (const pair of chunk) {
      let base = pair.wsname.replace("/USDT", "");

      if (base === "XBT") {
        base = "BTC";
      }

      const symbol = base + "USDT";

      let ticker = tickerData[pair.key];

      // Kraken puede devolver algunos identificadores
      // diferentes al solicitado.
      if (!ticker) {
        const tickerKey = Object.keys(
          tickerData
        ).find(key => {
          const normalizedKey = key
            .replace(/^X/, "")
            .replace(/^Z/, "");

          return (
            key === pair.key ||
            normalizedKey.includes(base)
          );
        });

        if (tickerKey) {
          ticker = tickerData[tickerKey];
        }
      }

      if (!ticker) continue;

      const ask = Number(ticker.a?.[0]);
      const bid = Number(ticker.b?.[0]);

      if (
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        bid <= 0 ||
        ask <= 0
      ) {
        continue;
      }

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
    for (const symbol of Object.keys(market)) {
      symbols.add(symbol);
    }
  }

  const normal = [];
  const suspicious = [];

  for (const symbol of symbols) {
    const quotes = [];

    for (const market of Object.values(markets)) {
      if (market[symbol]) {
        quotes.push(market[symbol]);
      }
    }

    // Necesitamos como mínimo dos exchanges.
    if (quotes.length < 2) continue;

    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.exchange === sell.exchange) continue;

        const buyPrice = buy.ask;
        const sellPrice = sell.bid;

        if (
          !Number.isFinite(buyPrice) ||
          !Number.isFinite(sellPrice) ||
          buyPrice <= 0 ||
          sellPrice <= 0
        ) {
          continue;
        }

        // No existe arbitraje si el precio de venta
        // no supera al precio real de compra.
        if (sellPrice <= buyPrice) continue;

        const grossPercent =
          ((sellPrice - buyPrice) / buyPrice) * 100;

        const totalFees =
          ((FEES[buy.exchange] || 0) +
            (FEES[sell.exchange] || 0)) *
          100;

        const netPercent =
          grossPercent - totalFees;

        const opportunity = {
          symbol,
          buyExchange: buy.exchange,
          buyPrice,
          sellExchange: sell.exchange,
          sellPrice,
          grossPercent,
          totalFees,
          netPercent
        };

        // No ocultamos completamente las anomalías:
        // las clasificamos aparte.
        if (
          grossPercent >
          MAX_NORMAL_GROSS_PERCENT
        ) {
          suspicious.push(opportunity);
        } else if (netPercent > 0) {
          normal.push(opportunity);
        }
      }
    }
  }

  normal.sort(
    (a, b) => b.netPercent - a.netPercent
  );

  suspicious.sort(
    (a, b) => b.grossPercent - a.grossPercent
  );

  return {
    normal,
    suspicious
  };
}

// ======================================================
// API
// ======================================================

app.get("/api/opportunities", async (req, res) => {
  const exchangeNames = [
    "OKX",
    "KuCoin",
    "BingX",
    "Kraken"
  ];

  const requests = [
    getOKX(),
    getKuCoin(),
    getBingX(),
    getKraken()
  ];

  const results =
    await Promise.allSettled(requests);

  const markets = {};
  const status = {};
  const counts = {};

  results.forEach((result, index) => {
    const name = exchangeNames[index];

    if (result.status === "fulfilled") {
      markets[name] = result.value;
      status[name] = "OK";
      counts[name] =
        Object.keys(result.value).length;
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

  const calculated =
    calculateOpportunities(markets);

  res.json({
    updatedAt: new Date().toISOString(),
    exchanges: counts,
    status,
    opportunities:
      calculated.normal.slice(0, 200),
    suspiciousCount:
      calculated.suspicious.length
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

button {
  background: white;
  border: 0;
  padding: 10px 18px;
  border-radius: 7px;
  font-weight: bold;
  cursor: pointer;
}

.refresh-button {
  margin-bottom: 12px;
}

.status {
  color: #9ca9bd;
  margin-bottom: 15px;
}

.warning {
  background: #332713;
  border: 1px solid #69501d;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 15px;
  color: #ffd875;
}

.table-wrapper {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  background: #111a2c;
  min-width: 950px;
}

th,
td {
  padding: 12px;
  border-bottom: 1px solid #25324a;
  text-align: right;
}

th:first-child,
td:first-child {
  text-align: center;
}

th:nth-child(2),
td:nth-child(2) {
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

.star {
  border: 0;
  background: transparent;
  padding: 2px 6px;
  margin: 0;
  font-size: 22px;
  cursor: pointer;
  color: #6f7c91;
}

.star.active {
  color: #ffd54a;
}

.favorite-row {
  background: #18243a;
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

<h1>Crypto Arbitrage Scanner</h1>

<div class="subtitle">
OKX · KuCoin · BingX · Kraken — Spot USDT
</div>

</header>

<div class="container">

<div class="cards" id="cards"></div>

<button
  class="refresh-button"
  onclick="loadData()"
>
Actualizar ahora
</button>

<div class="status" id="status">
Cargando precios...
</div>

<div
  class="warning"
  id="warning"
  style="display:none"
></div>

<div class="table-wrapper">

<table>

<thead>

<tr>
<th>⭐</th>
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

⭐ Las oportunidades marcadas quedan guardadas
en este navegador y aparecen primero aunque
la tabla se actualice.

<br><br>

Los spreads superiores al 10% se consideran
sospechosos y no aparecen en la tabla principal.
Esto evita tomar como válida una diferencia
extrema sin verificar antes que sea exactamente
el mismo activo y que exista liquidez real.

<br><br>

Todavía falta incorporar profundidad del libro,
slippage, volumen disponible y costes/redes de
transferencia antes de considerar una oportunidad
como ejecutable.

</div>

</div>

<script>

const FAVORITES_KEY =
  "crypto-arbitrage-favorites-v1";

function getFavorites() {
  try {
    const saved =
      localStorage.getItem(FAVORITES_KEY);

    return new Set(
      saved ? JSON.parse(saved) : []
    );
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites) {
  localStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify([...favorites])
  );
}

// La favorita identifica moneda + exchange de compra
// + exchange de venta.
function getOpportunityId(item) {
  return [
    item.symbol,
    item.buyExchange,
    item.sellExchange
  ].join("|");
}

function toggleFavorite(id) {
  const favorites = getFavorites();

  if (favorites.has(id)) {
    favorites.delete(id);
  } else {
    favorites.add(id);
  }

  saveFavorites(favorites);

  // Redibujamos usando los últimos datos.
  renderRows(window.lastOpportunities || []);
}

function formatPrice(value) {
  if (value >= 1000) {
    return value.toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 4
      }
    );
  }

  if (value >= 1) {
    return value.toFixed(6);
  }

  return Number(value).toPrecision(7);
}

function renderRows(opportunities) {
  const rows =
    document.getElementById("rows");

  rows.innerHTML = "";

  const favorites = getFavorites();

  const sorted = [...opportunities].sort(
    (a, b) => {
      const aFavorite =
        favorites.has(
          getOpportunityId(a)
        );

      const bFavorite =
        favorites.has(
          getOpportunityId(b)
        );

      if (aFavorite && !bFavorite) {
        return -1;
      }

      if (!aFavorite && bFavorite) {
        return 1;
      }

      return b.netPercent - a.netPercent;
    }
  );

  if (!sorted.length) {
    rows.innerHTML =
      '<tr><td colspan="9">No hay oportunidades netas positivas dentro del filtro actual.</td></tr>';

    return;
  }

  for (const item of sorted.slice(0, 100)) {
    const id =
      getOpportunityId(item);

    const isFavorite =
      favorites.has(id);

    const row =
      document.createElement("tr");

    if (isFavorite) {
      row.className = "favorite-row";
    }

    const star =
      isFavorite ? "★" : "☆";

    row.innerHTML = \`

<td>
<button
  class="star \${
    isFavorite ? "active" : ""
  }"
  onclick='toggleFavorite(\${JSON.stringify(id)})'
  title="Marcar oportunidad"
>
\${star}
</button>
</td>

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

<td class="good">
\${item.netPercent.toFixed(3)}%
</td>

    \`;

    rows.appendChild(row);
  }
}

async function loadData() {
  const statusElement =
    document.getElementById("status");

  statusElement.textContent =
    "Actualizando precios...";

  try {
    const response =
      await fetch(
        "/api/opportunities",
        { cache: "no-store" }
      );

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

    window.lastOpportunities =
      data.opportunities || [];

    renderRows(
      window.lastOpportunities
    );

    const warning =
      document.getElementById("warning");

    if (data.suspiciousCount > 0) {
      warning.style.display = "block";

      warning.textContent =
        "🛡️ " +
        data.suspiciousCount +
        " comparaciones con spread superior al 10% fueron separadas por seguridad.";
    } else {
      warning.style.display = "none";
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

// Refresco automático cada 10 segundos.
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
