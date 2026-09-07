

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const sessionDb = new Database(path.join(__dirname, 'db', 'sessions.db'));

const app = express();
const PORT = process.env.PORT || 3000;

require('dotenv').config();

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


app.get('/storage-manager', requireLogin('storage-manager'), (req, res) => {
  res.render('storage-manager_page', { name: req.session.name });
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
    const existing = db.prepare('SELECT id FROM auth WHERE email = ?').get(email);

    if (existing) {
      req.session.register_error = 'Email is already registered!';
      req.session.active_form = 'register';
      return res.redirect('/');
    } 


    const hashedPassword = await bcrypt.hash(password, 10);

    db.prepare(
      'INSERT INTO auth (name, email, password, role) VALUES (?, ?, ?, ?)'
    ).run(name, email, hashedPassword, role);

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
    const auth = db.prepare('SELECT * FROM auth WHERE email = ?').get(email);

    if (auth && (await bcrypt.compare(password, auth.password))) {
      req.session.authId = auth.id;
      req.session.name = auth.name;
      req.session.email = auth.email;
      req.session.role = auth.role;

      return res.redirect(auth.role === 'store-owner' ? '/store-owner' : '/cashier' && 'storage-manager' ? '/storage-manager' : '/cashier');
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
