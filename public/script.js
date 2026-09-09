function ShowForm(formID){
    document.querySelectorAll(".form-box").forEach(form => form.classList.remove("active"));
    document.getElementById(formID).classList.add("active")
     
}

function initSupplyCountToggle() {
  const measurementSelect = document.querySelector('select[name="supply-type-of-measurement"]');
  const countInput = document.getElementById('supply-count');
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