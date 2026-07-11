// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ActiveSessionCallback = (prev: string | null, next: string | null) => void;

let activeSessionId: string | null;
let setHasImage: ReturnType<typeof vi.fn>;
let addWidget: ReturnType<typeof vi.fn>;
let widgetUpdate: ReturnType<typeof vi.fn>;
let widgetRemove: ReturnType<typeof vi.fn>;
let activeSessionCallback: ActiveSessionCallback | null;
let pasteHandler: ((e: ClipboardEvent) => void) | null;
let nextDataUrl: string;

async function loadImagePaste() {
  vi.resetModules();
  activeSessionId = null;
  setHasImage = vi.fn();
  widgetUpdate = vi.fn();
  widgetRemove = vi.fn();
  addWidget = vi.fn(() => ({ update: widgetUpdate, remove: widgetRemove }));
  activeSessionCallback = null;
  pasteHandler = null;
  nextDataUrl = 'data:image/png;base64,AAA';
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'paste') pasteHandler = listener as (e: ClipboardEvent) => void;
  });
  vi.doMock('../../public/ts/app-state.js', () => ({
    setHasImage,
    getActiveSessionId: vi.fn(() => activeSessionId),
    onActiveSessionChange: vi.fn((cb: ActiveSessionCallback) => {
      activeSessionCallback = cb;
    }),
  }));
  vi.doMock('../../public/ts/adhoc-bar.js', () => ({ adHocBar: { addWidget } }));
  vi.doMock('../../public/ts/chat-view-controller.js', () => ({
    chatView: {
      getChattingForm: vi.fn(() => ({
        imageDataInput: document.getElementById('imageData') as HTMLInputElement,
      })),
    },
  }));
  vi.stubGlobal('FileReader', class {
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

    readAsDataURL(_blob: Blob): void {
      this.onload?.({ target: { result: nextDataUrl } } as unknown as ProgressEvent<FileReader>);
    }
  } as typeof FileReader);
  const mod = await import('../../public/ts/image-paste.js');
  mod.setupImagePaste();
  expect(pasteHandler).not.toBeNull();
  return mod;
}

function imagePasteEvent(type = 'image/png'): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  const item = {
    type,
    getAsFile: vi.fn(() => new Blob(['image'], { type })),
  };
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [item] },
  });
  return event;
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '<input id="imageData" type="hidden"><div id="adHocBar"></div>';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image-paste', () => {
  it('extracts a pasted image into the hidden input and direct new-chat thumbnail DOM', async () => {
    await loadImagePaste();

    const event = imagePasteEvent();
    pasteHandler!(event);

    const input = document.getElementById('imageData') as HTMLInputElement;
    const bar = document.getElementById('adHocBar')!;
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('data:image/png;base64,AAA');
    expect(setHasImage).toHaveBeenCalledWith(true);
    expect(addWidget).not.toHaveBeenCalled();
    expect(bar.classList.contains('visible')).toBe(true);
    expect(bar.querySelectorAll('.image-thumb')).toHaveLength(1);
    expect(bar.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('uses the ad-hoc widget seam for active-session images and updates an existing widget', async () => {
    await loadImagePaste();
    activeSessionId = 'sess-1';

    pasteHandler!(imagePasteEvent());
    nextDataUrl = 'data:image/png;base64,BBB';
    pasteHandler!(imagePasteEvent());

    expect(addWidget).toHaveBeenCalledTimes(1);
    expect(addWidget).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      id: 'images',
      priority: 0,
      render: expect.any(Function),
    }));
    expect(widgetUpdate).toHaveBeenCalledTimes(1);
    expect((document.getElementById('imageData') as HTMLInputElement).value).toBe(
      'data:image/png;base64,AAA\ndata:image/png;base64,BBB',
    );
  });

  it('removes direct thumbnails and clears the image seam from the remove button', async () => {
    await loadImagePaste();
    pasteHandler!(imagePasteEvent());

    document.querySelector<HTMLButtonElement>('.image-remove-btn')?.click();

    expect((document.getElementById('imageData') as HTMLInputElement).value).toBe('');
    expect(setHasImage).toHaveBeenLastCalledWith(false);
    expect(document.getElementById('adHocBar')?.classList.contains('visible')).toBe(false);
    expect(document.querySelectorAll('.image-thumb')).toHaveLength(0);
  });

  it('ignores non-image clipboard items', async () => {
    await loadImagePaste();

    const event = imagePasteEvent('text/plain');
    pasteHandler!(event);

    expect(event.defaultPrevented).toBe(false);
    expect(setHasImage).not.toHaveBeenCalled();
    expect((document.getElementById('imageData') as HTMLInputElement).value).toBe('');
  });

  it('clears active-session images and removes the widget when the active session changes', async () => {
    await loadImagePaste();
    activeSessionId = 'sess-1';
    pasteHandler!(imagePasteEvent());

    activeSessionCallback?.('sess-1', 'sess-2');

    expect(widgetRemove).toHaveBeenCalledTimes(1);
    expect(setHasImage).toHaveBeenLastCalledWith(false);
    expect((document.getElementById('imageData') as HTMLInputElement).value).toBe('');
  });
});
