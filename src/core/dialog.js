/**
 * Dialog detection and dismissal for TradingView MCP.
 * Reactive-only: call after actions known to produce modal dialogs.
 */

const POLL_DIALOG_EXPR = `
  (function __dismissDialog() {
    var btns = document.querySelectorAll('button');

    // Pass 1: pending-changes patterns — safe to match globally (specific text)
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      if (!btn.getClientRects().length) continue;
      var t = (btn.textContent || '').trim();
      if (/don.?t save|discard changes|^discard$/i.test(t)) {
        btn.click();
        return { handled: true, action: 'discard', button_text: t };
      }
    }

    // Pass 2: override-confirmation patterns — scoped to dialog containers only
    var containers = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"]');
    for (var c = 0; c < containers.length; c++) {
      var dlgBtns = containers[c].querySelectorAll('button');
      for (var j = 0; j < dlgBtns.length; j++) {
        var btn2 = dlgBtns[j];
        if (!btn2.getClientRects().length) continue;
        var t2 = (btn2.textContent || '').trim();
        if (/^(yes|ok|confirm)$/i.test(t2)) {
          btn2.click();
          return { handled: true, action: 'confirm', button_text: t2 };
        }
      }
    }

    return { handled: false };
  })()
`;

/**
 * Polls for a dismissible TradingView dialog and handles it.
 * Uses a fixed tick budget (maxMs / interval) so zero-delay test mocks
 * run a predictable number of iterations without spinning on real wall time.
 *
 * @param {{ evaluate: Function, sleep: Function }} d - resolved deps
 * @param {{ maxMs?: number, interval?: number }} opts
 * @returns {{ handled: boolean, action: string|null, button_text: string|null, elapsed_ms: number }}
 */
export async function pollForDialog(d, { maxMs = 2400, interval = 300 } = {}) {
  const start = Date.now();
  const maxTicks = Math.ceil(maxMs / interval);
  for (let i = 0; i < maxTicks; i++) {
    const result = await d.evaluate(POLL_DIALOG_EXPR);
    if (result?.handled) {
      return { handled: true, action: result.action, button_text: result.button_text, elapsed_ms: Date.now() - start };
    }
    if (i < maxTicks - 1) {
      await d.sleep(interval);
    }
  }
  return { handled: false, action: null, button_text: null, elapsed_ms: Date.now() - start };
}
