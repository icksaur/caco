/**
 * Image Utilities
 * 
 * Pure functions for handling image data URLs.
 */

export interface ParsedImageData {
  extension: string;
  base64Data: string;
}

/**
 * Parse a data URL into its components.
 * Returns null if the data URL is invalid or not an image.
 * 
 * @example
 * parseImageDataUrl('data:image/png;base64,iVBORw0KGgo...')
 * // => { extension: 'png', base64Data: 'iVBORw0KGgo...' }
 * 
 * parseImageDataUrl('not a data url')
 * // => null
 */
export function parseImageDataUrl(imageData: string | undefined): ParsedImageData | null {
  if (!imageData || !imageData.startsWith('data:image/')) {
    return null;
  }
  
  const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) {
    return null;
  }
  
  return {
    extension: matches[1],
    base64Data: matches[2]
  };
}
