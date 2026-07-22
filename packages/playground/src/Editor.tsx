// Reusable CodeMirror 6 pane, wrapped for Solid. Owns exactly one
// EditorView for its lifetime; prop changes (value/readOnly/lang) patch the
// existing view via dispatch/reconfigure rather than tearing it down, so the
// user's cursor/scroll position survives a format switch.
import { onCleanup, onMount, createEffect, type Component } from "solid-js"
import { EditorState, Compartment } from "@codemirror/state"
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { sql } from "@codemirror/lang-sql"
import { rust } from "@codemirror/lang-rust"
import { oneDark } from "@codemirror/theme-one-dark"
import type { LangHint } from "./formats.ts"

function langExtension(lang: LangHint) {
  switch (lang) {
    case "json":
      return json()
    case "js":
      return javascript()
    case "python":
      return python()
    case "sql":
      return sql()
    case "rust":
      return rust()
    default:
      return []
  }
}

export interface EditorProps {
  readonly value: string
  readonly lang: LangHint
  readonly readOnly?: boolean
  readonly onChange?: (value: string) => void
}

const Editor: Component<EditorProps> = (props) => {
  let container: HTMLDivElement | undefined
  let view: EditorView | undefined
  const langCompartment = new Compartment()
  const readOnlyCompartment = new Compartment()

  onMount(() => {
    if (container === undefined) return
    view = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          oneDark,
          langCompartment.of(langExtension(props.lang)),
          readOnlyCompartment.of(EditorState.readOnly.of(props.readOnly ?? false)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && props.onChange !== undefined) {
              props.onChange(update.state.doc.toString())
            }
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
          }),
        ],
      }),
      parent: container,
    })
  })

  onCleanup(() => {
    view?.destroy()
  })

  // External value changes (format switch reloading a sample, or a
  // successful conversion replacing the read-only output pane) get pushed in
  // only when they didn't originate from this same view's own typing —
  // comparing against the view's current doc avoids clobbering the cursor
  // mid-keystroke.
  createEffect(() => {
    const next = props.value
    if (view !== undefined && view.state.doc.toString() !== next) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    }
  })

  createEffect(() => {
    const lang = props.lang
    if (view !== undefined) {
      view.dispatch({ effects: langCompartment.reconfigure(langExtension(lang)) })
    }
  })

  createEffect(() => {
    const readOnly = props.readOnly ?? false
    if (view !== undefined) {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) })
    }
  })

  return <div class="editor-host" ref={container} />
}

export default Editor
