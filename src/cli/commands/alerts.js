import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['delete', {
      description: 'Delete a single alert by id, or delete all alerts',
      options: {
        id: { type: 'string', description: 'Id of a single alert to delete (targeted, safe)' },
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: (opts) => core.deleteAlerts({ alert_id: opts.id, delete_all: opts.all }),
    }],
  ]),
});
