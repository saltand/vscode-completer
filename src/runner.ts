import type { Disposable, TextDocument, TextEditor, TextEditorEdit } from 'vscode'
import type { ExtensionConfig } from './types'
import { commands, Position, Range, Selection, TextEditorSelectionChangeKind, window, workspace, WorkspaceEdit } from 'vscode'
import { logger } from './utils'

const SEEDS = ['i', 'r', 'h', 't', 'j'] as const
const USER_IDLE_GRACE_MS = 800
const POST_COMMIT_SETTLE_MS = 50

export class CompletionTesterRunner {
  private running = false
  private abortController: AbortController | undefined
  private loopPromise: Promise<void> | undefined
  private document: TextDocument | undefined
  private suppressActivity = 0
  private lastUserActivity = 0
  private disposables: Disposable[] = []
  private seedIndex = 0
  private readonly getConfig: () => ExtensionConfig
  private readonly reportState: (running: boolean) => void
  private editor: TextEditor | undefined
  private cycleIteration = 0
  private cycleSnapshotText: string | undefined
  private cycleSnapshotSelections: Selection[] | undefined

  constructor(getConfig: () => ExtensionConfig, reportState: (running: boolean) => void) {
    this.getConfig = () => ({ ...getConfig() })
    this.reportState = reportState
  }

  isRunning() {
    return this.running
  }

  async start() {
    if (this.running)
      return

    this.running = true
    this.seedIndex = 0
    this.cycleIteration = 0
    this.cycleSnapshotText = undefined
    this.cycleSnapshotSelections = undefined
    this.abortController = new AbortController()
    this.setupUserActivityListeners()
    this.reportState(true)

    this.loopPromise = this.runLoop(this.abortController.signal).catch((error) => {
      if (!isAbortError(error))
        logger.error('Completion loop failed', error)
    })
  }

  async stop() {
    if (!this.running)
      return

    const controller = this.abortController
    controller?.abort()

    try {
      await this.loopPromise
    }
    catch (error) {
      if (!isAbortError(error))
        logger.error('Error while stopping tester', error)
    }

    this.running = false
    this.abortController = undefined
    this.loopPromise = undefined
    this.disposeUserActivityListeners()
    this.reportState(false)

    if (this.editor) {
      try {
        await this.editor.hide()
      }
      catch (error) {
        logger.warn('Failed to hide test editor', error)
      }
    }

    this.editor = undefined
    this.document = undefined
    this.cycleIteration = 0
    this.cycleSnapshotText = undefined
    this.cycleSnapshotSelections = undefined
  }

  dispose() {
    void this.stop()
  }

  private async runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.waitForUserIdle(signal)
        const document = await this.ensureDocument(signal)
        const editor = await this.runSuppressed(() => window.showTextDocument(document, { preview: false, preserveFocus: false }))
        this.editor = editor
        const config = this.getConfig()

        signal.throwIfAborted()

        const currentText = document.getText()
        if (this.cycleIteration === 0) {
          this.cycleSnapshotText = currentText
          this.cycleSnapshotSelections = editor.selections.map(cloneSelection)
        }

        const insertionPosition = document.positionAt(currentText.length)
        await this.runSuppressed(() => {
          editor.selections = [new Selection(insertionPosition, insertionPosition)]
        })

        const seed = SEEDS[this.seedIndex % SEEDS.length]
        this.seedIndex++

        await this.runSuppressed(async () => {
          const inserted = await editor.edit((editBuilder: TextEditorEdit) => {
            editBuilder.insert(insertionPosition, seed)
          })
          if (!inserted)
            throw new Error('Failed to insert seed text')
          const afterPosition = editor.document.positionAt(editor.document.getText().length)
          editor.selections = [new Selection(afterPosition, afterPosition)]
        })

        await sleep(POST_COMMIT_SETTLE_MS, signal)

        const seededBytes = byteLength(document.getText())

        let delta = 0
        if (shouldAttemptInline(config.mode)) {
          delta = await this.tryInline(seededBytes, document, signal, config.inlineTimeout)
        }

        if (delta === 0 && shouldAttemptSuggest(config.mode))
          delta = await this.trySuggest(seededBytes, document, signal, config.suggestTimeout)

        this.cycleIteration++

        if (this.cycleIteration >= 3) {
          const snapshotText = this.cycleSnapshotText ?? ''
          const snapshotSelections = this.cycleSnapshotSelections ?? [new Selection(new Position(0, 0), new Position(0, 0))]
          await this.restoreSnapshot(document, snapshotText, snapshotSelections, signal)
          this.cycleIteration = 0
          this.cycleSnapshotText = undefined
          this.cycleSnapshotSelections = undefined
        }
        else {
          await this.prepareNextLine(editor, signal)
        }

        await sleep(config.loopDelay, signal)
      }
      catch (error) {
        if (isAbortError(error))
          break

        logger.error('Unexpected error in completion loop', error)
        await delayWithAbort(500, signal)
      }
    }
  }

  private async tryInline(referenceBytes: number, document: TextDocument, signal: AbortSignal, timeout: number) {
    await this.runSuppressed(() => commands.executeCommand('editor.action.inlineSuggest.trigger'))
    await delayWithAbort(timeout, signal)
    await this.runSuppressed(() => commands.executeCommand('editor.action.inlineSuggest.commit'))
    await sleep(POST_COMMIT_SETTLE_MS, signal)
    return byteLength(document.getText()) - referenceBytes
  }

  private async trySuggest(referenceBytes: number, document: TextDocument, signal: AbortSignal, timeout: number) {
    await this.runSuppressed(() => commands.executeCommand('editor.action.triggerSuggest'))
    await delayWithAbort(timeout, signal)
    await this.runSuppressed(() => commands.executeCommand('acceptSelectedSuggestion'))
    await sleep(POST_COMMIT_SETTLE_MS, signal)
    return byteLength(document.getText()) - referenceBytes
  }

  private async ensureDocument(signal: AbortSignal) {
    let document = this.document
    if (!document || document.isClosed) {
      document = await workspace.openTextDocument({ language: 'javascript', content: '' })
      this.document = document
      this.editor = undefined
    }

    signal.throwIfAborted()
    return document
  }

  private async restoreSnapshot(document: TextDocument, text: string, selections: Selection[], signal: AbortSignal) {
    await this.runSuppressed(async () => {
      const edit = new WorkspaceEdit()
      edit.replace(document.uri, fullDocumentRange(document), text)
      const applied = await workspace.applyEdit(edit)
      if (!applied)
        throw new Error('Failed to restore document')
    })

    await sleep(POST_COMMIT_SETTLE_MS, signal)

    if (this.editor && this.editor.document === document) {
      await this.runSuppressed(() => {
        this.editor!.selections = selections
      })
    }
  }

  private async prepareNextLine(editor: TextEditor, signal: AbortSignal) {
    await this.runSuppressed(async () => {
      const document = editor.document
      const endBefore = document.positionAt(document.getText().length)
      editor.selections = [new Selection(endBefore, endBefore)]
      const inserted = await editor.edit((editBuilder: TextEditorEdit) => {
        editBuilder.insert(endBefore, '\n')
      })
      if (!inserted)
        throw new Error('Failed to append newline for next iteration')
      const endAfter = document.positionAt(document.getText().length)
      editor.selections = [new Selection(endAfter, endAfter)]
    })

    await sleep(POST_COMMIT_SETTLE_MS, signal)
  }

  private async waitForUserIdle(signal: AbortSignal) {
    const config = this.getConfig()
    if (!config.pauseOnUserTyping)
      return

    while (!signal.aborted) {
      const idle = Date.now() - this.lastUserActivity
      if (idle >= USER_IDLE_GRACE_MS)
        break
      await delayWithAbort(100, signal)
    }
  }

  private runSuppressed<T>(fn: () => PromiseLike<T> | T) {
    this.suppressActivity++
    const done = () => {
      this.suppressActivity = Math.max(0, this.suppressActivity - 1)
    }

    try {
      const result = fn()
      return Promise.resolve(result).finally(done)
    }
    catch (error) {
      done()
      return Promise.reject(error)
    }
  }

  private setupUserActivityListeners() {
    if (this.disposables.length)
      return

    this.disposables.push(
      window.onDidChangeTextEditorSelection((event) => {
        if (this.suppressActivity > 0 && event.textEditor === this.editor)
          return

        if (event.kind === TextEditorSelectionChangeKind.Command && event.textEditor === this.editor && this.suppressActivity > 0)
          return

        this.lastUserActivity = Date.now()
      }),
      workspace.onDidChangeTextDocument((event) => {
        if (this.suppressActivity > 0 && event.document === this.document)
          return
        this.lastUserActivity = Date.now()
      }),
    )
  }

  private disposeUserActivityListeners() {
    for (const disposable of this.disposables)
      disposable.dispose()
    this.disposables = []
    this.lastUserActivity = 0
  }
}

function cloneSelection(selection: Selection) {
  return new Selection(selection.start, selection.end)
}

function fullDocumentRange(document: TextDocument) {
  const lastLine = document.lineCount ? document.lineAt(document.lineCount - 1) : undefined
  const end = lastLine ? lastLine.range.end : new Position(0, 0)
  return new Range(new Position(0, 0), end)
}

function byteLength(text: string) {
  // eslint-disable-next-line node/prefer-global/buffer
  return Buffer.byteLength(text, 'utf8')
}

function shouldAttemptInline(mode: ExtensionConfig['mode']) {
  return mode === 'both' || mode === 'inline'
}

function shouldAttemptSuggest(mode: ExtensionConfig['mode']) {
  return mode === 'both' || mode === 'suggest'
}

async function sleep(ms: number, signal: AbortSignal) {
  return delayWithAbort(ms, signal)
}

async function delayWithAbort(ms: number, signal: AbortSignal) {
  if (signal.aborted)
    throw new AbortError()

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(handleResolve, ms)

    const abortHandler = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abortHandler)
      reject(new AbortError())
    }

    function handleResolve() {
      signal.removeEventListener('abort', abortHandler)
      resolve()
    }

    signal.addEventListener('abort', abortHandler, { once: true })
  })
}

class AbortError extends Error {
  constructor() {
    super('Operation aborted')
    this.name = 'AbortError'
  }
}

function isAbortError(error: unknown): error is AbortError {
  return error instanceof AbortError
}
