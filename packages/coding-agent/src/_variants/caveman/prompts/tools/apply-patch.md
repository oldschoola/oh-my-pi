Use `apply_patch` shell command to edit files.
Patch language is stripped‑down, file‑oriented diff format designed for easy parsing and safe applying. Think of it as high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Inside envelope, sequence of file operations.
MUST include header to specify action you take.
Each operation starts with one of three headers:

*** Add File: <path> - create new file. Every following line is `+` line (initial contents).
*** Delete File: <path> - remove existing file. Nothing follows.
*** Update File: <path> - patch existing file in place (optionally with rename).

May be immediately followed by *** Move to: <new path> to rename file.
Then one or more "hunks", each introduced by @@ (optionally followed by hunk header).
Inside hunk each line starts with:

For [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If change is within 3 lines of prior change, do NOT duplicate first change's [context_after] lines in second change's [context_before] lines.
- If 3 lines of context not enough to uniquely identify snippet inside file, use @@ operator to indicate class or function snippet belongs to. Example:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]
- If code block repeats so many times inside class or function that even one `@@` statement plus 3 lines of context cannot uniquely identify snippet, use multiple `@@` statements to jump to right context. Example:

@@ class BaseClass
@@ 	 def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

Full grammar below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

Full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Remember:
- Must include header with intended action (Add/Delete/Update)
- Must prefix new lines with `+` even when creating new file
- File references must be relative, NEVER ABSOLUTE.
