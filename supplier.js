const path = require('path');
const Database = require('better-sqlite3');

const sp = new Database(path.join(__dirname, 'db', 'supplier.db'));

// Main supplies table. Each row is tagged with who created it
// ("created-by-id" / "created-by-name") so the storage-manager page
// can filter to "only what I added".
sp.exec(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "supplier-name" TEXT NOT NULL,
    "supplier-phone" TEXT NOT NULL,
    "supplier-email" TEXT NOT NULL,
    "supply-label" TEXT NOT NULL,
    "supply-type" TEXT NOT NULL,
    "supply-category" TEXT NOT NULL,
    "measurement-type" TEXT NOT NULL,
    "supply-count" NUMERIC(5, 2) NOT NULL DEFAULT 0,
    "supply-price" NUMERIC(10, 2) NOT NULL DEFAULT 0,
    "date-of-delivery" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "created-by-id" INTEGER NOT NULL,
    "created-by-name" TEXT NOT NULL
  )
`);

try { sp.exec(`ALTER TABLE suppliers ADD COLUMN "supplier-phone" TEXT`); } catch (e) {}
try { sp.exec(`ALTER TABLE suppliers ADD COLUMN "supplier-email" TEXT`); } catch (e) {}
try { sp.exec(`ALTER TABLE suppliers ADD COLUMN "measurement-type" TEXT`); } catch (e) {}

// Per-user work history / audit log. Every meaningful action
// (right now: adding a supply) gets a row here.
sp.exec(`
  CREATE TABLE IF NOT EXISTS work_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "user-id" INTEGER NOT NULL,
    "user-name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "created-at" DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Insert a new supply record, tagged with who added it, and log it
// to work_history. Accepts camelCase keys so server.js stays readable;
// maps them onto the hyphenated column names in the db.
function addSupply({
  supplierName,
  supplierPhone,
  supplierEmail,
  supplyLabel,
  supplyType,
  supplyCategory,
  measurementType,
  supplyCount,
  supplyPrice,
  dateOfDelivery,
  userId,
  userName
}) {
  const result = sp.prepare(`
    INSERT INTO suppliers
      ("supplier-name", "supplier-phone", "supplier-email",
       "supply-label", "supply-type", "supply-category",
       "measurement-type", "supply-count", "supply-price",
       "date-of-delivery", "created-by-id", "created-by-name")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    supplierName,
    supplierPhone,
    supplierEmail,
    supplyLabel,
    supplyType,
    supplyCategory,
    measurementType,
    supplyCount,
    supplyPrice,
    dateOfDelivery,
    userId,
    userName
  );

  logHistory({
    userId,
    userName,
    action: 'added supply',
    details: `${supplierName} — ${supplyLabel} (${supplyCategory}) x${supplyCount} @ $${supplyPrice}`
  });

  return result;
}

// Only the supplies the given user added (used to scope the
// storage-manager page to "my supplies" instead of everyone's).
function getSuppliesByUser(userId) {
  return sp.prepare(
    'SELECT * FROM suppliers WHERE "created-by-id" = ? ORDER BY id DESC'
  ).all(userId);
}

// Every supply, regardless of who added it (e.g. for a future
// store-owner oversight view).
function getAllSupplies() {
  return sp.prepare('SELECT * FROM suppliers ORDER BY id DESC').all();
}

// Record an action in the work history log.
function logHistory({ userId, userName, action, details }) {
  return sp.prepare(`
    INSERT INTO work_history ("user-id", "user-name", "action", "details")
    VALUES (?, ?, ?, ?)
  `).run(userId, userName, action, details || null);
}

// One user's history, most recent first.
function getHistoryByUser(userId) {
  return sp.prepare(
    'SELECT * FROM work_history WHERE "user-id" = ? ORDER BY id DESC'
  ).all(userId);
}

module.exports = {
  db: sp,
  addSupply,
  getSuppliesByUser,
  getAllSupplies,
  logHistory,
  getHistoryByUser
};