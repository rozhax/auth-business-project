const path = require('path');
const Database = require('better-sqlite3');

const salesDb = new Database(path.join(__dirname, 'db', 'sales.db'));

// WAL mode: lets reads (accounting reports) and writes (new sales) happen
// concurrently without blocking each other 
salesDb.pragma('journal_mode = WAL');
//this is to connect both auth and salse but is doing nothing right now
salesDb.pragma('foreign_keys = ON');

salesDb.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name     TEXT NOT NULL,
    sold_price    NUMERIC(10, 2) NOT NULL CHECK (sold_price > 0 AND sold_price <= 999999.99),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card')),
    cashier_id    INTEGER NOT NULL,
    cashier_name  TEXT NOT NULL,
    customer_id   INTEGER,
    customer_name TEXT,
    sale_date     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  salesDb.exec(`ALTER TABLE sales ADD COLUMN customer_id INTEGER`);
} catch (e) {
  // column already exists
}
try {
  salesDb.exec(`ALTER TABLE sales ADD COLUMN customer_name TEXT`);
} catch (e) {
  // column already exists
}

salesDb.exec(`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (date(sale_date))`);
salesDb.exec(`CREATE INDEX IF NOT EXISTS idx_sales_cashier_date ON sales (cashier_id, date(sale_date))`);
salesDb.exec(`CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales (customer_id)`);

module.exports = salesDb;
