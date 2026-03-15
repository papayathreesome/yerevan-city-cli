export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.details = details;
  }
}

export class YerevanCityApi {
  constructor(config) {
    this.config = config;
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://apishopv2.yerevan-city.am';
    this.marketplaceApiBaseUrl = config.marketplaceApiBaseUrl ?? 'https://marketplaceapi.yerevan-city.am';
  }

  buildHeaders(withJsonBody = false, extraHeaders = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.token}`,
      'content-language': String(this.config.defaults?.language ?? '2'),
      CityId: String(this.config.defaults?.cityId ?? ''),
      OsType: String(this.config.defaults?.osType ?? '3'),
      ...extraHeaders,
    };

    if (withJsonBody) {
      headers['Content-Type'] = 'application/json';
    }

    return headers;
  }

  async request(path, { method = 'GET', body, baseUrl = this.apiBaseUrl, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(body !== undefined, headers),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let parsed;

    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new ApiError(`API request failed with HTTP ${response.status}`, {
        status: response.status,
        body: parsed ?? text,
      });
    }

    if (parsed && parsed.success === false) {
      throw new ApiError(parsed.message ?? 'Yerevan City API returned a failure response.', {
        body: parsed,
      });
    }

    return parsed;
  }

  async marketplaceRequest(path, options = {}) {
    return this.request(path, {
      ...options,
      baseUrl: this.marketplaceApiBaseUrl,
    });
  }

  async getUserOrdersPaged({
    page = 1,
    count = 30,
    dateFrom = null,
    dateTo = null,
    orderOriginType = null,
    orderStatus = null,
  } = {}) {
    return this.request('/api/Order/UserAllOrdersPaged', {
      method: 'POST',
      body: {
        orderOriginType,
        orderStatus,
        dateTo,
        page,
        count,
        dateFrom,
      },
    });
  }

  async getOrderById(orderId) {
    return this.request(`/api/Order/GetById/${orderId}`);
  }

  async getAddresses() {
    return this.request('/api/Address/GetAll');
  }

  async searchProducts({
    search = '',
    page = 1,
    count = 20,
    priceFrom = null,
    priceTo = null,
    countries = [],
    categories = [],
    brands = [],
    isDiscounted = false,
    sortBy = 3,
  } = {}) {
    return this.request('/api/Product/Search', {
      method: 'POST',
      body: {
        count,
        page,
        priceFrom,
        priceTo,
        countries,
        categories,
        brands,
        search,
        isDiscounted,
        sortBy,
      },
    });
  }

  async getParentCategories() {
    return this.request('/api/Category/GetParentCategories', {
      method: 'POST',
      body: {},
    });
  }

  async getCategory(parentId) {
    return this.request('/api/Category/GetCategory', {
      method: 'POST',
      body: {
        parentId,
      },
    });
  }

  async getAllCategoryChildren(parentId) {
    return this.request('/api/Category/GetAllChildren', {
      method: 'POST',
      body: {
        parentId,
      },
    });
  }

  async getProductsByLastCategory({
    categoryId,
    parentId = categoryId,
    page = 1,
    count = 30,
    priceFrom = null,
    priceTo = null,
    countries = [],
    categories = [],
    brands = [],
    search = null,
    isDiscounted = false,
    sortBy = 3,
  } = {}) {
    return this.request('/api/Product/GetByLastCategory', {
      method: 'POST',
      body: {
        categoryId,
        count,
        page,
        priceFrom,
        priceTo,
        countries,
        categories,
        brands,
        search,
        parentId,
        isDiscounted,
        sortBy,
      },
    });
  }

  async getSuggestedProducts(productId) {
    return this.request(`/api/Product/GetSuggestedProducts/${productId}`);
  }

  async getCartCount() {
    return this.request('/api/Cart/GetItemsCount');
  }

  async getMarketplaceCartCount() {
    return this.marketplaceRequest('/api/app/v1/cart/count');
  }

  async getMarketplaceCartDetails() {
    return this.marketplaceRequest('/api/app/v1/cart/details');
  }

  async getCartItems({ lat, lng, isGreenLine = false } = {}) {
    return this.request('/api/Cart/GetCartItems', {
      method: 'POST',
      body: {
        lat,
        lng,
        isGreenLine,
      },
    });
  }

  async updateCartItem({
    addressId,
    id,
    quantity,
    weight = quantity,
    lat,
    lng,
    isGreenLine = false,
    note = '',
    cut = false,
    grind = false,
  }) {
    return this.request('/api/Cart/UpdateItems', {
      method: 'POST',
      body: {
        addressId,
        id,
        weight,
        quantity,
        note,
        cut,
        grind,
        lat,
        lng,
        isGreenLine,
      },
    });
  }
}
