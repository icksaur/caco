/**
 * Color Hash Applet
 * Uses the same hash algorithm as the favicon
 */

/**
 * Simple hash function - produces 4 bytes from string
 * Same as hostname-hash.ts
 */
function hashString(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  let h3 = 0xdeadbeef;
  let h4 = 0xcafebabe;
  
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 ^= c; h2 = Math.imul(h2, 0x85ebca6b);
    h3 ^= c; h3 = Math.imul(h3, 0xc2b2ae35);
    h4 ^= c; h4 = Math.imul(h4, 0x27d4eb2f);
  }
  
  return [h1 & 0xFF, h2 & 0xFF, h3 & 0xFF, h4 & 0xFF];
}

/**
 * Convert a byte (0-255) to an HSL color string
 */
function byteToHsl(byte) {
  const hue = Math.round((byte / 255) * 360);
  return `hsl(${hue}, 70%, 50%)`;
}

/**
 * Parse HSL string to RGB
 */
function hslToRgb(hsl) {
  const match = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!match) return [128, 128, 128];
  
  const h = parseInt(match[1]) / 360;
  const s = parseInt(match[2]) / 100;
  const l = parseInt(match[3]) / 100;
  
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255)
  ];
}

/**
 * Blend multiple HSL colors with weights
 */
function blendColors(...colorWeights) {
  let r = 0, g = 0, b = 0;
  
  for (const [color, weight] of colorWeights) {
    const rgb = hslToRgb(color);
    r += rgb[0] * weight;
    g += rgb[1] * weight;
    b += rgb[2] * weight;
  }
  
  return [Math.round(r), Math.round(g), Math.round(b)];
}

// Grid state
const GRID_SIZE = 17; // 17x17 grid
const toggledCells = new Set(); // Store toggled cell coordinates as "x,y"

/**
 * Generate the color hash visualization
 */
function generateColorHash(str) {
  const canvas = document.getElementById('colorCanvas');
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  
  // Hash the string to get 4 colors
  const bytes = hashString(str);
  const colors = bytes.map(byteToHsl);
  
  // Draw each pixel with bilinear interpolation from corners
  const imageData = ctx.createImageData(size, size);
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normalized coordinates (0-1)
      const nx = x / (size - 1);
      const ny = y / (size - 1);
      
      // Bilinear interpolation weights
      const w00 = (1 - nx) * (1 - ny); // top-left
      const w10 = nx * (1 - ny);       // top-right
      const w01 = (1 - nx) * ny;       // bottom-left
      const w11 = nx * ny;             // bottom-right
      
      // Blend colors
      const rgb = blendColors(
        [colors[0], w00],
        [colors[1], w10],
        [colors[2], w01],
        [colors[3], w11]
      );
      
      const i = (y * size + x) * 4;
      imageData.data[i] = rgb[0];
      imageData.data[i + 1] = rgb[1];
      imageData.data[i + 2] = rgb[2];
      imageData.data[i + 3] = 255;
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  
  // Redraw toggled cells on top
  drawToggledCells();
}

/**
 * Draw white squares for toggled cells
 */
function drawToggledCells() {
  const canvas = document.getElementById('colorCanvas');
  const ctx = canvas.getContext('2d');
  const canvasSize = canvas.width;
  
  ctx.fillStyle = 'white';
  
  for (const coord of toggledCells) {
    const [x, y] = coord.split(',').map(Number);
    
    // Calculate pixel-perfect boundaries to avoid gaps
    const x1 = Math.floor(x * canvasSize / GRID_SIZE);
    const y1 = Math.floor(y * canvasSize / GRID_SIZE);
    const x2 = Math.floor((x + 1) * canvasSize / GRID_SIZE);
    const y2 = Math.floor((y + 1) * canvasSize / GRID_SIZE);
    
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }
}

// Initialize with empty canvas (gray)
function initCanvas() {
  const canvas = document.getElementById('colorCanvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * Handle canvas click to toggle grid cells
 */
function handleCanvasClick(event) {
  const canvas = document.getElementById('colorCanvas');
  const rect = canvas.getBoundingClientRect();
  
  // Get click position relative to canvas
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  // Convert to canvas coordinates (accounting for CSS scaling)
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const canvasX = x * scaleX;
  const canvasY = y * scaleY;
  
  // Determine which grid cell was clicked
  const cellSize = canvas.width / GRID_SIZE;
  const gridX = Math.floor(canvasX / cellSize);
  const gridY = Math.floor(canvasY / cellSize);
  
  // Toggle the cell
  const coord = `${gridX},${gridY}`;
  if (toggledCells.has(coord)) {
    toggledCells.delete(coord);
  } else {
    toggledCells.add(coord);
  }
  
  // Redraw the canvas with the gradient background
  const input = document.getElementById('stringInput');
  const str = input.value.trim();
  if (str) {
    generateColorHash(str);
  } else {
    // Just redraw toggled cells on gray background
    initCanvas();
    drawToggledCells();
  }
}

// Event handlers
document.getElementById('hashButton').addEventListener('click', () => {
  const input = document.getElementById('stringInput');
  const str = input.value.trim();
  
  if (str) {
    generateColorHash(str);
  }
});

// Hash on Enter key
document.getElementById('stringInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const str = e.target.value.trim();
    if (str) {
      generateColorHash(str);
    }
  }
});

// Initialize
initCanvas();

// Add click handler for grid toggling
document.getElementById('colorCanvas').addEventListener('click', handleCanvasClick);
