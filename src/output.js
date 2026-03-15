import { formatOrderDetail, formatOrderSummary, formatOrdersList, printJson } from './format.js';

const PAYMENT_METHOD_NAMES = {
  1: 'Card',
  2: 'Cash',
};

function getPaymentMethod(order) {
  return order.paymentTypeName ?? PAYMENT_METHOD_NAMES[order.paymentMethod] ?? order.paymentMethod ?? null;
}

function formatAddressValue(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    const pieces = [
      value.city,
      value.street,
      value.buliding,
      value.building,
      value.address,
    ].filter(Boolean);

    if (pieces.length) {
      return [...new Set(pieces)].join(', ');
    }
  }

  return String(value);
}

function formatWeightText(item) {
  if (!item?.weight) {
    return null;
  }

  if (item.isKilogram || !item.weightMeasure || item.weightMeasure === 'NO') {
    return `${(item.weight / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} kg`;
  }

  return `${item.weight} ${String(item.weightMeasure).toLowerCase()}`;
}

function normalizeAddress(address) {
  if (!address) {
    return null;
  }

  if (typeof address === 'string') {
    return {
      full: address,
      city: null,
      street: address,
      building: null,
      entrance: null,
      floor: null,
      apartment: null,
    };
  }

  return {
    full: formatAddressValue(address),
    city: address.city ?? null,
    street: address.street ?? address.address ?? null,
    building: address.buliding ?? address.building ?? null,
    entrance: address.entrance ?? null,
    floor: address.floor ?? null,
    apartment: address.appartment ?? address.apartment ?? null,
  };
}

function normalizeBranch(branchAddress) {
  if (!branchAddress) {
    return null;
  }

  if (typeof branchAddress === 'string') {
    return {
      id: null,
      address: branchAddress,
      full: branchAddress,
    };
  }

  return {
    id: branchAddress.id ?? null,
    address: branchAddress.address ?? null,
    full: formatAddressValue(branchAddress),
  };
}

function getSourceType(order) {
  if (order.orderOriginType === 1 || (!order.id && order.offlineOrderId)) {
    return 'offline';
  }

  if (order.orderOriginType === 2 || Number(order.orderId ?? order.id) > 0) {
    return 'online';
  }

  return 'unknown';
}

function normalizeItem(item) {
  const weightText = formatWeightText(item);

  return {
    id: item.id ?? null,
    name: item.name ?? null,
    quantity: item.quantity ?? null,
    initialQuantity: item.initialQuantity ?? item.initialCount ?? null,
    totalPriceAmd: item.totalPrice ?? item.price ?? null,
    initialPriceAmd: item.initialPrice ?? null,
    unitPriceAmd: item.visiblePrice ?? null,
    isWeighted: Boolean(item.isKilogram || item.weight),
    weightGrams: item.weight || null,
    weightKg: item.weight ? item.weight / 1000 : null,
    weightText,
    categoryName: item.categoryName ?? null,
    sapCode: item.codeSap ?? null,
    note: item.note ?? null,
    isBag: Boolean(item.isBag),
  };
}

export function normalizeOrder(order) {
  const itemsFetched = Array.isArray(order.orderItems);
  const items = itemsFetched ? order.orderItems.map(normalizeItem) : [];
  const address = normalizeAddress(order.address);
  const branch = normalizeBranch(order.branchAddress);
  const orderId = order.orderId ?? order.id ?? null;
  const sourceType = getSourceType(order);
  const detailUnavailableReason =
    order.detailUnavailableReason
    ?? (sourceType === 'offline'
      ? 'This order appears to be offline/in-store. The public GetById API does not return item details for it.'
      : null);

  return {
    orderId: orderId === 0 ? 0 : orderId ? Number(orderId) : null,
    externalId: order.uniqueId ?? order.offlineOrderId ?? null,
    uniqueId: order.uniqueId ?? null,
    offlineOrderId: order.offlineOrderId ?? null,
    sourceType,
    detailsFetched: itemsFetched,
    detailUnavailableReason,
    statusCode: order.status ?? null,
    createdAt: order.createDate ?? null,
    finishedAt: order.finishDate ?? null,
    paymentMethodCode: order.paymentMethod ?? null,
    paymentMethod: getPaymentMethod(order),
    paymentTypeLogo: order.paymentTypeLogo ?? null,
    isDelivery: Boolean(order.isDelivery),
    address,
    branch,
    totalPriceAmd: order.totalPrice ?? null,
    totalToPayAmd: order.totalToPay ?? null,
    initialPriceAmd: order.initialPrice ?? null,
    deliveryFeeAmd: order.deliveryPrice ?? order.userDeliveryFee ?? null,
    serviceFeeAmd: order.serviceFee ?? null,
    driverTipAmountAmd: order.driverTipAmount ?? null,
    usedBonusAmountAmd: order.usedBonusAmount ?? null,
    totalBonusAmd: order.totalBonus ?? null,
    itemCount: itemsFetched ? items.length : null,
    items,
  };
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(escapeCsvValue).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(',')),
  ];

  return `${lines.join('\n')}\n`;
}

function summarizeItems(items) {
  if (!items.length) {
    return null;
  }

  return items
    .map((item) => {
      if (item.weightText) {
        return `${item.name} (${item.weightText})`;
      }

      return `${item.name} x${item.quantity ?? 1}`;
    })
    .join(' | ');
}

function ordersToCsv(normalizedOrders) {
  const rows = normalizedOrders.map((order) => ({
    order_id: order.orderId ?? '',
    external_id: order.externalId ?? '',
    unique_id: order.uniqueId ?? '',
    offline_order_id: order.offlineOrderId ?? '',
    source_type: order.sourceType ?? '',
    details_fetched: order.detailsFetched,
    detail_unavailable_reason: order.detailUnavailableReason ?? '',
    status_code: order.statusCode ?? '',
    created_at: order.createdAt ?? '',
    finished_at: order.finishedAt ?? '',
    payment_method_code: order.paymentMethodCode ?? '',
    payment_method: order.paymentMethod ?? '',
    is_delivery: order.isDelivery,
    total_price_amd: order.totalPriceAmd ?? '',
    total_to_pay_amd: order.totalToPayAmd ?? '',
    initial_price_amd: order.initialPriceAmd ?? '',
    delivery_fee_amd: order.deliveryFeeAmd ?? '',
    service_fee_amd: order.serviceFeeAmd ?? '',
    driver_tip_amount_amd: order.driverTipAmountAmd ?? '',
    used_bonus_amount_amd: order.usedBonusAmountAmd ?? '',
    total_bonus_amd: order.totalBonusAmd ?? '',
    address: order.address?.full ?? '',
    branch_id: order.branch?.id ?? '',
    branch_address: order.branch?.full ?? '',
    item_count: order.itemCount ?? '',
    item_names: order.items.map((item) => item.name).filter(Boolean).join(' | '),
    items_summary: summarizeItems(order.items) ?? '',
  }));

  return rows.length ? toCsv(rows) : '';
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function orderToMarkdown(order) {
  const heading = `## Order ${order.orderId ?? 'n/a'} (${order.externalId ?? 'n/a'})`;
  const lines = [
    heading,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Source type | ${escapeMarkdown(order.sourceType)} |`,
    `| Status | ${escapeMarkdown(order.statusCode ?? 'n/a')} |`,
    `| Created | ${escapeMarkdown(order.createdAt ?? 'n/a')} |`,
    `| Finished | ${escapeMarkdown(order.finishedAt ?? 'n/a')} |`,
    `| Payment | ${escapeMarkdown(order.paymentMethod ?? 'n/a')} |`,
    `| Delivery | ${escapeMarkdown(order.isDelivery ? 'yes' : 'no')} |`,
    `| Total price (AMD) | ${escapeMarkdown(order.totalPriceAmd ?? 'n/a')} |`,
    `| Total to pay (AMD) | ${escapeMarkdown(order.totalToPayAmd ?? 'n/a')} |`,
    `| Address | ${escapeMarkdown(order.address?.full ?? order.branch?.full ?? 'n/a')} |`,
    `| Details fetched | ${escapeMarkdown(order.detailsFetched ? 'yes' : 'no')} |`,
  ];

  if (order.detailUnavailableReason) {
    lines.push(`| Detail note | ${escapeMarkdown(order.detailUnavailableReason)} |`);
  }

  if (order.items.length) {
    lines.push(
      '',
      '### Items',
      '',
      '| Item | Quantity | Weight | Total (AMD) |',
      '| --- | --- | --- | --- |',
      ...order.items.map((item) =>
        `| ${escapeMarkdown(item.name ?? 'n/a')} | ${escapeMarkdown(item.quantity ?? 'n/a')} | ${escapeMarkdown(item.weightText ?? '')} | ${escapeMarkdown(item.totalPriceAmd ?? 'n/a')} |`,
      ),
    );
  } else if (order.detailUnavailableReason) {
    lines.push('', `_Items unavailable: ${escapeMarkdown(order.detailUnavailableReason)}_`);
  } else if (!order.detailsFetched) {
    lines.push('', '_Items not fetched. Re-run with `--details` to include line items._');
  }

  return lines.join('\n');
}

function ordersToMarkdown(normalizedOrders) {
  if (!normalizedOrders.length) {
    return '';
  }

  return `# Orders\n\n${normalizedOrders.map(orderToMarkdown).join('\n\n')}\n`;
}

function ordersToNdjson(orders) {
  if (!orders.length) {
    return '';
  }

  return `${orders.map((order) => JSON.stringify(order)).join('\n')}\n`;
}

export function renderOrdersOutput(input, options = {}) {
  const { format = 'text', raw = false } = options;
  const single = !Array.isArray(input);
  const orders = single ? [input] : input;

  if (!orders.length) {
    if (format === 'json') {
      return printJson(single ? null : []);
    }

    return format === 'text' ? 'No orders found.\n' : '';
  }

  if (raw && format !== 'json' && format !== 'ndjson') {
    throw new Error('`--raw` is only supported with `--format json` or `--format ndjson`.');
  }

  if (format === 'text') {
    if (single) {
      const order = orders[0];
      if (order.orderItems || order.detailUnavailableReason) {
        return `${formatOrderDetail(order, order)}\n`;
      }

      return `${formatOrderSummary(order)}\n`;
    }

    return `${formatOrdersList(orders)}\n`;
  }

  const normalizedOrders = raw ? orders : orders.map(normalizeOrder);

  switch (format) {
    case 'json':
      return printJson(single ? normalizedOrders[0] : normalizedOrders);
    case 'ndjson':
      return ordersToNdjson(normalizedOrders);
    case 'csv':
      return ordersToCsv(normalizedOrders);
    case 'md':
      return ordersToMarkdown(normalizedOrders);
    default:
      throw new Error(`Unsupported format "${format}".`);
  }
}
