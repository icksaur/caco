/**
 * Hostname Hash - Visual identification for different hosts
 * 
 * Generates a 4-color gradient based on hostname hash.
 * Each byte of the hash maps to a hue (0-255 → 0-360°).
 * Used for favicon and send button to identify which machine you're on.
 */

/** Extend Window to include injected server hostname */
declare global {
  interface Window {
    SERVER_HOSTNAME?: string;
  }
}

/** Cached hash result */
let cachedColors: string[] | null = null;

/**
 * Simple hash function - produces 4 bytes from hostname
 */
function hashHostname(hostname: string): number[] {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  let h3 = 0xdeadbeef;
  let h4 = 0xcafebabe;
  
  for (let i = 0; i < hostname.length; i++) {
    const c = hostname.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 ^= c; h2 = Math.imul(h2, 0x85ebca6b);
    h3 ^= c; h3 = Math.imul(h3, 0xc2b2ae35);
    h4 ^= c; h4 = Math.imul(h4, 0x27d4eb2f);
  }
  
  return [h1 & 0xFF, h2 & 0xFF, h3 & 0xFF, h4 & 0xFF];
}

/**
 * Convert a byte (0-255) to an HSL color string
 * Uses full saturation and medium lightness for vibrant colors
 */
function byteToHsl(byte: number): string {
  const hue = Math.round((byte / 255) * 360);
  return `hsl(${hue}, 70%, 50%)`;
}

/**
 * Get the 4 corner colors for the current hostname
 * Returns [topLeft, topRight, bottomLeft, bottomRight]
 */
export function getHostnameColors(): string[] {
  if (cachedColors) return cachedColors;
  
  // Use server's hostname (injected by server.ts), fallback to URL hostname
  const hostname = window.SERVER_HOSTNAME || window.location.hostname;
  const bytes = hashHostname(hostname);
  cachedColors = bytes.map(byteToHsl);
  
  return cachedColors;
}

/**
 * Get the server hostname for use in titles etc.
 */
export function getServerHostname(): string {
  return window.SERVER_HOSTNAME || window.location.hostname;
}

/**
 * Generate a favicon canvas with 4-corner gradient
 */
function createFaviconCanvas(size: number = 32): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  
  const colors = getHostnameColors();
  
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
      
      // Parse HSL colors and blend
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
  return canvas;
}

/**
 * Parse HSL string to RGB
 */
function hslToRgb(hsl: string): [number, number, number] {
  const match = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!match) return [128, 128, 128];
  
  const h = parseInt(match[1]) / 360;
  const s = parseInt(match[2]) / 100;
  const l = parseInt(match[3]) / 100;
  
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  
  const hue2rgb = (p: number, q: number, t: number) => {
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
function blendColors(...colorWeights: [string, number][]): [number, number, number] {
  let r = 0, g = 0, b = 0;
  
  for (const [color, weight] of colorWeights) {
    const rgb = hslToRgb(color);
    r += rgb[0] * weight;
    g += rgb[1] * weight;
    b += rgb[2] * weight;
  }
  
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Set the favicon to the hostname-based gradient
 */
export function setHostnameFavicon(): void {
  const canvas = createFaviconCanvas(32);
  const dataUrl = canvas.toDataURL('image/png');
  
  // Remove existing favicon
  const existing = document.querySelector('link[rel="icon"]');
  if (existing) existing.remove();
  
  // Add new favicon
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = dataUrl;
  document.head.appendChild(link);
}

/**
 * Apply hostname colors to the send button as CSS gradient
 */
export function applySendButtonColors(): void {
  const colors = getHostnameColors();
  
  // Set CSS custom properties for the gradient
  const root = document.documentElement;
  root.style.setProperty('--host-color-tl', colors[0]);
  root.style.setProperty('--host-color-tr', colors[1]);
  root.style.setProperty('--host-color-bl', colors[2]);
  root.style.setProperty('--host-color-br', colors[3]);
}

/**
 * Initialize hostname-based visual identification
 */
export function initHostnameHash(): void {
  setHostnameFavicon();
  applySendButtonColors();
}
