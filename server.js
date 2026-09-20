const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // must be first

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { addAuth, getUserByEmail } = require('./db');
const { addSupply, getSuppliesByUser, getHistoryByUser } = require('./supplier');
const sales = require('./sales');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const sessionDb = new Database(path.join(__dirname, 'db', 'sessions.db'));

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Trust the reverse proxy (needed for `cookie.secure` to work correctly
// when the app sits behind a load balancer / reverse proxy in production).
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const isProd = process.env.NODE_ENV === 'production';

app.use(session({
   store: new SqliteStore({
       client: sessionDb,
       expired: {
         clear: true,
         intervalMs: 1000 * 60 * 60 * 2 // clean up expired sessions every 2 hours
       }
     }),
  secret: process.env.SESSION_SECRET || 'cd431c6709305d2d2d17951d0800b34fe728c40a322af6b0c1984385ffc68d0f',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',   // mitigates cross-site request forgery on the auth cookie
    secure: isProd,    // requires HTTPS in production; keep false for local http dev
    maxAge: 1000 * 60 * 60 * 2 // 2 hours
  }
}));


function flash(req, key) {
  const val = req.session[key];
  delete req.session[key];
  return val || '';
}

function pop(req, key) {
  const val = req.session[key];
  delete req.session[key];
  return val;
}


app.get('/', (req, res) => {
  res.render('display', {
    loginError: flash(req, 'login_error'),
    registerError: flash(req, 'register_error'),
    activeForm: flash(req, 'active_form') || 'login',
    formData: pop(req, 'register_form_data') || {},
    loginFormData: pop(req, 'login_form_data') || {},
    successMessage: flash(req, 'success_message')
  });
});



app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Accepts one or more allowed roles: requireLogin() just checks you're
// logged in, requireLogin('cashier') checks you're logged in AND a cashier,
// requireLogin('store-owner', 'storage-manager') allows either.
function requireLogin(...roles) {
  return (req, res, next) => {
    if (!req.session.authId) return res.redirect('/');
    if (roles.length && !roles.includes(req.session.role)) return res.redirect('/');
    next();
  };
}

// Strict YYYY-MM-DD validator used everywhere a date comes in from the
// client (query params), so a malformed value can never reach the SQL layer.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function resolveDate(value) {
  return DATE_RE.test(value) ? value : new Date().toISOString().slice(0, 10);
}


app.get('/cashier', requireLogin('cashier'), (req, res) => {
  res.render('cashier_page', { name: req.session.name });
});

// storage-manager page: just render the shell. The table itself is filled
// in by client-side JS calling GET /supplies (see below), so we don't need
// to pass "supplies" in here at all.
app.get('/storage-manager', requireLogin('storage-manager'), (req, res) => {
  res.render('storage-manager_page', { name: req.session.name });
});

// so /supplier is from line 6 that initializes the path
app.post('/supplier', requireLogin('storage-manager'), async (req, res) => {
  const {
    'supplier-name': supplierName,
    'supply-label': supplyLabel,
    'supply-type': supplyType,
    'supply-category': supplyCategory,
    'supply-count': supplyCount,
    'supply-price': supplyPrice,
    'date_of_delivery': dateOfDelivery
  } = req.body;

  try {
    addSupply({
      supplierName,
      supplyLabel,
      supplyType,
      supplyCategory,
      supplyCount,
      supplyPrice,
      dateOfDelivery,
      userId: req.session.authId,
      userName: req.session.name
    });

    res.redirect('/storage-manager');
  } catch (err) {
    console.error('Supplier insert error:', err);
    res.status(500).send('Something went wrong.');
  }
});

// API of supplier — only the logged-in user's own supplies.
// (There was a duplicate /supplies route earlier that called
// getAllSupplies() and returned everyone's rows; since Express only
// runs the FIRST matching route for a given path, that one was
// silently winning and hiding this correct one. Removed it.)
app.get('/supplies', requireLogin('storage-manager'), (req, res) => {
  try {
    const supplies = getSuppliesByUser(req.session.authId);
    res.json(supplies);
  } catch (err) {
    console.error('Fetch supplies error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/history', requireLogin('storage-manager'), (req, res) => {
  try {
    const history = getHistoryByUser(req.session.authId);
    res.json(history);
  } catch (err) {
    console.error('Fetch history error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/store-owner', requireLogin('store-owner'), (req, res) => {
  res.render('store-owner_page', { name: req.session.name });
});


app.post('/sales', requireLogin('cashier'), (req, res) => {
  const { itemName, soldPrice, paymentMethod } = req.body;

  // 1. Presence check
  if (!itemName || soldPrice === undefined || soldPrice === null || !paymentMethod) {
    req.session.sale_error = 'All fields are required.';
    return res.redirect('/cashier');
  }

  // 2. Whitelist the payment method server-side — never trust the <select>
  //    the browser sent. This backs up the CHECK constraint in sales.js.
  if (paymentMethod !== 'cash' && paymentMethod !== 'card') {
    req.session.sale_error = 'Invalid payment method.';
    return res.redirect('/cashier');
  }

  // 3. Validate the price: must be a finite positive number, at most 2
  //    decimal places, within a sane upper bound.
  const priceRegex = /^\d{1,7}(\.\d{1,2})?$/;
  if (typeof soldPrice !== 'string' || !priceRegex.test(soldPrice.trim())) {
    req.session.sale_error = 'Enter a valid price (e.g. 12.99).';
    return res.redirect('/cashier');
  }
  const price = Number(soldPrice);
  if (!Number.isFinite(price) || price <= 0 || price > 999999.99) {
    req.session.sale_error = 'Price must be between 0.01 and 999999.99.';
    return res.redirect('/cashier');
  }

  // 4. Trim/cap free-text field length to keep the DB and UI sane.
  const cleanItemName = String(itemName).trim().slice(0, 200);
  if (!cleanItemName) {
    req.session.sale_error = 'Item name is required.';
    return res.redirect('/cashier');
  }

  try {
    // Parameterized statement — no string concatenation, so this is not
    // vulnerable to SQL injection regardless of what the client sends.
    sales.prepare(
      `INSERT INTO sales (item_name, sold_price, payment_method, cashier_id, cashier_name)
       VALUES (?, ?, ?, ?, ?)`
    ).run(cleanItemName, price.toFixed(2), paymentMethod, req.session.authId, req.session.name);

    res.redirect('/cashier');
  } catch (err) {
    console.error('Sale insert error:', err);
    req.session.sale_error = 'Something went wrong recording that sale.';
    res.redirect('/cashier');
  }
});


// JSON API: list sales for a given day.
// - cashiers only ever see their own sales (their register, not the store's)
// - storage-manager / store-owner see the whole store's sales for that day
app.get('/api/sales', requireLogin('cashier', 'storage-manager', 'store-owner'), (req, res) => {
  const date = resolveDate(req.query.date);

  let rows;
  if (req.session.role === 'cashier') {
    rows = sales.prepare(
      `SELECT id, item_name, sold_price, payment_method, sale_date
       FROM sales
       WHERE date(sale_date) = ? AND cashier_id = ?
       ORDER BY sale_date DESC
       LIMIT 200`
    ).all(date, req.session.authId);
  } else {
    rows = sales.prepare(
      `SELECT id, item_name, sold_price, payment_method, cashier_name, sale_date
       FROM sales
       WHERE date(sale_date) = ?
       ORDER BY sale_date DESC
       LIMIT 500`
    ).all(date);
  }

  res.json({ date, scope: req.session.role === 'cashier' ? 'own' : 'store', sales: rows });
});


// JSON API: cash vs card totals for a given day (computed with SQL SUM/
// GROUP BY rather than pulled row-by-row into JS — cheap even as the
// sales table grows, and the arithmetic never leaves the database).
app.get('/api/sales/totals', requireLogin('cashier', 'storage-manager', 'store-owner'), (req, res) => {
  const date = resolveDate(req.query.date);
  const scopedToCashier = req.session.role === 'cashier';

  const totals = scopedToCashier
    ? sales.prepare(
        `SELECT payment_method, COUNT(*) AS count, SUM(sold_price) AS total
         FROM sales WHERE date(sale_date) = ? AND cashier_id = ?
         GROUP BY payment_method`
      ).all(date, req.session.authId)
    : sales.prepare(
        `SELECT payment_method, COUNT(*) AS count, SUM(sold_price) AS total
         FROM sales WHERE date(sale_date) = ?
         GROUP BY payment_method`
      ).all(date);

  const result = {
    date,
    scope: scopedToCashier ? 'own' : 'store',
    cash: 0, cashCount: 0,
    card: 0, cardCount: 0,
    grandTotal: 0
  };

  for (const row of totals) {
    if (row.payment_method === 'cash') { result.cash = row.total || 0; result.cashCount = row.count; }
    if (row.payment_method === 'card') { result.card = row.total || 0; result.cardCount = row.count; }
  }
  result.grandTotal = Number((result.cash + result.card).toFixed(2));

  res.json(result);
});


// Full accounting dashboard page — store owner only.
app.get('/accounting', requireLogin('store-owner'), (req, res) => {
  res.render('accounting_page', { name: req.session.name });
});  


app.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    req.session.register_error = 'All fields are required.';
    req.session.active_form = 'register';
    req.session.register_form_data = { name, email, role };
    return res.redirect('/');
  }

  try {
    const existing = getUserByEmail(email);

    if (existing) {
      req.session.register_error = 'Email is already registered!';
      req.session.active_form = 'register';
      req.session.register_form_data = { name, email, role };
      return res.redirect('/');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    addAuth(name, email, hashedPassword, role, new Date().toISOString());
    req.session.success_message = 'Registration successful! Please log in.';
    req.session.active_form = 'login';
    req.session.register_form_data = { email };
    return res.redirect('/');
  } catch (err) {
    console.error('Register error:', err);
    req.session.register_error = 'Something went wrong. Please try again.';
    req.session.active_form = 'register';
    req.session.register_form_data = { name, email, role };
    return res.redirect('/');
  }
});


app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const auth = getUserByEmail(email);

    if (auth && (await bcrypt.compare(password, auth.password))) {
      try {
        await new Promise((resolve, reject) => {
          req.session.regenerate((err) => {
            if (err) return reject(err);
            req.session.authId = auth.id;
            req.session.name = auth.name;
            req.session.email = auth.email;
            req.session.role = auth.role;
            resolve();
          });
        });
      } catch (err) {
        console.error('Session regenerate error:', err);
      }

      return res.redirect(auth.role === 'store-owner' ? '/store-owner' : auth.role === 'storage-manager' ? '/storage-manager' : '/cashier');
    }

    req.session.login_error = 'Incorrect email or password';
    req.session.active_form = 'login';
    req.session.login_form_data = { email };
    return res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    req.session.login_error = 'Something went wrong. Please try again.';
    req.session.active_form = 'login';
    return res.redirect('/');
  }
});



app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});