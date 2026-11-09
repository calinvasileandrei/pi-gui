import { useEffect, useRef, useState } from "react";
import { isDark } from "../theme.ts";

type Monaco = typeof import("monaco-editor/editor/editor.api");
let monacoP: Promise<Monaco> | undefined;

/** Lazy, minimal Monaco: core editor + Monarch tokenizers (no language-service workers needed for diffs). */
export function loadMonaco(): Promise<Monaco> {
  monacoP ??= (async () => {
    const [{ default: EditorWorker }, monaco] = await Promise.all([
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/editor/editor.api"),
      import("monaco-editor/basic-languages/monaco.contribution"),
      import("monaco-editor/features/codicon/register"), // icon font (diff gutter, arrows) is opt-in since 0.5x
    ]);
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
    const common = { "editor.lineHighlightBackground": "#00000000", "editorGutter.background": "#00000000" };
    monaco.editor.defineTheme("pi-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        ...common,
        "editor.background": "#0d0d10",
        "diffEditor.insertedTextBackground": "#3dd68c26",
        "diffEditor.removedTextBackground": "#ff636926",
        "diffEditor.insertedLineBackground": "#3dd68c14",
        "diffEditor.removedLineBackground": "#ff636914",
        "editorLineNumber.foreground": "#4a4a55",
        "editor.selectionBackground": "#3f5ffe55",
        "scrollbarSlider.background": "#ffffff14",
      },
    });
    monaco.editor.defineTheme("pi-light", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        ...common,
        "editor.background": "#fbfbfc",
        "diffEditor.insertedTextBackground": "#17a67326",
        "diffEditor.removedTextBackground": "#e5484d22",
        "diffEditor.insertedLineBackground": "#17a67312",
        "diffEditor.removedLineBackground": "#e5484d10",
        "editorLineNumber.foreground": "#b4b4bd",
      },
    });
    return monaco;
  })();
  return monacoP;
}

const dark = isDark;

export function DiffEditor({ original, modified, language, path }: { original: string; modified: string; language: string; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<import("monaco-editor/editor/editor.api").editor.IStandaloneDiffEditor | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [sideBySide, setSideBySide] = useState(true);

  useEffect(() => {
    let disposed = false;
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      ed.current = monaco.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        minimap: { enabled: false },
        fontSize: 12.5,
        lineHeight: 20,
        fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "Menlo, monospace",
        scrollBeyondLastLine: false,
        renderOverviewRuler: true,
        ignoreTrimWhitespace: false,
        hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6 },
        theme: dark() ? "pi-dark" : "pi-light",
        padding: { top: 8 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      setReady(true);
    });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onTheme = () => void loadMonaco().then((m) => m.editor.setTheme(dark() ? "pi-dark" : "pi-light"));
    mq?.addEventListener("change", onTheme);
    return () => {
      disposed = true;
      mq?.removeEventListener("change", onTheme);
      const e = ed.current;
      ed.current = undefined;
      const m = e?.getModel();
      e?.dispose();
      m?.original.dispose();
      m?.modified.dispose();
    };
  }, []);

  useEffect(() => {
    if (!ready || !ed.current) return;
    void loadMonaco().then((monaco) => {
      const e = ed.current;
      if (!e) return;
      const prev = e.getModel();
      e.setModel({ original: monaco.editor.createModel(original, language), modified: monaco.editor.createModel(modified, language) });
      prev?.original.dispose();
      prev?.modified.dispose();
    });
  }, [ready, original, modified, language, path]);

  useEffect(() => {
    ed.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div ref={host} style={{ flex: 1, minHeight: 0 }} data-side-by-side={sideBySide} />
      {!ready && <div className="diff-msg"><span className="spinner" /></div>}
      <button className="btn sm" style={{ position: "absolute", right: 16, bottom: 12, zIndex: 3, boxShadow: "var(--shadow)" }} onClick={() => setSideBySide(!sideBySide)}>
        {sideBySide ? "Inline" : "Side by side"}
      </button>
    </div>
  );
}

/** Editable single-file editor (⌘S handled by the caller via onSave). */
export function CodeEditor({ value, language, path, readOnly, onChange, onSave }: { value: string; language: string; path: string; readOnly?: boolean; onChange?: (v: string) => void; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor | undefined>(undefined);
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      const e = monaco.editor.create(host.current, {
        value,
        language,
        readOnly,
        automaticLayout: true,
        minimap: { enabled: true, renderCharacters: false, scale: 1, maxColumn: 80 },
        fontSize: 12.5,
        lineHeight: 20,
        fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "Menlo, monospace",
        scrollBeyondLastLine: false,
        theme: dark() ? "pi-dark" : "pi-light",
        padding: { top: 10 },
        renderLineHighlight: "line",
        smoothScrolling: true,
        tabSize: 2,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      e.onDidChangeModelContent(() => cbs.current.onChange?.(e.getValue()));
      e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cbs.current.onSave?.());
      ed.current = e;
      setReady(true);
    });
    return () => {
      disposed = true;
      const e = ed.current;
      ed.current = undefined;
      const m = e?.getModel();
      e?.dispose();
      m?.dispose();
    };
  }, [path]);

  // external value (reload from disk) — only when it differs, so typing isn't reset
  useEffect(() => {
    const e = ed.current;
    if (ready && e && e.getValue() !== value) e.setValue(value);
  }, [ready, value]);
  useEffect(() => {
    if (!ready || !ed.current) return;
    void loadMonaco().then((m) => {
      const model = ed.current?.getModel();
      if (model) m.editor.setModelLanguage(model, language);
    });
  }, [ready, language]);
  useEffect(() => ed.current?.updateOptions({ readOnly }), [readOnly]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {!ready && <div className="diff-msg"><span className="spinner" /></div>}
    </div>
  );
}
