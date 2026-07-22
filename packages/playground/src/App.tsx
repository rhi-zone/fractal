import { createMemo, createSignal, type Component } from "solid-js"
import Editor from "./Editor.tsx"
import { convert } from "./convert.ts"
import { inputFormats, outputFormats, inputFormatById, outputFormatById } from "./formats.ts"

const App: Component = () => {
  const [inputFormatId, setInputFormatId] = createSignal(inputFormats[0]!.id)
  const [outputFormatId, setOutputFormatId] = createSignal(outputFormats[0]!.id)
  const [source, setSource] = createSignal(inputFormats[0]!.sample ?? "")

  const inputFormat = createMemo(() => inputFormatById(inputFormatId())!)
  const outputFormat = createMemo(() => outputFormatById(outputFormatId())!)

  const result = createMemo<{ output: string; error: string | undefined }>(() => {
    try {
      return { output: convert(inputFormatId(), outputFormatId(), source()), error: undefined }
    } catch (err) {
      return { output: "", error: err instanceof Error ? err.message : String(err) }
    }
  })

  function onInputFormatChange(id: string): void {
    setInputFormatId(id)
    // Loading a fresh sample on format switch is the common case (exploring
    // what each format looks like); a user who's already typed real content
    // into the pane keeps it — only an empty/untouched buffer gets replaced.
    if (source().trim().length === 0) {
      setSource(inputFormatById(id)?.sample ?? "")
    }
  }

  return (
    <div class="app">
      <header class="app-header">
        <h1>type-ir playground</h1>
        <p>Convert between any of the type-ir package's supported schema/type formats, live.</p>
      </header>
      <main class="panes">
        <section class="pane">
          <div class="pane-toolbar">
            <label for="input-format">Input</label>
            <select
              id="input-format"
              value={inputFormatId()}
              onChange={(e) => onInputFormatChange(e.currentTarget.value)}
            >
              {inputFormats.map((f) => (
                <option value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
          <div class="pane-body">
            <Editor value={source()} lang={inputFormat().lang} onChange={setSource} />
          </div>
        </section>
        <section class="pane">
          <div class="pane-toolbar">
            <label for="output-format">Output</label>
            <select
              id="output-format"
              value={outputFormatId()}
              onChange={(e) => setOutputFormatId(e.currentTarget.value)}
            >
              {outputFormats.map((f) => (
                <option value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
          <div class="pane-body">
            <Editor value={result().output} lang={outputFormat().lang} readOnly />
          </div>
          {result().error !== undefined && <div class="error-banner">{result().error}</div>}
        </section>
      </main>
    </div>
  )
}

export default App
