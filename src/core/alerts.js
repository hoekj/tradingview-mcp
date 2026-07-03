/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create alert"]')
        || document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  let messageSet = false;
  if (message) {
    // The Create-Alert dialog renders "Message" as a <legend> inside a <fieldset>
    // whose control is a summary button (not a plain textarea) — clicking it opens
    // an "Edit message" sub-dialog with a separate "Alert name" input. That input
    // must be set and "Apply" clicked to persist a custom message before the alert
    // is submitted. We scope lookups to the open "Create alert on" dialog because
    // several fieldsets (Trigger, Expiration, Message) share the same CSS classes.
    const messageRowOpened = await evaluate(`
      (function() {
        var heading = null;
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          if (all[i].children.length === 0 && /Create alert on/i.test(all[i].textContent) && all[i].textContent.trim().length < 30) {
            heading = all[i]; break;
          }
        }
        var dialog = heading ? heading.closest('[data-dialog-name], [role="dialog"], [class*="dialog"]') : null;
        if (!dialog) return false;
        var legends = dialog.querySelectorAll('legend');
        var fieldset = null;
        for (var i = 0; i < legends.length; i++) {
          if (legends[i].textContent.trim() === 'Message') { fieldset = legends[i].closest('fieldset'); break; }
        }
        var btn = fieldset ? fieldset.querySelector('button, [role="button"]') : null;
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `);

    if (messageRowOpened) {
      await new Promise(r => setTimeout(r, 400));
      const nameSet = await evaluate(`
        (function() {
          var heading = null;
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].children.length === 0 && /Edit message/i.test(all[i].textContent) && all[i].textContent.trim().length < 20) {
              heading = all[i]; break;
            }
          }
          var dialog = heading ? heading.closest('[data-dialog-name], [role="dialog"], [class*="dialog"]') : null;
          var input = dialog ? dialog.querySelector('input') : null;
          if (input) {
            input.focus();
            var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSet.call(input, ${JSON.stringify(message)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        })()
      `);

      if (nameSet) {
        await new Promise(r => setTimeout(r, 200));
        messageSet = await evaluate(`
          (function() {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
              if (/^apply$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
            }
            return false;
          })()
        `);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, message_set: messageSet, source: 'dom_fallback' };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              name: a.name,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_id }) {
  if (alert_id !== undefined && alert_id !== null && alert_id !== '') {
    // Targeted single-alert delete via the pricealerts REST API — discovered by
    // capturing the network request TradingView's own UI issues when deleting
    // one alert from the alerts panel context menu.
    const id = Number(alert_id);
    if (!Number.isFinite(id)) {
      throw new Error(`alert_id must be a finite number, got: ${alert_id}`);
    }
    const result = await evaluateAsync(`
      fetch('https://pricealerts.tradingview.com/delete_alerts', {
        credentials: 'include',
        method: 'POST',
        // Use text/plain instead of application/json to keep this a CORS "simple
        // request" (no preflight) — a JSON Content-Type triggers a preflight that
        // this endpoint rejects, even though the JSON-stringified body is accepted fine.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ payload: { alert_ids: [${id}] } })
      })
        .then(function(r) { return r.json().catch(function() { return { s: r.ok ? 'ok' : 'error' }; }); })
        .then(function(data) { return { ok: data.s !== 'error', raw: data }; })
        .catch(function(e) { return { ok: false, error: e.message }; })
    `);
    return {
      success: !!result?.ok,
      alert_id: id,
      source: 'internal_api',
      raw: result?.raw,
      error: result?.ok ? undefined : (result?.error || result?.raw?.errmsg),
    };
  }

  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Pass alert_id, or use delete_all: true.');
}
