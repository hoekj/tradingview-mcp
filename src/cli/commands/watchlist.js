import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, remove, clear, sort, select)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) {
          throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        }
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['remove', {
      description: 'Remove a symbol from the active watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) {
          throw new Error('Symbol required. Usage: tv watchlist remove AAPL');
        }
        return core.remove({ symbol: positionals[0] });
      },
    }],
    ['clear', {
      description: 'Remove all symbols from the active watchlist',
      options: { expect: { type: 'string', description: 'Only clear if the active list has this name' } },
      handler: (opts) => core.clear({ expect_list: opts.expect }),
    }],
    ['sort', {
      description: 'Reorder the active watchlist (exact permutation of current symbols)',
      handler: (opts, positionals) => {
        if (positionals.length === 0) {
          throw new Error('Symbols required. Usage: tv watchlist sort AAPL MSFT KO');
        }
        return core.sort({ symbols: positionals });
      },
    }],
    ['select', {
      description: 'Activate a saved watchlist by name',
      handler: (opts, positionals) => {
        if (!positionals[0]) {
          throw new Error('List name required. Usage: tv watchlist select Today');
        }
        // Join positionals so multi-word names (e.g. "Magnificent 7") work unquoted.
        return core.select({ name: positionals.join(' ') });
      },
    }],
  ]),
});
