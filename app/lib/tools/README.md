# Editor Tools (Rec 5 — Phase 4a)

LLM-driven editor surface. The model emits structured envelopes mid-completion; the bolt.diy chat client dispatches them against the live workbench and streams the result back so the LLM can keep reasoning.

## Tools

| Name | Args | Returns |
| --- | --- | --- |
| `openFile` | `{path: string}` | `{path, contents, language, line_count}` |
| `jumpToLine` | `{path: string, line: number, column?: number}` | `{ok, path, line, column}` |
| `runCommand` | `{command: string, cwd?: string}` | `{output, exitCode, cwd}` (output truncated at 8 KB) |
| `search` | `{query: string, regex?: boolean, file_pattern?: string}` | `{matches: [{path, line, match}], truncated}` (max 50 matches) |
| `getSelection` | `{}` | `{ok, path, text, from, to}` (1-based line/column) |
| `replaceSelection` | `{text: string}` | `{ok, bytes_written}` |

## Protocol envelope

The LLM emits exactly one of:

```
<tool_call name="openFile" id="t_42">{"args":{"path":"src/App.tsx"}}</tool_call>
```

The client posts the result back as a fresh user turn:

```
<tool_result id="t_42">{"path":"/home/project/src/App.tsx","contents":"…","language":"tsx","line_count":120}</tool_result>
```

Notes:

- `id` is opaque — the model owns generation and uses it to correlate concurrent calls.
- Body is JSON. We accept both `{"args":{…}}` and bare `{…}` for ergonomic emission.
- Tools that return JSON-shaped strings serialize themselves; the `tool_result` body is therefore plain JSON, no double-encoding.
- Validation failures, unknown tools, and handler exceptions all serialize as `{"error":{"code":"…","message":"…"}}` so the LLM can self-correct on the next turn.

## Architecture

```
LLM stream
  └─> message-parser.parseToolCallEnvelopes()  ← finds completed <tool_call>s
        └─> dispatcher.runTool(name, args, ctx)
              ├─> Zod-validate args (per-tool schema)
              ├─> handler(args, ctx)            ← pure function, ctx-injected
              ├─> PS_TELEMETRY "editor.tool_call" {name, ok, ms}
              └─> on failure: PS_ERROR "editor.tool_failed:<name>"
        └─> dispatchResultToEnvelope(result)  ← frames <tool_result id="…">
              └─> useChat.append({role:'user', content: envelope})
                    └─> LLM continues conversation with the tool_result in context
```

Browser-side context surfaces (`createEditorToolContext`) read+write through:

- `workbenchStore` — files, current view, scroll position
- `boltTerminal.executeCommand` — WebContainer shell
- An active-`EditorView` registry set by `CodeMirrorEditor` mount/unmount

## Adding a new tool

1. **Define schema + handler** in `editor-tools.ts`:

   ```ts
   const FormatArgs = z.object({ path: z.string() });
   export const formatTool: EditorTool<typeof FormatArgs> = {
     name: 'format',
     description: 'Run prettier on the named file and return the diff.',
     parameters: FormatArgs,
     async handler(args, ctx) {
       const absolute = ctx.resolvePath(args.path);
       if (!absolute) throw new Error(`File not found: ${args.path}`);
       const before = await ctx.readFile(absolute);
       const { output } = await ctx.runShell(`npx prettier --write ${absolute}`);
       const after = await ctx.readFile(absolute);
       return JSON.stringify({ before_bytes: before?.length, after_bytes: after?.length, log: output });
     },
   };
   ```

2. **Register** by adding it to `EDITOR_TOOLS` (alphabetical-ish, group by area).

3. **Extend context** in `editor-context.ts` if you need a new surface (avoid — prefer composing existing verbs).

4. **Test** by adding a case to `__tests__/dispatcher.spec.ts`. Mock surfaces via the `EditorToolContext` shape — no real WebContainer required.

5. **Document** in this README's table.

6. **System prompt** — `ai_admin.ts` reads `EDITOR_TOOL_SURFACE` to render the prompt. Add a one-line description for the model there too.

## Worker-side wiring

`apps/project-sites/src/routes/ai_admin.ts` `/api/admin/ai/stream/chat` accepts a `context.surface: 'editor'` flag. When set, the system prompt is augmented with the 6 editor tools and the model is instructed to emit `<tool_call>` envelopes.

Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (FP8 variant — the bare alias was retired Apr 2026).

## Telemetry + audit

Every dispatch fires `PS_TELEMETRY` `editor.tool_call` with `{name, ok, ms[, error]}`. Failures additionally raise `PS_ERROR` `editor.tool_failed:<name>` so the admin's `editor-error` audit pipeline picks them up. Server-side, the chat route logs `chat.ai.message` with `surface: 'editor'` so admin can filter.

## Failure modes

| Code | Cause | LLM self-correction path |
| --- | --- | --- |
| `unknown_tool` | Model invented a tool name | Re-emit using one of the 6 listed tools |
| `invalid_args` | Zod rejected the args | Read the error message (lists every failing field) and re-emit |
| `handler_failed` | Surface threw (file missing, terminal not ready, no selection) | Read the error message; try a different tool or path |

The dispatcher never throws — every result is a structured `DispatchResult` so the chat client can always frame a `tool_result` back to the model.
