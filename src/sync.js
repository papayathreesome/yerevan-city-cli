import { ApiError } from './api.js';
import { buildOrderKey } from './db.js';
import { normalizeOrder } from './output.js';

function isOfflineOrder(order) {
  return order.orderOriginType === 1 || (!Number(order.orderId ?? order.id) && Boolean(order.offlineOrderId));
}

function mergeSummaryAndDetail(summary, detailResponse) {
  return {
    ...summary,
    ...(detailResponse?.data ?? {}),
  };
}

function buildOrderSkeletonFromExisting(existingOrder, freshSummary) {
  if (!existingOrder?.raw) {
    return normalizeOrder(freshSummary);
  }

  const normalizedSummary = normalizeOrder(freshSummary);
  return {
    ...existingOrder.raw,
    ...normalizedSummary,
    detailsFetched: existingOrder.detailsFetched,
    items: existingOrder.raw.items ?? [],
  };
}

function extractApiErrorMessage(error) {
  if (error instanceof ApiError) {
    return error.message;
  }

  return error?.message ?? 'Unknown API failure';
}

export async function resolveAddressContext(api, config, db = null) {
  const response = await api.getAddresses();
  const addresses = response?.data?.addresses ?? [];
  const preferredAddressId = Number(config.defaults?.addressId ?? 0);
  const matchedAddress =
    addresses.find((address) => Number(address.id) === preferredAddressId)
    ?? addresses.find((address) => address.isDefault)
    ?? addresses[0]
    ?? null;

  if (!matchedAddress) {
    throw new Error('No saved delivery address was returned by the Yerevan City API.');
  }

  const context = {
    addressId: matchedAddress.id,
    lat: matchedAddress.lat,
    lng: matchedAddress.lng,
    isGreenLine: false,
    title: matchedAddress.title ?? null,
    city: matchedAddress.city ?? null,
    street: matchedAddress.street ?? null,
    building: matchedAddress.buliding ?? matchedAddress.building ?? null,
    entrance: matchedAddress.entrance ?? null,
    floor: matchedAddress.floor ?? null,
    apartment: matchedAddress.appartment ?? matchedAddress.apartment ?? null,
    isDefault: Boolean(matchedAddress.isDefault),
    raw: matchedAddress,
    refreshedAt: new Date().toISOString(),
  };

  if (db) {
    db.setAddressContext(context);
  }

  return context;
}

export async function syncOrders({
  api,
  db,
  config,
  mode = 'refresh',
  pageSize = 50,
  maxPages = 100,
} = {}) {
  if (!api || !db || !config) {
    throw new Error('syncOrders requires api, db, and config.');
  }

  if (!['backfill', 'refresh'].includes(mode)) {
    throw new Error('syncOrders mode must be "backfill" or "refresh".');
  }

  const startedAt = new Date().toISOString();
  let pagesFetched = 0;
  let scannedOrders = 0;
  let savedOrders = 0;
  let detailFetches = 0;
  let detailFailures = 0;
  let newOrders = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await api.getUserOrdersPaged({ page, count: pageSize });
    const list = response?.data?.list ?? [];
    pagesFetched += 1;

    if (!list.length) {
      break;
    }

    let newOrdersOnPage = 0;

    for (const summary of list) {
      scannedOrders += 1;

      const summaryNormalized = normalizeOrder(summary);
      const orderKey = buildOrderKey(summaryNormalized);
      const existingOrder = db.getOrder(orderKey);
      const orderIsOffline = isOfflineOrder(summary);
      let normalizedOrder = summaryNormalized;

      if (orderIsOffline) {
        normalizedOrder = {
          ...summaryNormalized,
          detailsFetched: false,
          detailUnavailableReason: summaryNormalized.detailUnavailableReason
            ?? 'This order appears to be offline/in-store. The public GetById API does not return item details for it.',
          items: [],
        };
      } else {
        const shouldFetchDetail =
          mode === 'backfill'
          || !existingOrder
          || !existingOrder.detailsFetched;

        if (shouldFetchDetail) {
          try {
            const detail = await api.getOrderById(summary.id);
            normalizedOrder = normalizeOrder(mergeSummaryAndDetail(summary, detail));
            detailFetches += 1;
          } catch (error) {
            detailFailures += 1;
            normalizedOrder = {
              ...summaryNormalized,
              detailsFetched: false,
              detailUnavailableReason: extractApiErrorMessage(error),
              items: [],
            };
          }
        } else {
          normalizedOrder = buildOrderSkeletonFromExisting(existingOrder, summary);
        }
      }

      db.saveNormalizedOrder(normalizedOrder);
      savedOrders += 1;

      if (!existingOrder) {
        newOrders += 1;
        newOrdersOnPage += 1;
      }
    }

    if (list.length < pageSize) {
      break;
    }

    if (mode === 'refresh' && newOrdersOnPage === 0) {
      break;
    }
  }

  const derived = db.rebuildDerivedData();
  await resolveAddressContext(api, config, db);
  const finishedAt = new Date().toISOString();
  const result = {
    mode,
    startedAt,
    finishedAt,
    pageSize,
    maxPages,
    pagesFetched,
    scannedOrders,
    savedOrders,
    newOrders,
    detailFetches,
    detailFailures,
    itemStatsCount: derived.itemCount,
    conceptCount: derived.conceptCount,
  };

  db.setState('last_order_sync', result);
  return result;
}

export async function autoSync({ api, db, config, pageSize = 50, maxPages = 100 } = {}) {
  if (db.hasOrders()) {
    return syncOrders({
      api,
      db,
      config,
      mode: 'refresh',
      pageSize,
      maxPages,
    });
  }

  return syncOrders({
    api,
    db,
    config,
    mode: 'backfill',
    pageSize,
    maxPages,
  });
}
