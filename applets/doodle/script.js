// Drawing state
let canvas, ctx;
let isDrawing = false;
let currentColor = '#000000';
let currentSize = 1;
let lastX = 0;
let lastY = 0;

// Initialize canvas and event listeners
function init() {
  canvas = document.getElementById('doodle-canvas');
  ctx = canvas.getContext('2d');
  
  // Set up drawing context
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Color swatches
  const swatches = document.querySelectorAll('.color-swatch');
  swatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      swatches.forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      currentColor = swatch.dataset.color;
    });
  });
  
  // Set first color as active
  swatches[0].classList.add('active');
  
  // Size buttons
  const sizeButtons = document.querySelectorAll('.size-btn');
  sizeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      sizeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSize = parseInt(btn.dataset.size);
    });
  });
  
  // Clear button
  document.getElementById('clear-btn').addEventListener('click', clearCanvas);
  
  // Send button
  document.getElementById('send-btn').addEventListener('click', sendToSession);
  
  // Canvas drawing events
  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseout', stopDrawing);
  
  // Touch support
  canvas.addEventListener('touchstart', handleTouchStart);
  canvas.addEventListener('touchmove', handleTouchMove);
  canvas.addEventListener('touchend', stopDrawing);
}

function startDrawing(e) {
  isDrawing = true;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  lastX = (e.clientX - rect.left) * scaleX;
  lastY = (e.clientY - rect.top) * scaleY;
  
  // Draw a point at click location
  ctx.fillStyle = currentColor;
  ctx.beginPath();
  ctx.arc(lastX, lastY, currentSize / 2, 0, Math.PI * 2);
  ctx.fill();
}

function draw(e) {
  if (!isDrawing) return;
  
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const currentX = (e.clientX - rect.left) * scaleX;
  const currentY = (e.clientY - rect.top) * scaleY;
  
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentSize;
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(currentX, currentY);
  ctx.stroke();
  
  lastX = currentX;
  lastY = currentY;
}

function stopDrawing() {
  isDrawing = false;
}

function handleTouchStart(e) {
  e.preventDefault();
  const touch = e.touches[0];
  const mouseEvent = new MouseEvent('mousedown', {
    clientX: touch.clientX,
    clientY: touch.clientY
  });
  canvas.dispatchEvent(mouseEvent);
}

function handleTouchMove(e) {
  e.preventDefault();
  const touch = e.touches[0];
  const mouseEvent = new MouseEvent('mousemove', {
    clientX: touch.clientX,
    clientY: touch.clientY
  });
  canvas.dispatchEvent(mouseEvent);
}

function clearCanvas() {
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

async function sendToSession() {
  const prompt = document.getElementById('prompt-input').value.trim();
  const imageData = canvas.toDataURL('image/png');
  
  // Build message
  let message = 'Here is a doodle from the Doodle applet';
  if (prompt) {
    message += `\n\nPrompt: ${prompt}`;
  }
  
  try {
    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    
    // Try appletAPI namespace
    if (typeof appletAPI !== 'undefined' && appletAPI.sendAgentMessage) {
      await appletAPI.sendAgentMessage(message, { imageData });
    } else if (typeof sendAgentMessage !== 'undefined') {
      await sendAgentMessage(message, { imageData });
    } else {
      throw new Error('sendAgentMessage API not available');
    }
    
    sendBtn.textContent = 'Sent!';
    setTimeout(() => {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send to Session';
    }, 2000);
  } catch (error) {
    console.error('Failed to send:', error);
    alert('Failed to send to session. Error: ' + error.message);
    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send to Session';
  }
}

// Initialize when DOM is ready
init();
