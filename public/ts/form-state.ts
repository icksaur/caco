export type ButtonLabel = 'send' | 'stop' | 'steer';
export type ButtonAction = 'send' | 'abort' | 'steer' | 'none';

export interface FormState {
  buttonLabel: ButtonLabel;
  buttonAction: ButtonAction;
  buttonEnabled: boolean;
  placeholder: string;
  optionsVisible: boolean;
  optionsMuted: boolean;
}

export function computeFormState(sessionBusy: boolean, hasText: boolean, hasOptions = false): FormState {
  if (!sessionBusy) {
    // Idle: the Send button is ALWAYS present (never hidden) so the
    // input well never looks broken; it's simply disabled until the
    // textarea has content.
    return {
      buttonLabel: 'send',
      buttonAction: hasText ? 'send' : 'none',
      buttonEnabled: hasText,
      placeholder: 'Ask anything...',
      optionsVisible: hasOptions && !hasText,
      optionsMuted: hasOptions && hasText,
    };
  }
  // Busy: text → Steer (inject into the running turn), empty → Stop
  // (abort). Both are always enabled.
  return {
    buttonLabel: hasText ? 'steer' : 'stop',
    buttonAction: hasText ? 'steer' : 'abort',
    buttonEnabled: true,
    placeholder: 'Steer the agent...',
    optionsVisible: false,
    optionsMuted: false,
  };
}
