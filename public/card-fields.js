(function () {
  const form = document.getElementById('sale-form');
  if (!form) return;

  const method = form.querySelector('select[name="paymentMethod"]');
  const box = document.getElementById('card-fields');
  const nameEl = document.getElementById('card-name');
  const num = document.getElementById('card-number');
  const exp = document.getElementById('card-expiry');
  const cvv = document.getElementById('card-cvv');
  const err = document.getElementById('card-error');
  const inputs = [nameEl, num, exp, cvv];

  function clearCard() {
    inputs.forEach(i => { i.value = ''; });
    err.style.display = 'none';
  }

  function toggle() {
    const isCard = method.value === 'card';
    box.style.display = isCard ? 'block' : 'none';
    // required only while visible, otherwise hidden fields would block "cash" sales
    inputs.forEach(i => { i.required = isCard; });
    if (!isCard) clearCard();
  }

  // ---- input formatting ----
  num.addEventListener('input', () => {
    const digits = num.value.replace(/\D/g, '').slice(0, 19);
    num.value = digits.replace(/(.{4})/g, '$1 ').trim();
  });

  exp.addEventListener('input', () => {
    let d = exp.value.replace(/\D/g, '').slice(0, 4);
    if (d.length >= 3) d = d.slice(0, 2) + '/' + d.slice(2);
    exp.value = d;
  });

  cvv.addEventListener('input', () => {
    cvv.value = cvv.value.replace(/\D/g, '').slice(0, 4);
  });

  // ---- validation ----
  function luhnValid(digits) {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function expiryValid(value) {
    const m = /^(\d{2})\/(\d{2})$/.exec(value);
    if (!m) return false;
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    if (month < 1 || month > 12) return false;
    const now = new Date();
    // card is valid through the END of its expiry month
    return new Date(year, month, 1) > now;
  }

  function validate() {
    const digits = num.value.replace(/\D/g, '');
    if (!nameEl.value.trim()) return 'Enter the cardholder name.';
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return 'Card number is not valid.';
    if (!expiryValid(exp.value)) return 'Card is expired or the expiry date is invalid.';
    const isAmex = /^3[47]/.test(digits);
    if (cvv.value.length !== (isAmex ? 4 : 3)) {
      return isAmex ? 'Amex cards need a 4-digit code.' : 'CVV must be 3 digits.';
    }
    return '';
  }

  form.addEventListener('submit', (e) => {
    if (method.value !== 'card') return;
    const problem = validate();
    if (problem) {
      e.preventDefault();
      err.textContent = problem;
      err.style.display = 'block';
      return;
    }
    // Valid: wipe the card data from the page. The inputs have no "name"
    // attribute, so none of it is ever sent to the server anyway.
    clearCard();
  });

  // Don't let the browser's back/forward cache restore card details.
  window.addEventListener('pageshow', clearCard);

  method.addEventListener('change', toggle);
  toggle();
})();   