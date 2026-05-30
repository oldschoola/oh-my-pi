Performs string replacements in files with fuzzy whitespace matching.
<instruction>
Params are `{ path, edits }`; `path` is required at the top level & applies to every replacement
Use the smallest `old_text` that uniquely identifies the change
If `old_text` isn't unique, expand it with more context or use `all: true` to replace all occurrences
Prefer editing existing files over creating new ones
<output>
Returns success/failure status. On success, file modified in place with replacement applied. On failure (e.g. `old_text` not found or matches multiple locations without `all: true`), returns error describing the issue.
<critical>
Read the file at least once in the conversation before editing — the tool errors out if you try to edit without reading first, since fuzzy matching needs the current bytes.
<bash-alternatives>
Replace handles content-addressed changes — you identify _what_ to change by its text.
For position-addressed or pattern-addressed changes, bash is more efficient:
|Operation|Command|
|---|---|
|Append to file|`cat >> file <<'EOF'`…`EOF`|
|Prepend to file|`{ cat - file; } <<'EOF' > tmp && mv tmp file`|
|Delete lines N-M|`sed -i 'N,Md' file`|
|Insert after line N|`sed -i 'Na\text' file`|
|Regex replace|`sd 'pattern' 'replacement' file`|
|Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|
|Copy lines N-M to another file|`sed -n 'N,Mp' src >> dest`|
|Move lines N-M to another file|`sed -n 'N,Mp' src >> dest && sed -i 'N,Md' src`|

Use Replace when _content itself_ identifies location.
Use bash when _position_ or _pattern_ identifies what to change.