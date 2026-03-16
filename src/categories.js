import { normalizeText, tokenize } from './text.js';

const STOP_TOKENS = new Set(['и', 'или', 'the', 'a', 'an']);
const CATEGORY_TREE_STATE_KEY = 'category_tree_v1';
export const DEFAULT_CATEGORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeCategoryNode(rawCategory, context = {}) {
  const id = Number(rawCategory.id ?? rawCategory.categoryId ?? 0);
  const name = rawCategory.name ?? rawCategory.categoryName ?? null;
  const itemCount = rawCategory.itemCount ?? null;
  const parentId =
    context.parentId !== undefined
      ? context.parentId
      : (rawCategory.parentId ?? rawCategory.parentCategoryId ?? null);
  const topParentId = context.topParentId ?? id;
  const depth = context.depth ?? 0;
  const pathNames = [...(context.pathNames ?? []), name].filter(Boolean);

  return {
    id,
    name,
    parentId: parentId === undefined ? null : parentId,
    topParentId,
    depth,
    pathNames,
    path: pathNames.join(' > '),
    itemCount,
    isAdult: Boolean(rawCategory.isAdult),
    childrenCount: Array.isArray(rawCategory.children) ? rawCategory.children.length : 0,
    raw: rawCategory,
  };
}

function flattenChildTree(children, context) {
  const flattened = [];

  for (const child of children ?? []) {
    const normalized = normalizeCategoryNode(child, context);
    flattened.push(normalized);

    if (Array.isArray(child.children) && child.children.length) {
      flattened.push(...flattenChildTree(child.children, {
        parentId: normalized.id,
        topParentId: normalized.topParentId,
        depth: normalized.depth + 1,
        pathNames: normalized.pathNames,
      }));
    }
  }

  return flattened;
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

function buildCategoryMatch(query, category) {
  const normalizedQuery = normalizeText(query);
  const normalizedName = normalizeText(category.name);
  const normalizedPath = normalizeText(category.path);
  const queryTokens = tokenize(query).filter((token) => !STOP_TOKENS.has(token));
  const searchableText = [category.name, category.path].filter(Boolean).join(' ');
  const overlap = tokenOverlapScore(query, searchableText);
  const categoryTokens = new Set(tokenize(searchableText).filter((token) => !STOP_TOKENS.has(token)));
  const headTokenPresent = queryTokens.length ? categoryTokens.has(queryTokens[0]) : true;
  const exactNameMatch = Boolean(
    normalizedQuery && (
      normalizedName === normalizedQuery
      || normalizedPath === normalizedQuery
    )
  );
  const containsQuery = Boolean(
    normalizedQuery && (
      normalizedName.includes(normalizedQuery)
      || normalizedPath.includes(normalizedQuery)
      || normalizedQuery.includes(normalizedName)
    )
  );

  let score = overlap * 120;
  if (exactNameMatch) {
    score += 100;
  }
  if (containsQuery) {
    score += 45;
  }
  if (category.childrenCount === 0) {
    score += 12;
  }
  score += Math.min(20, category.depth * 4);
  if (!headTokenPresent) {
    score -= 110;
  }

  const confidence = Math.max(
    0.05,
    Math.min(
      0.99,
      0.2
        + overlap * 0.45
        + (exactNameMatch ? 0.2 : 0)
        + (containsQuery ? 0.1 : 0)
        + (category.childrenCount === 0 ? 0.05 : 0),
    ),
  );

  return {
    ...category,
    score,
    confidence: Math.max(0.05, headTokenPresent ? confidence : confidence - 0.25),
    scoreBreakdown: {
      overlap,
      exactNameMatch,
      containsQuery,
      headTokenPresent,
      depth: category.depth,
      childrenCount: category.childrenCount,
    },
  };
}

function toCachedCategoryNode(category) {
  return {
    id: category.id,
    name: category.name,
    parentId: category.parentId,
    topParentId: category.topParentId,
    depth: category.depth,
    pathNames: category.pathNames,
    path: category.path,
    itemCount: category.itemCount,
    isAdult: category.isAdult,
    childrenCount: category.childrenCount,
    raw: null,
  };
}

function normalizeCachedCategoryNode(rawCategory) {
  if (!rawCategory || typeof rawCategory !== 'object') {
    return null;
  }

  const pathNames = Array.isArray(rawCategory.pathNames)
    ? rawCategory.pathNames.filter(Boolean)
    : [rawCategory.name].filter(Boolean);

  const path = rawCategory.path ?? pathNames.join(' > ');

  return {
    id: Number(rawCategory.id ?? 0),
    name: rawCategory.name ?? null,
    parentId: rawCategory.parentId ?? null,
    topParentId: Number(rawCategory.topParentId ?? rawCategory.id ?? 0),
    depth: Number(rawCategory.depth ?? 0),
    pathNames,
    path,
    itemCount: rawCategory.itemCount ?? null,
    isAdult: Boolean(rawCategory.isAdult),
    childrenCount: Number(rawCategory.childrenCount ?? 0),
    raw: null,
  };
}

function getTreeCacheMeta(generatedAt, source, cacheTtlMs) {
  const generatedTime = generatedAt ? new Date(generatedAt).getTime() : Number.NaN;
  const ageMs = Number.isFinite(generatedTime) ? Math.max(0, Date.now() - generatedTime) : null;

  return {
    key: CATEGORY_TREE_STATE_KEY,
    source,
    generatedAt: generatedAt ?? null,
    ageMs,
    ttlMs: cacheTtlMs,
    fresh: ageMs === null ? false : ageMs <= cacheTtlMs,
  };
}

function readCachedCategoryTree(db, cacheTtlMs) {
  if (!db) {
    return null;
  }

  const cached = db.getState(CATEGORY_TREE_STATE_KEY, null);
  if (!cached || !Array.isArray(cached.categories)) {
    return null;
  }

  const categories = cached.categories
    .map((category) => normalizeCachedCategoryNode(category))
    .filter((category) => category && category.id > 0 && category.name);

  if (!categories.length) {
    return null;
  }

  return {
    generatedAt: cached.generatedAt ?? null,
    categories,
    cache: getTreeCacheMeta(cached.generatedAt ?? null, 'cache', cacheTtlMs),
  };
}

function writeCachedCategoryTree(db, tree) {
  if (!db) {
    return;
  }

  db.setState(CATEGORY_TREE_STATE_KEY, {
    generatedAt: tree.generatedAt,
    categories: tree.categories.map((category) => toCachedCategoryNode(category)),
  });
}

export function lookupCategoriesInTree({ tree, query, limit = 10, minScore = 0 } = {}) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    throw new Error('lookupCategoriesInTree requires a non-empty query.');
  }

  return (tree?.categories ?? [])
    .map((category) => buildCategoryMatch(query, category))
    .filter((category) => category.score > minScore)
    .sort((left, right) =>
      right.score - left.score
      || right.confidence - left.confidence
      || left.depth - right.depth
      || left.name.localeCompare(right.name, 'ru'))
    .slice(0, limit);
}

export function getCategoryById(tree, categoryId) {
  const numericId = Number(categoryId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return null;
  }

  return (tree?.categories ?? []).find((category) => Number(category.id) === numericId) ?? null;
}

export async function loadCategoryTree(api, {
  db = null,
  concurrency = 6,
  refresh = false,
  cacheTtlMs = DEFAULT_CATEGORY_CACHE_TTL_MS,
} = {}) {
  if (!api) {
    throw new Error('loadCategoryTree requires api.');
  }

  const cachedTree = !refresh ? readCachedCategoryTree(db, cacheTtlMs) : null;
  if (cachedTree?.cache?.fresh) {
    return cachedTree;
  }

  const parentResponse = await api.getParentCategories();
  const topCategories = (parentResponse?.data?.categories ?? []).map((rawCategory) =>
    normalizeCategoryNode(rawCategory, {
      parentId: null,
      topParentId: Number(rawCategory.id ?? rawCategory.categoryId ?? 0),
      depth: 0,
      pathNames: [],
    }),
  );

  const childrenResponses = await mapWithConcurrency(topCategories, concurrency, async (topCategory) => ({
    topCategory,
    response: await api.getAllCategoryChildren(topCategory.id),
  }));

  const categories = [];
  for (const { topCategory, response } of childrenResponses) {
    const children = response?.data?.children ?? [];
    categories.push({
      ...topCategory,
      childrenCount: children.length,
    });
    categories.push(...flattenChildTree(children, {
      parentId: topCategory.id,
      topParentId: topCategory.id,
      depth: 1,
      pathNames: [topCategory.name],
    }));
  }

  const tree = {
    generatedAt: new Date().toISOString(),
    categories,
  };
  writeCachedCategoryTree(db, tree);

  return {
    ...tree,
    cache: getTreeCacheMeta(tree.generatedAt, cachedTree ? 'refreshed' : 'network', cacheTtlMs),
  };
}

export async function lookupCategories({ api, db = null, query, limit = 10, refresh = false } = {}) {
  const tree = await loadCategoryTree(api, { db, refresh });
  const matches = lookupCategoriesInTree({ tree, query, limit });
  return {
    query,
    generatedAt: new Date().toISOString(),
    totalCategories: tree.categories.length,
    treeCache: tree.cache,
    matches,
  };
}
