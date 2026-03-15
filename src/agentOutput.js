function formatDate(value) {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatAmd(value) {
  if (value === null || value === undefined) {
    return 'n/a';
  }

  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })} AMD`;
}

function formatStock(candidate) {
  if (candidate.isWeighted) {
    return `${Number(candidate.availableWeight ?? 0).toLocaleString('en-US')} g`;
  }

  return `${Number(candidate.availableCount ?? 0).toLocaleString('en-US')} pcs`;
}

export function renderSyncResultText(result) {
  return [
    `Mode: ${result.mode}`,
    `Started: ${formatDate(result.startedAt)}`,
    `Finished: ${formatDate(result.finishedAt)}`,
    `Pages fetched: ${result.pagesFetched}`,
    `Orders scanned: ${result.scannedOrders}`,
    `Orders saved: ${result.savedOrders}`,
    `New orders: ${result.newOrders}`,
    `Details fetched: ${result.detailFetches}`,
    `Detail failures: ${result.detailFailures}`,
    `Known items: ${result.itemStatsCount}`,
    `Known concepts: ${result.conceptCount}`,
  ].join('\n');
}

export function renderConceptLookupText(result) {
  if (!result.concepts.length) {
    return `No concept matches for "${result.query}".\n`;
  }

  return `${result.concepts.map((concept) => [
    `${concept.displayName} [${concept.conceptKey}]`,
    `  Orders: ${concept.totalOrders}`,
    `  Items: ${concept.itemCount}`,
    `  Last ordered: ${formatDate(concept.lastOrderedAt)}`,
    ...concept.topItems.slice(0, 3).map((item) => `  - ${item.canonicalName} (orders: ${item.totalOrders}, typical: ${item.isWeighted ? `${item.typicalWeightGrams ?? 'n/a'} g` : item.typicalQuantity ?? 'n/a'})`),
  ].join('\n')).join('\n\n')}\n`;
}

export function renderCategoryLookupText(result) {
  if (!result.matches.length) {
    return `No category matches for "${result.query}".\n`;
  }

  return `${result.matches.map((category, index) => [
    `${index + 1}. ${category.name} (#${category.id})`,
    `   Path: ${category.path}`,
    `   Score: ${category.score.toFixed(1)} | Confidence: ${category.confidence.toFixed(2)}`,
    `   Parent: ${category.parentId ?? 'root'} | Children: ${category.childrenCount}`,
    `   Adult: ${category.isAdult ? 'yes' : 'no'}`,
  ].join('\n')).join('\n\n')}\n`;
}

export function renderItemLookupText(result) {
  const descriptorParts = [];
  if (result.query) {
    descriptorParts.push(`query "${result.query}"`);
  }
  if (result.categoryIds?.length) {
    descriptorParts.push(`category filters [${result.categoryIds.join(', ')}]`);
  }
  const descriptor = descriptorParts.length ? ` for ${descriptorParts.join(' + ')}` : '';

  if (!result.candidates.length) {
    return `No live item matches${descriptor}.\n`;
  }

  const headerLines = [];
  if (result.query) {
    headerLines.push(`Query: ${result.query}`);
  }
  if (result.categoryIds?.length) {
    headerLines.push(`Category filters: ${result.categoryIds.join(', ')}`);
  }
  const header = headerLines.length ? `${headerLines.join('\n')}\n\n` : '';

  return `${header}${result.candidates.map((candidate, index) => [
    `${index + 1}. ${candidate.name} (#${candidate.productId})`,
    `   Score: ${candidate.score.toFixed(1)} | Confidence: ${candidate.confidence.toFixed(2)}`,
    `   Stock: ${formatStock(candidate)} | Price: ${formatAmd(candidate.price)}`,
    `   Category: ${candidate.categoryName ?? 'n/a'}`,
    candidate.itemStats
      ? `   History: ${candidate.itemStats.totalOrders} orders, typical ${candidate.isWeighted ? `${candidate.itemStats.typicalWeightGrams ?? 'n/a'} g` : candidate.itemStats.typicalQuantity ?? 'n/a'}`
      : '   History: no prior order record',
  ].join('\n')).join('\n\n')}\n`;
}

export function renderPlanText(plan) {
  const header = [
    `Plan ID: ${plan.planId}`,
    `Created: ${formatDate(plan.createdAt)}`,
    `Status: ${plan.status}`,
    `Resolved lines: ${plan.resolvedCount}/${plan.lineCount}`,
    '',
  ];

  const body = plan.lines.map((line, index) => {
    const selected = line.selectedItems?.length
      ? line.selectedItems.map((item) => `  - ${item.name} (#${item.productId}) x${item.quantityLabel ?? item.quantity ?? 1}`).join('\n')
      : '  - none';
    const alternatives = line.alternatives?.length
      ? line.alternatives.slice(0, 3).map((item) => `  - ${item.name} (#${item.productId})`).join('\n')
      : '  - none';
    const notes = line.notes?.length
      ? line.notes.map((note) => `  - ${note}`).join('\n')
      : '  - none';

    return [
      `${index + 1}. ${line.sourceLine}`,
      `   Status: ${line.status} | Confidence: ${Number(line.confidence ?? 0).toFixed(2)}`,
      `   Selected:`,
      selected,
      `   Alternatives:`,
      alternatives,
      `   Notes:`,
      notes,
    ].join('\n');
  });

  return `${header.concat(body).join('\n')}\n`;
}

export function renderApplyResultText(result) {
  const finalItems = result.finalCart?.items ?? [];

  return [
    `Plan ID: ${result.planId}`,
    `Applied at: ${formatDate(result.appliedAt)}`,
    `Replace mode: ${result.replaceMode ? 'yes' : 'no'}`,
    `Removed existing cart lines: ${result.removedExistingItems}`,
    `Applied planned lines: ${result.appliedItems.length}`,
    `Skipped planned lines: ${result.skippedItems.length}`,
    `Final cart lines: ${finalItems.length}`,
    `Final cart total: ${formatAmd(result.finalCart?.totalPrice)}`,
    '',
    ...result.appliedItems.map((item) => `  - applied ${item.name} (#${item.productId}) ${item.isWeighted ? `${item.weightGrams} g` : `x${item.quantity}`}${item.trimmed ? ' [trimmed]' : ''}`),
    ...result.skippedItems.map((item) => `  - skipped ${item.name} (#${item.productId}): ${item.reason}`),
  ].join('\n');
}

export function renderBasketText(result) {
  const items = result.cart?.items ?? [];
  const lines = [
    `Cart lines: ${items.length}`,
    `Total: ${formatAmd(result.cart?.totalPrice)}`,
    `Delivery fee: ${formatAmd(result.cart?.deliveryFee)}`,
    `Service fee: ${formatAmd(result.cart?.serviceFee)}`,
    '',
  ];

  if (!items.length) {
    lines.push('Cart is empty.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    ...items.map((item) =>
      `  - ${item.name} (#${item.id}) ${item.isKilogram ? `${item.weight} g` : `x${item.count}`}`,
    ),
  );

  return `${lines.join('\n')}\n`;
}

export function renderBasketWriteText(result) {
  return [
    `Replace mode: ${result.replaceMode ? 'yes' : 'no'}`,
    `Removed existing lines: ${result.removedExistingItems}`,
    `Attempted items: ${result.attemptedItems}`,
    `Applied items: ${result.appliedItems.length}`,
    `Skipped items: ${result.skippedItems.length}`,
    `Final cart lines: ${result.cart?.items?.length ?? 0}`,
    `Final total: ${formatAmd(result.cart?.totalPrice)}`,
    '',
    ...result.appliedItems.map((item) => `  - applied ${item.name} (#${item.productId}) ${item.isWeighted ? `${item.weightGrams} g` : `x${item.quantity}`}${item.trimmed ? ' [trimmed]' : ''}`),
    ...result.skippedItems.map((item) => `  - skipped #${item.productId}: ${item.reason}`),
  ].join('\n');
}

export function renderBasketClearText(result) {
  return [
    `Cleared lines: ${result.clearedCount}`,
    `Final cart lines: ${result.cart?.items?.length ?? 0}`,
    `Final total: ${formatAmd(result.cart?.totalPrice)}`,
  ].join('\n');
}

export function renderOverridesText(overrides) {
  if (!overrides.length) {
    return 'No overrides saved.\n';
  }

  return `${overrides.map((override) => [
    `#${override.id} ${override.mode.toUpperCase()} "${override.queryText}"`,
    `  Product ID: ${override.productId ?? 'n/a'}`,
    `  Item key: ${override.itemKey ?? 'n/a'}`,
    `  Quantity: ${override.quantity ?? 'n/a'}`,
    `  Weight: ${override.weightGrams ?? 'n/a'}`,
    `  Note: ${override.note ?? 'n/a'}`,
    `  Updated: ${formatDate(override.updatedAt)}`,
  ].join('\n')).join('\n\n')}\n`;
}
