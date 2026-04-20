import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        try {
          var chart = ${CHART_API};
          return {
            symbol: chart.symbol() || '',
            resolution: chart.resolution() || '',
          };
        } catch(e) {
          return null;
        }
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (expectedSymbol && !state.symbol.toUpperCase().includes(expectedSymbol.toUpperCase())) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (expectedTf && state.resolution !== String(expectedTf)) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    return true;
  }

  return false;
}
