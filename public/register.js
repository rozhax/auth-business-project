(function () {
  const salesBody = document.getElementById('sales-body');
  const cashTotalEl = document.getElementById('cash-total');
  const cardTotalEl = document.getElementById('card-total');
  const grandTotalEl = document.getElementById('grand-total');
  const datePicker = document.getElementById('date-picker');
  const isAccountingPage = !!datePicker;

  function money(n) {
    return '$' + Number(n || 0).toFixed(2);
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function currentDate() {
    return isAccountingPage ? (datePicker.value || todayISO()) : todayISO();
  }

  // Build table rows with textContent (never innerHTML) so item names or
  // cashier names typed at the register can never be interpreted as HTML.
  function renderSales(rows) {
    salesBody.innerHTML = '';

    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = isAccountingPage ? 6 : 5;
      td.textContent = 'No sales yet.';
      tr.appendChild(td);
      salesBody.appendChild(tr);
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');

      const cells = [
        row.customer_name || '-',
        row.item_name,
        money(row.sold_price),
        row.payment_method,
      ];
      if (isAccountingPage) cells.push(row.cashier_name);
      cells.push(new Date(row.sale_date).toLocaleTimeString());

      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      salesBody.appendChild(tr);
    }
  }

  async function loadSales() {
    try {
      const date = currentDate();
      const [salesRes, totalsRes] = await Promise.all([
        fetch(`/api/sales?date=${encodeURIComponent(date)}`),
        fetch(`/api/sales/totals?date=${encodeURIComponent(date)}`)
      ]);

      if (!salesRes.ok || !totalsRes.ok) throw new Error('Request failed');

      const salesData = await salesRes.json();
      const totalsData = await totalsRes.json();

      renderSales(salesData.sales);
      cashTotalEl.textContent = money(totalsData.cash);
      cardTotalEl.textContent = money(totalsData.card);
      grandTotalEl.textContent = money(totalsData.grandTotal);
    } catch (err) {
      console.error('Failed to load sales data:', err);
      salesBody.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = isAccountingPage ? 6 : 5;
      td.textContent = 'Could not load sales data.';
      tr.appendChild(td);
      salesBody.appendChild(tr);
    }
  }

  if (isAccountingPage) {
    datePicker.value = todayISO();
    datePicker.addEventListener('change', loadSales);
  }

  loadSales();
  setInterval(loadSales, 15000);

  // Customer search for the cashier sale form
  const customerSearch = document.getElementById('customer-search');
  const customerIdInput = document.getElementById('customer-id');
  const searchResults = document.getElementById('customer-search-results');

  if (customerSearch) {
    let debounceTimer;
    customerSearch.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      const query = this.value.trim();
      customerIdInput.value = '';
      searchResults.innerHTML = '';

      if (!query) return;

      debounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/customers/search?q=${encodeURIComponent(query)}`);
          if (!res.ok) throw new Error('Search failed');
          const customers = await res.json();

          if (!customers.length) {
            searchResults.innerHTML = '<div style="padding: 8px; background: #eee; border-radius: 4px; margin-top: 4px; font-size: 14px;">No customers found</div>';
            return;
          }

          const ul = document.createElement('div');
          ul.style.cssText = 'position: absolute; background: #fff; border: 1px solid #ccc; border-radius: 4px; max-height: 200px; overflow-y: auto; width: 100%; z-index: 10; box-shadow: 0 2px 6px rgba(0,0,0,0.15);';

          customers.forEach(c => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 10px; cursor: pointer; font-size: 14px; border-bottom: 1px solid #f0f0f0;';
            item.textContent = `${c.name} (${c.email})`;
            item.addEventListener('click', () => {
              customerSearch.value = c.name;
              customerIdInput.value = c.id;
              searchResults.innerHTML = '';
            });
            item.addEventListener('mouseenter', () => { item.style.background = '#f5f5f5'; });
            item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
            ul.appendChild(item);
          });

          searchResults.appendChild(ul);
        } catch (err) {
          console.error('Customer search error:', err);
        }
      }, 200);
    });

    document.addEventListener('click', function (e) {
      if (e.target !== customerSearch && e.target !== searchResults) {
        searchResults.innerHTML = '';
      }
    });
  }
})();
