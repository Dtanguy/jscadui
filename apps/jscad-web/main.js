import { addToCache, extractEntries, fileDropped, getFile, registerServiceWorker } from '@jscadui/fs-provider'
import { Gizmo } from '@jscadui/html-gizmo'
import { OrbitControl } from '@jscadui/orbit'
import { genParams } from '@jscadui/params'
import { initMessaging } from '@jscadui/postmessage'

import defaultCode from './examples/jscad.example.js'
import * as editor from './src/editor.js'
import * as engine from './src/engine.js'
import * as exporter from './src/exporter.js'
import * as menu from './src/menu.js'
import * as remote from './src/remote.js'
import { formatStacktrace } from './src/stacktrace.js'
import { ViewState } from './src/viewState.js'
import * as welcome from './src/welcome.js'

export const byId = id => document.getElementById(id)
const appBase = document.baseURI
let currentBase = appBase
const toUrl = path => new URL(path, appBase).toString()

const viewState = new ViewState()

const gizmo = (window.gizmo = new Gizmo())
byId('overlay').parentNode.appendChild(gizmo)

let projectName = 'jscad'
let model = []

// load default model unless another model was already loaded
let loadDefault = true

const ctrl = (window.ctrl = new OrbitControl([byId('viewer')], { ...viewState.camera, alwaysRotate: false }))

const updateFromCtrl = change => {
  const { position, target, rx, rz, len, ...rest } = change
  viewState.setCamera({ position, target })
  gizmo.rotateXZ(rx, rz)
}
updateFromCtrl(ctrl)

ctrl.onchange = state => viewState.saveCamera(state)
ctrl.oninput = state => updateFromCtrl(state)

gizmo.oncam = ({ cam }) => ctrl.animateToCommonCamera(cam)

let sw
async function initFs() {
  const getFileWrapper = (path, sw) => {
    const file = getFile(path, sw)
    // notify editor of active files
    file.then(() => editor.setFiles(sw.filesToCheck))
    return file
  }
  let scope = document.location.pathname
  sw = await registerServiceWorker(`bundle.fs-serviceworker.js?prefix=${scope}swfs/`, getFileWrapper, {scope, prefix:scope+'swfs/'})
  sw.defProjectName = 'jscad'
  sw.onfileschange = files => {
    sendNotify('clearFileCache', { files })
    if (sw.fileToRun) runScript({ url: sw.fileToRun, base: sw.base })
  }
}
const dropModal = byId('dropModal')
const showDrop = show => {
  clearTimeout(showDrop.timer)
  dropModal.style.display = show ? 'initial' : 'none'
}
document.body.ondrop = async ev => {
  try {
    ev.preventDefault()
    let files = extractEntries(ev.dataTransfer)
    if (!files.length) return {}

    if (!sw) await initFs()
    showDrop(false)
    sendCmd('clearTempCache', {})
    const { alias, script } = await fileDropped(sw, files)
    projectName = sw.projectName
    if (alias.length) {
      sendNotify('init', { alias })
    }
    runScript({ url: sw.fileToRun, base: sw.base })
    editor.setSource(script, sw.fileToRun)
    editor.setFiles(sw.filesToCheck)
  } catch (error) {
    setError(error)
    console.error(error)
  }
}

document.body.ondragover = ev => {
  ev.preventDefault()
  showDrop(true)
}
document.body.ondragleave = document.body.ondragend = ev => {
  clearTimeout(showDrop.timer)
  showDrop.timer = setTimeout(() => {
    showDrop(false)
  }, 300)
}

const setError = error => {
  const errorBar = byId('error-bar')
  if (error) {
    console.error(error)
    const name = (error.name || 'Error') + ': '
    byId('error-name').innerText = name
    const message = formatStacktrace(error)
    byId('error-message').innerText = message
    errorBar.classList.add('visible')
  } else {
    errorBar.classList.remove('visible')
  }
}

// Dummy link for download action
const link = document.createElement('a')
link.style.display = 'none'
document.body.appendChild(link)
function save(blob, filename) {
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
}

const exportModel = async (format, extension) => {
  const { data } = (await sendCmdAndSpin('exportData', { format })) || {}
  if (data) {
    save(new Blob([data], { type: 'text/plain' }), `${projectName}.${extension}`)
    console.log('save', `${projectName}.${extension}`, data)
  }
}

const worker = new Worker('./build/bundle.worker.js')
const handlers = {
  entities: ({ entities }) => {
    if (!(entities instanceof Array)) entities = [entities]
    viewState.setModel((model = entities))
    setError(undefined)
  },
}
const { sendCmd, sendNotify } = initMessaging(worker, handlers)

const spinner = byId('spinner')
let jobs = 0
let firstJobTimer
async function sendCmdAndSpin(method, params) {
  jobs++
  if(jobs === 1){
    // do not show spinner for fast renders
    firstJobTimer = setTimeout(()=>{
      spinner.style.display = 'block'
    },300)
  }
  try {
    return await sendCmd(method, params)
  } catch (error) {
    setError(error)
    throw error
  } finally {
    if (--jobs === 0) {
      clearTimeout(firstJobTimer)
      spinner.style.display = 'none'
    }
  }
}

sendCmdAndSpin('init', {
  bundles: {// local bundled alias for common libs.
    '@jscad/modeling': toUrl('./build/bundle.jscad_modeling.js'),
    '@jscad/io': toUrl('./build/bundle.jscad_io.js'),
  },
}).then(() => {
  if (loadDefault) {
    runScript({ script: defaultCode })
  }
})

let working
let lastParams
const paramChangeCallback = async params => {
  if(!working){
    lastParams = null
  }else{
    lastParams = params
    return
  }
  working = true
  let result
  try{
    result = await sendCmdAndSpin('runMain', { params })
  } finally{
    working = false
  }
  handlers.entities(result)
  if(lastParams && lastParams != params) paramChangeCallback(lastParams)
}

const runScript = async ({ script, url = './index.js', base = currentBase, root }) => {
  currentBase = base
  loadDefault = false // don't load default model if something else was loaded
  const result = await sendCmdAndSpin('runScript', { script, url, base, root })
  genParams({ target: byId('paramsDiv'), params: result.def || {}, callback: paramChangeCallback })
  handlers.entities(result)
}

const loadExample = (source, base=appBase) => {
  editor.setSource(source)
  runScript({ script: source, base })
}

// Initialize three engine
engine.init().then(viewer => {
  viewState.setEngine(viewer)
})

editor.init(defaultCode, async (script, path) => {
  if (sw && sw.fileToRun) {
    await addToCache(sw.cache, path, script)
    // imported script will be also cached by require/import implementation
    // it is expected if multiple files require same file/module that first time it is loaded
    // but for others resolved module is returned
    // if not cleared by calling clearFileCache, require will not try to reload the file
    await sendCmd('clearFileCache', { files: [path] })
    if (sw.fileToRun) runScript({ url: sw.fileToRun, base: sw.base })
  } else {
    runScript({ script })
  }
})
menu.init(loadExample)
welcome.init()
remote.init((script, url) => {
  // run remote script
  editor.setSource(script)
  runScript({ script, base:url })
  welcome.dismiss()
}, (err) => {
  // show remote script error
  loadDefault = false
  setError(err)
  welcome.dismiss()
})
exporter.init(exportModel)

try {
  await initFs()
} catch (err) {
  setError(err)
}

if ('serviceWorker' in navigator && !navigator.serviceWorker.controller) {
  // service workers are disabled on hard-refresh, so need to reload.
  // to prevent a reload loop, don't reload again within 3 seconds.
  const lastReload = localStorage.getItem('lastReload')
  if (!lastReload || Date.now() - lastReload > 3000) {
    setError('cannot start service worker, reloading')
    localStorage.setItem('lastReload', Date.now())
    location.reload()
  } else {
    console.error('cannot start service worker, reload required')
  }
  setError('cannot start service worker, reload required')
}
