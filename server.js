const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // must be first

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { addAuth, getUserByEmail } = require('./db');
const { addSupply, getSuppliesByUser, getHistoryByUser } = require('./supplier');
const sales = require('./sales');
const loyalty = require('./loyalty');
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
  res.render('cashier_page', {
    name: req.session.name,
    success: flash(req, 'cashier_customer_success'),
    error: flash(req, 'cashier_customer_error')
  });
});

app.get('/cashier/register-customer', requireLogin('cashier'), (req, res) => {
  res.render('cashier_register_customer', {
    name: req.session.name,
    success: flash(req, 'cashier_customer_success'),
    error: flash(req, 'cashier_customer_error'),
    formData: pop(req, 'cashier_customer_form_data') || {}
  });
});

app.post('/cashier/register-customer', requireLogin('cashier'), async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !password) {
    req.session.cashier_customer_error = 'Name, email and password are required.';
    req.session.cashier_customer_form_data = { name, email, phone };
    return res.redirect('/cashier/register-customer');
  }

  try {
    const existing = loyalty.findCustomerByEmail(email);
    if (existing) {
      req.session.cashier_customer_error = 'Email is already registered.';
      req.session.cashier_customer_form_data = { name, email, phone };
      return res.redirect('/cashier/register-customer');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    loyalty.createCustomer(name, email, phone, hashedPassword);
    req.session.cashier_customer_success = `Customer "${name}" registered successfully.`;
    req.session.cashier_customer_form_data = {};
    return res.redirect('/cashier/register-customer');
  } catch (err) {
    console.error('Cashier customer register error:', err);
    req.session.cashier_customer_error = 'Something went wrong. Please try again.';
    req.session.cashier_customer_form_data = { name, email, phone };
    return res.redirect('/cashier/register-customer');
  }
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
    'supplier-phone': supplierPhone,
    'supplier-email': supplierEmail,
    'supply-label': supplyLabel,
    'supply-type': supplyType,
    'supply-category': supplyCategory,
    'measurement-type': measurementType,
    'supply-count': supplyCount,
    'supply-price': supplyPrice,
    'date_of_delivery': dateOfDelivery
  } = req.body;

  try {
    addSupply({
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
  const { itemName, soldPrice, paymentMethod, customerId } = req.body;

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

  let customerName = null;
  if (customerId) {
    const customer = loyalty.findCustomerById(parseInt(customerId, 10));
    if (customer) customerName = customer.name;
  }

  try {
    // Parameterized statement — no string concatenation, so this is not
    // vulnerable to SQL injection regardless of what the client sends.
    sales.prepare(
      `INSERT INTO sales (item_name, sold_price, payment_method, cashier_id, cashier_name, customer_id, customer_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(cleanItemName, price.toFixed(2), paymentMethod, req.session.authId, req.session.name, customerId ? parseInt(customerId, 10) : null, customerName);

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
      `SELECT id, item_name, sold_price, payment_method, customer_name, sale_date
       FROM sales
       WHERE date(sale_date) = ? AND cashier_id = ?
       ORDER BY sale_date DESC
       LIMIT 200`
    ).all(date, req.session.authId);
  } else {
    rows = sales.prepare(
      `SELECT id, item_name, sold_price, payment_method, cashier_name, customer_name, sale_date
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


// JSON API: search loyalty customers by name for the cashier sale form.
app.get('/api/customers/search', requireLogin('cashier', 'storage-manager', 'store-owner'), (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const rows = loyalty.db.prepare(
    `SELECT id, name, email, phone FROM customers WHERE name LIKE ? OR email LIKE ? ORDER BY name ASC LIMIT 20`
  ).all(`%${q}%`, `%${q}%`);

  res.json(rows);
});


// Full accounting dashboard page — store owner only.
app.get('/accounting', requireLogin('store-owner'), (req, res) => {
  res.render('accounting_page', { name: req.session.name });
});  


// ---- loyalty program (separate from staff auth) ------------------------------
function requireCustomer(req, res, next) {
  if (!req.session.customerId) return res.redirect('/loyalty/login');
  next();
}

app.get('/loyalty/register', (req, res) => {
  const formData = pop(req, 'loyalty_form_data') || {};
  res.render('loyalty_register', {
    activeForm: 'register',
    loginError: flash(req, 'loyalty_login_error'),
    registerError: flash(req, 'loyalty_register_error'),
    success: flash(req, 'loyalty_success'),
    formData,
    loginFormData: pop(req, 'loyalty_login_form_data') || {}
  });
});

app.get('/loyalty/login', (req, res) => {
  const formData = pop(req, 'loyalty_form_data') || {};
  res.render('loyalty_register', {
    activeForm: 'login',
    loginError: flash(req, 'loyalty_login_error'),
    registerError: flash(req, 'loyalty_register_error'),
    success: flash(req, 'loyalty_success'),
    formData,
    loginFormData: pop(req, 'loyalty_login_form_data') || {}
  });
});

app.post('/loyalty/register', async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !password) {
    req.session.loyalty_register_error = 'Name, email and password are required.';
    req.session.loyalty_form_data = { name, email, phone };
    req.session.active_form = 'register';
    return res.redirect('/loyalty/register');
  }

  try {
    const existing = loyalty.findCustomerByEmail(email);
    if (existing) {
      req.session.loyalty_register_error = 'Email is already registered.';
      req.session.loyalty_form_data = { name, email, phone };
      req.session.active_form = 'register';
      return res.redirect('/loyalty/register');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const customerId = loyalty.createCustomer(name, email, phone, hashedPassword);
    const customer = loyalty.findCustomerById(customerId);
    req.session.loyalty_success = `Welcome, ${customer.name}! Your account has been created. Please log in.`;
    req.session.active_form = 'login';
    return res.redirect('/loyalty/register');
  } catch (err) {
    console.error('Loyalty register error:', err);
    req.session.loyalty_register_error = 'Something went wrong. Please try again.';
    req.session.loyalty_form_data = { name, email, phone };
    req.session.active_form = 'register';
    return res.redirect('/loyalty/register');
  }
});

app.post('/loyalty/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const customer = loyalty.findCustomerByEmail(email);
    if (customer && (await bcrypt.compare(password, customer.password))) {
      req.session.customerId = customer.id;
      req.session.customerName = customer.name;
      return res.redirect('/loyalty/dashboard');
    }

    req.session.loyalty_login_error = 'Incorrect email or password';
    req.session.loyalty_login_form_data = { email };
    req.session.active_form = 'login';
    return res.redirect('/loyalty/register');
  } catch (err) {
    console.error('Loyalty login error:', err);
    req.session.loyalty_login_error = 'Something went wrong. Please try again.';
    req.session.active_form = 'login';
    return res.redirect('/loyalty/register');
  }
});

app.get('/loyalty/dashboard', requireCustomer, (req, res) => {
  const customer = loyalty.findCustomerById(req.session.customerId);
  const ledger = loyalty.getLedger(req.session.customerId);
  res.render('loyalty_dashboard', { customer, ledger });
});

app.get('/loyalty/products', (req, res) => {
  const products = loyalty.getAllProducts();
  res.render('loyalty_products', { products });
});

app.get('/loyalty/checkout', requireLogin('cashier', 'storage-manager', 'store-owner'), (req, res) => {
  const customerEmail = req.query.customerEmail || '';
  const customer = customerEmail ? loyalty.findCustomerByEmail(customerEmail) : null;
  const products = loyalty.getAllProducts();
  res.render('loyalty_checkout', { customer, products, customerEmail, cashierName: req.session.name });
});

app.post('/loyalty/checkout', requireLogin('cashier', 'storage-manager', 'store-owner'), (req, res) => {
  const { customerId, productId, quantity, redeemPoints } = req.body;

  try {
    const result = loyalty.processSale({
      customerId: customerId ? parseInt(customerId, 10) : null,
      cashierName: req.session.name,
      items: [{ productId: parseInt(productId, 10), quantity: parseInt(quantity, 10) }],
      redeemPoints: parseInt(redeemPoints || 0, 10)
    });

    if (req.session.customerId) {
      return res.redirect('/loyalty/dashboard');
    }
    return res.redirect('/loyalty/checkout');
  } catch (err) {
    console.error('Checkout error:', err);
    if (req.session.customerId) {
      req.session.loyalty_error = err.message;
      return res.redirect('/loyalty/dashboard');
    }
    return res.redirect('/loyalty/checkout');
  }
});

app.get('/loyalty/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/loyalty/login');
  });
});

// store owner loyalty management
app.get('/loyalty/store-owner', requireLogin('store-owner'), (req, res) => {
  res.redirect('/loyalty/store-owner/customers');
});

app.get('/loyalty/store-owner/products', requireLogin('store-owner'), (req, res) => {
  const products = loyalty.getAllProducts();
  res.render('loyalty_products_manage', { products });
});

app.post('/loyalty/store-owner/products', requireLogin('store-owner'), (req, res) => {
  const { name, sku, category, price } = req.body;

  if (!name || !price) {
    req.session.loyalty_error = 'Name and price are required.';
    return res.redirect('/loyalty/store-owner/products');
  }

  try {
    loyalty.addProduct(name, sku, category, parseFloat(price));
    return res.redirect('/loyalty/store-owner/products');
  } catch (err) {
    console.error('Add product error:', err);
    req.session.loyalty_error = 'Something went wrong.';
    return res.redirect('/loyalty/store-owner/products');
  }
});

app.get('/loyalty/store-owner/customers', requireLogin('store-owner'), (req, res) => {
  const customers = loyalty.getAllCustomers();
  res.render('loyalty_customers', { customers, adjustError: flash(req, 'loyalty_adjust_error'), adjustSuccess: flash(req, 'loyalty_adjust_success') });
});

app.post('/loyalty/store-owner/customers/adjust', requireLogin('store-owner'), (req, res) => {
  const { customerId, points, note } = req.body;

  if (!customerId || !points) {
    req.session.loyalty_adjust_error = 'Customer ID and points are required.';
    return res.redirect('/loyalty/store-owner/customers');
  }

  try {
    loyalty.recordPoints(parseInt(customerId, 10), 'adjust', parseInt(points, 10), null, note || 'Manual adjustment', req.session.name);
    req.session.loyalty_adjust_success = 'Points adjusted successfully.';
    return res.redirect('/loyalty/store-owner/customers');
  } catch (err) {
    console.error('Adjust points error:', err);
    req.session.loyalty_adjust_error = err.message;
    return res.redirect('/loyalty/store-owner/customers');
  }
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