// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The offered-action click path (spec-offer-action-stage).
 *
 * Nothing exercised `#responseOptions` before this file, which is why the click
 * handler could send immediately without any test noticing. The seam that matters
 * is `dispatchPrompt`: "clicking an action must not send" is asserted against the
 * dispatch itself, not against the absence of `requestSubmit`, so a later change
 * to how the form submits cannot make this pass falsely.
 */

const seams = vi.hoisted(() => ({
  dispatchPrompt: vi.fn(),
  dispatchSteer: vi.fn(),
  getActiveSessionId: vi.fn(() => 'sess-1'),
  getNewChatCwd: vi.fn(() => '/repo'),
  notifyMessageSent: vi.fn(),
  getDraft: vi.fn(() => Promise.resolve(null)),
  putDraft: vi.fn(() => Promise.resolve()),
  deleteDraft: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../public/ts/message-streaming.js', () => ({
  dispatchPrompt: seams.dispatchPrompt,
  dispatchSteer: seams.dispatchSteer,
}));
vi.mock('../../public/ts/chat-draft-api.js', () => ({
  getDraft: seams.getDraft, putDraft: seams.putDraft, deleteDraft: seams.deleteDraft,
}));
vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: seams.getActiveSessionId,
  getNewChatCwd: seams.getNewChatCwd,
  notifyMessageSent: seams.notifyMessageSent,
}));
vi.mock('../../public/ts/chat-view-controller.js', () => ({
  chatView: { getCwd: () => '/repo', setFormEnabled: vi.fn() },
}));
vi.mock('../../public/ts/command-registry.js', () => ({ findCommand: () => null, getCommands: () => [] }));
vi.mock('../../public/ts/multiline-input.js', () => ({ poundProviders: [] }));
vi.mock('../../public/ts/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../public/ts/model-selector.js', () => ({ showNewChatError: vi.fn() }));
vi.mock('../../public/ts/image-paste.js', () => ({ removeImage: vi.fn() }));
vi.mock('../../public/ts/view-controller.js', () => ({ isViewState: () => true }));
vi.mock('../../public/ts/session-state-tracker.js', () => ({
  sessionTracker: { onChange: vi.fn(), get: () => ({ busy: false }) },
}));

import { ChatFormController } from '../../public/ts/chat-form-controller.js';
import { formStateStore } from '../../public/ts/form-state-store.js';

const OPTIONS = ['Fix the failing auth test', 'Add a regression test for the parser'];

function mount(): { form: HTMLFormElement; textarea: HTMLTextAreaElement; optionsEl: HTMLElement } {
  document.body.innerHTML = `
    <form id="chatForm">
      <div id="responseOptions"></div>
      <div class="input-bar">
        <textarea name="message"></textarea>
        <input type="hidden" name="imageData">
        <button type="submit" class="send-btn">Send</button>
        <button type="button" class="stop-btn">Stop</button>
      </div>
    </form>`;
  const form = document.getElementById('chatForm') as HTMLFormElement;
  const controller = new ChatFormController(form, 'chatting', {
    getDraftCache: () => undefined,
    setDraftCache: vi.fn(),
  });
  controller.attach();
  controller.bind('sess-1');
  formStateStore.set({ sessionBusy: false, options: OPTIONS.slice() });
  return {
    form,
    textarea: form.querySelector('textarea') as HTMLTextAreaElement,
    optionsEl: document.getElementById('responseOptions') as HTMLElement,
  };
}

const buttons = (el: HTMLElement): HTMLButtonElement[] =>
  [...el.querySelectorAll('.response-option-btn')] as HTMLButtonElement[];

beforeEach(() => {
  vi.clearAllMocks();
  formStateStore.set({ sessionBusy: false, options: [] });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('clicking an offered action stages it', () => {
  it('renders one button per option, carrying the full text', () => {
    const { optionsEl } = mount();
    expect(buttons(optionsEl).map(b => b.dataset.prompt)).toEqual(OPTIONS);
  });

  it('puts the full option text in the well', () => {
    const { textarea, optionsEl } = mount();

    buttons(optionsEl)[0].click();

    expect(textarea.value).toBe(OPTIONS[0]);
  });

  it('sends nothing — the second act is the send', () => {
    // The property the whole change exists for. Asserted on the dispatch seam
    // rather than on requestSubmit, so it survives a change to how submit works.
    const { optionsEl } = mount();

    buttons(optionsEl)[0].click();

    expect(seams.dispatchPrompt).not.toHaveBeenCalled();
    expect(seams.dispatchSteer).not.toHaveBeenCalled();
  });

  it('keeps the other options available after staging', () => {
    // Nothing was sent, so the offer is not spent: a user who clicked the wrong
    // option must still be able to pick another.
    const { optionsEl } = mount();

    buttons(optionsEl)[0].click();

    expect(formStateStore.get().options).toEqual(OPTIONS);
    expect(buttons(optionsEl)).toHaveLength(OPTIONS.length);
  });

  it('leaves the options visible but muted, not hidden', () => {
    // computeFormState reports optionsVisible=false and optionsMuted=true at the
    // same time when text is present; refreshButton renders on either, so muted
    // means shown-and-dimmed. Pinned because the two flags read as contradictory.
    const { optionsEl } = mount();

    buttons(optionsEl)[0].click();

    expect(optionsEl.style.display).not.toBe('none');
    for (const b of buttons(optionsEl)) expect(b.classList.contains('muted')).toBe(true);
  });

  it('focuses the well with the caret at the end, ready to amend', () => {
    const { textarea, optionsEl } = mount();

    buttons(optionsEl)[0].click();

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(OPTIONS[0].length);
  });

  it('restages when a different option is clicked', () => {
    const { textarea, optionsEl } = mount();

    buttons(optionsEl)[0].click();
    buttons(optionsEl)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(textarea.value).toBe(OPTIONS[1]);
    expect(seams.dispatchPrompt).not.toHaveBeenCalled();
  });

  it('does not let CSS make a muted option unclickable', async () => {
    // The behavioural test above CANNOT catch this: jsdom does no hit-testing,
    // so dispatching on the button works regardless of `pointer-events`. In a
    // real browser a `pointer-events: none` button makes the CONTAINER the event
    // target, `closest('.response-option-btn')` returns null, and the user who
    // staged the wrong option can never click another. Verified in Edge; pinned
    // here statically because that is the only place it is checkable.
    const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
    const mutedRule = /\.response-option-btn\.muted\s*\{([^}]*)\}/.exec(css);

    expect(mutedRule, '.response-option-btn.muted rule').not.toBeNull();
    expect(mutedRule![1]).not.toContain('pointer-events');
  });
});
