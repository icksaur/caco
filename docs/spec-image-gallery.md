# Image Gallery Applet

## Goals

Grid-based image browser for a directory. Shows thumbnails in rows (at least 4 wide), lazy-loaded as they scroll into view. Clicking a thumbnail opens the image-viewer applet. Image-viewer gets a "gallery" link back.

## Slug

`image-gallery`

## Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes | Absolute directory path to browse |

## UI Layout

Toolbar at top showing directory path. Below it, a scrollable grid of thumbnail images. At least 4 columns, responsive. "No images" message if directory has no supported files.

### Thumbnail grid

- CSS grid, `repeat(auto-fill, minmax(120px, 1fr))` — responsive, typically 4+ columns
- Each cell: square aspect ratio (`aspect-ratio: 1`), overflow hidden, subtle background color as loading placeholder
- Image scaled to cover (`object-fit: cover`)
- Filename below each thumbnail: small muted text, truncated with ellipsis (`text-overflow: ellipsis; white-space: nowrap; overflow: hidden`)
- Click navigates to `/?applet=image-viewer&path=<abs_path>`
- Sort order: alphabetical by filename (inherited from API)

### Supported extensions

`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`

Filter at load time — only show files matching these extensions (case-insensitive).

## Lazy Loading

Images must not all fetch at once. Strategy:

1. Fetch directory listing via `GET /api/files?path=<dir>` — returns file names + sizes. Filter to image extensions.
2. Render placeholder grid cells for all images (empty divs with filename).
3. Use `IntersectionObserver` on each cell. When a cell enters the viewport, set `img.src` to `GET /api/file?path=<abs_path>`.
4. Handle 413 responses (file > 10MB) — show "too large" placeholder instead of broken image.
5. Once loaded, the image stays (no unloading on scroll-out).

This means only visible thumbnails fetch their image data. Scrolling down progressively loads more.

## No-image State

If the directory exists but has no matching image files: show centered "No images in this directory" message.

If the directory doesn't exist or `GET /api/files` fails: show error with directory path.

## Image-Viewer Integration

### Gallery → Viewer

Each thumbnail click: `/?applet=image-viewer&path=<absolute_image_path>`

### Viewer → Gallery

Add a "📁 gallery" link to the image-viewer toolbar. Derives the directory from the current image path (`path.split('/').slice(0, -1).join('/')`). Links to `/?applet=image-gallery&path=<dir>`.

## Design

### Applet files: `applets/image-gallery/`

**`meta.json`:**
```json
{
  "slug": "image-gallery",
  "name": "Image Gallery",
  "description": "Browse images in a directory",
  "params": { "path": { "required": true, "description": "Directory path" } }
}
```

**`content.html`:**
- Toolbar div with path display
- Scrollable grid container
- Empty/error state divs

**`script.js`:**
- `loadGallery(dirPath)` — fetch `GET /api/files?path=<dir>`, filter to image extensions, render grid
- `IntersectionObserver` on `.gallery-cell` elements — set `img.src` on intersect
- Click handler via event delegation on grid container
- `onUrlParamsChange` for initial load

**`style.css`:**
- `.gallery-grid` — CSS grid, `repeat(auto-fill, minmax(150px, 1fr))`, gap
- `.gallery-cell` — square aspect ratio (`aspect-ratio: 1`), overflow hidden, cursor pointer
- `.gallery-cell img` — `width: 100%; height: 100%; object-fit: cover`
- `.gallery-cell .gallery-name` — filename below thumbnail
- Hover effect on cells

### Image-viewer change: `applets/image-viewer/`

**`content.html`:** Add gallery link button to toolbar controls:
```html
<a class="iv-btn" id="ivGallery" title="Gallery" style="display:none">📁</a>
```

**`script.js`:** After image loads, derive directory path from `currentPath`, show gallery link:
```javascript
var dir = currentPath.split('/').slice(0, -1).join('/');
var galleryLink = document.getElementById('ivGallery');
galleryLink.href = '?applet=image-gallery&path=' + encodeURIComponent(dir);
galleryLink.style.display = '';
```

## API Dependencies

Both endpoints already exist:
- `GET /api/files?path=<dir>` — directory listing with name, type, size
- `GET /api/file?path=<file>` — serves file content with proper MIME type

No new endpoints needed.

## Risks and Mitigations

1. **Large directories** — hundreds of images. IntersectionObserver handles this — only visible images load. Directory listing itself is fast (just filenames).
2. **Thumbnail size** — full images served as thumbnails. No server-side resizing. `/api/file` rejects files > 10MB with 413 — gallery shows "too large" placeholder. For large photos below the limit, browser scales in CSS. Acceptable for v1.
3. **Cross-platform paths** — directory derivation in viewer→gallery link must handle both `/` and `\` separators (use regex split like existing applets).
4. **Symlinked directories** — `readdir` reports symlinks to directories as files, so they won't appear as browseable. Symlinks to image files work normally. Acceptable limitation.

## Acceptance

- Observable: Navigate to `/?applet=image-gallery&path=<dir>`. Thumbnails render in a 4+ column grid. Scrolling loads more images lazily (only visible cells fetch). Clicking a thumbnail opens `image-viewer`. Image-viewer shows a "📁 gallery" toolbar link.
- Budgets: Only visible thumbnails fetch. Files >10 MB show "too large" placeholder (API 413).
- Gates: `npm run build`, `npm test` green.
- Oracles: by-construction (no dedicated unit test); visual signoff on grid, lazy-load, and viewer↔gallery round-trip.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Create applet: meta, HTML, CSS skeleton | `applets/image-gallery/meta.json`, `content.html`, `style.css` | by-construction |
| 2 | Load directory + filter to image extensions | `applets/image-gallery/script.js` | visual: grid appears with filenames |
| 3 | IntersectionObserver lazy-load | `applets/image-gallery/script.js` | visual: only scrolled-into-view cells load |
| 4 | Add gallery link to image-viewer | `applets/image-viewer/content.html`, `script.js` | visual: 📁 link in toolbar navigates back |
