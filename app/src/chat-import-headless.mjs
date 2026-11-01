// The import plugin's host half, without its window. `dsh-chat-import` declares a client bundle
// in its own manifest (`dsh.client`), and DSH's client-modules reads that manifest to serve the
// UI — a disabled loader row drops the plugin whole (host and tools with it), so the row stays
// enabled and the UI is removed by mounting the plugin from here instead. This module is a row
// name of its own; its manifest is the app's (app/package.json), which declares no `dsh.client`,
// so client-modules finds no bundle to serve for it. The plugin itself is untouched and still
// applies in full: every tool, including `import_chat`, registers as usual.
export { apply, inject, name, Config } from 'dsh-chat-import'
