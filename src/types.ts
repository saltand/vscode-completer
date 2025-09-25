export type CompletionMode = 'both' | 'inline' | 'suggest'

export interface ExtensionConfig {
  mode: CompletionMode
  inlineTimeout: number
  suggestTimeout: number
  loopDelay: number
  showTitleButtonsWithoutFocus: boolean
  pauseOnUserTyping: boolean
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  mode: 'both',
  inlineTimeout: 1200,
  suggestTimeout: 800,
  loopDelay: 300,
  showTitleButtonsWithoutFocus: false,
  pauseOnUserTyping: true,
}

export const CONFIG_SECTION = 'completionsTester'
