import { resolveAddressContext } from './sync.js';

function normalizeLiveProduct(rawProduct) {
  return {
    productId: rawProduct.id,
    name: rawProduct.name,
    categoryName: rawProduct.categoryName ?? null,
    isWeighted: Boolean(rawProduct.isKilogram),
    minimumWeight: rawProduct.minimumWeight ?? null,
    weightStep: rawProduct.weightStep ?? null,
    availableCount: rawProduct.stockDetails?.availableCount ?? rawProduct.count ?? 0,
    availableWeight: rawProduct.stockDetails?.availableWeight ?? rawProduct.weight ?? 0,
    price: rawProduct.discountedPrice > 0 ? rawProduct.discountedPrice : rawProduct.price,
    raw: rawProduct,
  };
}

function alignWeightDown(weightGrams, step) {
  if (!step || step <= 1) {
    return weightGrams;
  }

  return Math.floor(weightGrams / step) * step;
}

function fitStructuredAmount(liveProduct, item) {
  if (liveProduct.isWeighted) {
    const requestedWeight = Math.max(
      1,
      Math.round(Number(item.weightGrams ?? item.quantity ?? liveProduct.minimumWeight ?? liveProduct.weightStep ?? 1000)),
    );
    const step = liveProduct.weightStep ?? liveProduct.minimumWeight ?? 1;
    const availableWeight = Number(liveProduct.availableWeight ?? 0);

    if (availableWeight <= 0) {
      return null;
    }

    let appliedWeight = Math.min(requestedWeight, availableWeight);
    appliedWeight = alignWeightDown(appliedWeight, step);
    if (liveProduct.minimumWeight && appliedWeight < liveProduct.minimumWeight) {
      if (availableWeight >= liveProduct.minimumWeight) {
        appliedWeight = liveProduct.minimumWeight;
      } else {
        return null;
      }
    }

    if (appliedWeight <= 0) {
      return null;
    }

    return {
      quantity: appliedWeight,
      weight: appliedWeight,
      trimmed: appliedWeight < requestedWeight,
    };
  }

  const requestedCount = Math.max(1, Math.round(Number(item.quantity ?? 1)));
  const availableCount = Math.floor(Number(liveProduct.availableCount ?? 0));
  if (availableCount <= 0) {
    return null;
  }

  const appliedQuantity = Math.min(requestedCount, availableCount);
  if (appliedQuantity <= 0) {
    return null;
  }

  return {
    quantity: appliedQuantity,
    weight: 0,
    trimmed: appliedQuantity < requestedCount,
  };
}

async function ensureAddressContext(api, db, config) {
  return db.getAddressContext() ?? resolveAddressContext(api, config, db);
}

async function findLiveProduct(api, db, item) {
  const cachedProduct = db.getCatalogProduct(Number(item.productId));
  const query =
    item.query
    ?? item.name
    ?? cachedProduct?.name
    ?? null;

  if (!query) {
    throw new Error(`Cannot revalidate product ${item.productId} without a query or known cached name.`);
  }

  const response = await api.searchProducts({
    search: query,
    page: 1,
    count: 30,
  });

  const products = (response?.data?.products ?? []).map(normalizeLiveProduct);
  db.saveCatalogProducts(products.map((product) => product.raw), query);
  return products.find((product) => Number(product.productId) === Number(item.productId)) ?? null;
}

function normalizeStructuredItems(input) {
  if (Array.isArray(input)) {
    return {
      replace: true,
      items: input,
    };
  }

  if (!input || !Array.isArray(input.items)) {
    throw new Error('Structured basket input must be an array of items or an object with an `items` array.');
  }

  return {
    replace: input.replace !== false,
    items: input.items,
  };
}

export async function getBasket({ api, db, config } = {}) {
  const addressContext = await ensureAddressContext(api, db, config);
  const cart = await api.getCartItems(addressContext);
  return {
    cart: cart?.data ?? null,
  };
}

export async function clearBasket({ api, db, config } = {}) {
  const addressContext = await ensureAddressContext(api, db, config);
  const cart = await api.getCartItems(addressContext);
  const items = cart?.data?.items ?? [];

  for (const item of items) {
    await api.updateCartItem({
      addressId: addressContext.addressId,
      id: item.id,
      quantity: 0,
      weight: 0,
      lat: addressContext.lat,
      lng: addressContext.lng,
      isGreenLine: addressContext.isGreenLine,
      note: item.note ?? '',
      cut: Boolean(item.cut),
      grind: Boolean(item.grind),
    });
  }

  const finalCart = await api.getCartItems(addressContext);
  return {
    clearedCount: items.length,
    cart: finalCart?.data ?? null,
  };
}

export async function writeBasket({ api, db, config, input, replace = null } = {}) {
  const addressContext = await ensureAddressContext(api, db, config);
  const normalizedInput = normalizeStructuredItems(input);
  const replaceMode = replace ?? normalizedInput.replace ?? true;
  let removedExistingItems = 0;

  if (replaceMode) {
    const cleared = await clearBasket({ api, db, config });
    removedExistingItems = cleared.clearedCount;
  }

  const appliedItems = [];
  const skippedItems = [];

  for (const item of normalizedInput.items) {
    const liveProduct = await findLiveProduct(api, db, item);
    if (!liveProduct) {
      skippedItems.push({
        ...item,
        reason: 'Product was not found in the live store for the provided query/name.',
      });
      continue;
    }

    const fittedAmount = fitStructuredAmount(liveProduct, item);
    if (!fittedAmount) {
      skippedItems.push({
        ...item,
        reason: 'Product is out of stock or below its minimum live quantity.',
      });
      continue;
    }

    await api.updateCartItem({
      addressId: addressContext.addressId,
      id: liveProduct.productId,
      quantity: fittedAmount.quantity,
      weight: fittedAmount.weight,
      lat: addressContext.lat,
      lng: addressContext.lng,
      isGreenLine: addressContext.isGreenLine,
      note: item.note ?? '',
      cut: Boolean(item.cut),
      grind: Boolean(item.grind),
    });

    appliedItems.push({
      ...item,
      name: liveProduct.name,
      categoryName: liveProduct.categoryName,
      isWeighted: liveProduct.isWeighted,
      quantity: liveProduct.isWeighted ? fittedAmount.weight : fittedAmount.quantity,
      weightGrams: liveProduct.isWeighted ? fittedAmount.weight : null,
      trimmed: fittedAmount.trimmed,
      liveAvailability: liveProduct.isWeighted ? liveProduct.availableWeight : liveProduct.availableCount,
    });
  }

  const finalCart = await api.getCartItems(addressContext);
  return {
    replaceMode,
    removedExistingItems,
    attemptedItems: normalizedInput.items.length,
    appliedItems,
    skippedItems,
    cart: finalCart?.data ?? null,
  };
}
