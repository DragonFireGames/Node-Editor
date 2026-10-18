# Extension model

The editor deliberately uses a small, non-installing extension API.

## Embedding page owns loading

Third-party extensions are not installed into the editor. An embedding page loads an extension script into the editor iframe, for example with `frame.contentWindow.document.createElement('script')` and a script `src` or source string.

## Global extension API

The editor exposes `window.EditorExtensionAPI`:

```js
const handle = EditorExtensionAPI.register({
  id: 'example',
  name: 'Example Extension',
  description: '...',
  icon: '<img ...>',
  open({ group, editor, api }) {
    // the extension owns what opens here
  }
});

handle.update({ description: '...' });
handle.open();

EditorExtensionAPI.list();
EditorExtensionAPI.get('example');
EditorExtensionAPI.open('example');
EditorExtensionAPI.onChange(...);
```

There is intentionally no installation/removal API yet.

## Extension-owned pages

The extension API does **not** define a generic extension details page. When the user clicks an extension in the Extensions sidebar, the API invokes that extension's own `open` callback.

For custom editor pages, the extension/embedding host can use the existing global builtin registry:

```js
editor.EditorBuiltinFactories.test = function(ctx) {
  return {
    title: 'Test',
    icon: '...',
    render(group) { /* render the extension's page */ }
  };
};
```

The embedding host can also add a Welcome action with `EditorApp.addWelcomeAction(...)`. Neither mechanism is part of `EditorExtensionAPI`.

## `extension.html` test

`extension.html` embeds `index.html`, waits for the iframe's load/init, loads `test-extension.js` into the child page, registers the `test` builtin from the parent page, and adds that builtin to Welcome. It also lets the parent upload arbitrary extension scripts and project ZIP files.

## AI tools and hooks

Extensions can add trusted tools to the built-in AI without modifying the AI implementation:

```js
EditorExtensionAPI.register({
  id: 'example',
  name: 'Example',
  ai: {
    tools: [{
      name: 'example_action',
      description: 'Do an example action.',
      permission: 'extensionActions',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      },
      async execute(args) {
        return { ok: true, value: args.value };
      }
    }],
    hooks: {
      'ai.beforeRun': async payload => payload,
      'ai.afterRun': async payload => payload,
      'ai.beforeTool': async payload => payload,
      'ai.afterTool': async payload => payload
    }
  }
});
```

AI tools are exposed to the built-in agent as normal function tools and go through the normal AI permission system. Extensions should use a specific permission such as `extensionActions` for actions that can change external state.

Hook payloads are ordinary JavaScript objects. `ai.beforeRun` can return a replacement payload (for example, with additional messages); `ai.afterRun` receives the completed result. `ai.beforeTool` can return a replacement `{args}` object, and `ai.afterTool` can return a replacement `{result}`. Hook failures are isolated so an extension cannot silently take down the AI agent.

The editor also exposes built-in GitHub AI tools. They use the existing GitHub sign-in from the Editor Profile and are separately permissioned as `githubRead` and `githubWrite`. GitHub write actions remain disabled until the user grants permission.

An extension can also register tools directly with `EditorExtensionAPI.registerAITool(extensionId, tool)` and remove one with `unregisterAITool(name)`.