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

function formatMoney(value) {
  if (value === null || value === undefined || value === '') {
    return 'n/a';
  }

  const amount = Number(value);
  if (Number.isNaN(amount)) {
    return `${value} AMD`;
  }

  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} AMD`;
}

function formatAddress(value) {
  if (!value) {
    return 'n/a';
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

function formatPayment(order) {
  const paymentMethodNames = {
    1: 'Card',
    2: 'Cash',
  };

  return order.paymentTypeName ?? paymentMethodNames[order.paymentMethod] ?? order.paymentMethod ?? 'n/a';
}

function formatWeight(item) {
  if (!item.weight) {
    return null;
  }

  if (item.isKilogram || !item.weightMeasure || item.weightMeasure === 'NO') {
    const kilograms = item.weight / 1000;
    return `${kilograms.toLocaleString('en-US', { maximumFractionDigits: 3 })} kg`;
  }

  return `${item.weight} ${String(item.weightMeasure).toLowerCase()}`;
}

function summarizeOrderMeta(order) {
  return [
    `Status: ${order.status ?? 'n/a'}`,
    `Created: ${formatDate(order.createDate)}`,
    `Finished: ${formatDate(order.finishDate)}`,
    `Total: ${formatMoney(order.totalToPay ?? order.totalPrice)}`,
    `Payment: ${formatPayment(order)}`,
    `Delivery: ${order.isDelivery ? 'yes' : 'no'}`,
    `Address: ${formatAddress(order.address ?? order.branchAddress)}`,
    `Unique ID: ${order.uniqueId ?? order.offlineOrderId ?? 'n/a'}`,
  ];
}

function formatOrderItems(items = []) {
  if (!items.length) {
    return ['Items: none returned by API'];
  }

  return [
    'Items:',
    ...items.map((item) => {
      const quantity = item.quantity ?? item.initialQuantity ?? item.initialCount ?? 1;
      const price = item.totalPrice ?? item.price;
      const weight = formatWeight(item);

      if (weight) {
        return `  - ${item.name} (${weight}) (${formatMoney(price)})`;
      }

      return `  - ${item.name} x${quantity} (${formatMoney(price)})`;
    }),
  ];
}

export function formatLoginResult(config, redactedToken) {
  return [
    `Saved session to ${config.source?.configPath ?? 'config file'}`,
    `Browser: ${config.source?.browser ?? 'n/a'} (${config.source?.profile ?? 'n/a'})`,
    `Token: ${redactedToken}`,
    `Expires: ${config.tokenMeta?.expiresAt ? formatDate(config.tokenMeta.expiresAt) : 'unknown'}`,
    `Language: ${config.defaults?.language ?? 'n/a'}`,
    `City ID: ${config.defaults?.cityId ?? 'n/a'}`,
    `Address ID: ${config.defaults?.addressId ?? 'n/a'}`,
  ].join('\n');
}

export function formatOrderSummary(order) {
  const heading = `Order ${order.id ?? 'n/a'} (${order.uniqueId ?? order.offlineOrderId ?? 'no external id'})`;
  return [heading, ...summarizeOrderMeta(order)].join('\n');
}

export function formatOrderDetail(order, extra = {}) {
  const heading = `Order ${order.orderId ?? order.id ?? 'n/a'} (${order.uniqueId ?? order.offlineOrderId ?? 'no external id'})`;
  const totals = [
    `Initial price: ${formatMoney(order.initialPrice)}`,
    `Delivery fee: ${formatMoney(order.deliveryPrice ?? order.userDeliveryFee)}`,
    `Service fee: ${formatMoney(order.serviceFee)}`,
    `Driver tip: ${formatMoney(order.driverTipAmount)}`,
    `Bonus used: ${formatMoney(order.usedBonusAmount)}`,
    `Total to pay: ${formatMoney(order.totalToPay ?? order.totalPrice)}`,
  ];

  const deleted = order.deletedItems?.length
    ? ['Deleted items:', ...order.deletedItems.map((item) => `  - ${item.name} x${item.quantity ?? 1}`)]
    : [];

  const unavailable = extra.detailUnavailableReason ? [`Detail note: ${extra.detailUnavailableReason}`] : [];
  const items = order.orderItems?.length
    ? formatOrderItems(order.orderItems)
    : extra.detailUnavailableReason
      ? ['Items: unavailable via API for this order type']
      : formatOrderItems(order.orderItems);

  return [
    heading,
    ...summarizeOrderMeta(order),
    ...totals,
    ...items,
    ...deleted,
    ...unavailable,
  ].join('\n');
}

export function formatOrdersList(orders) {
  return orders
    .map((order) => (order.orderItems || order.detailUnavailableReason ? formatOrderDetail(order, order) : formatOrderSummary(order)))
    .join('\n\n');
}

export function printJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
