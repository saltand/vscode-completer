import type { ExtensionConfig } from './types'
import { defineConfigObject } from 'reactive-vscode'
import { CONFIG_SECTION, DEFAULT_CONFIG } from './types'

export const config = defineConfigObject<ExtensionConfig>(
  CONFIG_SECTION,
  DEFAULT_CONFIG,
)
