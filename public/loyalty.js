// Cashier loyalty desk. Every change goes through /api/loyalty/* and the
// server's response is what gets rendered, so the balance on screen is always
// the balance in loyalty.db.
(function () {
  'use strict';

  var listEl = document.getElementById('customerList');
  var listEmptyEl = document.getElementById('listEmpty');
  var searchForm = document.getElementById('searchForm');
  var searchInput = document.getElementById('searchInput');
  var newCustomerForm = document.getElementById('newCustomerForm');
  var newCustomerToggle = document.getElementById('newCustomerToggle');
  var newCustomerCancel = document.getElementById('newCustomerCancel');
  var detailEl = document.getElementById('detail');
  var detailEmptyEl = document.getElementById('detailEmpty');
  var nameEl = document.getElementById('customerName');
  var contactEl = document.getElementById('customerContact');
  var tierEl = document.getElementById('customerTier');
  var pointsEl = document.getElementById('statPoints');
  var lifetimeEl = document.getElementById('statLifetime');
  var nextTierEl = document.getElementById('statNextTier');
  var earnForm = document.getElementById('earnForm');
  var redeemForm = document.getElementById('redeemForm');
  var historyBody = document.getElementById('historyBody');
  var historyEmpty = document.getElementById('historyEmpty');
  var toastEl = document.getElementById('toast');

  var TIERS = [
    { name: 'silver', min: 100 },
    { name: 'gold', min: 500 },
    { name: 'platinum', min: 1000 }
  ];

  var selectedId = null;
  var toastTimer = null;

  // --- helpers -------------------------------------------------------------

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle('is-error', !!isError);
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 4000);
  }

  // Throws the server's message (e.g. "Not enough points: ...") so the desk
  // can show the real reason instead of a generic failure.
  function api(url, options) {
    return fetch(url, options).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          if (!res.ok) {
            throw new Error((data && data.error) || 'Request failed (' + res.status + ').');
          }
          return data;
        });
    });
  }

  function postJson(url, body) {
    return api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function nextTierFor(lifetimePoints) {
    for (var i = 0; i < TIERS.length; i++) {
      if (lifetimePoints < TIERS[i].min) {
        return { name: TIERS[i].name, remaining: TIERS[i].min - lifetimePoints };
      }
    }
    return null;
  }

  function formatDate(value) {
    if (!value) return '—';
    // SQLite stores UTC ("YYYY-MM-DD HH:MM:SS"); mark it so the browser
    // converts to local time instead of guessing.
    var date = new Date(String(value).replace(' ', 'T') + 'Z');
    return isNaN(date) ? value : date.toLocaleString();
  }

  // --- rendering -----------------------------------------------------------

  function renderList(customers) {
    listEl.innerHTML = '';
    listEmptyEl.classList.toggle('is-hidden', customers.length > 0);

    customers.forEach(function (customer) {
      var li = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'loyalty-list-item';
      button.dataset.id = customer.id;
      if (customer.id === selectedId) button.classList.add('is-selected');

      button.innerHTML =
        '<span class="loyalty-list-main">' +
        '<span class="loyalty-list-name">' + esc(customer.name) + '</span>' +
        '<span class="loyalty-list-contact">' +
        esc(customer.email || customer.phone || 'No contact details') +
        '</span>' +
        '</span>' +
        '<span class="loyalty-list-side">' +
        '<span class="loyalty-pill">' + esc(customer.points) + ' pts</span>' +
        '<span class="loyalty-tier tier-' + esc(customer.tier) + '">' + esc(customer.tier) + '</span>' +
        '</span>';

      li.appendChild(button);
      listEl.appendChild(li);
    });
  }

  function renderHistory(transactions) {
    historyBody.innerHTML = '';
    historyEmpty.classList.toggle('is-hidden', transactions.length > 0);

    transactions.forEach(function (tx) {
      var positive = tx.type === 'earn';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="loyalty-muted">' + esc(formatDate(tx['created-at'])) + '</td>' +
        '<td><span class="loyalty-action ' + (positive ? 'is-earn' : 'is-redeem') + '">' +
        (positive ? 'Earned' : 'Redeemed') + '</span></td>' +
        '<td class="' + (positive ? 'loyalty-up' : 'loyalty-down') + '">' +
        (positive ? '+' : '−') + esc(tx.points) + '</td>' +
        '<td>' + esc(tx.note || '—') + '</td>' +
        '<td class="loyalty-muted">' + esc(tx['cashier-name'] || '—') + '</td>';
      historyBody.appendChild(tr);
    });
  }

  function renderCustomer(customer, transactions) {
    selectedId = customer.id;

    nameEl.textContent = customer.name;
    contactEl.textContent = customer.email || customer.phone || 'No contact details on file';
    tierEl.textContent = customer.tier;
    tierEl.className = 'loyalty-tier tier-' + customer.tier;

    pointsEl.textContent = customer.points;
    lifetimeEl.textContent = customer['lifetime-points'];

    var next = nextTierFor(customer['lifetime-points']);
    nextTierEl.textContent = next ? next.remaining + ' pts to ' + next.name : 'Top tier';

    detailEmptyEl.classList.add('is-hidden');
    detailEl.classList.remove('is-hidden');

    if (transactions) renderHistory(transactions);
  }

  function clearCustomer(message) {
    selectedId = null;
    detailEl.classList.add('is-hidden');
    detailEmptyEl.classList.remove('is-hidden');
    if (message) detailEmptyEl.querySelector('p').textContent = message;
  }

  // --- data loading --------------------------------------------------------

  function loadCustomers(query) {
    var url = '/api/loyalty/customers';
    if (query) url += '?q=' + encodeURIComponent(query);

    return api(url)
      .then(function (data) {
        renderList(data.customers || []);
      })
      .catch(function (err) {
        toast(err.message, true);
      });
  }

  function selectCustomer(id) {
    return api('/api/loyalty/customers/' + id)
      .then(function (data) {
        renderCustomer(data.customer, data.transactions);
        loadCustomers(searchInput.value);
      })
      .catch(function (err) {
        toast(err.message, true);
      });
  }

  // Shared by earn and redeem: one POST, then repaint from the response.
  function submitMovement(form, url, pointsInput, noteInput, busyLabel, idleLabel) {
    return function (event) {
      event.preventDefault();
      if (!selectedId) {
        toast('Select a customer first.', true);
        return;
      }

      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = busyLabel;

      postJson(url, {
        customerId: selectedId,
        points: Number(pointsInput.value),
        note: noteInput.value
      })
        .then(function (data) {
          renderCustomer(data.customer, data.transactions);
          noteInput.value = '';
          toast(data.message);
          return loadCustomers(searchInput.value);
        })
        .catch(function (err) {
          toast(err.message, true);
        })
        .finally(function () {
          button.disabled = false;
          button.textContent = idleLabel;
        });
    };
  }

  // --- wiring --------------------------------------------------------------

  searchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    loadCustomers(searchInput.value);
  });

  searchInput.addEventListener('input', function () {
    loadCustomers(searchInput.value);
  });

  listEl.addEventListener('click', function (event) {
    var item = event.target.closest('.loyalty-list-item');
    if (item) selectCustomer(Number(item.dataset.id));
  });

  newCustomerToggle.addEventListener('click', function () {
    newCustomerForm.classList.toggle('is-hidden');
    if (!newCustomerForm.classList.contains('is-hidden')) {
      newCustomerForm.querySelector('input[name="name"]').focus();
    }
  });

  newCustomerCancel.addEventListener('click', function () {
    newCustomerForm.reset();
    newCustomerForm.classList.add('is-hidden');
  });

  newCustomerForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;

    postJson('/api/loyalty/customers', {
      name: form.name.value,
      email: form.email.value,
      phone: form.phone.value
    })
      .then(function (data) {
        toast(data.message);
        form.reset();
        form.classList.add('is-hidden');
        return loadCustomers(searchInput.value).then(function () {
          return selectCustomer(data.customer.id);
        });
      })
      .catch(function (err) {
        toast(err.message, true);
      })
      .finally(function () {
        button.disabled = false;
      });
  });

  earnForm.addEventListener(
    'submit',
    submitMovement(
      earnForm,
      '/api/loyalty/earn',
      document.getElementById('earnPoints'),
      document.getElementById('earnNote'),
      'Adding…',
      'Earn points'
    )
  );

  redeemForm.addEventListener(
    'submit',
    submitMovement(
      redeemForm,
      '/api/loyalty/redeem',
      document.getElementById('redeemPoints'),
      document.getElementById('redeemNote'),
      'Redeeming…',
      'Redeem points'
    )
  );

  // Quick-reward buttons pre-fill the redeem form instead of spending
  // immediately, so the cashier still confirms the amount.
  document.querySelectorAll('.loyalty-reward').forEach(function (button) {
    button.addEventListener('click', function () {
      document.getElementById('redeemPoints').value = button.dataset.points;
      document.getElementById('redeemNote').value = button.dataset.label;
    });
  });

  loadCustomers('');
})();
