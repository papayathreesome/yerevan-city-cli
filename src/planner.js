import { autoSync, resolveAddressContext } from './sync.js';
import { buildItemKey } from './db.js';
import {
  expandSharedHeadClause,
  normalizeText,
  parseExplicitQuantity,
  simplifyProductName,
  splitLineIntoClauses,
  splitShoppingList,
  tokenize,
  uniqueStrings,
} from './text.js';

const STOP_TOKENS = new Set(['и', 'или', 'the', 'a', 'an']);

function normalizeLiveProduct(rawProduct) {
  return {
    productId: rawProduct.id,
    name: rawProduct.name,
    nameEn: rawProduct.nameEn ?? null,
    nameRu: rawProduct.nameRu ?? null,
    categoryName: rawProduct.categoryName ?? null,
    price: rawProduct.discountedPrice > 0 ? rawProduct.discountedPrice : rawProduct.price,
    listPrice: rawProduct.price ?? null,
    discountedPrice: rawProduct.discountedPrice ?? 0,
    isWeighted: Boolean(rawProduct.isKilogram),
    minimumWeight: rawProduct.minimumWeight ?? null,
    weightStep: rawProduct.weightStep ?? null,
    availableCount: rawProduct.stockDetails?.availableCount ?? rawProduct.count ?? 0,
    availableWeight: rawProduct.stockDetails?.availableWeight ?? rawProduct.weight ?? 0,
    weightMeasure: rawProduct.weightMeasure ?? null,
    raw: rawProduct,
  };
}

function tokenOverlapScore(query, candidateText) {
  const queryTokens = tokenize(query).filter((token) => !STOP_TOKENS.has(token));
  const candidateTokens = new Set(tokenize(candidateText).filter((token) => !STOP_TOKENS.has(token)));

  if (!queryTokens.length || !candidateTokens.size) {
    return 0;
  }

  let matches = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      matches += 1;
    }
  }

  return matches / queryTokens.length;
}

function recencyScore(lastOrderedAt) {
  if (!lastOrderedAt) {
    return 0;
  }

  const ageDays = (Date.now() - new Date(lastOrderedAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - Math.min(ageDays, 365) / 365);
}

function normalizeCandidateAvailability(candidate) {
  return candidate.isWeighted ? Number(candidate.availableWeight ?? 0) : Number(candidate.availableCount ?? 0);
}

function alignWeightDown(weightGrams, step) {
  if (!step || step <= 1) {
    return weightGrams;
  }

  return Math.floor(weightGrams / step) * step;
}

function chooseRequestedAmount(candidate, explicitQuantity, override = null) {
  if (candidate.isWeighted) {
    let desiredWeight =
      explicitQuantity?.weightGrams
      ?? override?.weightGrams
      ?? candidate.itemStats?.typicalWeightGrams
      ?? candidate.minimumWeight
      ?? candidate.weightStep
      ?? 1000;

    desiredWeight = Math.max(1, Math.round(desiredWeight));
    const step = candidate.weightStep ?? candidate.minimumWeight ?? 1;
    desiredWeight = alignWeightDown(desiredWeight, step);
    if (desiredWeight <= 0) {
      desiredWeight = step;
    }

    const availableWeight = Number(candidate.availableWeight ?? 0);
    if (availableWeight <= 0) {
      return {
        available: false,
        quantity: null,
        weightGrams: null,
        quantityLabel: null,
        trimmed: false,
      };
    }

    let appliedWeight = desiredWeight;
    let trimmed = false;

    if (appliedWeight > availableWeight) {
      appliedWeight = alignWeightDown(availableWeight, step);
      trimmed = true;
    }

    if (candidate.minimumWeight && appliedWeight < candidate.minimumWeight) {
      if (availableWeight >= candidate.minimumWeight) {
        appliedWeight = candidate.minimumWeight;
      } else {
        return {
          available: false,
          quantity: null,
          weightGrams: null,
          quantityLabel: null,
          trimmed: true,
        };
      }
    }

    return {
      available: appliedWeight > 0,
      quantity: appliedWeight,
      weightGrams: appliedWeight,
      quantityLabel: `${(appliedWeight / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} kg`,
      trimmed,
    };
  }

  let desiredQuantity =
    explicitQuantity?.quantity
    ?? override?.quantity
    ?? candidate.itemStats?.typicalQuantity
    ?? 1;

  desiredQuantity = Math.max(1, Math.round(desiredQuantity));
  const availableCount = Math.floor(Number(candidate.availableCount ?? 0));
  if (availableCount <= 0) {
    return {
      available: false,
      quantity: null,
      weightGrams: null,
      quantityLabel: null,
      trimmed: false,
    };
  }

  let appliedQuantity = desiredQuantity;
  let trimmed = false;
  if (appliedQuantity > availableCount) {
    appliedQuantity = availableCount;
    trimmed = true;
  }

  return {
    available: appliedQuantity > 0,
    quantity: appliedQuantity,
    weightGrams: null,
    quantityLabel: String(appliedQuantity),
    trimmed,
  };
}

function buildCandidate(query, product, itemStatsMap, conceptMatches, overrides) {
  const itemStats = itemStatsMap.get(product.productId) ?? null;
  const searchableText = [
    product.name,
    product.nameRu,
    product.nameEn,
    product.categoryName,
    itemStats?.canonicalName,
    itemStats?.conceptName,
  ].filter(Boolean).join(' ');
  const overlap = tokenOverlapScore(query, searchableText);
  const queryTokens = tokenize(query).filter((token) => !STOP_TOKENS.has(token));
  const candidateTokens = new Set(tokenize(searchableText).filter((token) => !STOP_TOKENS.has(token)));
  const headTokenPresent = queryTokens.length ? candidateTokens.has(queryTokens[0]) : true;
  const normalizedQuery = normalizeText(query);
  const normalizedName = normalizeText(product.name);
  const simplifiedName = simplifyProductName(product.name);
  const exactNameMatch = Boolean(
    normalizedQuery && (
      normalizedName === normalizedQuery
      || simplifiedName === normalizedQuery
      || normalizedName.includes(normalizedQuery)
      || normalizedQuery.includes(simplifiedName)
    )
  );
  const conceptMatch = itemStats?.conceptKey
    ? conceptMatches.some((concept) => concept.conceptKey === itemStats.conceptKey)
    : false;
  const matchingOverrides = overrides.filter((override) =>
    (override.productId && Number(override.productId) === Number(product.productId))
    || (override.itemKey && override.itemKey === itemStats?.itemKey),
  );

  let score = overlap * 120;
  if (exactNameMatch) {
    score += 80;
  }
  if (conceptMatch) {
    score += 45;
  }
  if (itemStats) {
    score += Math.min(220, itemStats.totalOrders * 24);
    score += recencyScore(itemStats.lastOrderedAt) * 50;
  }
  if (!headTokenPresent) {
    score -= 110;
  }

  for (const override of matchingOverrides) {
    score += override.mode === 'prefer' ? 300 : -1000;
  }

  const availability = normalizeCandidateAvailability(product);
  if (availability > 0) {
    score += 35;
  } else {
    score -= 300;
  }

  const confidence = Math.max(
    0.05,
    Math.min(
      0.99,
      0.2
        + overlap * 0.35
        + (exactNameMatch ? 0.2 : 0)
        + (itemStats ? 0.15 : 0)
        + (conceptMatch ? 0.05 : 0)
        + (availability > 0 ? 0.1 : -0.2),
    ),
  );
  const adjustedConfidence = Math.max(0.05, headTokenPresent ? confidence : confidence - 0.25);

  return {
    ...product,
    itemStats,
    conceptMatch,
    overrides: matchingOverrides,
    score,
    confidence: adjustedConfidence,
    scoreBreakdown: {
      overlap,
      exactNameMatch,
      conceptMatch,
      headTokenPresent,
      historicalOrders: itemStats?.totalOrders ?? 0,
      availability,
      overrideCount: matchingOverrides.length,
    },
  };
}

async function searchLiveProducts(api, db, query, limit) {
  const response = await api.searchProducts({
    search: query,
    page: 1,
    count: limit,
  });
  const products = (response?.data?.products ?? []).map(normalizeLiveProduct);
  db.saveCatalogProducts(products.map((product) => product.raw), query);
  return products;
}

async function browseCategoryProducts(api, db, categoryId, query, limit) {
  const productsById = new Map();
  const pageSize = query ? Math.max(limit * 10, 60) : Math.max(limit * 5, 30);
  const maxPages = query ? 5 : 1;
  let currentPage = 1;
  let pageCount = 1;

  do {
    const response = await api.getProductsByLastCategory({
      categoryId,
      parentId: categoryId,
      page: currentPage,
      count: pageSize,
      priceFrom: null,
      priceTo: null,
      countries: [],
      categories: [],
      brands: [],
      search: query || null,
      isDiscounted: false,
      sortBy: 3,
    });

    const products = (response?.data?.list ?? []).map(normalizeLiveProduct);
    db.saveCatalogProducts(
      products.map((product) => product.raw),
      query ? `${query} [category:${categoryId}]` : `category:${categoryId}`,
    );

    for (const product of products) {
      productsById.set(product.productId, product);
    }

    pageCount = Math.max(1, Number(response?.data?.pageCount ?? 1));
    if (!query) {
      break;
    }

    const locallyMatchedCount = Array.from(productsById.values()).filter((product) =>
      tokenOverlapScore(query, [product.name, product.nameRu, product.nameEn, product.categoryName].filter(Boolean).join(' ')) > 0
    ).length;

    if (locallyMatchedCount >= limit * 3) {
      break;
    }

    currentPage += 1;
  } while (currentPage <= pageCount && currentPage <= maxPages);

  return Array.from(productsById.values());
}

async function searchProductsInCategories(api, db, query, limit, categoryIds) {
  const productsById = new Map();

  for (const categoryId of categoryIds) {
    const products = await browseCategoryProducts(api, db, categoryId, query, limit);
    for (const product of products) {
      productsById.set(product.productId, product);
    }
  }

  return Array.from(productsById.values());
}

function resolveOverrideTargetProductId(db, override) {
  if (override.productId) {
    return Number(override.productId);
  }

  if (!override.itemKey) {
    return null;
  }

  const itemStats = db.getItemStatsByItemKey(override.itemKey);
  return itemStats?.productId ? Number(itemStats.productId) : null;
}

function deriveOverrideSearchTerms(db, override, targetProductId, overrideItemStatsByProductId) {
  const overrideItemStats =
    overrideItemStatsByProductId.get(targetProductId)
    ?? (override.itemKey ? db.getItemStatsByItemKey(override.itemKey) : null);
  const cachedProduct = targetProductId ? db.getCatalogProduct(targetProductId) : null;

  return uniqueStrings([
    overrideItemStats?.canonicalName,
    overrideItemStats?.simplifiedName,
    overrideItemStats?.conceptName,
    cachedProduct?.name,
    cachedProduct?.nameRu,
    cachedProduct?.nameEn,
    override.queryText,
  ].filter(Boolean));
}

async function searchLiveProductsWithOverrides(api, db, query, limit, overrides, categoryIds = []) {
  const productsById = new Map();
  const baseProducts = categoryIds.length
    ? await searchProductsInCategories(api, db, query, limit, categoryIds)
    : await searchLiveProducts(api, db, query, limit);
  for (const product of baseProducts) {
    productsById.set(product.productId, product);
  }

  const preferredOverrides = overrides.filter((override) => override.mode === 'prefer');
  const overrideProductIds = preferredOverrides
    .map((override) => Number(override.productId))
    .filter((productId) => Number.isFinite(productId));
  const overrideItemStatsByProductId = db.getItemStatsByProductIds(overrideProductIds);

  for (const override of preferredOverrides) {
    const targetProductId = resolveOverrideTargetProductId(db, override);
    if (!targetProductId || productsById.has(targetProductId)) {
      continue;
    }

    const searchTerms = deriveOverrideSearchTerms(db, override, targetProductId, overrideItemStatsByProductId)
      .filter((term) => normalizeText(term) !== normalizeText(query));

    for (const term of searchTerms) {
      const overrideProducts = categoryIds.length
        ? await searchProductsInCategories(api, db, term, limit, categoryIds)
        : await searchLiveProducts(api, db, term, limit);
      const matchedProduct = overrideProducts.find((product) => Number(product.productId) === targetProductId);
      if (!matchedProduct) {
        continue;
      }

      productsById.set(matchedProduct.productId, matchedProduct);
      break;
    }
  }

  return Array.from(productsById.values());
}

function deriveHistoricalFragments(db, cleanedLine) {
  const tokens = tokenize(cleanedLine).filter((token) => !STOP_TOKENS.has(token));
  const scored = [];

  for (let size = 1; size <= Math.min(3, tokens.length); size += 1) {
    for (let start = 0; start <= tokens.length - size; start += 1) {
      const fragment = tokens.slice(start, start + size).join(' ');
      if (fragment.length < 3) {
        continue;
      }

      const topItem = db.searchHistoricalItems(fragment, 1)[0] ?? null;
      const topConcept = db.searchConcepts(fragment, 1)[0] ?? null;
      const topScore = Math.max(topItem?.totalOrders ?? 0, topConcept?.totalOrders ?? 0);
      if (topScore <= 0) {
        continue;
      }

      if (size === 1 && topScore < 2) {
        continue;
      }

      scored.push({ fragment, score: topScore, size });
    }
  }

  return scored
    .sort((left, right) => right.score - left.score || right.size - left.size)
    .map((entry) => entry.fragment)
    .filter((fragment, index, values) => values.indexOf(fragment) === index)
    .slice(0, 3);
}

function resolveDbHint(db, fragment) {
  const topItem = db.searchHistoricalItems(fragment, 1)[0] ?? null;
  const topConcept = db.searchConcepts(fragment, 1)[0] ?? null;

  if (!topItem && !topConcept) {
    return null;
  }

  if ((topConcept?.totalOrders ?? 0) >= (topItem?.totalOrders ?? 0)) {
    return {
      type: 'concept',
      query: topConcept.conceptKey,
      totalOrders: topConcept.totalOrders,
      displayName: topConcept.displayName,
    };
  }

  return {
    type: 'item',
    query: topItem.simplifiedName || topItem.canonicalName,
    totalOrders: topItem.totalOrders,
    displayName: topItem.canonicalName,
  };
}

function normalizeFragmentWithDb(db, fragment) {
  const hint = resolveDbHint(db, fragment);
  if (!hint?.query) {
    return {
      fragment,
      normalizedFragment: fragment,
      dbHint: null,
    };
  }

  const rawTokens = tokenize(fragment);
  const hintTokens = tokenize(hint.query);
  const rawHead = rawTokens[0] ?? '';
  const hintHead = hintTokens[0] ?? '';
  const sharesHeadPrefix = rawHead && hintHead && rawHead.slice(0, 4) === hintHead.slice(0, 4);

  const normalizedFragment =
    sharesHeadPrefix && hintTokens.length <= rawTokens.length
      ? hint.query
      : fragment;

  return {
    fragment,
    normalizedFragment,
    dbHint: {
      ...hint,
      applied: normalizedFragment !== fragment,
    },
  };
}

function deriveQueryFragments(db, sourceLine) {
  const explicitQuantity = parseExplicitQuantity(sourceLine);
  const cleanedLine = normalizeText(
    explicitQuantity?.matchedText
      ? sourceLine.replace(explicitQuantity.matchedText, ' ')
      : sourceLine,
  );

  const baseClauses = splitLineIntoClauses(cleanedLine);
  const expandedClauses = baseClauses.flatMap((clause) => expandSharedHeadClause(clause));
  let primaryFragments = [];

  if (expandedClauses.length > 1) {
    primaryFragments = expandedClauses;
  } else if (baseClauses.length > 1) {
    primaryFragments = baseClauses;
  } else {
    primaryFragments = [cleanedLine];
  }

  const normalizedPrimaryFragments = primaryFragments.map((fragment) => normalizeFragmentWithDb(db, fragment));
  const historicalFragments = primaryFragments.length === 1
    ? deriveHistoricalFragments(db, cleanedLine)
    : [];
  const fragments = uniqueStrings([
    ...normalizedPrimaryFragments.map((entry) => entry.normalizedFragment),
    ...historicalFragments,
  ]).filter(Boolean);

  return {
    explicitQuantity,
    cleanedLine,
    primaryFragments,
    normalizedFragments: normalizedPrimaryFragments.map((entry) => entry.normalizedFragment),
    normalizationHints: normalizedPrimaryFragments.map((entry) => ({
      sourceFragment: entry.fragment,
      normalizedFragment: entry.normalizedFragment,
      dbHint: entry.dbHint,
    })),
    fragments,
    requiredMatches: primaryFragments.length,
  };
}

function summarizeAlternative(candidate) {
  return {
    productId: candidate.productId,
    name: candidate.name,
    price: candidate.price,
    isWeighted: candidate.isWeighted,
    availableCount: candidate.availableCount,
    availableWeight: candidate.availableWeight,
    confidence: candidate.confidence,
    score: candidate.score,
  };
}

function buildSelectedItem(query, candidate, requestedAmount, notes) {
  return {
    query,
    productId: candidate.productId,
    itemKey: candidate.itemStats?.itemKey ?? buildItemKey({ id: candidate.productId, name: candidate.name }),
    conceptKey: candidate.itemStats?.conceptKey ?? null,
    name: candidate.name,
    categoryName: candidate.categoryName,
    isWeighted: candidate.isWeighted,
    quantity: requestedAmount.quantity,
    weightGrams: requestedAmount.weightGrams,
    quantityLabel: requestedAmount.quantityLabel,
    availableCount: candidate.availableCount,
    availableWeight: candidate.availableWeight,
    priceAmd: candidate.price,
    confidence: candidate.confidence,
    score: candidate.score,
    notes,
  };
}

export async function lookupItems({ api, db, query = '', limit = 10, categoryIds = [] } = {}) {
  if (!api || !db) {
    throw new Error('lookupItems requires api and db.');
  }

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery && !categoryIds.length) {
    throw new Error('lookupItems requires either a query or at least one categoryId.');
  }

  const overrides = normalizedQuery ? db.findOverridesForQuery(query) : [];
  const liveProducts = await searchLiveProductsWithOverrides(api, db, query, limit, overrides, categoryIds);
  const itemStatsMap = db.getItemStatsByProductIds(liveProducts.map((product) => product.productId));
  const conceptMatches = normalizedQuery ? db.searchConcepts(query, 5) : [];
  const candidates = liveProducts
    .map((product) => buildCandidate(query, product, itemStatsMap, conceptMatches, overrides))
    .sort((left, right) => right.score - left.score);

  return {
    query,
    categoryIds,
    generatedAt: new Date().toISOString(),
    conceptMatches,
    overrides,
    candidates,
  };
}

export function lookupConcepts({ db, query, limit = 10 } = {}) {
  if (!db) {
    throw new Error('lookupConcepts requires db.');
  }

  return {
    query,
    generatedAt: new Date().toISOString(),
    concepts: db.searchConcepts(query, limit),
  };
}

function selectBestCandidate(candidates, explicitQuantity, usedProductIds = new Set()) {
  let best = null;

  for (const candidate of candidates) {
    if (usedProductIds.has(candidate.productId)) {
      continue;
    }

    const preferOverride = candidate.overrides.find((override) => override.mode === 'prefer') ?? null;
    const requestedAmount = chooseRequestedAmount(candidate, explicitQuantity, preferOverride);
    if (!requestedAmount.available) {
      continue;
    }

    let score = candidate.score;
    if (!requestedAmount.trimmed) {
      score += 25;
    }
    if (candidate.availableCount > 0 || candidate.availableWeight > 0) {
      score += 10;
    }

    if (!best || score > best.finalScore) {
      best = {
        candidate,
        requestedAmount,
        finalScore: score,
      };
    }
  }

  return best;
}

export async function createBasketPlan({
  api,
  db,
  config,
  sourceText,
  replaceMode = true,
  skipSync = false,
  pageSize = 50,
  maxPages = 100,
  lineCandidateLimit = 10,
} = {}) {
  if (!api || !db || !config) {
    throw new Error('createBasketPlan requires api, db, and config.');
  }

  if (!skipSync) {
    await autoSync({ api, db, config, pageSize, maxPages });
  }

  const addressContext = db.getAddressContext() ?? await resolveAddressContext(api, config, db);
  const lines = splitShoppingList(sourceText);
  if (!lines.length) {
    throw new Error('Shopping list is empty.');
  }

  const plannedLines = [];

  for (const sourceLine of lines) {
    const {
      explicitQuantity,
      cleanedLine,
      primaryFragments,
      normalizedFragments,
      normalizationHints,
      fragments,
      requiredMatches,
    } = deriveQueryFragments(db, sourceLine);
    const selectedItems = [];
    const alternatives = [];
    const notes = [];
    const usedProductIds = new Set();
    let lineConfidence = 1;

    for (const fragment of fragments) {
      const lookup = await lookupItems({
        api,
        db,
        query: fragment,
        limit: lineCandidateLimit,
      });

      const selected = selectBestCandidate(lookup.candidates, explicitQuantity, usedProductIds);
      if (selected && selected.candidate.confidence >= 0.62) {
        const selectionNotes = [];
        if (selected.requestedAmount.trimmed) {
          selectionNotes.push('Requested quantity was trimmed to current store availability.');
        }
        if (fragment !== cleanedLine) {
          selectionNotes.push(`Resolved from fragment "${fragment}".`);
        }

        selectedItems.push(buildSelectedItem(fragment, selected.candidate, selected.requestedAmount, selectionNotes));
        usedProductIds.add(selected.candidate.productId);
        lineConfidence = Math.min(lineConfidence, selected.candidate.confidence);
      }

      lookup.candidates.slice(0, 3).forEach((candidate) => {
        if (!alternatives.some((alternative) => alternative.productId === candidate.productId)) {
          alternatives.push(summarizeAlternative(candidate));
        }
      });
    }

    if (!selectedItems.length) {
      notes.push('No confident in-stock product match was found for this line.');
    }

    if (selectedItems.length < requiredMatches) {
      notes.push('At least one intended sub-query could not be matched confidently in the live store.');
    }

    const needsReview =
      !selectedItems.length
      || selectedItems.length < requiredMatches
      || lineConfidence < 0.62;
    if (needsReview && selectedItems.length) {
      notes.push('A plausible match was found, but confidence is below the auto-apply threshold.');
    }

    plannedLines.push({
      sourceLine,
      normalizedQuery: normalizeText(cleanedLine),
      cleanedLine,
      fragments,
      primaryFragments,
      normalizedFragments,
      normalizationHints,
      status: needsReview ? 'needs_review' : 'selected',
      confidence: Number((selectedItems.length ? lineConfidence : 0).toFixed(3)),
      needsReview,
      selectedItems,
      alternatives: alternatives.slice(0, 5),
      notes,
    });
  }

  const resolvedCount = plannedLines.filter((line) => !line.needsReview && line.selectedItems.length).length;
  const unresolvedCount = plannedLines.length - resolvedCount;
  const savedPlan = db.savePlan({
    createdAt: new Date().toISOString(),
    sourceText,
    replaceMode,
    status: unresolvedCount ? 'needs_review' : 'planned',
    lineCount: plannedLines.length,
    resolvedCount,
    unresolvedCount,
    addressContext,
    lines: plannedLines,
  });

  return savedPlan;
}

export function flattenPlanSelections(plan) {
  const aggregated = new Map();

  for (const line of plan.lines ?? []) {
    if (line.needsReview || !Array.isArray(line.selectedItems)) {
      continue;
    }

    for (const selectedItem of line.selectedItems) {
      const existing = aggregated.get(selectedItem.productId) ?? {
        ...selectedItem,
        sourceLines: [],
      };

      existing.quantity = Number(existing.quantity ?? 0) + Number(selectedItem.quantity ?? 0);
      existing.weightGrams = Number(existing.weightGrams ?? 0) + Number(selectedItem.weightGrams ?? 0);
      existing.sourceLines.push(line.sourceLine);
      aggregated.set(selectedItem.productId, existing);
    }
  }

  return [...aggregated.values()];
}

async function findFreshCandidateForSelection(api, db, selection) {
  const lookup = await lookupItems({
    api,
    db,
    query: selection.query ?? selection.name,
    limit: 10,
  });

  return (
    lookup.candidates.find((candidate) => Number(candidate.productId) === Number(selection.productId))
    ?? lookup.candidates[0]
    ?? null
  );
}

function fitPlannedAmountToAvailability(candidate, selection) {
  if (candidate.isWeighted) {
    const step = candidate.weightStep ?? candidate.minimumWeight ?? 1;
    const availableWeight = Number(candidate.availableWeight ?? 0);
    if (availableWeight <= 0) {
      return null;
    }

    let appliedWeight = Math.min(Number(selection.weightGrams ?? selection.quantity ?? 0), availableWeight);
    appliedWeight = alignWeightDown(appliedWeight, step);
    if (candidate.minimumWeight && appliedWeight < candidate.minimumWeight) {
      if (availableWeight >= candidate.minimumWeight) {
        appliedWeight = candidate.minimumWeight;
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
      trimmed: appliedWeight < Number(selection.weightGrams ?? selection.quantity ?? 0),
    };
  }

  const availableCount = Math.floor(Number(candidate.availableCount ?? 0));
  if (availableCount <= 0) {
    return null;
  }

  const appliedQuantity = Math.min(Math.round(Number(selection.quantity ?? 1)), availableCount);
  if (appliedQuantity <= 0) {
    return null;
  }

  return {
    quantity: appliedQuantity,
    weight: 0,
    trimmed: appliedQuantity < Math.round(Number(selection.quantity ?? 1)),
  };
}

export async function applyBasketPlan({
  api,
  db,
  config,
  plan,
  replace = true,
  skipSync = false,
  pageSize = 50,
  maxPages = 100,
} = {}) {
  if (!api || !db || !config) {
    throw new Error('applyBasketPlan requires api, db, and config.');
  }

  const resolvedPlan =
    typeof plan === 'string'
      ? db.getPlan(plan)
      : plan;

  if (!resolvedPlan) {
    throw new Error('Basket plan was not found.');
  }

  if (!skipSync) {
    await autoSync({ api, db, config, pageSize, maxPages });
  }

  const addressContext = db.getAddressContext() ?? await resolveAddressContext(api, config, db);
  const appliedItems = [];
  const skippedItems = [];
  let removedExistingItems = 0;

  if (replace) {
    const currentCart = await api.getCartItems(addressContext);
    const currentItems = currentCart?.data?.items ?? [];

    for (const item of currentItems) {
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
      removedExistingItems += 1;
    }
  }

  const aggregatedSelections = flattenPlanSelections(resolvedPlan);

  for (const selection of aggregatedSelections) {
    const freshCandidate = await findFreshCandidateForSelection(api, db, selection);
    if (!freshCandidate) {
      skippedItems.push({
        ...selection,
        reason: 'Product is no longer discoverable in the live store catalog.',
      });
      continue;
    }

    const fittedAmount = fitPlannedAmountToAvailability(freshCandidate, selection);
    if (!fittedAmount) {
      skippedItems.push({
        ...selection,
        reason: 'Product is out of stock or does not meet its minimum live quantity.',
      });
      continue;
    }

    await api.updateCartItem({
      addressId: addressContext.addressId,
      id: freshCandidate.productId,
      quantity: fittedAmount.quantity,
      weight: fittedAmount.weight,
      lat: addressContext.lat,
      lng: addressContext.lng,
      isGreenLine: addressContext.isGreenLine,
      note: '',
      cut: false,
      grind: false,
    });

    appliedItems.push({
      ...selection,
      quantity: fittedAmount.quantity,
      weightGrams: freshCandidate.isWeighted ? fittedAmount.weight : null,
      trimmed: fittedAmount.trimmed,
      liveAvailability: freshCandidate.isWeighted ? freshCandidate.availableWeight : freshCandidate.availableCount,
    });
  }

  const finalCart = await api.getCartItems(addressContext);
  const result = {
    planId: resolvedPlan.planId,
    appliedAt: new Date().toISOString(),
    replaceMode: replace,
    removedExistingItems,
    attemptedItems: aggregatedSelections.length,
    appliedItems,
    skippedItems,
    finalCart: finalCart?.data ?? null,
  };

  db.markPlanApplied(resolvedPlan.planId, result);
  return result;
}
