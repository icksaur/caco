var display = document.getElementById('display');
var currentValue = '0';
var pendingOp = null;
var previousValue = null;
var resetNext = false;
var calcHistory = [];

function syncState() {
  setAppletState({
    currentValue: currentValue,
    pendingOp: pendingOp,
    previousValue: previousValue,
    displayValue: display.value,
    history: calcHistory
  });
}

function updateDisplay() {
  var formatted = currentValue;
  if (formatted.length > 12) {
    formatted = parseFloat(formatted).toExponential(6);
  }
  display.value = formatted;
  syncState();
}

function appendNum(num) {
  if (resetNext) {
    currentValue = num;
    resetNext = false;
  } else if (currentValue === '0') {
    currentValue = num;
  } else {
    currentValue += num;
  }
  updateDisplay();
}

function appendDecimal() {
  if (resetNext) {
    currentValue = '0.';
    resetNext = false;
  } else if (currentValue.indexOf('.') === -1) {
    currentValue += '.';
  }
  updateDisplay();
}

function appendOp(op) {
  if (pendingOp && !resetNext) {
    calculate();
  }
  previousValue = currentValue;
  pendingOp = op;
  resetNext = true;
  syncState();
}

function calculate() {
  if (!pendingOp || previousValue === null) return;
  
  var prev = parseFloat(previousValue);
  var curr = parseFloat(currentValue);
  var result;
  var expr = prev + ' ' + pendingOp + ' ' + curr;
  
  if (pendingOp === '+') result = prev + curr;
  else if (pendingOp === '-') result = prev - curr;
  else if (pendingOp === '*') result = prev * curr;
  else if (pendingOp === '/') result = curr !== 0 ? prev / curr : 'Error';
  
  calcHistory.push(expr + ' = ' + result);
  currentValue = String(result);
  pendingOp = null;
  previousValue = null;
  resetNext = true;
  updateDisplay();
}

function clearDisplay() {
  currentValue = '0';
  pendingOp = null;
  previousValue = null;
  resetNext = false;
  updateDisplay();
}

function toggleSign() {
  currentValue = String(-parseFloat(currentValue));
  updateDisplay();
}

function percentage() {
  currentValue = String(parseFloat(currentValue) / 100);
  updateDisplay();
}

document.querySelectorAll('[data-num]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    appendNum(this.getAttribute('data-num'));
  });
});

document.querySelectorAll('[data-op]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    appendOp(this.getAttribute('data-op'));
  });
});

document.querySelectorAll('[data-action]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var action = this.getAttribute('data-action');
    if (action === 'clear') clearDisplay();
    else if (action === 'toggle') toggleSign();
    else if (action === 'percent') percentage();
    else if (action === 'decimal') appendDecimal();
    else if (action === 'equals') calculate();
  });
});

document.addEventListener('keydown', function(e) {
  // Ignore if user is typing in an input or textarea
  var tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  
  // Ignore if calculator is not visible (check offsetParent)
  if (!display.offsetParent) return;
  
  if (e.key >= '0' && e.key <= '9') appendNum(e.key);
  else if (e.key === '.') appendDecimal();
  else if (e.key === '+') appendOp('+');
  else if (e.key === '-') appendOp('-');
  else if (e.key === '*') appendOp('*');
  else if (e.key === '/') appendOp('/');
  else if (e.key === 'Enter' || e.key === '=') calculate();
  else if (e.key === 'Escape' || e.key === 'c') clearDisplay();
});

// Listen for state updates pushed from agent
onStateUpdate(function(state) {
  console.log('[CALC] Received state from agent:', state);
  if (state.currentValue !== undefined) {
    currentValue = String(state.currentValue);
  }
  if (state.pendingOp !== undefined) {
    pendingOp = state.pendingOp;
  }
  if (state.previousValue !== undefined) {
    previousValue = state.previousValue;
  }
  if (state.displayValue !== undefined) {
    display.value = state.displayValue;
  }
  // Apply changes and sync back to server (applet is source of truth)
  updateDisplay();
});

syncState();