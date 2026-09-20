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
      td.colSpan = isAccountingPage ? 5 : 4;
      td.textContent = 'No sales yet.';
      tr.appendChild(td);
      salesBody.appendChild(tr);
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');

      const cells = [
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
      td.colSpan = isAccountingPage ? 5 : 4;
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
  // Refresh periodically so the register/accounting view stays current
  // without needing a manual page reload.
  setInterval(loadSales, 15000);
})();
