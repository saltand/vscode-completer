import { useLogger } from 'reactive-vscode'
import { EXTENSION_DISPLAY_NAME } from './constants'

export const logger = useLogger(EXTENSION_DISPLAY_NAME)
