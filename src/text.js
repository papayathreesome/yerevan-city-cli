const GENERIC_UNIT_TOKENS = new Set([
  'г',
  'гр',
  'кг',
  'kg',
  'л',
  'л.',
  'ml',
  'мл',
  'шт',
  'шт.',
  'pcs',
  'pc',
  'уп',
  'уп.',
  'pack',
  'бут',
  'бут.',
]);

const GENERIC_DESCRIPTOR_TOKENS = new Set([
  'жир',
  'жирн',
  'проц',
  'процент',
  'new',
  'xl',
  'xlarge',
  'large',
  'medium',
  'small',
]);

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/["'`«»()[\]{}]/g, ' ')
    .replace(/[.,/#!$%^&*;:{}=_~?@+<>\\|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

export function simplifyProductName(value) {
  const tokens = tokenize(value).filter((token) => {
    if (!token) {
      return false;
    }

    if (/^\d+(?:[.,]\d+)?$/.test(token)) {
      return false;
    }

    if (/^\d+(?:[.,]\d+)?(?:г|гр|кг|kg|л|л\.|ml|мл|шт|pcs|pc)$/.test(token)) {
      return false;
    }

    if (/^\d+(?:[.,]\d+)?%$/.test(token)) {
      return false;
    }

    if (GENERIC_UNIT_TOKENS.has(token) || GENERIC_DESCRIPTOR_TOKENS.has(token)) {
      return false;
    }

    return true;
  });

  return tokens.join(' ').trim();
}

export function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function extractAliasesFromItem(item) {
  return uniqueStrings([
    item?.name,
    item?.nameRu,
    item?.nameEn,
    item?.canonicalName,
    item?.categoryName,
    simplifyProductName(item?.name),
    simplifyProductName(item?.nameRu),
    simplifyProductName(item?.nameEn),
    simplifyProductName(item?.categoryName),
  ]);
}

export function guessConceptKey(itemOrText) {
  if (!itemOrText) {
    return '';
  }

  if (typeof itemOrText === 'string') {
    const simplified = simplifyProductName(itemOrText);
    const tokens = tokenize(simplified);
    return tokens.slice(0, Math.min(tokens.length, 3)).join(' ');
  }

  const nameTokens = tokenize(simplifyProductName(itemOrText.name ?? itemOrText.nameRu ?? itemOrText.nameEn ?? ''));
  const categoryTokens = tokenize(simplifyProductName(itemOrText.categoryName ?? ''));

  if (categoryTokens.length && nameTokens.length && categoryTokens[0] === nameTokens[0]) {
    return categoryTokens.slice(0, Math.min(categoryTokens.length, 3)).join(' ');
  }

  return nameTokens.slice(0, Math.min(nameTokens.length, 3)).join(' ');
}

export function titleCase(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
    .join(' ');
}

export function parseExplicitQuantity(line) {
  const text = normalizeText(line);

  const weightMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|г|гр|g)\b/);
  if (weightMatch) {
    const rawValue = Number.parseFloat(weightMatch[1].replace(',', '.'));
    const unit = weightMatch[2];
    const weightGrams = unit === 'кг' || unit === 'kg' ? Math.round(rawValue * 1000) : Math.round(rawValue);
    return {
      kind: 'weight',
      quantity: null,
      weightGrams,
      matchedText: weightMatch[0],
    };
  }

  const countMatch = text.match(/(?:^|\s)(\d+)\s*(шт|pcs|pc|бут|бут\.|банк|банки|pack|уп|уп\.)?\b/);
  if (countMatch) {
    return {
      kind: 'count',
      quantity: Number.parseInt(countMatch[1], 10),
      weightGrams: null,
      matchedText: countMatch[0].trim(),
    };
  }

  return null;
}

export function splitShoppingList(sourceText) {
  return String(sourceText ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
    .filter(Boolean);
}

export function splitLineIntoClauses(line) {
  return uniqueStrings(
    String(line ?? '')
      .split(/[;,]/)
      .map((part) => part.trim()),
  );
}

export function expandSharedHeadClause(clause) {
  const normalized = String(clause ?? '').trim();
  const match = normalized.match(/^(.+?)\s+([^\s]+)\s+и\s+([^\s]+)$/i);

  if (!match) {
    return [normalized];
  }

  const [, head, left, right] = match;
  if (tokenize(head).length > 3) {
    return [normalized];
  }

  return uniqueStrings([`${head} ${left}`, `${head} ${right}`]);
}
