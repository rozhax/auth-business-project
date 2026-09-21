const path = require('path');
const Database = require('better-sqlite3');

// Loyalty lives in its own SQLite file, next to the auth and supplier
// databases, so a cashier's points bookkeeping never touches login or
// supply data.
const loy = new Database(path.join(__dirname, 'db', 'loyalty.db'));

// One row per loyalty customer (a shopper, not an app user). `points` is
// the spendable balance; `lifetime-points` only ever goes up, so redeeming
// a reward can never demote someone's tier. `tier` is denormalised from
// lifetime-points on every write so the UI can render it without recalculating.
loy.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    "lifetime-points" INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'bronze',
    "created-at" DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Append-only ledger of every earn/redeem, so a customer's balance can
// always be explained and traced back to the cashier who moved it.
loy.exec(`
  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "customer-id" INTEGER NOT NULL,
    "customer-name" TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('earn', 'redeem')),
    points INTEGER NOT NULL,
    note TEXT,
    "cashier-id" INTEGER,
    "cashier-name" TEXT,
    "created-at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("customer-id") REFERENCES customers(id)
  )
`);

// Tiers are driven by lifetime points earned, highest threshold first.
const TIERS = [
  { name: 'platinum', min: 1000 },
  { name: 'gold', min: 500 },
  { name: 'silver', min: 100 },
  { name: 'bronze', min: 0 }
];

// Suggested redemptions surfaced as one-click buttons on the cashier page.
const REWARDS = [
  { label: 'Free coffee', cost: 50 },
  { label: '$5 off purchase', cost: 100 },
  { label: '$15 off purchase', cost: 250 },
  { label: '$50 off purchase', cost: 750 }
];

const MAX_POINTS_PER_ACTION = 100000;

// Errors carry a status so the HTTP layer can answer 400 vs 404 without
// string-matching messages.
function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function tierFor(lifetimePoints) {
  const match = TIERS.find((t) => lifetimePoints >= t.min);
  return match ? match.name : 'bronze';
}

// Points come in from forms/fetch as strings, so normalise to a whole
// number and reject anything that would corrupt the balance.
function normalisePoints(raw) {
  const points = Number(raw);
  if (!Number.isInteger(points) || points <= 0) {
    throw fail(400, 'Points must be a whole number greater than 0.');
  }
  if (points > MAX_POINTS_PER_ACTION) {
    throw fail(400, `Points cannot exceed ${MAX_POINTS_PER_ACTION} in one go.`);
  }
  return points;
}

function getCustomer(id) {
  return loy.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function requireCustomer(rawId) {
  const id = Number(rawId);
  const customer = Number.isInteger(id) ? getCustomer(id) : undefined;
  if (!customer) throw fail(404, 'Customer not found.');
  return customer;
}

// Newest first, capped so a large loyalty list can't flood the page.
function getCustomers(search) {
  const term = (search || '').trim();
  if (!term) {
    return loy.prepare('SELECT * FROM customers ORDER BY id DESC LIMIT 100').all();
  }
  const like = `%${term}%`;
  return loy
    .prepare(`
      SELECT * FROM customers
      WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?
      ORDER BY id DESC
      LIMIT 100
    `)
    .all(like, like, like);
}

function addCustomer({ name, email, phone }) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw fail(400, 'Customer name is required.');

  const result = loy
    .prepare(`
      INSERT INTO customers (name, email, phone)
      VALUES (?, ?, ?)
    `)
    .run(trimmedName, (email || '').trim() || null, (phone || '').trim() || null);

  return getCustomer(result.lastInsertRowid);
}

function getTransactions(customerId) {
  return loy
    .prepare(`
      SELECT * FROM loyalty_transactions
      WHERE "customer-id" = ?
      ORDER BY id DESC
    `)
    .all(customerId);
}

// Shared write path for both movements: adjust the balance, recompute the
// tier, and append the ledger row inside one transaction so a crash can
// never leave points and history out of sync.
function recordMovement({ customerId, type, points, note, cashierId, cashierName }) {
  const customer = requireCustomer(customerId);

  if (type === 'redeem' && points > customer.points) {
    throw fail(400, `Not enough points: ${customer.name} has ${customer.points}.`);
  }

  const delta = type === 'earn' ? points : -points;
  // Redeeming spends the balance but leaves lifetime points alone, which is
  // what keeps the tier sticky.
  const lifetimeDelta = type === 'earn' ? points : 0;

  const apply = loy.transaction(() => {
    const nextPoints = customer.points + delta;
    const nextLifetime = customer['lifetime-points'] + lifetimeDelta;

    loy.prepare(`
      UPDATE customers
      SET points = ?, "lifetime-points" = ?, tier = ?
      WHERE id = ?
    `).run(nextPoints, nextLifetime, tierFor(nextLifetime), customer.id);

    loy.prepare(`
      INSERT INTO loyalty_transactions
        ("customer-id", "customer-name", type, points, note, "cashier-id", "cashier-name")
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      customer.id,
      customer.name,
      type,
      points,
      (note || '').trim() || null,
      cashierId || null,
      cashierName || null
    );

    return getCustomer(customer.id);
  });

  return apply();
}

function earnPoints({ customerId, points, note, cashierId, cashierName }) {
  return recordMovement({
    customerId,
    type: 'earn',
    points: normalisePoints(points),
    note,
    cashierId,
    cashierName
  });
}

function redeemPoints({ customerId, points, note, cashierId, cashierName }) {
  return recordMovement({
    customerId,
    type: 'redeem',
    points: normalisePoints(points),
    note,
    cashierId,
    cashierName
  });
}

module.exports = {
  db: loy,
  TIERS,
  REWARDS,
  tierFor,
  addCustomer,
  getCustomer,
  getCustomers,
  getTransactions,
  earnPoints,
  redeemPoints
};
