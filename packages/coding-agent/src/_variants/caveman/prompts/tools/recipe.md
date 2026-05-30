Run recipe / script / target from project's task runners.

<instruction>
- `op` is single string: task name plus any args, e.g. `{op: "test"}` or `{op: "build --release"}`.
- In monorepos, package and Cargo target tasks namespaced with `/`, e.g. `{op: "pkg-a/test"}` or `{op: "crate/bin/server"}`.
{{#if hasMultipleRunners}}- When same task name exists in more than one runner, prefix with runner id, e.g. `{op: "{{ambiguityExampleRunner}}:{{ambiguityExampleTask}}"}`. Available runner ids: {{#each runners}}`{{id}}`{{#unless @last}}, {{/unless}}{{/each}}.
{{/if}}- Runs in session's cwd. Output and exit code returned in same shape as `bash`.
</instruction>

{{#each runners}}
<runner id="{{id}}" label="{{label}}" command="{{commandPrefix}}">
{{#each tasks}}
- `{{name}}{{#if paramSig}} {{paramSig}}{{/if}}`{{#if doc}} — {{doc}}{{/if}}{{#if command}} (`{{command}}`{{#if cwd}} in `{{cwd}}`{{/if}}){{/if}}
{{/each}}
</runner>
{{/each}}
