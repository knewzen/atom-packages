"use babel"

const settings = require("./settings")
const VimState = require("./vim-state")

let selectList, FILE_TABLE

function classify(s) {
  return s[0].toUpperCase() + s.slice(1).replace(/-(\w)/g, m => m[1].toUpperCase())
}

function dasherize(s) {
  return (s[0].toLowerCase() + s.slice(1)).replace(/[A-Z]/g, m => "-" + m.toLowerCase())
}

class Base {
  static classTable = {}

  static commandPrefix = "vim-mode-plus"
  static commandScope = null
  static operationKind = null

  recordable = false
  repeated = false
  count = null
  defaultCount = 1

  get name() {
    return this.constructor.name
  }

  constructor(vimState) {
    this.vimState = vimState
  }

  initialize() {}

  // Called both on cancel and success
  resetState() {}

  // OperationStack postpone execution untill isReady() get true, overridden on subclass.
  isReady() {
    return true
  }

  // VisualModeSelect is anormal, since it auto complemented in visial mode.
  // In other word, normal-operator is explicit whereas anormal-operator is inplicit.
  isTargetOfNormalOperator() {
    return this.operator && this.operator.name !== "VisualModeSelect"
  }

  getCount(offset = 0) {
    if (this.count == null) {
      this.count = this.vimState.hasCount() ? this.vimState.getCount() : this.defaultCount
    }
    return this.count + offset
  }

  resetCount() {
    this.count = null
  }

  countTimes(last, fn) {
    if (last < 1) return

    let stopped = false
    const stop = () => (stopped = true)
    for (let count = 1; count <= last; count++) {
      fn({count, isFinal: count === last, stop})
      if (stopped) break
    }
  }

  activateMode(mode, submode) {
    this.onDidFinishOperation(() => this.vimState.activate(mode, submode))
  }

  activateModeIfNecessary(mode, submode) {
    if (!this.vimState.isMode(mode, submode)) {
      this.activateMode(mode, submode)
    }
  }

  getInstance(name, properties) {
    return this.constructor.getInstance(this.vimState, name, properties)
  }

  cancelOperation() {
    this.vimState.operationStack.cancel(this)
  }

  processOperation() {
    this.vimState.operationStack.process()
  }

  focusSelectList(options = {}) {
    this.onDidCancelSelectList(() => this.cancelOperation())
    if (!selectList) {
      selectList = new (require("./select-list"))()
    }
    selectList.show(this.vimState, options)
  }

  focusInput(options = {}) {
    if (!options.onConfirm) {
      options.onConfirm = input => {
        this.input = input
        this.processOperation()
      }
    }
    if (!options.onCancel) options.onCancel = () => this.cancelOperation()
    if (!options.onChange) options.onChange = input => this.vimState.hover.set(input)

    this.vimState.focusInput(options)
  }

  // Return promise which resolve with input char or `undefined` when cancelled.
  focusInputPromised(options = {}) {
    return new Promise(resolve => {
      const defaultOptions = {hideCursor: true, onChange: input => this.vimState.hover.set(input)}
      this.vimState.focusInput(Object.assign(defaultOptions, options, {onConfirm: resolve, onCancel: resolve}))
    })
  }

  readChar() {
    this.vimState.readChar({
      onConfirm: input => {
        this.input = input
        this.processOperation()
      },
      onCancel: () => this.cancelOperation(),
    })
  }

  // Return promise which resolve with read char or `undefined` when cancelled.
  readCharPromised() {
    return new Promise(resolve => {
      this.vimState.readChar({onConfirm: resolve, onCancel: resolve})
    })
  }

  instanceof(klassName) {
    return this instanceof Base.getClass(klassName)
  }

  isOperator() {
    // Don't use `instanceof` to postpone require for faster activation.
    return this.constructor.operationKind === "operator"
  }

  isMotion() {
    // Don't use `instanceof` to postpone require for faster activation.
    return this.constructor.operationKind === "motion"
  }

  isTextObject() {
    // Don't use `instanceof` to postpone require for faster activation.
    return this.constructor.operationKind === "text-object"
  }

  getCursorBufferPosition() {
    return this.getBufferPositionForCursor(this.editor.getLastCursor())
  }

  getCursorBufferPositions() {
    return this.editor.getCursors().map(cursor => this.getBufferPositionForCursor(cursor))
  }

  getCursorBufferPositionsOrdered() {
    return this.utils.sortPoints(this.getCursorBufferPositions())
  }

  getBufferPositionForCursor(cursor) {
    return this.mode === "visual" ? this.getCursorPositionForSelection(cursor.selection) : cursor.getBufferPosition()
  }

  getCursorPositionForSelection(selection) {
    return this.swrap(selection).getBufferPositionFor("head", {from: ["property", "selection"]})
  }

  getOperationTypeChar() {
    return {operator: "O", "text-object": "T", motion: "M", "misc-command": "X"}[this.constructor.operationKind]
  }

  toString() {
    const base = `${this.name}<${this.getOperationTypeChar()}>`
    return this.target ? `${base}{target = ${this.target.toString()}}` : base
  }

  getCommandName() {
    return this.constructor.getCommandName()
  }

  getCommandNameWithoutPrefix() {
    return this.constructor.getCommandNameWithoutPrefix()
  }

  // # How vmp commands become available?
  // #========================================
  // Vmp have many commands, loading full commands at startup slow down pkg activation.
  // So vmp load summary command table only at startup then lazy require command body on-used timing.
  // Here is how vmp commands are registerd and invoked.
  // Initially introduced in PR #758
  //
  // 1. [On dev]: Preparation done by developer
  //   - Invoking `Vim Mode Plus:Write Command Table And File Table To Disk`. it does following.
  //   - "./command-table.json" and "./file-table.json". are updated.
  //
  // 2. [On atom/vmp startup]
  //   - Register commands(e.g. `move-down`) from "./command-table.json".
  //
  // 3. [On run time]: e.g. Invoke `move-down` by `j` keystroke
  //   - Fire `move-down` command.
  //   - It execute `vimState.operationStack.run("MoveDown")`
  //   - Determine files to require from "./file-table.json".
  //   - Load `MoveDown` class by require('./motions') and run it!
  //
  static async writeCommandTableAndFileTableToDisk() {
    const path = require("path")
    const commandTablePath = path.join(__dirname, "command-table.json")
    const fileTablePath = path.join(__dirname, "file-table.json")

    const {commandTable, fileTable} = this.buildCommandTableAndFileTable()
    const _ = require("underscore-plus")
    delete require.cache[commandTablePath] // invalidate cache
    delete require.cache[fileTablePath] // invalidate cache
    const needUpdateCommandTable = !_.isEqual(require(commandTablePath), commandTable)
    const needUpdateFileTable = !_.isEqual(require(fileTablePath), fileTable)

    if (!needUpdateCommandTable && !needUpdateFileTable) {
      atom.notifications.addInfo("No changfes in commandTable and fileTable", {dismissable: true})
      return
    }

    const writeJSON = (filePath, object) => {
      return atom.workspace.open(filePath, {activatePane: false, activateItem: false}).then(editor => {
        editor.setText(JSON.stringify(object))
        const baseName = path.basename(filePath)
        return editor.save().then(() => atom.notifications.addInfo(`Updated ${baseName}`, {dismissable: true}))
      })
    }

    if (needUpdateCommandTable) await writeJSON(commandTablePath, commandTable)
    if (needUpdateFileTable) await writeJSON(fileTablePath, fileTable)
  }

  static isCommand() {
    return this.hasOwnProperty("command") ? this.command : true
  }

  static buildCommandTableAndFileTable() {
    // NOTE: changing order affects output of lib/command-table.json
    const filesToLoad = [
      "./operator",
      "./operator-insert",
      "./operator-transform-string",
      "./motion",
      "./motion-search",
      "./text-object",
      "./misc-command",
    ]

    const fileTable = {}
    const commandTable = []

    for (const file of filesToLoad) {
      fileTable[file] = []

      for (const klass of Object.values(require(file))) {
        if (klass.name in fileTable) {
          throw new Error(`Duplicate operation class ${klass.name} in "${file}" and "${fileTable[klass.name]}"`)
        }
        fileTable[file].push(klass.name)
        if (klass.isCommand()) commandTable.push(klass.getCommandName())
      }
    }
    return {commandTable, fileTable}
  }

  // Return disposables for vmp commands.
  static init() {
    return require("./command-table.json").map(name => this.registerCommandFromSpec(null, {name}))
  }

  static getClass(name) {
    if (!(name in this.classTable)) {
      if (!FILE_TABLE) {
        FILE_TABLE = {}
        const loaded = require("./file-table.json")
        Object.keys(loaded).forEach(file => loaded[file].forEach(name => (FILE_TABLE[name] = file)))
      }
      if (atom.inDevMode() && settings.get("debug")) {
        console.log(`lazy-require: ${FILE_TABLE[name]} for ${name}`)
      }
      Object.values(require(FILE_TABLE[name])).forEach(klass => klass.register())
    }
    if (name in this.classTable) return this.classTable[name]
    throw new Error(`class '${name}' not found`)
  }

  static getInstance(vimState, klass, properties) {
    klass = typeof klass === "function" ? klass : Base.getClass(klass)
    const object = new klass(vimState)
    if (properties) Object.assign(object, properties)
    object.initialize()
    return object
  }

  // Dont remove this. Public API to register operations to classTable
  // This can be used from vmp-plugin such as vmp-ex-mode.
  static register() {
    if (this.name in this.classTable) console.warn(`Duplicate constructor ${this.name}`)
    this.classTable[this.name] = this
  }

  static getCommandName(prefix = this.commandPrefix, name = this.name) {
    return prefix + ":" + dasherize(name)
  }

  static getCommandNameWithoutPrefix() {
    return dasherize(this.name)
  }

  static registerCommand() {
    return this.registerCommandFromSpec(this.name, {
      scope: this.commandScope,
      name: this.getCommandName(),
      getClass: () => this,
    })
  }

  static registerCommandFromSpec(klass, {scope, name, prefix, getClass}) {
    if (!name) name = this.getCommandName(prefix, klass)
    return atom.commands.add(scope || "atom-text-editor", name, function(event) {
      const vimState = VimState.get(this.getModel())

      // vimState possibly be undefined See #85
      if (vimState) {
        if (!klass) klass = classify(name.replace("vim-mode-plus:", ""))
        vimState.operationStack.run(getClass ? getClass(klass) : klass)
      }
      event.stopPropagation()
    })
  }

  static getKindForCommandName(command) {
    const commandWithoutPrefix = command.replace(/^vim-mode-plus:/, "")
    const commandClassName = classify(commandWithoutPrefix)
    if (commandClassName in this.classTable) {
      return this.classTable[commandClassName].operationKind
    }
  }

  getSmoothScrollDuation(kind) {
    const base = "smoothScrollOn" + kind
    return this.getConfig(base) ? this.getConfig(base + "Duration") : 0
  }

  // Proxy propperties and methods
  //===========================================================================
  get mode() { return this.vimState.mode } // prettier-ignore
  get submode() { return this.vimState.submode } // prettier-ignore
  get swrap() { return this.vimState.swrap } // prettier-ignore
  get utils() { return this.vimState.utils } // prettier-ignore
  get editor() { return this.vimState.editor } // prettier-ignore
  get editorElement() { return this.vimState.editorElement } // prettier-ignore
  get globalState() { return this.vimState.globalState } // prettier-ignore
  get mutationManager() { return this.vimState.mutationManager } // prettier-ignore
  get occurrenceManager() { return this.vimState.occurrenceManager } // prettier-ignore
  get persistentSelection() { return this.vimState.persistentSelection } // prettier-ignore

  onDidChangeSearch(...args) { return this.vimState.onDidChangeSearch(...args) } // prettier-ignore
  onDidConfirmSearch(...args) { return this.vimState.onDidConfirmSearch(...args) } // prettier-ignore
  onDidCancelSearch(...args) { return this.vimState.onDidCancelSearch(...args) } // prettier-ignore
  onDidCommandSearch(...args) { return this.vimState.onDidCommandSearch(...args) } // prettier-ignore
  onDidSetTarget(...args) { return this.vimState.onDidSetTarget(...args) } // prettier-ignore
  emitDidSetTarget(...args) { return this.vimState.emitDidSetTarget(...args) } // prettier-ignore
  onWillSelectTarget(...args) { return this.vimState.onWillSelectTarget(...args) } // prettier-ignore
  emitWillSelectTarget(...args) { return this.vimState.emitWillSelectTarget(...args) } // prettier-ignore
  onDidSelectTarget(...args) { return this.vimState.onDidSelectTarget(...args) } // prettier-ignore
  emitDidSelectTarget(...args) { return this.vimState.emitDidSelectTarget(...args) } // prettier-ignore
  onDidFailSelectTarget(...args) { return this.vimState.onDidFailSelectTarget(...args) } // prettier-ignore
  emitDidFailSelectTarget(...args) { return this.vimState.emitDidFailSelectTarget(...args) } // prettier-ignore
  onWillFinishMutation(...args) { return this.vimState.onWillFinishMutation(...args) } // prettier-ignore
  emitWillFinishMutation(...args) { return this.vimState.emitWillFinishMutation(...args) } // prettier-ignore
  onDidFinishMutation(...args) { return this.vimState.onDidFinishMutation(...args) } // prettier-ignore
  emitDidFinishMutation(...args) { return this.vimState.emitDidFinishMutation(...args) } // prettier-ignore
  onDidFinishOperation(...args) { return this.vimState.onDidFinishOperation(...args) } // prettier-ignore
  onDidResetOperationStack(...args) { return this.vimState.onDidResetOperationStack(...args) } // prettier-ignore
  onDidCancelSelectList(...args) { return this.vimState.onDidCancelSelectList(...args) } // prettier-ignore
  subscribe(...args) { return this.vimState.subscribe(...args) } // prettier-ignore
  isMode(...args) { return this.vimState.isMode(...args) } // prettier-ignore
  getBlockwiseSelections(...args) { return this.vimState.getBlockwiseSelections(...args) } // prettier-ignore
  getLastBlockwiseSelection(...args) { return this.vimState.getLastBlockwiseSelection(...args) } // prettier-ignore
  addToClassList(...args) { return this.vimState.addToClassList(...args) } // prettier-ignore
  getConfig(...args) { return this.vimState.getConfig(...args) } // prettier-ignore

  // Wrapper for this.utils
  //===========================================================================
  getVimEofBufferPosition() { return this.utils.getVimEofBufferPosition(this.editor) } // prettier-ignore
  getVimLastBufferRow() { return this.utils.getVimLastBufferRow(this.editor) } // prettier-ignore
  getVimLastScreenRow() { return this.utils.getVimLastScreenRow(this.editor) } // prettier-ignore
  getValidVimBufferRow(row) { return this.utils.getValidVimBufferRow(this.editor, row) } // prettier-ignore
  getValidVimScreenRow(row) { return this.utils.getValidVimScreenRow(this.editor, row) } // prettier-ignore
  getWordBufferRangeAndKindAtBufferPosition(...args) { return this.utils.getWordBufferRangeAndKindAtBufferPosition(this.editor, ...args) } // prettier-ignore
  getFirstCharacterPositionForBufferRow(row) { return this.utils.getFirstCharacterPositionForBufferRow(this.editor, row) } // prettier-ignore
  getBufferRangeForRowRange(rowRange) { return this.utils.getBufferRangeForRowRange(this.editor, rowRange) } // prettier-ignore
  scanEditor(...args) { return this.utils.scanEditor(this.editor, ...args) } // prettier-ignore
  findInEditor(...args) { return this.utils.findInEditor(this.editor, ...args) } // prettier-ignore
  findPoint(...args) { return this.utils.findPoint(this.editor, ...args) } // prettier-ignore
  trimBufferRange(...args) { return this.utils.trimBufferRange(this.editor, ...args) } // prettier-ignore
  isEmptyRow(...args) { return this.utils.isEmptyRow(this.editor, ...args) } // prettier-ignore
  getFoldStartRowForRow(...args) { return this.utils.getFoldStartRowForRow(this.editor, ...args) } // prettier-ignore
  getFoldEndRowForRow(...args) { return this.utils.getFoldEndRowForRow(this.editor, ...args) } // prettier-ignore
  getBufferRows(...args) { return this.utils.getRows(this.editor, "buffer", ...args) } // prettier-ignore
  getScreenRows(...args) { return this.utils.getRows(this.editor, "screen", ...args) } // prettier-ignore
}

module.exports = Base
