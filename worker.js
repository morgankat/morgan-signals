// ===== MORGAN SIGNALS - 24/7 MARKET WATCHER =====
// Runs on a schedule (every 15 min). Checks each symbol, and only messages
// Telegram when it finds a real setup — not on every single check.

const SYMBOLS = [
  { name: 'EUR/USD', label: 'EUR/USD' },
  { name: 'GBP/USD', label: 'GBP/USD' },
  { name: 'USD/JPY', label: 'USD/JPY' },
  { name: 'XAU/USD', label: 'GOLD (XAU/USD)' },
  { name: 'BTC/USD', label: 'BTC/USD' },
  { name: 'ETH/USD', label: 'ETH/USD' },
];

const INTERVAL = '15min';
const RESEND_COOLDOWN_MS = 4 * 60 * 60 * 1000; // don't repeat the same call within 4 hours

// ---- Technical helpers ----
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function swingLevels(highs, lows, lookback = 20) {
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  return {
    swingHigh: Math.max(...recentHighs),
    swingLow: Math.min(...recentLows),
  };
}

function analyze(candles) {
  // candles: array oldest->newest of {open, high, low, close}
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const price = closes[closes.length - 1];
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const { swingHigh, swingLow } = swingLevels(highs, lows, 20);

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const bullishCandle = lastCandle.close > lastCandle.open;
  const bearishCandle = lastCandle.close < lastCandle.open;
  const engulfingBull = prevCandle && bullishCandle && lastCandle.close > prevCandle.open && lastCandle.open < prevCandle.close && prevCandle.close < prevCandle.open;
  const engulfingBear = prevCandle && bearishCandle && lastCandle.close < prevCandle.open && lastCandle.open > prevCandle.close && prevCandle.close > prevCandle.open;

  if (sma20 === null || sma50 === null || rsi14 === null) {
    return { direction: 'WAIT', reason: 'Not enough data yet' };
  }

  const uptrend = sma20 > sma50 && price > sma20;
  const downtrend = sma20 < sma50 && price < sma20;

  // BUY: uptrend + healthy RSI (not overbought) + bullish confirmation near support
  if (uptrend && rsi14 > 45 && rsi14 < 70 && (bullishCandle || engulfingBull)) {
    const entry = price;
    const sl = Math.min(swingLow, entry * 0.997);
    const risk = entry - sl;
    const tp1 = entry + risk * 1.5;
    const tp2 = entry + risk * 2.5;
    return {
      direction: 'BUY',
      entry, sl, tp1, tp2,
      confidence: engulfingBull ? 'Strong setup (bullish engulfing + trend)' : 'Moderate setup (trend + momentum)',
      reason: `Uptrend confirmed (SMA20>SMA50), RSI ${rsi14.toFixed(1)}, bullish candle at support`,
    };
  }

  // SELL: downtrend + healthy RSI (not oversold) + bearish confirmation near resistance
  if (downtrend && rsi14 < 55 && rsi14 > 30 && (bearishCandle || engulfingBear)) {
    const entry = price;
    const sl = Math.max(swingHigh, entry * 1.003);
    const risk = sl - entry;
    const tp1 = entry - risk * 1.5;
    const tp2 = entry - risk * 2.5;
    return {
      direction: 'SELL',
      entry, sl, tp1, tp2,
      confidence: engulfingBear ? 'Strong setup (bearish engulfing + trend)' : 'Moderate setup (trend + momentum)',
      reason: `Downtrend confirmed (SMA20<SMA50), RSI ${rsi14.toFixed(1)}, bearish candle at resistance`,
    };
  }

  return { direction: 'WAIT', reason: `No clear setup (RSI ${rsi14.toFixed(1)}, trend ${uptrend ? 'up' : downtrend ? 'down' : 'flat'})` };
}

async function fetchCandles(symbol, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${INTERVAL}&outputsize=60&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) return null;

  return data.values
    .map(v => ({
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse(); // TwelveData returns newest-first; we want oldest-first
}

function formatSignalMessage(label, result) {
  const arrow = result.direction === 'BUY' ? '🟢' : '🔴';
  const decimals = label.includes('JPY') ? 3 : label.includes('BTC') || label.includes('ETH') ? 2 : 5;

  return `${arrow} *${result.direction} ALERT — ${label}*\n\n` +
    `Entry: \`${result.entry.toFixed(decimals)}\`\n` +
    `Stop Loss: \`${result.sl.toFixed(decimals)}\`\n` +
    `TP1: \`${result.tp1.toFixed(decimals)}\`\n` +
    `TP2: \`${result.tp2.toFixed(decimals)}\`\n\n` +
    `${result.confidence}\n_${result.reason}_\n\n` +
    `⚠️ Not guaranteed — manage your risk.`;
}

async function sendTelegram(text, env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
    }),
  });
}

async function runScan(env) {
  const results = [];

  for (const sym of SYMBOLS) {
    try {
      const candles = await fetchCandles(sym.name, env.TWELVEDATA_API_KEY);
      if (!candles || candles.length < 50) {
        results.push({ symbol: sym.label, direction: 'WAIT', reason: 'No data' });
        continue;
      }

      const result = analyze(candles);
      results.push({ symbol: sym.label, ...result });

      if (result.direction === 'BUY' || result.direction === 'SELL') {
        const dedupeKey = `signal:${sym.name}`;
        const last = env.SIGNALS_KV ? await env.SIGNALS_KV.get(dedupeKey) : null;
        const lastData = last ? JSON.parse(last) : null;
        const now = Date.now();

        const shouldSend = !lastData ||
          lastData.direction !== result.direction ||
          (now - lastData.timestamp) > RESEND_COOLDOWN_MS;

        if (shouldSend) {
          await sendTelegram(formatSignalMessage(sym.label, result), env);
          if (env.SIGNALS_KV) {
            await env.SIGNALS_KV.put(dedupeKey, JSON.stringify({ direction: result.direction, timestamp: now }));
          }
        }
      }
    } catch (err) {
      results.push({ symbol: sym.label, direction: 'ERROR', reason: err.message });
    }
  }

  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const results = await runScan(env);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, message: 'Morgan Signals is running. Visit /run to trigger a manual scan.' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
};
