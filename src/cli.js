#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';
import { findFreshestSession } from './browserStorage.js';
import { getConfigPath, loadConfig, redactToken, saveConfig } from './config.js';
import { ApiError, YerevanCityApi } from './api.js';
import { YerevanCityDb } from './db.js';
import { formatLoginResult, printJson } from './format.js';
import { renderOrdersOutput } from './output.js';
import { lookupConcepts, lookupItems } from './planner.js';
import { lookupCategories } from './categories.js';
import { autoSync, syncOrders } from './sync.js';
import { clearBasket, getBasket, writeBasket } from './basket.js';
import {
  renderBasketClearText,
  renderBasketText,
  renderBasketWriteText,
  renderCategoryLookupText,
  renderConceptLookupText,
  renderItemLookupText,
  renderOverridesText,
  renderSyncResultText,
} from './agentOutput.js';

const ROOT_HELP = `Yerevan City CLI

Purpose:
  Reuse an existing logged-in Chromium session, sync your order history into a
  local SQLite DB, expose that DB for agent queries, and mutate the live basket
  with explicit structured item selections.

Product Boundary:
  - the tool fetches orders and builds local memory
  - the tool exposes lookup/query commands over that memory
  - the tool adds/removes/writes concrete basket items
  - the agent does the actual list normalization, reasoning, and choice-making

Core Commands:
  yerevan-city login
    Refresh local auth/config from browser storage.

  yerevan-city orders list
  yerevan-city orders get <id>
    Order history access and export.

  yerevan-city sync backfill
  yerevan-city sync refresh
  yerevan-city sync auto
    Build or refresh the local history/concept database.

  yerevan-city lookup concepts <query>
  yerevan-city lookup categories <query>
  yerevan-city lookup items <query>
    Query the local DB and live store state so the agent can decide what to buy.

  yerevan-city basket show
  yerevan-city basket clear
  yerevan-city basket add
  yerevan-city basket apply
    Read or mutate the live basket with explicit product IDs and quantities.

  yerevan-city overrides list
  yerevan-city overrides upsert
  yerevan-city overrides remove <id>
    Structured steering for future query/ranking work.

Usage:
  yerevan-city login [--json]
  yerevan-city orders list [--page N] [--limit N] [--page-size N] [--all] [--include-offline] [--details] [--format text|json|ndjson|csv|md] [--raw] [--output FILE]
  yerevan-city orders get <order-id-or-external-id> [--search-pages N] [--search-count N] [--format text|json|ndjson|csv|md] [--raw] [--output FILE]
  yerevan-city sync backfill [--page-size N] [--max-pages N] [--format text|json] [--output FILE]
  yerevan-city sync refresh [--page-size N] [--max-pages N] [--format text|json] [--output FILE]
  yerevan-city sync auto [--page-size N] [--max-pages N] [--format text|json] [--output FILE]
  yerevan-city lookup concepts <query> [--limit N] [--format text|json] [--output FILE]
  yerevan-city lookup categories <query> [--limit N] [--format text|json] [--output FILE]
  yerevan-city lookup items [query] [--category-id N...] [--limit N] [--format text|json] [--output FILE]
  yerevan-city basket show [--format text|json] [--output FILE]
  yerevan-city basket clear [--format text|json] [--output FILE]
  yerevan-city basket add --product-id N [--quantity N | --weight-grams N] [--query TEXT] [--name TEXT] [--note TEXT] [--cut] [--grind] [--format text|json] [--output FILE]
  yerevan-city basket apply [--input FILE] [--keep-existing] [--format text|json] [--output FILE]
  yerevan-city overrides list [--format text|json] [--output FILE]
  yerevan-city overrides upsert --query TEXT --mode prefer|ban [--product-id N] [--item-key KEY] [--quantity N] [--weight-grams N] [--note TEXT] [--id N] [--format text|json] [--output FILE]
  yerevan-city overrides remove <id> [--format text|json] [--output FILE]

Suggested Flow:
  1. yerevan-city login
  2. yerevan-city sync auto
  3. the agent uses lookup/orders output to reason about the shopping list
  4. the agent sends explicit structured items to basket add/apply

Structured Basket Apply JSON:
  [
    {"productId": 15622, "quantity": 2, "query": "яйца"},
    {"productId": 13093, "weightGrams": 1500, "query": "бананы"}
  ]

  or

  {
    "replace": true,
    "items": [
      {"productId": 15622, "quantity": 2, "query": "яйца"},
      {"productId": 13093, "weightGrams": 1500, "query": "бананы"}
    ]
  }

More Context:
  See AGENTS.md in this folder for API notes, browser/storage findings, DB
  design, basket contract shape, and stable operator/developer guidance.
`;

const LOGIN_HELP = `yerevan-city login

Purpose:
  Refresh the CLI's saved auth/config from an already logged-in Chromium session.

Usage:
  yerevan-city login
  yerevan-city login --json
`;

const ORDERS_LIST_HELP = `yerevan-city orders list

Purpose:
  Fetch recent order history in bulk.

Usage:
  yerevan-city orders list [--page N] [--limit N] [--page-size N] [--all] [--include-offline] [--details] [--format text|json|ndjson|csv|md] [--raw] [--output FILE]
`;

const ORDERS_GET_HELP = `yerevan-city orders get

Purpose:
  Fetch a single order by numeric ID or external/display ID.

Usage:
  yerevan-city orders get <order-id-or-external-id> [--search-pages N] [--search-count N] [--format text|json|ndjson|csv|md] [--raw] [--output FILE]
`;

const SYNC_HELP = `yerevan-city sync backfill|refresh|auto

Purpose:
  Build and refresh the local SQLite memory used by the agent.

Usage:
  yerevan-city sync backfill [--page-size N] [--max-pages N] [--format text|json] [--output FILE]
  yerevan-city sync refresh [--page-size N] [--max-pages N] [--format text|json] [--output FILE]
  yerevan-city sync auto [--page-size N] [--max-pages N] [--format text|json] [--output FILE]

Notes:
  - \`sync auto\` uses backfill when the local DB is empty
  - \`sync auto\` uses refresh when orders already exist locally
`;

const LOOKUP_CONCEPTS_HELP = `yerevan-city lookup concepts <query>

Purpose:
  Search the local concept memory built from your prior online orders.

Usage:
  yerevan-city lookup concepts <query> [--limit N] [--format text|json] [--output FILE]
`;

const LOOKUP_CATEGORIES_HELP = `yerevan-city lookup categories <query>

Purpose:
  Search the live Yerevan City category tree and return matching category IDs.

Usage:
  yerevan-city lookup categories <query> [--limit N] [--format text|json] [--output FILE]

Examples:
  yerevan-city lookup categories полотенца
  yerevan-city lookup categories бумажные полотенца
`;

const LOOKUP_ITEMS_HELP = `yerevan-city lookup items [query]

Purpose:
  Search live products in the current store and return history-aware candidates.
  Optionally constrain the lookup to one or more category IDs.

Usage:
  yerevan-city lookup items <query> [--limit N] [--format text|json] [--output FILE]
  yerevan-city lookup items [query] --category-id N [--category-id N...] [--limit N] [--format text|json] [--output FILE]

Note:
  This command helps the agent decide. It does not choose or add products by itself.
  Use \`lookup categories\` first when the text search is noisy and you want to browse within a known category.
`;

const BASKET_HELP = `yerevan-city basket show|clear|add|apply

Purpose:
  Work with the live basket using explicit structured items chosen by the agent.

Commands:
  yerevan-city basket show
    Read the current cart.

  yerevan-city basket clear
    Remove all current cart lines.

  yerevan-city basket add --product-id N [--quantity N | --weight-grams N] [--query TEXT] [--name TEXT]
    Add or update one explicit item while keeping the rest of the cart.

  yerevan-city basket apply [--input FILE] [--keep-existing]
    Replace the basket by default using a JSON array/object of explicit items.
    With --keep-existing, merges into the current basket instead.

Structured basket input JSON:
  [
    {"productId": 15622, "quantity": 2, "query": "яйца"},
    {"productId": 13093, "weightGrams": 1500, "query": "бананы"}
  ]

  or

  {
    "replace": true,
    "items": [
      {"productId": 15622, "quantity": 2, "query": "яйца"},
      {"productId": 13093, "weightGrams": 1500, "query": "бананы"}
    ]
  }

Notes:
  - the tool revalidates each product live before mutating the basket
  - the agent should do all loose-list normalization before calling basket add/apply
  - there is intentionally no built-in basket planner in the CLI surface
`;

const OVERRIDES_HELP = `yerevan-city overrides list|upsert|remove

Purpose:
  Store structured steering for future query/ranking work.

Commands:
  yerevan-city overrides list
  yerevan-city overrides upsert --query TEXT --mode prefer|ban [--product-id N] [--item-key KEY] [--quantity N] [--weight-grams N] [--note TEXT] [--id N]
  yerevan-city overrides remove <id>
`;

function showHelp(topic = 'root') {
  const helpByTopic = {
    root: ROOT_HELP,
    login: LOGIN_HELP,
    'orders list': ORDERS_LIST_HELP,
    'orders get': ORDERS_GET_HELP,
    sync: SYNC_HELP,
    'lookup concepts': LOOKUP_CONCEPTS_HELP,
    'lookup categories': LOOKUP_CATEGORIES_HELP,
    'lookup items': LOOKUP_ITEMS_HELP,
    basket: BASKET_HELP,
    overrides: OVERRIDES_HELP,
  };

  const message = helpByTopic[topic];
  if (!message) {
    throw new Error('Unknown help topic. Try: help, help login, help orders list, help sync, help lookup categories, help lookup items, help basket, help overrides.');
  }

  console.log(message);
}

function parseIntegerOption(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected --${name} to be a positive integer.`);
  }
  return parsed;
}

function parseOptionalIntegerOption(value, name) {
  if (value === undefined || value === null) {
    return null;
  }
  return parseIntegerOption(value, name);
}

function parseIntegerListOption(values, name) {
  const entries = Array.isArray(values) ? values : values ? [values] : [];
  return entries.map((entry) => parseIntegerOption(entry, name));
}

function parseOptionalNumberOption(value, name) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected --${name} to be a positive number.`);
  }

  return parsed;
}

function resolveOrdersFormat(options) {
  const format = options.format ?? (options.json ? 'json' : 'text');
  const allowedFormats = new Set(['text', 'json', 'ndjson', 'csv', 'md']);

  if (!allowedFormats.has(format)) {
    throw new Error('Unsupported format. Expected one of: text, json, ndjson, csv, md.');
  }

  return format;
}

function resolveSimpleFormat(options, allowedFormats = ['text', 'json']) {
  const format = options.format ?? (options.json ? 'json' : 'text');
  if (!allowedFormats.includes(format)) {
    throw new Error(`Unsupported format "${format}". Expected one of: ${allowedFormats.join(', ')}.`);
  }
  return format;
}

async function writeCommandOutput(content, outputPath) {
  if (!outputPath || outputPath === '-') {
    process.stdout.write(content);
    return;
  }

  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, content);
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readRequiredJsonInput(inputPath) {
  if (inputPath) {
    const raw = inputPath === '-'
      ? await readAll(process.stdin)
      : await fs.readFile(path.resolve(inputPath), 'utf8');
    return JSON.parse(raw);
  }

  if (!process.stdin.isTTY) {
    const raw = await readAll(process.stdin);
    return JSON.parse(raw);
  }

  throw new Error('No structured basket JSON input provided. Pipe JSON on stdin or use --input FILE.');
}

function renderSimpleOutput(value, format, textRenderer) {
  if (format === 'json') {
    return printJson(value);
  }
  return `${textRenderer(value)}\n`;
}

async function withRuntime(callback) {
  const config = await loadConfig();
  const api = new YerevanCityApi(config);
  const db = new YerevanCityDb();

  try {
    return await callback({ config, api, db });
  } finally {
    db.close();
  }
}

async function runLogin(options) {
  const session = await findFreshestSession();
  const config = {
    ...session,
    source: {
      ...session.source,
      configPath: getConfigPath(),
    },
  };

  await saveConfig(config);

  if (options.json) {
    process.stdout.write(printJson({
      ...config,
      token: redactToken(config.token),
    }));
    return;
  }

  console.log(formatLoginResult(config, redactToken(config.token)));
}

function isOfflineOrder(order) {
  return order.orderOriginType === 1 || (!Number(order.orderId ?? order.id) && Boolean(order.offlineOrderId));
}

async function fetchOrders(api, { page, pageSize, all, limit, includeOffline }) {
  const shouldKeepOrder = includeOffline ? () => true : (order) => !isOfflineOrder(order);

  if (!all && !limit) {
    const response = await api.getUserOrdersPaged({ page, count: pageSize });
    return (response?.data?.list ?? []).filter(shouldKeepOrder);
  }

  if (all && limit) {
    throw new Error('Use either `--all` or `--limit`, not both together.');
  }

  const orders = [];
  let currentPage = page;
  const singlePageCount = limit && limit <= pageSize ? limit : pageSize;
  const requestCount = all ? pageSize : singlePageCount;
  const targetCount = all ? Number.POSITIVE_INFINITY : limit;

  while (true) {
    const response = await api.getUserOrdersPaged({ page: currentPage, count: requestCount });
    const list = response?.data?.list ?? [];
    orders.push(...list.filter(shouldKeepOrder));

    if (list.length < requestCount) {
      break;
    }

    if (Number.isFinite(targetCount) && orders.length >= targetCount) {
      break;
    }

    currentPage += 1;
  }

  return Number.isFinite(targetCount) ? orders.slice(0, targetCount) : orders;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function mergeSummaryAndDetail(summary, detailResponse) {
  return {
    ...summary,
    ...(detailResponse?.data ?? {}),
  };
}

async function runOrdersList(options) {
  const config = await loadConfig();
  const api = new YerevanCityApi(config);
  const orders = await fetchOrders(api, options);

  const hydratedOrders = options.details
    ? await mapWithConcurrency(orders, 4, async (order) => {
        if (!order.id || Number(order.id) <= 0) {
          return {
            ...order,
            detailUnavailableReason: 'This order appears to be offline/in-store. The public GetById API does not return item details for it.',
          };
        }

        try {
          const detail = await api.getOrderById(order.id);
          return mergeSummaryAndDetail(order, detail);
        } catch (error) {
          const reason = error instanceof ApiError ? error.message : 'Unknown detail fetch failure';
          return {
            ...order,
            detailUnavailableReason: reason,
          };
        }
      })
    : orders;

  await writeCommandOutput(renderOrdersOutput(hydratedOrders, {
    format: options.format,
    raw: options.raw,
  }), options.output);
}

async function resolveOrder(api, identifier, searchPages, searchCount) {
  if (/^\d+$/.test(identifier) && Number(identifier) > 0) {
    const detail = await api.getOrderById(identifier);
    return detail?.data ?? null;
  }

  for (let page = 1; page <= searchPages; page += 1) {
    const response = await api.getUserOrdersPaged({ page, count: searchCount });
    const list = response?.data?.list ?? [];
    const match = list.find((order) =>
      [String(order.id ?? ''), order.uniqueId, order.offlineOrderId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === identifier.toLowerCase()),
    );

    if (match) {
      if (!match.id || Number(match.id) <= 0) {
        return {
          ...match,
          detailUnavailableReason: 'This order appears to be offline/in-store. The public GetById API does not return item details for it.',
        };
      }

      const detail = await api.getOrderById(match.id);
      return mergeSummaryAndDetail(match, detail);
    }

    if (list.length < searchCount) {
      break;
    }
  }

  return null;
}

async function runOrdersGet(identifier, options) {
  const config = await loadConfig();
  const api = new YerevanCityApi(config);
  const order = await resolveOrder(api, identifier, options.searchPages, options.searchCount);

  if (!order) {
    throw new Error(`Order "${identifier}" was not found in the searched history.`);
  }

  await writeCommandOutput(renderOrdersOutput(order, {
    format: options.format,
    raw: options.raw,
  }), options.output);
}

async function runSyncCommand(mode, options) {
  await withRuntime(async ({ config, api, db }) => {
    const result = mode === 'auto'
      ? await autoSync({
        api,
        db,
        config,
        pageSize: options.pageSize,
        maxPages: options.maxPages,
      })
      : await syncOrders({
        api,
        db,
        config,
        mode,
        pageSize: options.pageSize,
        maxPages: options.maxPages,
      });

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderSyncResultText),
      options.output,
    );
  });
}

async function runLookupConceptsCommand(query, options) {
  await withRuntime(async ({ db }) => {
    const result = lookupConcepts({
      db,
      query,
      limit: options.limit,
    });

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderConceptLookupText),
      options.output,
    );
  });
}

async function runLookupCategoriesCommand(query, options) {
  await withRuntime(async ({ api }) => {
    const result = await lookupCategories({
      api,
      query,
      limit: options.limit,
    });

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderCategoryLookupText),
      options.output,
    );
  });
}

async function runLookupItemsCommand(query, options) {
  await withRuntime(async ({ api, db }) => {
    const result = await lookupItems({
      api,
      db,
      query,
      limit: options.limit,
      categoryIds: options.categoryIds,
    });

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderItemLookupText),
      options.output,
    );
  });
}

async function runBasketShowCommand(options) {
  await withRuntime(async ({ api, db, config }) => {
    const result = await getBasket({ api, db, config });
    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderBasketText),
      options.output,
    );
  });
}

async function runBasketClearCommand(options) {
  await withRuntime(async ({ api, db, config }) => {
    const result = await clearBasket({ api, db, config });
    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderBasketClearText),
      options.output,
    );
  });
}

async function runBasketAddCommand(options) {
  await withRuntime(async ({ api, db, config }) => {
    const input = {
      replace: false,
      items: [{
        productId: options.productId,
        quantity: options.quantity,
        weightGrams: options.weightGrams,
        query: options.query,
        name: options.name,
        note: options.note,
        cut: options.cut,
        grind: options.grind,
      }],
    };

    const result = await writeBasket({
      api,
      db,
      config,
      input,
      replace: false,
    });

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderBasketWriteText),
      options.output,
    );
  });
}

async function runBasketApplyCommand(options) {
  const input = await readRequiredJsonInput(options.input);

  await withRuntime(async ({ api, db, config }) => {
    const result = await writeBasket({
      api,
      db,
      config,
      input,
      replace: !options.keepExisting,
    });

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, renderBasketWriteText),
      options.output,
    );
  });
}

async function runOverridesListCommand(options) {
  await withRuntime(async ({ db }) => {
    const overrides = db.listOverrides();
    await writeCommandOutput(
      renderSimpleOutput(overrides, options.format, renderOverridesText),
      options.output,
    );
  });
}

async function runOverridesUpsertCommand(options) {
  await withRuntime(async ({ db }) => {
    const override = db.upsertOverride({
      id: options.id,
      queryText: options.query,
      mode: options.mode,
      productId: options.productId,
      itemKey: options.itemKey,
      quantity: options.quantity,
      weightGrams: options.weightGrams,
      note: options.note,
    });

    await writeCommandOutput(
      renderSimpleOutput(override, options.format, (value) => renderOverridesText(value ? [value] : [])),
      options.output,
    );
  });
}

async function runOverridesRemoveCommand(id, options) {
  await withRuntime(async ({ db }) => {
    const removed = db.removeOverride(id);
    const result = {
      removed: Boolean(removed),
      id,
    };

    await writeCommandOutput(
      renderSimpleOutput(result, options.format, (value) => `${value.removed ? 'Removed' : 'No override found for'} override #${value.id}`),
      options.output,
    );
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    showHelp('root');
    return;
  }

  if (command === 'help') {
    const topic = args.slice(1).join(' ') || 'root';
    showHelp(topic);
    return;
  }

  if (command === 'login') {
    if (args.includes('--help') || args.includes('-h')) {
      showHelp('login');
      return;
    }

    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
    await runLogin(values);
    return;
  }

  const subcommand = args[1];
  const rest = args.slice(2);

  if (command === 'orders' && subcommand === 'list') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('orders list');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        page: { type: 'string', default: '1' },
        count: { type: 'string', default: '30' },
        limit: { type: 'string' },
        'page-size': { type: 'string' },
        all: { type: 'boolean', default: false },
        'include-offline': { type: 'boolean', default: false },
        details: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        raw: { type: 'boolean', default: false },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    const pageSize = values['page-size']
      ? parseIntegerOption(values['page-size'], 'page-size')
      : parseIntegerOption(values.count, 'count');

    await runOrdersList({
      page: parseIntegerOption(values.page, 'page'),
      pageSize,
      limit: values.limit ? parseIntegerOption(values.limit, 'limit') : null,
      all: values.all,
      includeOffline: values['include-offline'],
      details: values.details,
      format: resolveOrdersFormat(values),
      raw: values.raw,
      output: values.output,
    });
    return;
  }

  if (command === 'orders' && subcommand === 'get') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('orders get');
      return;
    }

    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        raw: { type: 'boolean', default: false },
        output: { type: 'string' },
        'search-pages': { type: 'string', default: '20' },
        'search-count': { type: 'string', default: '100' },
      },
      allowPositionals: true,
    });

    const identifier = positionals[0];
    if (!identifier) {
      throw new Error('Missing order identifier. Usage: `yerevan-city orders get <order-id-or-external-id>`');
    }

    await runOrdersGet(identifier, {
      format: resolveOrdersFormat(values),
      raw: values.raw,
      output: values.output,
      searchPages: parseIntegerOption(values['search-pages'], 'search-pages'),
      searchCount: parseIntegerOption(values['search-count'], 'search-count'),
    });
    return;
  }

  if (command === 'sync' && (subcommand === 'backfill' || subcommand === 'refresh' || subcommand === 'auto')) {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('sync');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
        'page-size': { type: 'string', default: '50' },
        'max-pages': { type: 'string', default: '100' },
      },
      allowPositionals: false,
    });

    await runSyncCommand(subcommand, {
      format: resolveSimpleFormat(values),
      output: values.output,
      pageSize: parseIntegerOption(values['page-size'], 'page-size'),
      maxPages: parseIntegerOption(values['max-pages'], 'max-pages'),
    });
    return;
  }

  if (command === 'lookup' && subcommand === 'concepts') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('lookup concepts');
      return;
    }

    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        limit: { type: 'string', default: '10' },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: true,
    });

    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing concept query. Usage: `yerevan-city lookup concepts <query>`');
    }

    await runLookupConceptsCommand(query, {
      limit: parseIntegerOption(values.limit, 'limit'),
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'lookup' && subcommand === 'categories') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('lookup categories');
      return;
    }

    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        limit: { type: 'string', default: '10' },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: true,
    });

    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing category query. Usage: `yerevan-city lookup categories <query>`');
    }

    await runLookupCategoriesCommand(query, {
      limit: parseIntegerOption(values.limit, 'limit'),
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'lookup' && subcommand === 'items') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('lookup items');
      return;
    }

    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        limit: { type: 'string', default: '10' },
        'category-id': { type: 'string', multiple: true },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: true,
    });

    const query = positionals.join(' ').trim();
    const categoryIds = parseIntegerListOption(values['category-id'], 'category-id');
    if (!query && !categoryIds.length) {
      throw new Error('Missing item query. Usage: `yerevan-city lookup items <query>` or provide --category-id.');
    }

    await runLookupItemsCommand(query, {
      limit: parseIntegerOption(values.limit, 'limit'),
      categoryIds,
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'basket' && subcommand === 'show') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('basket');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    await runBasketShowCommand({
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'basket' && subcommand === 'clear') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('basket');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    await runBasketClearCommand({
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'basket' && subcommand === 'add') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('basket');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        'product-id': { type: 'string' },
        quantity: { type: 'string' },
        'weight-grams': { type: 'string' },
        query: { type: 'string' },
        name: { type: 'string' },
        note: { type: 'string' },
        cut: { type: 'boolean', default: false },
        grind: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    const productId = parseOptionalIntegerOption(values['product-id'], 'product-id');
    if (!productId) {
      throw new Error('Missing --product-id for basket add.');
    }
    if (!values.quantity && !values['weight-grams']) {
      throw new Error('Basket add requires either --quantity N or --weight-grams N.');
    }

    await runBasketAddCommand({
      productId,
      quantity: parseOptionalNumberOption(values.quantity, 'quantity'),
      weightGrams: parseOptionalIntegerOption(values['weight-grams'], 'weight-grams'),
      query: values.query ?? null,
      name: values.name ?? null,
      note: values.note ?? null,
      cut: values.cut,
      grind: values.grind,
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'basket' && subcommand === 'apply') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('basket');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: 'string' },
        'keep-existing': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    await runBasketApplyCommand({
      input: values.input,
      keepExisting: values['keep-existing'],
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'basket' && subcommand === 'plan') {
    throw new Error('`basket plan` is intentionally not part of the tool boundary. The agent should normalize the list, use lookup/orders output, and then call `basket add` or `basket apply` with explicit items.');
  }

  if (command === 'overrides' && subcommand === 'list') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('overrides');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    await runOverridesListCommand({
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'overrides' && subcommand === 'upsert') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('overrides');
      return;
    }

    const { values } = parseArgs({
      args: rest,
      options: {
        id: { type: 'string' },
        query: { type: 'string' },
        mode: { type: 'string' },
        'product-id': { type: 'string' },
        'item-key': { type: 'string' },
        quantity: { type: 'string' },
        'weight-grams': { type: 'string' },
        note: { type: 'string' },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    if (!values.query) {
      throw new Error('Missing --query for override upsert.');
    }
    if (!values.mode) {
      throw new Error('Missing --mode for override upsert. Use prefer or ban.');
    }

    await runOverridesUpsertCommand({
      id: parseOptionalIntegerOption(values.id, 'id'),
      query: values.query,
      mode: values.mode,
      productId: parseOptionalIntegerOption(values['product-id'], 'product-id'),
      itemKey: values['item-key'] ?? null,
      quantity: parseOptionalNumberOption(values.quantity, 'quantity'),
      weightGrams: parseOptionalIntegerOption(values['weight-grams'], 'weight-grams'),
      note: values.note ?? null,
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  if (command === 'overrides' && subcommand === 'remove') {
    if (rest.includes('--help') || rest.includes('-h')) {
      showHelp('overrides');
      return;
    }

    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: true,
    });

    const identifier = positionals[0];
    if (!identifier) {
      throw new Error('Missing override id. Usage: `yerevan-city overrides remove <id>`');
    }

    await runOverridesRemoveCommand(parseIntegerOption(identifier, 'id'), {
      format: resolveSimpleFormat(values),
      output: values.output,
    });
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

main().catch((error) => {
  if (error instanceof ApiError) {
    console.error(error.message);
    if (error.details?.body) {
      process.stderr.write(printJson(error.details.body));
    }
  } else {
    console.error(error.message);
  }

  process.exitCode = 1;
});
