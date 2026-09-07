const path = require('path');
const Database = require('better-sqlite3');

const sp = new Database(path.join(__dirname, 'db', 'supplier.db'));

// Rename the old (empty) "sup" table to "suppliers" if it still exists from
// an earlier version of this file, and fix the "supply-catagory" typo.


sp.exec(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "supplier-name" TEXT NOT NULL,
    "supply-label" TEXT NOT NULL,
    "supply-type" TEXT NOT NULL,
    "supply-category" TEXT NOT NULL,
    "supply-count" NUMERIC(5, 2) NOT NULL DEFAULT 0,
    "date-of-delivery" DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Insert a new supply record. Accepts camelCase keys so server.js stays
// readable; maps them onto the hyphenated column names in the db.
function addSupply({ supplierName, supplyLabel, supplyType, supplyCategory, supplyCount, dateOfDelivery }) {
  return sp.prepare(`
    INSERT INTO suppliers
      ("supplier-name", "supply-label", "supply-type", "supply-category", "supply-count", "date-of-delivery")
    VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(supplierName, supplyLabel, supplyType, supplyCategory, supplyCount, dateOfDelivery || null);
}

// Fetch every supply row, most recent first, for the storage-manager page.
function getAllSupplies() {
  return sp.prepare('SELECT * FROM suppliers ORDER BY id DESC').all();
}

module.exports = { supplierbd: sp, addSupply, getAllSupplies };
