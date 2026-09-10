function initSupplyCountToggle() {
  const measurementSelect = document.querySelector('select[name="supplyTypeOfMeasurement"]');
  const countInput = document.getElementById('supplyCount');
  if (!measurementSelect || !countInput) return;

  measurementSelect.addEventListener('change', function() {
    if (this.value === 'box' || this.value === 'piece') {
      countInput.step = '1';
      countInput.max = '999';
      countInput.placeholder = '0';
    } else {
      countInput.step = '0.01';
      countInput.max = '999.99';
      countInput.placeholder = '0.00';
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSupplyCountToggle);
} else {
  initSupplyCountToggle();
}
