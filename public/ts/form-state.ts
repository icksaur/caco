export type ButtonLabel = 'send' | 'stop' | 'steer' | 'hidden';
export type ButtonAction = 'send' | 'abort' | 'steer' | 'none';

export interface FormState {
  buttonLabel: ButtonLabel;
  buttonAction: ButtonAction;
  placeholder: string;
  optionsVisible: boolean;
  optionsMuted: boolean;
}

export function computeFormState(sessionBusy: boolean, hasText: boolean, hasOptions = false): FormState {
  if (!sessionBusy) {
    return {
      buttonLabel: hasText ? 'send' : 'hidden',
      buttonAction: hasText ? 'send' : 'none',
      placeholder: 'Ask anything...',
      optionsVisible: hasOptions && !hasText,
      optionsMuted: hasOptions && hasText,
    };
  }
  return {
    buttonLabel: hasText ? 'steer' : 'stop',
    buttonAction: hasText ? 'steer' : 'abort',
    placeholder: 'Steer the agent...',
    optionsVisible: false,
    optionsMuted: false,
  };
}
