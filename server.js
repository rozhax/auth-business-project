const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // must be first

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { addAuth, getUserByEmail } = require('./db');
const { addSupply, getSuppliesByUser, getHistoryByUser } = require('./supplier');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const sessionDb = new Database(path.join(__dirname, 'db', 'sessions.db'));

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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
    maxAge: 1000 * 60 * 60 * 2 // 2 hours
  }
}));


function flash(req, key) {
  const val = req.session[key];
  delete req.session[key];
  return val || '';
}


app.get('/', (req, res) => {
  res.render('display', {
    loginError: flash(req, 'login_error'),
    registerError: flash(req, 'register_error'),
    activeForm: flash(req, 'active_form') || 'login'
  });
});



app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

function requireLogin(role) {
  return (req, res, next) => {
    if (!req.session.authId) return res.redirect('/');
    if (role && req.session.role !== role) return res.redirect('/');
    next();
  };
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


app.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    req.session.register_error = 'All fields are required.';
    req.session.active_form = 'register';
    return res.redirect('/');
  }

  try {
    const existing = getUserByEmail(email);

    if (existing) {
      req.session.register_error = 'Email is already registered!';
      req.session.active_form = 'register';
      return res.redirect('/');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    addAuth(name, email, hashedPassword, role, new Date().toISOString());
    req.session.active_form = 'login';
    return res.redirect('/');
  } catch (err) {
    console.error('Register error:', err);
    req.session.register_error = 'Something went wrong. Please try again.';
    req.session.active_form = 'register';
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