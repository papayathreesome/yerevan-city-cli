import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { getDatabasePath } from './config.js';
import {
  extractAliasesFromItem,
  guessConceptKey,
  normalizeText,
  simplifyProductName,
  titleCase,
  uniqueStrings,
} from './text.js';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function toInt(value) {
  return value ? 1 : 0;
}

function fromInt(value) {
  return Boolean(value);
}

function median(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (!sorted.length) {
    return null;
  }

  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mostRecent(first, second) {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  return first > second ? first : second;
}

function leastRecent(first, second) {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  return first < second ? first : second;
}

function buildCanonicalName(item) {
  return item?.name ?? item?.nameRu ?? item?.nameEn ?? item?.canonical_name ?? null;
}

export function buildOrderKey(order) {
  const orderId = Number(order.orderId ?? order.id ?? 0);
  if (orderId > 0) {
    return `online:${orderId}`;
  }

  const externalId = order.externalId ?? order.uniqueId ?? order.offlineOrderId;
  if (externalId) {
    return `offline:${externalId}`;
  }

  throw new Error('Cannot build order key without an online order id or offline external id.');
}

export function buildItemKey(item) {
  const numericId = Number(item?.id ?? item?.product_id ?? 0);
  if (numericId > 0) {
    return `product:${numericId}`;
  }

  if (item?.sapCode ?? item?.sap_code) {
    return `sap:${item.sapCode ?? item.sap_code}`;
  }

  const name = simplifyProductName(buildCanonicalName(item) ?? item?.name ?? '');
  if (name) {
    return `name:${name}`;
  }

  return `unknown:${randomUUID()}`;
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_key TEXT PRIMARY KEY,
      order_id INTEGER,
      external_id TEXT,
      unique_id TEXT,
      offline_order_id TEXT,
      source_type TEXT NOT NULL,
      details_fetched INTEGER NOT NULL DEFAULT 0,
      detail_unavailable_reason TEXT,
      status_code TEXT,
      created_at TEXT,
      finished_at TEXT,
      payment_method_code INTEGER,
      payment_method TEXT,
      is_delivery INTEGER NOT NULL DEFAULT 0,
      total_price_amd REAL,
      total_to_pay_amd REAL,
      initial_price_amd REAL,
      delivery_fee_amd REAL,
      service_fee_amd REAL,
      driver_tip_amount_amd REAL,
      used_bonus_amount_amd REAL,
      total_bonus_amd REAL,
      address_json TEXT,
      branch_json TEXT,
      raw_json TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      order_key TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      product_id INTEGER,
      item_key TEXT NOT NULL,
      sap_code TEXT,
      name TEXT,
      normalized_name TEXT,
      simplified_name TEXT,
      quantity REAL,
      total_price_amd REAL,
      unit_price_amd REAL,
      is_weighted INTEGER NOT NULL DEFAULT 0,
      weight_grams INTEGER,
      category_name TEXT,
      note TEXT,
      raw_json TEXT,
      created_at TEXT,
      PRIMARY KEY (order_key, line_index)
    );

    CREATE TABLE IF NOT EXISTS item_stats (
      item_key TEXT PRIMARY KEY,
      product_id INTEGER,
      sap_code TEXT,
      canonical_name TEXT,
      normalized_name TEXT,
      simplified_name TEXT,
      concept_key TEXT,
      concept_name TEXT,
      category_name TEXT,
      is_weighted INTEGER NOT NULL DEFAULT 0,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_quantity REAL NOT NULL DEFAULT 0,
      total_weight_grams INTEGER NOT NULL DEFAULT 0,
      total_spend_amd REAL NOT NULL DEFAULT 0,
      average_quantity REAL,
      typical_quantity REAL,
      average_weight_grams REAL,
      typical_weight_grams INTEGER,
      first_ordered_at TEXT,
      last_ordered_at TEXT,
      last_seen_at TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS item_aliases (
      item_key TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (item_key, normalized_alias, source)
    );

    CREATE TABLE IF NOT EXISTS concepts (
      concept_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      alias_count INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_quantity REAL NOT NULL DEFAULT 0,
      total_weight_grams INTEGER NOT NULL DEFAULT 0,
      last_ordered_at TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS concept_aliases (
      concept_key TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (concept_key, normalized_alias, source)
    );

    CREATE TABLE IF NOT EXISTS catalog_cache (
      product_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_en TEXT,
      name_ru TEXT,
      normalized_name TEXT,
      simplified_name TEXT,
      category_name TEXT,
      brand_id INTEGER,
      price REAL,
      discounted_price REAL,
      is_weighted INTEGER NOT NULL DEFAULT 0,
      minimum_weight INTEGER,
      weight_step INTEGER,
      available_count REAL,
      available_weight INTEGER,
      weight_measure TEXT,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_query TEXT
    );

    CREATE TABLE IF NOT EXISTS overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_text TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      mode TEXT NOT NULL,
      product_id INTEGER,
      item_key TEXT,
      quantity REAL,
      weight_grams INTEGER,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS basket_plans (
      plan_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source_text TEXT NOT NULL,
      status TEXT NOT NULL,
      line_count INTEGER NOT NULL DEFAULT 0,
      resolved_count INTEGER NOT NULL DEFAULT 0,
      unresolved_count INTEGER NOT NULL DEFAULT 0,
      replace_mode INTEGER NOT NULL DEFAULT 1,
      applied_at TEXT,
      apply_result_json TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS basket_plan_lines (
      plan_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      source_line TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      selected_summary TEXT,
      notes_json TEXT,
      alternatives_json TEXT,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (plan_id, line_index)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_item_aliases_normalized_alias ON item_aliases(normalized_alias);
    CREATE INDEX IF NOT EXISTS idx_item_stats_concept_key ON item_stats(concept_key);
    CREATE INDEX IF NOT EXISTS idx_concept_aliases_normalized_alias ON concept_aliases(normalized_alias);
    CREATE INDEX IF NOT EXISTS idx_catalog_cache_updated_at ON catalog_cache(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_overrides_normalized_query ON overrides(normalized_query);
  `);
}

export class YerevanCityDb {
  constructor(databasePath = getDatabasePath()) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.applyMigrations();
  }

  applyMigrations() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version === 0) {
      createSchema(this.db);
      this.db.pragma('user_version = 1');
      return;
    }

    if (version > 1) {
      throw new Error(`Unsupported database schema version ${version}.`);
    }

    createSchema(this.db);
  }

  close() {
    this.db.close();
  }

  hasOrders() {
    return Boolean(this.db.prepare('SELECT 1 FROM orders LIMIT 1').get());
  }

  hasOrder(orderKey) {
    return Boolean(this.db.prepare('SELECT 1 FROM orders WHERE order_key = ?').get(orderKey));
  }

  getOrder(orderKey) {
    const row = this.db.prepare('SELECT * FROM orders WHERE order_key = ?').get(orderKey);
    if (!row) {
      return null;
    }

    return {
      ...row,
      detailsFetched: fromInt(row.details_fetched),
      isDelivery: fromInt(row.is_delivery),
      address: parseJson(row.address_json),
      branch: parseJson(row.branch_json),
      raw: parseJson(row.raw_json),
    };
  }

  setState(key, value) {
    this.db.prepare(`
      INSERT INTO sync_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, toJson(value), nowIso());
  }

  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM sync_state WHERE key = ?').get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  getAddressContext() {
    return this.getState('address_context', null);
  }

  setAddressContext(context) {
    this.setState('address_context', context);
  }

  saveNormalizedOrder(order) {
    const syncedAt = nowIso();
    const orderKey = buildOrderKey(order);
    const items = Array.isArray(order.items) ? order.items : [];

    const insertOrder = this.db.prepare(`
      INSERT INTO orders (
        order_key,
        order_id,
        external_id,
        unique_id,
        offline_order_id,
        source_type,
        details_fetched,
        detail_unavailable_reason,
        status_code,
        created_at,
        finished_at,
        payment_method_code,
        payment_method,
        is_delivery,
        total_price_amd,
        total_to_pay_amd,
        initial_price_amd,
        delivery_fee_amd,
        service_fee_amd,
        driver_tip_amount_amd,
        used_bonus_amount_amd,
        total_bonus_amd,
        address_json,
        branch_json,
        raw_json,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_key) DO UPDATE SET
        order_id = excluded.order_id,
        external_id = excluded.external_id,
        unique_id = excluded.unique_id,
        offline_order_id = excluded.offline_order_id,
        source_type = excluded.source_type,
        details_fetched = excluded.details_fetched,
        detail_unavailable_reason = excluded.detail_unavailable_reason,
        status_code = excluded.status_code,
        created_at = excluded.created_at,
        finished_at = excluded.finished_at,
        payment_method_code = excluded.payment_method_code,
        payment_method = excluded.payment_method,
        is_delivery = excluded.is_delivery,
        total_price_amd = excluded.total_price_amd,
        total_to_pay_amd = excluded.total_to_pay_amd,
        initial_price_amd = excluded.initial_price_amd,
        delivery_fee_amd = excluded.delivery_fee_amd,
        service_fee_amd = excluded.service_fee_amd,
        driver_tip_amount_amd = excluded.driver_tip_amount_amd,
        used_bonus_amount_amd = excluded.used_bonus_amount_amd,
        total_bonus_amd = excluded.total_bonus_amd,
        address_json = excluded.address_json,
        branch_json = excluded.branch_json,
        raw_json = excluded.raw_json,
        synced_at = excluded.synced_at
    `);

    const deleteItems = this.db.prepare('DELETE FROM order_items WHERE order_key = ?');
    const insertItem = this.db.prepare(`
      INSERT INTO order_items (
        order_key,
        line_index,
        product_id,
        item_key,
        sap_code,
        name,
        normalized_name,
        simplified_name,
        quantity,
        total_price_amd,
        unit_price_amd,
        is_weighted,
        weight_grams,
        category_name,
        note,
        raw_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      insertOrder.run(
        orderKey,
        order.orderId,
        order.externalId,
        order.uniqueId,
        order.offlineOrderId,
        order.sourceType ?? 'unknown',
        toInt(order.detailsFetched),
        order.detailUnavailableReason ?? null,
        order.statusCode ?? null,
        order.createdAt ?? null,
        order.finishedAt ?? null,
        order.paymentMethodCode ?? null,
        order.paymentMethod ?? null,
        toInt(order.isDelivery),
        order.totalPriceAmd ?? null,
        order.totalToPayAmd ?? null,
        order.initialPriceAmd ?? null,
        order.deliveryFeeAmd ?? null,
        order.serviceFeeAmd ?? null,
        order.driverTipAmountAmd ?? null,
        order.usedBonusAmountAmd ?? null,
        order.totalBonusAmd ?? null,
        toJson(order.address),
        toJson(order.branch),
        toJson(order),
        syncedAt,
      );

      deleteItems.run(orderKey);

      items.forEach((item, index) => {
        const itemKey = buildItemKey(item);
        const canonicalName = buildCanonicalName(item);
        insertItem.run(
          orderKey,
          index,
          item.id ?? null,
          itemKey,
          item.sapCode ?? null,
          canonicalName,
          normalizeText(canonicalName),
          simplifyProductName(canonicalName),
          item.quantity ?? null,
          item.totalPriceAmd ?? null,
          item.unitPriceAmd ?? null,
          toInt(item.isWeighted),
          item.weightGrams ?? null,
          item.categoryName ?? null,
          item.note ?? null,
          toJson(item),
          order.createdAt ?? null,
        );
      });
    });

    transaction();
    return orderKey;
  }

  saveCatalogProducts(products, query = null) {
    const insert = this.db.prepare(`
      INSERT INTO catalog_cache (
        product_id,
        name,
        name_en,
        name_ru,
        normalized_name,
        simplified_name,
        category_name,
        brand_id,
        price,
        discounted_price,
        is_weighted,
        minimum_weight,
        weight_step,
        available_count,
        available_weight,
        weight_measure,
        raw_json,
        updated_at,
        last_query
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        name = excluded.name,
        name_en = excluded.name_en,
        name_ru = excluded.name_ru,
        normalized_name = excluded.normalized_name,
        simplified_name = excluded.simplified_name,
        category_name = excluded.category_name,
        brand_id = excluded.brand_id,
        price = excluded.price,
        discounted_price = excluded.discounted_price,
        is_weighted = excluded.is_weighted,
        minimum_weight = excluded.minimum_weight,
        weight_step = excluded.weight_step,
        available_count = excluded.available_count,
        available_weight = excluded.available_weight,
        weight_measure = excluded.weight_measure,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at,
        last_query = excluded.last_query
    `);

    const transaction = this.db.transaction((rows, lastQuery) => {
      const updatedAt = nowIso();
      rows.forEach((product) => {
        insert.run(
          product.id,
          product.name,
          product.nameEn ?? null,
          product.nameRu ?? null,
          normalizeText(product.name),
          simplifyProductName(product.name),
          product.categoryName ?? null,
          product.brandId ?? null,
          product.price ?? null,
          product.discountedPrice ?? null,
          toInt(product.isKilogram),
          product.minimumWeight ?? null,
          product.weightStep ?? null,
          product.stockDetails?.availableCount ?? product.count ?? null,
          product.stockDetails?.availableWeight ?? product.weight ?? null,
          product.weightMeasure ?? null,
          toJson(product),
          updatedAt,
          lastQuery,
        );
      });
    });

    transaction(products, query);
  }

  getCatalogProduct(productId) {
    const row = this.db.prepare('SELECT * FROM catalog_cache WHERE product_id = ?').get(productId);
    return row ? this.#hydrateCatalogRow(row) : null;
  }

  searchCatalogCache(query, limit = 10) {
    const normalized = normalizeText(query);
    if (!normalized) {
      return [];
    }

    return this.db
      .prepare(`
        SELECT *
        FROM catalog_cache
        WHERE normalized_name LIKE ?
           OR simplified_name LIKE ?
           OR product_id IN (
             SELECT product_id
             FROM overrides
             WHERE normalized_query = ?
           )
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(`%${normalized}%`, `%${normalized}%`, normalized, limit)
      .map((row) => this.#hydrateCatalogRow(row));
  }

  getItemStatsByProductIds(productIds) {
    if (!productIds.length) {
      return new Map();
    }

    const placeholders = productIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT *
      FROM item_stats
      WHERE product_id IN (${placeholders})
    `).all(...productIds);

    return new Map(rows.map((row) => [row.product_id, this.#hydrateItemStatsRow(row)]));
  }

  getItemStatsByItemKey(itemKey) {
    const row = this.db.prepare('SELECT * FROM item_stats WHERE item_key = ?').get(itemKey);
    return row ? this.#hydrateItemStatsRow(row) : null;
  }

  searchHistoricalItems(query, limit = 10) {
    const normalized = normalizeText(query);
    if (!normalized) {
      return [];
    }

    const rows = this.db
      .prepare(`
        SELECT DISTINCT item_stats.*
        FROM item_stats
        LEFT JOIN item_aliases ON item_aliases.item_key = item_stats.item_key
        WHERE item_stats.normalized_name LIKE ?
           OR item_stats.simplified_name LIKE ?
           OR item_aliases.normalized_alias LIKE ?
           OR item_stats.concept_key IN (
             SELECT concept_key
             FROM concept_aliases
             WHERE normalized_alias LIKE ?
           )
        ORDER BY item_stats.total_orders DESC, item_stats.last_ordered_at DESC
        LIMIT ?
      `)
      .all(`%${normalized}%`, `%${normalized}%`, `%${normalized}%`, `%${normalized}%`, limit);

    return rows.map((row) => this.#hydrateItemStatsRow(row));
  }

  searchConcepts(query, limit = 10) {
    const normalized = normalizeText(query);
    if (!normalized) {
      return [];
    }

    const rows = this.db
      .prepare(`
        SELECT DISTINCT concepts.*
        FROM concepts
        LEFT JOIN concept_aliases ON concept_aliases.concept_key = concepts.concept_key
        WHERE concepts.normalized_name LIKE ?
           OR concept_aliases.normalized_alias LIKE ?
        ORDER BY concepts.total_orders DESC, concepts.last_ordered_at DESC
        LIMIT ?
      `)
      .all(`%${normalized}%`, `%${normalized}%`, limit);

    return rows.map((row) => {
      const concept = this.#hydrateConceptRow(row);
      const topItems = this.db
        .prepare(`
          SELECT *
          FROM item_stats
          WHERE concept_key = ?
          ORDER BY total_orders DESC, last_ordered_at DESC
          LIMIT 5
        `)
        .all(concept.conceptKey)
        .map((itemRow) => this.#hydrateItemStatsRow(itemRow));

      return {
        ...concept,
        topItems,
      };
    });
  }

  listOverrides() {
    return this.db
      .prepare('SELECT * FROM overrides ORDER BY updated_at DESC, id DESC')
      .all()
      .map((row) => this.#hydrateOverrideRow(row));
  }

  findOverridesForQuery(query) {
    const normalized = normalizeText(query);
    if (!normalized) {
      return [];
    }

    return this.db
      .prepare(`
        SELECT *
        FROM overrides
        WHERE normalized_query = ?
           OR normalized_query LIKE ?
        ORDER BY
          CASE WHEN normalized_query = ? THEN 0 ELSE 1 END,
          updated_at DESC,
          id DESC
      `)
      .all(normalized, `%${normalized}%`, normalized)
      .map((row) => this.#hydrateOverrideRow(row));
  }

  upsertOverride({
    id = null,
    queryText,
    mode,
    productId = null,
    itemKey = null,
    quantity = null,
    weightGrams = null,
    note = null,
  }) {
    const normalizedQuery = normalizeText(queryText);
    const timestamp = nowIso();

    if (!normalizedQuery) {
      throw new Error('Override query text cannot be empty.');
    }

    if (!['prefer', 'ban'].includes(mode)) {
      throw new Error('Override mode must be either "prefer" or "ban".');
    }

    if (id) {
      this.db.prepare(`
        UPDATE overrides
        SET
          query_text = ?,
          normalized_query = ?,
          mode = ?,
          product_id = ?,
          item_key = ?,
          quantity = ?,
          weight_grams = ?,
          note = ?,
          updated_at = ?
        WHERE id = ?
      `).run(queryText, normalizedQuery, mode, productId, itemKey, quantity, weightGrams, note, timestamp, id);
      return this.listOverrides().find((override) => override.id === Number(id)) ?? null;
    }

    const result = this.db.prepare(`
      INSERT INTO overrides (
        query_text,
        normalized_query,
        mode,
        product_id,
        item_key,
        quantity,
        weight_grams,
        note,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(queryText, normalizedQuery, mode, productId, itemKey, quantity, weightGrams, note, timestamp, timestamp);

    return this.listOverrides().find((override) => override.id === Number(result.lastInsertRowid)) ?? null;
  }

  removeOverride(id) {
    return this.db.prepare('DELETE FROM overrides WHERE id = ?').run(id).changes;
  }

  savePlan(plan) {
    const savedPlan = {
      planId: plan.planId ?? randomUUID(),
      createdAt: plan.createdAt ?? nowIso(),
      ...plan,
    };

    const insertPlan = this.db.prepare(`
      INSERT INTO basket_plans (
        plan_id,
        created_at,
        source_text,
        status,
        line_count,
        resolved_count,
        unresolved_count,
        replace_mode,
        applied_at,
        apply_result_json,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET
        created_at = excluded.created_at,
        source_text = excluded.source_text,
        status = excluded.status,
        line_count = excluded.line_count,
        resolved_count = excluded.resolved_count,
        unresolved_count = excluded.unresolved_count,
        replace_mode = excluded.replace_mode,
        applied_at = excluded.applied_at,
        apply_result_json = excluded.apply_result_json,
        raw_json = excluded.raw_json
    `);

    const deleteLines = this.db.prepare('DELETE FROM basket_plan_lines WHERE plan_id = ?');
    const insertLine = this.db.prepare(`
      INSERT INTO basket_plan_lines (
        plan_id,
        line_index,
        source_line,
        normalized_query,
        status,
        confidence,
        needs_review,
        selected_count,
        selected_summary,
        notes_json,
        alternatives_json,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      insertPlan.run(
        savedPlan.planId,
        savedPlan.createdAt,
        savedPlan.sourceText,
        savedPlan.status,
        savedPlan.lineCount ?? savedPlan.lines.length,
        savedPlan.resolvedCount ?? 0,
        savedPlan.unresolvedCount ?? 0,
        toInt(savedPlan.replaceMode ?? true),
        savedPlan.appliedAt ?? null,
        toJson(savedPlan.applyResult ?? null),
        toJson(savedPlan),
      );

      deleteLines.run(savedPlan.planId);

      savedPlan.lines.forEach((line, index) => {
        const selectedItems = Array.isArray(line.selectedItems) ? line.selectedItems : [];
        insertLine.run(
          savedPlan.planId,
          index,
          line.sourceLine,
          line.normalizedQuery ?? '',
          line.status ?? 'needs_review',
          line.confidence ?? null,
          toInt(line.needsReview),
          selectedItems.length,
          selectedItems.map((item) => `${item.name} x${item.quantityLabel ?? item.quantity ?? 1}`).join(' | '),
          toJson(line.notes ?? []),
          toJson(line.alternatives ?? []),
          toJson(line),
        );
      });
    });

    transaction();
    return this.getPlan(savedPlan.planId);
  }

  getPlan(planId) {
    const row = this.db.prepare('SELECT * FROM basket_plans WHERE plan_id = ?').get(planId);
    if (!row) {
      return null;
    }

    const plan = parseJson(row.raw_json, {});
    const lines = this.db
      .prepare('SELECT * FROM basket_plan_lines WHERE plan_id = ? ORDER BY line_index ASC')
      .all(planId)
      .map((lineRow) => parseJson(lineRow.raw_json, {
        sourceLine: lineRow.source_line,
        normalizedQuery: lineRow.normalized_query,
        status: lineRow.status,
        confidence: lineRow.confidence,
        needsReview: fromInt(lineRow.needs_review),
        selectedItems: [],
        alternatives: parseJson(lineRow.alternatives_json, []),
        notes: parseJson(lineRow.notes_json, []),
      }));

    return {
      ...plan,
      planId: row.plan_id,
      createdAt: row.created_at,
      sourceText: row.source_text,
      status: row.status,
      lineCount: row.line_count,
      resolvedCount: row.resolved_count,
      unresolvedCount: row.unresolved_count,
      replaceMode: fromInt(row.replace_mode),
      appliedAt: row.applied_at ?? null,
      applyResult: parseJson(row.apply_result_json, null),
      lines,
    };
  }

  getLatestPlan() {
    const row = this.db
      .prepare('SELECT plan_id FROM basket_plans ORDER BY created_at DESC LIMIT 1')
      .get();
    return row ? this.getPlan(row.plan_id) : null;
  }

  markPlanApplied(planId, applyResult) {
    this.db.prepare(`
      UPDATE basket_plans
      SET
        status = 'applied',
        applied_at = ?,
        apply_result_json = ?
      WHERE plan_id = ?
    `).run(nowIso(), toJson(applyResult), planId);
  }

  rebuildDerivedData() {
    const rows = this.db.prepare(`
      SELECT
        order_items.*,
        orders.created_at AS order_created_at
      FROM order_items
      JOIN orders ON orders.order_key = order_items.order_key
      WHERE orders.source_type = 'online'
        AND orders.details_fetched = 1
      ORDER BY orders.created_at ASC, order_items.line_index ASC
    `).all();

    const itemAggregates = new Map();

    for (const row of rows) {
      const aggregate = itemAggregates.get(row.item_key) ?? {
        itemKey: row.item_key,
        productId: row.product_id ?? null,
        sapCode: row.sap_code ?? null,
        canonicalName: row.name ?? null,
        normalizedName: row.normalized_name ?? null,
        simplifiedName: row.simplified_name ?? null,
        categoryName: row.category_name ?? null,
        isWeighted: fromInt(row.is_weighted),
        orderKeys: new Set(),
        quantities: [],
        weights: [],
        totalSpendAmd: 0,
        aliases: new Set(),
        firstOrderedAt: null,
        lastOrderedAt: null,
      };

      aggregate.productId ??= row.product_id ?? null;
      aggregate.sapCode ??= row.sap_code ?? null;
      aggregate.canonicalName = row.name ?? aggregate.canonicalName;
      aggregate.normalizedName = row.normalized_name ?? aggregate.normalizedName;
      aggregate.simplifiedName = row.simplified_name ?? aggregate.simplifiedName;
      aggregate.categoryName = row.category_name ?? aggregate.categoryName;
      aggregate.isWeighted = aggregate.isWeighted || fromInt(row.is_weighted);
      aggregate.orderKeys.add(row.order_key);
      aggregate.firstOrderedAt = leastRecent(aggregate.firstOrderedAt, row.order_created_at);
      aggregate.lastOrderedAt = mostRecent(aggregate.lastOrderedAt, row.order_created_at);

      if (Number.isFinite(row.quantity)) {
        aggregate.quantities.push(Number(row.quantity));
      }

      if (Number.isFinite(row.weight_grams)) {
        aggregate.weights.push(Number(row.weight_grams));
      }

      if (Number.isFinite(row.total_price_amd)) {
        aggregate.totalSpendAmd += Number(row.total_price_amd);
      }

      extractAliasesFromItem({
        name: row.name,
        categoryName: row.category_name,
      }).forEach((alias) => aggregate.aliases.add(alias));

      itemAggregates.set(row.item_key, aggregate);
    }

    const conceptAggregates = new Map();

    const transaction = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM item_stats;
        DELETE FROM item_aliases;
        DELETE FROM concepts;
        DELETE FROM concept_aliases;
      `);

      const insertItemStats = this.db.prepare(`
        INSERT INTO item_stats (
          item_key,
          product_id,
          sap_code,
          canonical_name,
          normalized_name,
          simplified_name,
          concept_key,
          concept_name,
          category_name,
          is_weighted,
          total_orders,
          total_quantity,
          total_weight_grams,
          total_spend_amd,
          average_quantity,
          typical_quantity,
          average_weight_grams,
          typical_weight_grams,
          first_ordered_at,
          last_ordered_at,
          last_seen_at,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertItemAlias = this.db.prepare(`
        INSERT OR IGNORE INTO item_aliases (item_key, alias, normalized_alias, source)
        VALUES (?, ?, ?, ?)
      `);

      for (const aggregate of itemAggregates.values()) {
        const conceptKey = guessConceptKey({
          name: aggregate.canonicalName,
          categoryName: aggregate.categoryName,
        }) || aggregate.simplifiedName || aggregate.normalizedName;
        const conceptName = titleCase(conceptKey || aggregate.canonicalName || 'Unknown');
        const totalOrders = aggregate.orderKeys.size;
        const totalQuantity = aggregate.quantities.reduce((sum, value) => sum + value, 0);
        const totalWeightGrams = aggregate.weights.reduce((sum, value) => sum + value, 0);
        const averageQuantity = aggregate.quantities.length ? totalQuantity / aggregate.quantities.length : null;
        const typicalQuantity = median(aggregate.quantities);
        const averageWeightGrams = aggregate.weights.length ? totalWeightGrams / aggregate.weights.length : null;
        const typicalWeightGrams = median(aggregate.weights);

        insertItemStats.run(
          aggregate.itemKey,
          aggregate.productId,
          aggregate.sapCode,
          aggregate.canonicalName,
          aggregate.normalizedName,
          aggregate.simplifiedName,
          conceptKey,
          conceptName,
          aggregate.categoryName,
          toInt(aggregate.isWeighted),
          totalOrders,
          totalQuantity,
          totalWeightGrams,
          aggregate.totalSpendAmd,
          averageQuantity,
          typicalQuantity,
          averageWeightGrams,
          typicalWeightGrams,
          aggregate.firstOrderedAt,
          aggregate.lastOrderedAt,
          aggregate.lastOrderedAt,
          toJson({
            aliases: [...aggregate.aliases],
          }),
        );

        uniqueStrings([
          aggregate.canonicalName,
          aggregate.simplifiedName,
          aggregate.categoryName,
          ...aggregate.aliases,
        ]).forEach((alias) => {
          insertItemAlias.run(aggregate.itemKey, alias, normalizeText(alias), 'history');
        });

        const conceptAggregate = conceptAggregates.get(conceptKey) ?? {
          conceptKey,
          displayName: conceptName,
          aliases: new Set(),
          itemKeys: new Set(),
          totalOrders: 0,
          totalQuantity: 0,
          totalWeightGrams: 0,
          lastOrderedAt: null,
        };

        conceptAggregate.aliases.add(conceptName);
        conceptAggregate.aliases.add(conceptKey);
        if (aggregate.categoryName) {
          conceptAggregate.aliases.add(aggregate.categoryName);
          conceptAggregate.aliases.add(simplifyProductName(aggregate.categoryName));
        }
        if (aggregate.simplifiedName) {
          conceptAggregate.aliases.add(aggregate.simplifiedName);
          const tokens = aggregate.simplifiedName.split(' ');
          if (tokens.length) {
            conceptAggregate.aliases.add(tokens[0]);
          }
        }

        conceptAggregate.itemKeys.add(aggregate.itemKey);
        conceptAggregate.totalOrders += totalOrders;
        conceptAggregate.totalQuantity += totalQuantity;
        conceptAggregate.totalWeightGrams += totalWeightGrams;
        conceptAggregate.lastOrderedAt = mostRecent(conceptAggregate.lastOrderedAt, aggregate.lastOrderedAt);
        conceptAggregates.set(conceptKey, conceptAggregate);
      }

      const insertConcept = this.db.prepare(`
        INSERT INTO concepts (
          concept_key,
          display_name,
          normalized_name,
          alias_count,
          item_count,
          total_orders,
          total_quantity,
          total_weight_grams,
          last_ordered_at,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertConceptAlias = this.db.prepare(`
        INSERT OR IGNORE INTO concept_aliases (concept_key, alias, normalized_alias, source)
        VALUES (?, ?, ?, ?)
      `);

      for (const concept of conceptAggregates.values()) {
        const aliases = uniqueStrings([...concept.aliases]);
        insertConcept.run(
          concept.conceptKey,
          concept.displayName,
          normalizeText(concept.displayName),
          aliases.length,
          concept.itemKeys.size,
          concept.totalOrders,
          concept.totalQuantity,
          concept.totalWeightGrams,
          concept.lastOrderedAt,
          toJson({
            itemKeys: [...concept.itemKeys],
          }),
        );

        aliases.forEach((alias) => {
          insertConceptAlias.run(concept.conceptKey, alias, normalizeText(alias), 'derived');
        });
      }
    });

    transaction();

    return {
      itemCount: itemAggregates.size,
      conceptCount: conceptAggregates.size,
    };
  }

  #hydrateCatalogRow(row) {
    return {
      productId: row.product_id,
      name: row.name,
      nameEn: row.name_en,
      nameRu: row.name_ru,
      normalizedName: row.normalized_name,
      simplifiedName: row.simplified_name,
      categoryName: row.category_name,
      brandId: row.brand_id,
      price: row.price,
      discountedPrice: row.discounted_price,
      isWeighted: fromInt(row.is_weighted),
      minimumWeight: row.minimum_weight,
      weightStep: row.weight_step,
      availableCount: row.available_count,
      availableWeight: row.available_weight,
      weightMeasure: row.weight_measure,
      updatedAt: row.updated_at,
      lastQuery: row.last_query,
      raw: parseJson(row.raw_json, {}),
    };
  }

  #hydrateItemStatsRow(row) {
    return {
      itemKey: row.item_key,
      productId: row.product_id,
      sapCode: row.sap_code,
      canonicalName: row.canonical_name,
      normalizedName: row.normalized_name,
      simplifiedName: row.simplified_name,
      conceptKey: row.concept_key,
      conceptName: row.concept_name,
      categoryName: row.category_name,
      isWeighted: fromInt(row.is_weighted),
      totalOrders: row.total_orders,
      totalQuantity: row.total_quantity,
      totalWeightGrams: row.total_weight_grams,
      totalSpendAmd: row.total_spend_amd,
      averageQuantity: row.average_quantity,
      typicalQuantity: row.typical_quantity,
      averageWeightGrams: row.average_weight_grams,
      typicalWeightGrams: row.typical_weight_grams,
      firstOrderedAt: row.first_ordered_at,
      lastOrderedAt: row.last_ordered_at,
      lastSeenAt: row.last_seen_at,
      raw: parseJson(row.raw_json, {}),
    };
  }

  #hydrateConceptRow(row) {
    return {
      conceptKey: row.concept_key,
      displayName: row.display_name,
      normalizedName: row.normalized_name,
      aliasCount: row.alias_count,
      itemCount: row.item_count,
      totalOrders: row.total_orders,
      totalQuantity: row.total_quantity,
      totalWeightGrams: row.total_weight_grams,
      lastOrderedAt: row.last_ordered_at,
      raw: parseJson(row.raw_json, {}),
    };
  }

  #hydrateOverrideRow(row) {
    return {
      id: row.id,
      queryText: row.query_text,
      normalizedQuery: row.normalized_query,
      mode: row.mode,
      productId: row.product_id,
      itemKey: row.item_key,
      quantity: row.quantity,
      weightGrams: row.weight_grams,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
