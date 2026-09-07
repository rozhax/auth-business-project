const path = require('path');
const Database = require('better-sqlite3');

const sp = new Database(path.join(__dirname, 'db', 'supplier.db'));


sp.exec(`
  CREATE TABLE IF NOT EXISTS sup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "supplier-name" TEXT NOT NULL,
    "supply-label" TEXT NOT NULL,
    "supply-type" TEXT NOT NULL,
    "supply-catagory" TEXT NOT NULL,
    "supply-count" NUMERIC(5, 2) NOT NULL DEFAULT 0,
    "date-of-delivery" DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = sp;