<h1 align="center">Build, Preview, and Ship on the Web</h1>

<p align="center">
A browser-based code editor for working with project files, running previews, connecting to GitHub, and extending the editor with small embedding-page integrations.
</p>

---

## 🌟 About the Editor

This project is a web-based development environment built around a workspace, file explorer, editor panes, previews, terminals, and a collection of built-in tools.

It is designed to make the project itself the center of the experience. You can start from a template, open a local ZIP, load a remote project, connect a GitHub repository, edit files, run the project, and inspect the result without leaving the editor.

The editor is also designed to be embedded. Instead of requiring a large installation system, extensions can be loaded by the page hosting the editor and can register their own editor pages through a small global API.

---

## 🚀 Features

### 📁 **Project Workspaces**
Open and work with project files directly in the browser. The editor includes an Explorer, tabs, file operations, search, settings, and workspace state handling.

Projects can be started from built-in templates, including:

- **Node.js** — node server + browser + terminal
- **Static** — static site + browser

You can also import project ZIP files or load projects from remote URLs.

### 👀 **Live Previews**
The editor includes preview support for several common project types and file formats, including HTML, Markdown, images, audio, video, 3D/OBJ content, raw files, and Piskel content.

A browser and run/debug environment are also available as built-in editor tools.

### 🧰 **Built-in Tools**
The workbench includes built-in pages for:

- Browser
- Run and Debug
- Terminal
- Run Configuration
- Environment
- AI
- Settings

These are exposed through the editor's builtin registry and can also be opened by extensions.

### 🐙 **GitHub Support**
The editor includes GitHub authentication and repository support through its Source Control experience.

GitHub-backed workspaces can be restored and opened directly, and remote repositories can be downloaded into the editor as project workspaces.

### 🤖 **AI Tools**
The editor includes an AI workspace with provider settings, permissions, project context, an agent, and browser/project development tools.

The tool system is designed to let the assistant work with the project instead of only generating text about it.

### 🧩 **Extensions**
The editor uses a deliberately small, non-installing extension model.

An embedding page loads an extension into the editor and registers it through `EditorExtensionAPI`:

```js
const handle = EditorExtensionAPI.register({
  id: 'example',
  name: 'Example Extension',
  description: '...',
  icon: '<img ...>',
  open({ group, editor, api }) {
    // The extension owns what opens here.
  }
});
```

Extensions own the page they open. The editor provides the sidebar, builtin registry, workspace APIs, and editor events needed for the extension to integrate with the workbench.

There is intentionally no extension installation/removal system yet.

### 🎛️ **Editor Events and Theming**
The editor exposes public events for changes such as sidebar activity, tab opening/activation/closing, builtin rendering, DOM additions, workbench rebuilds, and theme changes.

A shared `EditorTheme` object is also exposed so an embedding page or extension can work with the editor's theme instead of maintaining a separate theme system.

---

## 🛠️ Getting Started

The editor is a browser application, so serve the project from a web server rather than opening `index.html` directly from the filesystem. The editor loads configuration and other resources through normal web requests.

Once it is running, the main entry point is:

```text
/index.html
```

From there you can create a project, open a local project, load a remote project, or connect a GitHub repository.

### Templates

Built-in templates are defined in `templates/templates.json` and currently include the Node.js and Static starter projects.

### Embedding the Editor

`extension.html` is included as a simple embedding/test page. It demonstrates loading the editor in an iframe and registering an extension from the parent page.

The extension model is documented separately in [`EXTENSION_MODEL.md`](EXTENSION_MODEL.md).

---

## 🌐 Remote Projects

The editor can open remote projects from GitHub repositories as well as HTTP(S) project URLs.

For GitHub, signed-in users can browse repositories through the editor UI. Public repositories can also be opened by URL without requiring GitHub sign-in.

Large remote and local ZIP imports include progress feedback while the archive is inspected, read, rebuilt when necessary, and turned into a workspace.

---

## 📦 Deployment and Preview

The editor includes deployment configuration and a deployment page for loading projects outside the main workbench.

The deployment system can work with the editor's own URL configuration, peer-server support, and third-party deployment URLs/hooks. The deployment page can also fall back to the editor's project emulation when a separately deployed URL is not available.

---

## 🔌 Extension Model

The editor deliberately keeps extensions lightweight.

Third-party extensions are not installed into the editor. The embedding page is responsible for loading the extension code, and the extension registers itself with the global `EditorExtensionAPI`.

The API provides registration, lookup, opening, updates, and change notifications. Custom extension pages can use the editor's global builtin registry, while embedding pages can add their own Welcome actions.

This keeps the editor useful on its own while making it possible for a host application to add larger, application-specific experiences on top.

---

## 🧪 Development Notes

This editor is still an evolving project. Some features are intentionally small and flexible rather than being presented as a finished IDE platform.

The most important design goal is keeping the editor's core useful on its own while leaving room for embedding applications to provide their own workflows, integrations, and extensions.

When adding editor features, preserve the existing project/workspace model and prefer public APIs when a feature needs to communicate with an embedding page.

---

## ❤️ Built for Creativity

A code editor does not have to get in the way of making things. The goal of this project is to keep the workspace close to the code, the preview close to the project, and the tools close to the person using them.

Whether you're experimenting with a small static page, running a Node project, connecting a GitHub repository, or building an extension around the editor, the workspace is meant to stay flexible enough to grow with the project.

---

<p align="center">
✨ Build something, preview it, and keep going. ✨
</p>
