const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'db', 'loyalty.db'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    password TEXT NOT NULL,
    points_balance INTEGER NOT NULL DEFAULT 0 CHECK(points_balance >= 0),
    tier TEXT NOT NULL DEFAULT 'bronze' CHECK(tier IN ('bronze','silver','gold')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT UNIQUE,
    category TEXT,
    price NUMERIC(10,2) NOT NULL CHECK(price >= 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    cashier_name TEXT NOT NULL,
    subtotal NUMERIC(10,2) NOT NULL,
    discount NUMERIC(10,2) NOT NULL DEFAULT 0,
    total NUMERIC(10,2) NOT NULL,
    points_earned INTEGER NOT NULL DEFAULT 0,
    points_redeemed INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL,
    line_total NUMERIC(10,2) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    sale_id INTEGER REFERENCES sales(id),
    type TEXT NOT NULL CHECK(type IN ('earn','redeem','adjust','signup_bonus')),
    points INTEGER NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---- loyalty program rules (tweak here, nowhere else) ----------------------
const EARN_RATE = 1;        // 1 point per $1 of the *paid* total
const REDEEM_BLOCK = 100;   // points must be redeemed in blocks of 100
const REDEEM_VALUE = 1;     // 100 points = $1 off

// ---- prepared statements ----------------------------------------------------
const stmt = {
  insertCustomer: db.prepare(
    `INSERT INTO customers (name, email, phone, password) VALUES (?, ?, ?, ?)`
  ),
  findCustomerByEmail: db.prepare(`SELECT * FROM customers WHERE email = ?`),
  findCustomerById: db.prepare(`SELECT * FROM customers WHERE id = ?`),
  updateBalance: db.prepare(
    `UPDATE customers SET points_balance = points_balance + ? WHERE id = ?`
  ),
  insertLedger: db.prepare(
    `INSERT INTO points_ledger (customer_id, sale_id, type, points, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  ledgerForCustomer: db.prepare(
    `SELECT * FROM points_ledger WHERE customer_id = ? ORDER BY created_at DESC, id DESC`
  ),
  allCustomers: db.prepare(
    `SELECT id, name, email, phone, points_balance, tier, created_at FROM customers ORDER BY created_at DESC`
  ),

  insertProduct: db.prepare(
    `INSERT INTO products (name, sku, category, price) VALUES (?, ?, ?, ?)`
  ),
  allProducts: db.prepare(`SELECT * FROM products ORDER BY name ASC`),
  findProductById: db.prepare(`SELECT * FROM products WHERE id = ?`),

  insertSale: db.prepare(
    `INSERT INTO sales (customer_id, cashier_name, subtotal, discount, total, points_earned, points_redeemed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  insertSaleItem: db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, line_total)
     VALUES (?, ?, ?, ?, ?)`
  ),
  salesForCustomer: db.prepare(
    `SELECT * FROM sales WHERE customer_id = ? ORDER BY created_at DESC`
  ),
};

// ---- customer accounts -------------------------------------------------------

function createCustomer(name, email, phone, hashedPassword) {
  const info = stmt.insertCustomer.run(name, email, phone || null, hashedPassword);
  // small welcome bonus, recorded through the ledger like everything else
  const customerId = info.lastInsertRowid;
  recordPoints(customerId, 'signup_bonus', 50, null, 'Welcome bonus', 'system');
  return customerId;
}

function findCustomerByEmail(email) {
  return stmt.findCustomerByEmail.get(email);
}

function findCustomerById(id) {
  return stmt.findCustomerById.get(id);
}

function getLedger(customerId) {
  return stmt.ledgerForCustomer.all(customerId);
}

function getAllCustomers() {
  return stmt.allCustomers.all();
}

function getSalesForCustomer(customerId) {
  return stmt.salesForCustomer.all(customerId);
}

// ---- points ledger (atomic, auditable) ---------------------------------------

/**
 * Writes one ledger row and updates the cached balance, atomically.
 * type: 'earn' | 'redeem' | 'adjust' | 'signup_bonus'
 * points: always a non-negative integer >= 1 (the sign is implied by `type`,
 *          except 'adjust' which may carry a caller-supplied signed delta).
 */
const recordPoints = db.transaction((customerId, type, points, saleId, note, createdBy) => {
  const customer = stmt.findCustomerById.get(customerId);
  if (!customer) throw new Error('Customer not found');

  let delta;
  if (type === 'earn' || type === 'signup_bonus') {
    if (!Number.isInteger(points) || points <= 0) throw new Error('Invalid points amount');
    delta = points;
  } else if (type === 'redeem') {
    if (!Number.isInteger(points) || points <= 0) throw new Error('Invalid points amount');
    if (points % REDEEM_BLOCK !== 0) throw new Error(`Redemptions must be in blocks of ${REDEEM_BLOCK}`);
    if (customer.points_balance < points) throw new Error('Insufficient points balance');
    delta = -points;
  } else if (type === 'adjust') {
    if (!Number.isInteger(points)) throw new Error('Invalid points amount');
    if (customer.points_balance + points < 0) throw new Error('Adjustment would make balance negative');
    delta = points;
  } else {
    throw new Error('Invalid ledger type');
  }

  // Ledger stores the signed delta directly for 'adjust' (since its direction
  // isn't implied by the type the way earn/redeem/signup_bonus are), and the
  // plain magnitude otherwise.
  const ledgerPoints = type === 'adjust' ? points : Math.abs(points);
  stmt.insertLedger.run(customerId, saleId || null, type, ledgerPoints, note || null, createdBy || null);
  stmt.updateBalance.run(delta, customerId);
});

// ---- product catalog -----------------------------------------------------------

function addProduct(name, sku, category, price) {
  if (!name || typeof price !== 'number' || price < 0) {
    throw new Error('Invalid product data');
  }
  return stmt.insertProduct.run(name, sku || null, category || null, price).lastInsertRowid;
}

function getAllProducts() {
  return stmt.allProducts.all();
}

// ---- checkout: the connection between customer <-> products <-> points --------

/**
 * Processes a full point-of-sale transaction in one atomic step:
 *   1. Prices every line item from the trusted `products` table (never trust
 *      client-submitted prices).
 *   2. Optionally redeems the customer's points for a discount.
 *   3. Records the sale + line items.
 *   4. Awards points on the *net* amount actually paid.
 *
 * items: [{ productId, quantity }]
 * redeemPoints: integer, multiple of REDEEM_BLOCK, or 0
 */
const processSale = db.transaction(({ customerId, cashierName, items, redeemPoints }) => {
  if (!Array.isArray(items) || items.length === 0) throw new Error('No items in sale');
  if (!cashierName) throw new Error('Missing cashier identity');

  let subtotal = 0;
  const priced = items.map((it) => {
    const qty = parseInt(it.quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Invalid quantity');
    const product = stmt.findProductById.get(it.productId);
    if (!product) throw new Error(`Unknown product id ${it.productId}`);
    const lineTotal = Math.round(product.price * qty * 100) / 100;
    subtotal += lineTotal;
    return { product, qty, lineTotal };
  });
  subtotal = Math.round(subtotal * 100) / 100;

  let discount = 0;
  const redeem = parseInt(redeemPoints, 10) || 0;
  if (redeem > 0) {
    if (!customerId) throw new Error('Cannot redeem points without a customer on the sale');
    if (redeem % REDEEM_BLOCK !== 0) throw new Error(`Redemptions must be in blocks of ${REDEEM_BLOCK}`);
    discount = Math.round((redeem / REDEEM_BLOCK) * REDEEM_VALUE * 100) / 100;
    if (discount > subtotal) throw new Error('Discount cannot exceed subtotal');
  }

  const total = Math.round((subtotal - discount) * 100) / 100;
  const pointsEarned = customerId ? Math.floor(total * EARN_RATE) : 0;

  const saleInfo = stmt.insertSale.run(
    customerId || null, cashierName, subtotal, discount, total, pointsEarned, redeem
  );
  const saleId = saleInfo.lastInsertRowid;

  for (const p of priced) {
    stmt.insertSaleItem.run(saleId, p.product.id, p.qty, p.product.price, p.lineTotal);
  }

  // Redeem first (checks against the pre-sale balance), then award new points.
  if (redeem > 0) {
    recordPoints(customerId, 'redeem', redeem, saleId, 'Redeemed at checkout', cashierName);
  }
  if (pointsEarned > 0) {
    recordPoints(customerId, 'earn', pointsEarned, saleId, 'Purchase', cashierName);
  }

  return { saleId, subtotal, discount, total, pointsEarned, pointsRedeemed: redeem };
});

module.exports = {
  db,
  EARN_RATE,
  REDEEM_BLOCK,
  REDEEM_VALUE,
  createCustomer,
  findCustomerByEmail,
  findCustomerById,
  getLedger,
  getAllCustomers,
  getSalesForCustomer,
  recordPoints,
  addProduct,
  getAllProducts,
  processSale,
};