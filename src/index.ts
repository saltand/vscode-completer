import type { ExtensionConfig } from './types'
import { defineExtension } from 'reactive-vscode'
import { commands, extensions, window, workspace } from 'vscode'
import { config } from './config'
import { COMMAND_START, COMMAND_STOP, CONTEXT_RUNNING, CONTEXT_SHOW_WITHOUT_FOCUS, TARGET_EXTENSION_ID } from './constants'
import { CompletionTesterRunner } from './runner'
import { CONFIG_SECTION, DEFAULT_CONFIG } from './types'
import { logger } from './utils'

const runner = new CompletionTesterRunner(readConfigSnapshot, (running) => {
  void commands.executeCommand('setContext', CONTEXT_RUNNING, running)
})

const { activate, deactivate } = defineExtension((context) => {
  void commands.executeCommand('setContext', CONTEXT_RUNNING, false)
  void updateShowButtonsContext()

  const startDisposable = commands.registerCommand(COMMAND_START, async () => {
    const targetReady = await ensureTargetExtension()
    if (!targetReady)
      return

    if (runner.isRunning()) {
      void window.showInformationMessage('Completion tester is already running.')
      return
    }

    try {
      await runner.start()
      logger.info('Completion tester started')
    }
    catch (error) {
      logger.error('Failed to start completion tester', error)
      void window.showErrorMessage('Failed to start completion tester. Check logs for details.')
    }
  })

  const stopDisposable = commands.registerCommand(COMMAND_STOP, async () => {
    if (!runner.isRunning()) {
      void window.showInformationMessage('Completion tester is not running.')
      return
    }

    try {
      await runner.stop()
      logger.info('Completion tester stopped')
    }
    catch (error) {
      logger.error('Failed to stop completion tester', error)
      void window.showErrorMessage('Failed to stop completion tester. Check logs for details.')
    }
  })

  const configDisposable = workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration(`${CONFIG_SECTION}.showTitleButtonsWithoutFocus`))
      await updateShowButtonsContext()
  })

  context.subscriptions.push(
    startDisposable,
    stopDisposable,
    configDisposable,
    { dispose: () => { void runner.stop() } },
  )
})

async function updateShowButtonsContext() {
  const { showTitleButtonsWithoutFocus } = readConfigSnapshot()
  await commands.executeCommand('setContext', CONTEXT_SHOW_WITHOUT_FOCUS, showTitleButtonsWithoutFocus)
}

function readConfigSnapshot(): ExtensionConfig {
  const defaults = DEFAULT_CONFIG
  return {
    mode: config.mode,
    inlineTimeout: sanitizeNumber(config.inlineTimeout, defaults.inlineTimeout),
    suggestTimeout: sanitizeNumber(config.suggestTimeout, defaults.suggestTimeout),
    loopDelay: sanitizeNumber(config.loopDelay, defaults.loopDelay),
    showTitleButtonsWithoutFocus: Boolean(config.showTitleButtonsWithoutFocus),
    pauseOnUserTyping: Boolean(config.pauseOnUserTyping),
  }
}

function sanitizeNumber(value: unknown, fallback: number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback
}

async function ensureTargetExtension() {
  const target = extensions.getExtension(TARGET_EXTENSION_ID)
  if (!target) {
    logger.warn(`Required extension ${TARGET_EXTENSION_ID} not found`)
    void window.showErrorMessage(`Required extension ${TARGET_EXTENSION_ID} is not installed.`)
    return false
  }

  if (target.isActive)
    return true

  try {
    await target.activate()
    logger.info(`Activated extension ${TARGET_EXTENSION_ID}`)
    return true
  }
  catch (error) {
    logger.error(`Failed to activate ${TARGET_EXTENSION_ID}`, error)
    void window.showErrorMessage(`Failed to activate ${TARGET_EXTENSION_ID}. Check logs for details.`)
    return false
  }
}

export { activate, deactivate }
