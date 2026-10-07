const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Comisiones estimadas para la primera prueba.
// Luego las hacemos configurables según tu nivel real en cada exchange.
const FEES = {
  Binance: 0.001,
  Bybit: 0.001,
  OKX: 0.001,
};

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "crypto-arbitrage-scanner/1.0" },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

// -------------------- BINANCE --------------------

async function getBinance() {
  const data = await getJson(
    "https://api.binance.com/api/v3/ticker/bookTicker"
  );

  const result = {};

  for (const item of data) {
    if (!item.symbol.endsWith("USDT")) continue;

    const bid = Number(item.bidPrice);
    const ask = Number(item.askPrice);

    if (!bid || !ask) continue;

    result[item.symbol] = {
      exchange: "Binance",
      symbol: item.symbol,
      bid,
      ask,
    };
  }

  return result;
}

// -------------------- BYBIT --------------------

async function getBybit() {
  const data = await getJson(
    "https://api.bybit.com/v5/market/tickers?category=spot"
  );

  const result = {};

  for (const item of data.result?.list || []) {
    if (!item.symbol.endsWith("USDT")) continue;

    const bid = Number(item.bid1Price);
    const ask = Number(item.ask1Price);

    if (!bid || !ask) continue;

    result[item.symbol] = {
      exchange: "Bybit",
      symbol: item.symbol,
      bid,
      ask,
    };
  }

  return result;
}

// -------------------- OKX --------------------

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
      ask,
    };
  }

  return result;
}

// -------------------- ARBITRAJE --------------------

function calculateOpportunities(markets) {
  const exchanges = Object.keys(markets);

  const symbols = new Set();

  for (const exchange of exchanges) {
    Object.keys(markets[exchange]).forEach((symbol) =>
      symbols.add(symbol)
    );
  }

  const opportunities = [];

  for (const symbol of symbols) {
    const quotes = [];

    for (const exchange of exchanges) {
      const quote = markets[exchange][symbol];

      if (quote) quotes.push(quote);
    }

    // Queremos comparar solamente monedas presentes
    // en al menos dos exchanges.
    if (quotes.length < 2) continue;

    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.exchange === sell.exchange) continue;

        const buyPrice = buy.ask;
        const sellPrice = sell.bid;

        if (!buyPrice || !sellPrice) continue;

        const grossPercent =
          ((sellPrice - buyPrice) / buyPrice) * 100;

        const totalFees =
          (FEES[buy.exchange] + FEES[sell.exchange]) * 100;

        const netPercent = grossPercent - totalFees;

        opportunities.push({
          symbol,
          buyExchange: buy.exchange,
          buyPrice,
          sellExchange: sell.exchange,
          sellPrice,
          grossPercent,
          totalFees,
          netPercent,
        });
      }
    }
  }

  return opportunities
    .filter((item) => item.grossPercent > 0)
    .sort((a, b) => b.netPercent - a.netPercent);
}

// -------------------- API --------------------

app.get("/api/opportunities", async (req, res) => {
  try {
    const [binance, bybit, okx] = await Promise.all([
      getBinance(),
      getBybit(),
      getOKX(),
    ]);

    const markets = {
      Binance: binance,
      Bybit: bybit,
      OKX: okx,
    };

    const opportunities = calculateOpportunities(markets);

    res.json({
      updatedAt: new Date().toISOString(),
      exchanges: {
        Binance: Object.keys(binance).length,
        Bybit: Object.keys(bybit).length,
        OKX: Object.keys(okx).length,
      },
      opportunities: opportunities.slice(0, 100),
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "No se pudieron obtener los precios.",
      detail: error.message,
    });
  }
});

// -------------------- WEB --------------------

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Crypto Arbitrage Scanner</title>

<style>

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #0b1220;
  color: white;
}

header {
  padding: 24px;
  background: #111a2c;
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
}

.status {
  margin-bottom: 15px;
  color: #9ca9bd;
}

table {
  width: 100%;
  border-collapse: collapse;
  background: #111a2c;
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

button {
  background: white;
  color: #111;
  border: 0;
  padding: 10px 18px;
  border-radius: 7px;
  cursor: pointer;
  font-weight: bold;
  margin-bottom: 15px;
}

.note {
  margin-top: 20px;
  color: #9ca9bd;
  font-size: 13px;
}

</style>
</head>

<body>

<header>
  <h1>Crypto Arbitrage Scanner</h1>

  <div class="subtitle">
    Binance · Bybit · OKX — Spot USDT
  </div>
</header>

<div class="container">

  <div class="cards">
    <div class="card">
      Binance: <strong id="binance">-</strong> pares
    </div>

    <div class="card">
      Bybit: <strong id="bybit">-</strong> pares
    </div>

    <div class="card">
      OKX: <strong id="okx">-</strong> pares
    </div>
  </div>

  <button onclick="loadData()">Actualizar ahora</button>

  <div class="status" id="status">
    Cargando precios...
  </div>

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

  <div class="note">
    Scanner informativo. Los precios pueden cambiar antes de ejecutar una operación.
    Esta primera versión todavía no calcula profundidad completa del libro,
    slippage ni costes de transferencia.
  </div>

</div>

<script>

function price(value) {
  if (value >= 1000)
    return value.toLocaleString("en-US", {
      maximumFractionDigits: 2
    });

  if (value >= 1)
    return value.toFixed(4);

  return value.toPrecision(6);
}

async function loadData() {

  const status = document.getElementById("status");

  status.textContent = "Actualizando precios...";

  try {

    const response = await fetch("/api/opportunities");

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || data.error);
    }

    document.getElementById("binance").textContent =
      data.exchanges.Binance;

    document.getElementById("bybit").textContent =
      data.exchanges.Bybit;

    document.getElementById("okx").textContent =
      data.exchanges.OKX;

    const rows = document.getElementById("rows");

    rows.innerHTML = "";

    const visible =
      data.opportunities.filter(x => x.netPercent > 0);

    for (const item of visible.slice(0, 50)) {

      const tr = document.createElement("tr");

      tr.innerHTML = \`
        <td><strong>\${item.symbol}</strong></td>

        <td class="buy">
          \${item.buyExchange}
        </td>

        <td>
          \${price(item.buyPrice)}
        </td>

        <td class="sell">
          \${item.sellExchange}
        </td>

        <td>
          \${price(item.sellPrice)}
        </td>

        <td>
          \${item.grossPercent.toFixed(3)}%
        </td>

        <td>
          \${item.totalFees.toFixed(3)}%
        </td>

        <td class="\${item.netPercent > 0.20 ? "good" : "bad"}">
          \${item.netPercent.toFixed(3)}%
        </td>
      \`;

      rows.appendChild(tr);
    }

    if (!visible.length) {

      rows.innerHTML =
        '<tr><td colspan="8">No hay oportunidades netas positivas en este momento.</td></tr>';

    }

    status.textContent =
      "Última actualización: " +
      new Date(data.updatedAt).toLocaleTimeString();

  } catch (error) {

    status.textContent =
      "Error: " + error.message;

  }
}

loadData();

// Actualiza automáticamente cada 10 segundos.
setInterval(loadData, 10000);

</script>

</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(
    "Crypto Arbitrage Scanner funcionando en puerto " + PORT
  );
});
