// fix adding scripts to DOM

(function() {
  // if (window.__pageEmulator) {

  //   let browserWindow = window.__trueWindow;
  //   while (browserWindow.parent !== browserWindow && !browserWindow.__pageRegistry) browserWindow = browserWindow.parent;

  //   if (!browserWindow.__pageRegistry) {
  //     return alert("Finding page emulator failed: no registry");
  //   }

  //   window.PageEmulator = browserWindow.PageEmulator;

  //   // These are exposed for the existing runtime interceptor / browser-side
  //   // integrations without moving the implementations back into PageEmulator.
  //   window.createDataUri = browserWindow.createDataUri;
  //   window.rewriteCSSURLs = browserWindow.rewriteCSSURLs;
  //   window.getFileNameFromURL = browserWindow.getFileNameFromURL;
  //   window.sandboxSource = browserWindow.sandboxSource;
  //   window.preprocessHtml = browserWindow.preprocessHtml;
  //   window.__pageRegistry = browserWindow.__pageRegistry;

  //   return;
  // }

  window.__pageRegistry = {};

  // I'm thinking we put stuff like preprocessHtml in here not inside the pageEmulator
  async function createDataUri(response) {
    if (!response) return null;
    try {
      const blob = await response.clone().blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (response.source_url && typeof cacheMap !== 'undefined') cacheMap[response.source_url] = reader.result;

          let defaultName = '';

          // 1. Try checking the Content-Disposition header first
          if (response.headers) {
            const disposition = response.headers.get('content-disposition');
            if (disposition && disposition.includes('filename=')) {
              const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
              const matches = filenameRegex.exec(disposition);
              if (matches && matches[1]) {
                defaultName = matches[1].replace(/['"]/g, '').trim();
              }
            }
          }

          // 2. Fall back to your URL extraction method if header parsing failed
          if (!defaultName && response.source_url) {
            defaultName = getFileNameFromURL(response.source_url,'');
          }

          if (defaultName) defaultName = "#f="+defaultName;

          resolve(reader.result+defaultName);
        }
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch(e) {
      if (window.logError) window.logError("DataURI conversion failed: " + e.message);
      return null;
    }
  };

  function getPageBaseUrl(page) {
    if (page && page.location && page.location.url === "about:srcdoc") {
      try {
        if (page.parent && page.parent !== false && page.parent.location && page.parent.location.url) return page.parent.location.url;
      } catch (e) {}
    }
    return page?.location?.url || "http://localhost:3000/";
  }

  function ensureSandBoxSameOrigin(iframe) {
    if (!iframe.hasAttribute('sandbox')) return;

    var tokens = iframe.getAttribute('sandbox').split(/\s+/).filter(Boolean);

    if (!tokens.includes('allow-same-origin')) {
      tokens.push('allow-same-origin');
      iframe.setAttribute('sandbox',tokens.join(' '));
    }
  }

  async function preprocessHtml(rawHtml, page, baseUrlOverride = null) {
    let pageUrl = baseUrlOverride || getPageBaseUrl(page);
    let dynamicBaseOrigin = (() => { try { return new URL(pageUrl).origin; } catch (_) { return page.location.origin; } })();

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    const resolveUrl = (relUrl) => {
      try { return new URL(relUrl, pageUrl).href; } 
      catch (e) { return relUrl; }
    };

    const processSrcSet = async (el) => {
      return;

      const srcsetVal = el.getAttribute('srcset');
      if (!srcsetVal) return;

      // 1. Stateful parsing loop to safely isolate candidates without breaking data: URIs
      const candidates = [];
      let currentToken = "";
      let inUrl = true;

      for (let i = 0; i < srcsetVal.length; i++) {
        const char = srcsetVal[i];

        if (inUrl && /\s/.test(char)) {
          inUrl = false;
        }

        if (char === ',' && !inUrl) {
          candidates.push(currentToken.trim());
          currentToken = "";
          inUrl = true;
          continue;
        }

        currentToken += char;
      }

      if (currentToken.trim()) {
        candidates.push(currentToken.trim());
      }

      // 2. Process the safely parsed candidates
      const updatedCandidates = await Promise.all(candidates.map(async (candidate) => {
        const match = candidate.match(/^(\S+)\s*(.*)$/);
        if (!match) return candidate;

        const url = match[1];
        const descriptor = match[2];

        if (!url || url.startsWith('data:') || url.startsWith('blob:')) return candidate;

        try {
          const absoluteUrl = resolveUrl(url);
          const response = await page.network.request(absoluteUrl, dynamicBaseOrigin, {}, 'srcset');

          if (response && response.ok) {
            const dataUri = await createDataUri(response);
            return dataUri ? `${dataUri}${descriptor ? ' ' + descriptor : ''}` : candidate;
          }
        } catch (error) {
          console.error(`Failed to process srcset URL: ${url}`, error);
        }

        return candidate;
      }));

      el.setAttribute('srcset', updatedCandidates.join(', '));
    };

    const processElements = (selector, attr, rawAttr = 'data-raw-src', filter = f => f) => {
      const elements = Array.from(doc.querySelectorAll(selector));

      return elements.map(async (el) => {
        const originalUrl = el.getAttribute(attr);
        if (!originalUrl || originalUrl.startsWith('data:') || originalUrl.startsWith('blob:')) return;

        const absoluteUrl = resolveUrl(originalUrl);
        el.setAttribute(rawAttr, originalUrl);

        const response = await page.network.request(absoluteUrl, dynamicBaseOrigin, {}, selector);

        if (!response || !response.ok) return;

        const processedRes = await filter(response, absoluteUrl, originalUrl, el);

        if (!processedRes) return;

        const dataUri = await createDataUri(processedRes);

        if (dataUri) el.setAttribute(attr, dataUri);
      });
    };

    await Promise.all([
      processElements('script[src]', 'src', 'data-raw-src', async function(response, url, ourl, element) {
        let text = await response.clone().text();
        const isModule = element && element.getAttribute('type') === 'module';

        if (isModule) {
          element.removeAttribute('type');
          text = `window.__executeCodeModule(${JSON.stringify(text)}, ${JSON.stringify(ourl)});`;
        } else {
          // Standard synchronous execution
          text = `window.__executeCode(${JSON.stringify(text)}, ${JSON.stringify(ourl)});`;
        }

        return new Response(text, { headers: { 'Content-Type': 'application/javascript' } });
      }),

      processElements('link:not([rel="stylesheet"])[href]', 'href', 'data-raw-href'),

      processElements('link[rel="stylesheet"][href]', 'href', 'data-raw-href', async function(response, absoluteUrl) {
        let cssText = await response.text();
        cssText = await rewriteCSSURLs(cssText, page);
        return new Response(cssText, { headers: { 'Content-Type': 'text/css' } });
      }),

      processElements('img[src]', 'src'),
      processElements('video[src]', 'src'),
      processElements('video[poster]', 'poster', 'data-raw-poster'),
      processElements('audio[src]', 'src'),
      processElements('source[src]', 'src'),

      Promise.all(Array.from(doc.querySelectorAll('embed[src]')).map(async function(el) {
        var src = el.getAttribute('src');
        if (!src) return;
        // The parsed document is detached from the live browser document here.
        // Do not create/render the embed yet; the runtime setup below will do
        // that after the document has actually been installed in its iframe.
        el.setAttribute('data-raw-src',src);
        el.removeAttribute('src');
      })),

      Promise.all(Array.from(doc.querySelectorAll('iframe')).map(async function(el) {
        var src = el.getAttribute("src");
        var srcdoc = el.getAttribute("srcdoc");
        if (!src && !srcdoc) srcdoc = `<html><head></head><body></body></html>`;
        el.removeAttribute("data-raw-src");
        el.removeAttribute("data-raw-srcdoc");
        if (src) el.setAttribute('data-raw-src',src);
        if (srcdoc !== null && srcdoc !== undefined) el.setAttribute('data-raw-srcdoc',srcdoc);
        el.removeAttribute("src");
        el.removeAttribute("srcdoc");
        el.__sandboxed = true;
        el.__iframeNavigationId = (el.__iframeNavigationId || 0) + 1;

        ensureSandBoxSameOrigin(el);

        page.sendEvent('iframe-create',{
          iframe: el,
          src: src,
          srcdoc: srcdoc,
          is_doc: !src,
        });

        await page.sendAsyncEvent('iframe-navigate',{
          iframe: el,
          src: src,
          srcdoc: srcdoc,
          is_doc: !src,
          navigationId: el.__iframeNavigationId,
        });

        return null;
      })),

      processElements('object[data]', 'data'),

      // Process all srcset instances across img and source elements
      Promise.all(Array.from(doc.querySelectorAll('[srcset]')).map(processSrcSet)),

      Array.from(doc.querySelectorAll('style')).map(async (styleEl) => {
        if (styleEl.textContent) {
          styleEl.textContent = await rewriteCSSURLs(styleEl.textContent, page);
        }
      }),

      Array.from(doc.querySelectorAll('[style]')).map(async (el) => {
        const styleAttr = el.getAttribute('style');

        if (styleAttr && styleAttr.includes('url(')) {
          const updatedStyle = await rewriteCSSURLs(styleAttr,page);
          el.setAttribute('style', updatedStyle);
        }
      })
    ].flat());

    // Handle inline script blocks and inline on* event attributes
    doc.querySelectorAll('*').forEach(node => {
      Array.from(node.attributes || []).forEach(attr => {
        if (attr.name.startsWith('on') && attr.value && !attr.value.includes('__executeCode')) {
          node.setAttribute(attr.name, `return window.__executeCode(${JSON.stringify(attr.value)}, '<anonymous onevent>', this, typeof event !== 'undefined' ? {event: event} : {})`);
        }
      });
    });

    doc.querySelectorAll('script:not([src])').forEach(script => {
      if (script.textContent && !script.textContent.includes('__executeCode')) {
        const isModule = script.getAttribute('type') === 'module';

        if (isModule) script.removeAttribute('type');

        const execFn = isModule ? '__executeCodeModule' : '__executeCode';

        script.textContent = `window.${execFn}(${JSON.stringify(script.textContent)}, ${JSON.stringify(pageUrl)}, this);\n`;
      }
    });

    return doc.documentElement.outerHTML;
  }

  async function sandboxSource(rawHtml,page,processHtml = true, baseUrlOverride = null) {
    let processedHtml;

    if (processHtml) processedHtml = await preprocessHtml(rawHtml,page,baseUrlOverride);
    else processedHtml = rawHtml;

    const documentUrl = baseUrlOverride || page.location.url;
    const baseUrl = baseUrlOverride || getPageBaseUrl(page);
    const runtimeInterceptor = createRuntimeInterceptor(documentUrl, page.location.origin, undefined, baseUrl);

    let finalHtml = processedHtml;

    if (finalHtml.includes('<head>')) {
      finalHtml = finalHtml.replace('<head>',`<head><base href="${baseUrl}"><script>${runtimeInterceptor}<\/script>`);
    } else {
      finalHtml = runtimeInterceptor+finalHtml;
    }

    return finalHtml;
  }

  var acornParseOptions = {
    ecmaVersion: 'latest',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true
  };

  function parseCode(code, sourceType = 'script') {
    return acorn.parse(code, { ...acornParseOptions, sourceType });
  }

  function extractFunctionBody(funct) {
    const code = '('+funct.toString()+')();';

    const ast = parseCode(code, 'script');

    const node = ast.body[0].expression.callee;

    function codeSlice(blockNode) {
      const start = blockNode.start + 1;
      const end = blockNode.end - 1;
      return code.substring(start, end).trim();
    }

    // Case: function(){...}
    if (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression") {
      return codeSlice(node.body);
    }

    // Case: expression statement wrapping a function
    if (node.type === "ExpressionStatement") {
      const expr = node.expression;

      // (function(){})
      if (expr.type === "FunctionExpression") {
        return codeSlice(expr.body);
      }

      // Arrow function
      if (expr.type === "ArrowFunctionExpression") {
        if (expr.body.type === "BlockStatement") {
          return codeSlice(expr.body);
        } else {
          // Expression body: () => x + 1
          return astring.generate(expr.body);
        }
      }
    }

    throw new Error("Unsupported function format");
  }

  function getPatternNames(pattern,names = []) {
    if (!pattern) return names;

    if (pattern.type === "Identifier") {
      if (!names.includes(pattern.name)) names.push(pattern.name);
    }
    else if (pattern.type === "AssignmentPattern") {
      getPatternNames(pattern.left,names);
    }
    else if (pattern.type === "RestElement") {
      getPatternNames(pattern.argument,names);
    }
    else if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") getPatternNames(prop.argument,names);
        else getPatternNames(prop.value,names);
      }
    }
    else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) {
        if (element) getPatternNames(element,names);
      }
    }

    return names;
  }

  function extractGlobals(ast) {
    const vars = new Set();
    const funcs = new Set();

    acorn.walk.simple(ast, {
      VariableDeclaration(node) {
        if (node.kind === "var") {
          for (const decl of node.declarations) {
            getPatternNames(decl.id).forEach(name => vars.add(name));
          }
        }
      },

      FunctionDeclaration(node) {
        if (node.id && node.id.name) {
          funcs.add(node.id.name);
        }
      },

      ClassDeclaration(node) {
        if (node.id && node.id.name) {
          vars.add(node.id.name);
        }
      }
    });

    return { vars, funcs };
  }

  function createGlobalLexicalDeclaration(kind,name) {
    return {
      type: "ExpressionStatement",
      expression: {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: kind === "const" ? "__declareGlobalLexicalConstant" : "__declareGlobalLexicalVariable"
        },
        arguments: [{ type: "Literal", value: name, raw: JSON.stringify(name) }]
      }
    };
  }

  function createGlobalLexicalInitialization(name,initValueNode) {
    return {
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "__globalLexicalScope" },
          property: { type: "Identifier", name: name },
          computed: false
        },
        right: initValueNode || { type: "Identifier", name: "undefined" }
      }
    };
  }

  function transformPatternToTarget(pattern,targetName) {
    if (!pattern) return pattern;

    if (pattern.type === "Identifier") {
      return {
        type: "MemberExpression",
        object: { type: "Identifier", name: targetName },
        property: { type: "Identifier", name: pattern.name },
        computed: false
      };
    }

    if (pattern.type === "AssignmentPattern") {
      return {
        type: "AssignmentPattern",
        left: transformPatternToTarget(pattern.left,targetName),
        right: pattern.right
      };
    }

    if (pattern.type === "RestElement") {
      return {
        type: "RestElement",
        argument: transformPatternToTarget(pattern.argument,targetName)
      };
    }

    if (pattern.type === "ObjectPattern") {
      return {
        type: "ObjectPattern",
        properties: pattern.properties.map(prop => {
          if (prop.type === "RestElement") return transformPatternToTarget(prop,targetName);

          return {
            ...prop,
            value: transformPatternToTarget(prop.value,targetName),
            shorthand: false
          };
        })
      };
    }

    if (pattern.type === "ArrayPattern") {
      return {
        type: "ArrayPattern",
        elements: pattern.elements.map(element => element ? transformPatternToTarget(element,targetName) : null)
      };
    }

    return pattern;
  }

  // Use one native destructuring assignment so the initializer is evaluated exactly once.
  function createGlobalDestructuringAssignment(kind,decl) {
    const names = getPatternNames(decl.id);
    const body = [];
    const targetName = (kind === "let" || kind === "const") ? "__globalLexicalScope" : "window";

    if (kind === "let" || kind === "const") {
      names.forEach(name => body.push(createGlobalLexicalDeclaration(kind,name)));
    }

    body.push({
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: transformPatternToTarget(decl.id,targetName),
        right: decl.init || { type: "Identifier", name: "undefined" }
      }
    });

    return body.length === 1 ? body[0] : { type: "BlockStatement", body };
  }

  function transformAST(ast) {
    acorn.walk.simple(ast, {
      CallExpression(node) {
        const callee = node.callee;

        // IIFE: (function(){})()
        if (callee.type === "FunctionExpression") {
          node.callee = {
            type: "MemberExpression",
            object: callee,
            property: { type: "Identifier", name: "call" },
            computed: false
          };

          node.arguments.unshift({ type: "Identifier", name: "__windowProxy" });
        }

        // Simple identifier call: foo()
        else if (callee.type === "Identifier" && callee.name !== "eval") {
          node.callee = {
            type: "MemberExpression",
            object: callee,
            property: { type: "Identifier", name: "call" },
            computed: false
          };

          node.arguments.unshift({ type: "Identifier", name: "__windowProxy" });
        }

        // Comma operator — (0, fn)()
        if (callee.type === "SequenceExpression") {
          const exprs = callee.expressions;
          const last = exprs[exprs.length - 1];

          // Only rewrite if last expression is callable
          if (last.type === "Identifier" || last.type === "MemberExpression") {
            node.callee = {
              type: "MemberExpression",
              object: last,
              property: { type: "Identifier", name: "call" },
              computed: false
            };

            node.arguments.unshift({ type: "Identifier", name: "__windowProxy" });
          }
        }
      }
    });

    const rootBody = ast.body;
    const newBody = [];
    const hoistedAssignments = [];

    for (const node of rootBody) {

      // 1. Keep Functions hoisted where they are, but queue a global assignment for the top
      if (node.type === "FunctionDeclaration") {
        if (node.id && node.id.name) {
          const name = node.id.name;

          // Queue assignment: window.foo = foo;
          hoistedAssignments.push(createGlobalAssignment(name, {
            type: "Identifier",
            name: name
          }));
        }

        newBody.push(node);
      }

      // 2. Rewrite global variables
      else if (node.type === "VariableDeclaration") {
        for (const decl of node.declarations) {
          if (decl.id.type === "Identifier") {
            if (node.kind === "let" || node.kind === "const") {
              newBody.push(createGlobalLexicalDeclaration(node.kind,decl.id.name));
              newBody.push(createGlobalLexicalInitialization(decl.id.name,decl.init));
            } else {
              newBody.push(createGlobalAssignment(decl.id.name, decl.init));
            }
          } else {
            newBody.push(createGlobalDestructuringAssignment(node.kind,decl));
          }
        }
      }

      // 3. Rewrite classes: class Foo {} -> window.Foo = class Foo {}
      else if (node.type === "ClassDeclaration") {
        if (node.id && node.id.name) {
          const name = node.id.name;

          node.type = "ClassExpression";

          newBody.push(createGlobalAssignment(name, node));
        }
      }

      // 4. Leave loops, expressions, statements alone
      else {
        newBody.push(node);
      }
    }

    // Prepend the assignments to the top of the script body
    ast.body = [...hoistedAssignments,...newBody];
  }

  // Helper to generate AST nodes for: window[name] = value;
  function createGlobalAssignment(name,initValueNode) {
    return {
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "window" },
          property: { type: "Identifier", name: name },
          computed: false
        },
        right: initValueNode || { type: "Identifier", name: "undefined" }
      }
    };
  }

  function editCode(code) {
    // Allow passing a function directly
    if (typeof code === 'function') {
      code = extractFunctionBody(code);
    }

    if (typeof code !== 'string' || !code.trim()) {
      return { code, globals: { vars: [], funcs: [] } };
    }

    // Parse the code (function or raw)
    const ast = parseCode(code, 'script');

    // Transform AST
    transformAST(ast);

    // Regenerate code
    const transformed = astring.generate(ast);

    // Extract globals (var + function declarations)
    const globals = extractGlobals(ast);

    return { code: transformed, globals };
  }

  function editCodeAsync(codeObj) {
    var __codeString = codeObj.code;

    if (!__codeString || !__codeString.trim()) {
      return { code: '', globals: codeObj.globals };
    }

    try {
      const ast = parseCode(__codeString, 'script');

      const body = ast.body;

      if (body.length > 0) {
        const lastIndex = body.length - 1;
        const lastNode = body[lastIndex];

        // Change the last expression to evaluate and assign to __execResult
        if (lastNode.type === 'ExpressionStatement') {
          body[lastIndex] = {
            type: 'ExpressionStatement',
            start: lastNode.start,
            end: lastNode.end,
            expression: {
              type: 'AssignmentExpression',
              operator: '=',
              left: { type: 'Identifier', name: '__execResult' },
              right: lastNode.expression
            }
          };
        }
      }

      const transformedCode = astring.generate(ast);

      return {
        code: transformedCode,
        globals: codeObj.globals
      };
    } catch (err) {
      console.error("Failed to parse/transform code string via Acorn:", err);
      return {
        code: __codeString,
        globals: codeObj.globals
      };
    }
  }

  function editCodeModule(code) {
    // Allow passing a function directly
    if (typeof code === 'function') {
      code = extractFunctionBody(code);
    }

    if (!code || !code.trim()) {
      return code;
    }

    let ast;

    try {
      ast = parseCode(code, 'module');
    } catch (e) {
      console.error("Failed to parse module code via Acorn:", e);
      return code;
    }

    const newBody = [];
    
    ast.body.forEach(node => {
      // Process import.meta & dynamic import()
      transformNode(node);

      if (node.type === 'ImportDeclaration') {
        const sourceUrl = node.source.value;
        const specifiers = node.specifiers;
        
        if (specifiers.length === 0) {
          newBody.push(createSafeParserNode(`await __importModule("${sourceUrl}");`));
        } else {
          const props = specifiers.map(spec => {
            if (spec.type === 'ImportDefaultSpecifier') return 'default: ' + spec.local.name;
            if (spec.type === 'ImportNamespaceSpecifier') return spec.local.name;
            return `${spec.imported.name}: ${spec.local.name}`;
          }).join(', ');
          
          const isNamespace = specifiers[0].type === 'ImportNamespaceSpecifier';

          const decl = `const ${isNamespace ? props : `{ ${props} }`} = await __importModule("${sourceUrl}");`;

          newBody.push(createSafeParserNode(decl));
        }
      }

      else if (node.type === 'ExportDefaultDeclaration') {
        // export default function foo() {} OR export default 42;
        const declNode = node.declaration;
        
        if (declNode.type === 'FunctionDeclaration' || declNode.type === 'ClassDeclaration') {
          const name = declNode.id ? declNode.id.name : '__defaultExport';

          if (!declNode.id) {
            declNode.id = {
              type: 'Identifier',
              name
            };
          }
          
          // 1. Declare the function/class locally
          newBody.push(declNode);

          // 2. Export its reference
          newBody.push(createSafeParserNode(`__exportModule({ default: ${name} });`));
        } else {
          // Expressions like: export default 123 + 456;
          const exprCode = code.slice(declNode.start, declNode.end);

          newBody.push(createSafeParserNode(`__exportModule({ default: ${exprCode} });`));
        }
      }

      else if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          // export const a = 1; / export function foo() {} / export class Bar {}
          const decl = node.declaration;

          newBody.push(decl);

          if (decl.type === 'VariableDeclaration') {
            const names = decl.declarations.map(d => d.id.name);
            const exportCall = `__exportModule({ ${names.map(n => `${n}: ${n}`).join(', ')} });`;

            newBody.push(createSafeParserNode(exportCall));
          }

          else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
            const name = decl.id.name;
            const exportCall = `__exportModule({ ${name} });`;

            newBody.push(createSafeParserNode(exportCall));
          }
        }

        else if (node.specifiers && node.specifiers.length > 0) {
          if (node.source) {
            // export { a, b as c } from './exports.js'
            const sourceUrl = node.source.value;

            const proxyBlock = `const __tempExport = await __importModule("${sourceUrl}");\n__exportModule({ ${node.specifiers.map(s => `${s.exported.name}: __tempExport.${s.local.name}`).join(', ')} });`;

            newBody.push(createSafeParserNode(proxyBlock));
          } else {
            // export { subtract, divide as safeDivide };
            const specMappings = node.specifiers.map(s => `${s.exported.name}: ${s.local.name}`).join(', ');

            const exportCall = `__exportModule({ ${specMappings} });`;

            newBody.push(createSafeParserNode(exportCall));
          }
        }
      }

      else if (node.type === 'ExportAllDeclaration') {
        const sourceUrl = node.source.value;

        if (node.exported) {
          // export * as exportsNs from './exports.js'
          const nsName = node.exported.name;

          const exportNsCall = `const ${nsName} = await __importModule("${sourceUrl}");\n__exportModule({ ${nsName} });`;

          newBody.push(createSafeParserNode(exportNsCall));
        } else {
          // export * from './exports.js'
          const exportAllCall = `const __allExport = await __importModule("${sourceUrl}");\n__exportModule(__allExport);`;

          newBody.push(createSafeParserNode(exportAllCall));
        }
      }

      else {
        newBody.push(node);
      }
    });

    ast.body = newBody;

    return astring.generate(ast);
  }

  // Helper to safely parse strings into AST nodes with top-level await support
  function createSafeParserNode(codeSnippet) {
    try {
      const parsed = acorn.parse(codeSnippet, { 
        ecmaVersion: 'latest',
        allowAwaitOutsideFunction: true
      });

      return parsed.body.length === 1 ? parsed.body[0] : {
        type: 'BlockStatement',
        body: parsed.body
      };
    } catch (err) {
      console.error("Failed to parse snippet:", codeSnippet, err);
      throw err;
    }
  }

  // Recursive AST Node Transformer for dynamic import() and import.meta
  function transformNode(node) {
    if (!node || typeof node !== 'object') return node;

    if (node.type === 'ImportExpression') {
      node.type = 'CallExpression';
      node.callee = {
        type: 'Identifier',
        name: '__importModule'
      };
      node.arguments = [transformNode(node.source)];

      delete node.source;

      return node;
    }

    if (node.type === 'MetaProperty' &&
        node.meta &&
        node.meta.name === 'import' &&
        node.property &&
        node.property.name === 'meta') {

      return {
        type: 'MemberExpression',
        object: {
          type: 'Identifier',
          name: '__importModule'
        },
        property: {
          type: 'Identifier',
          name: 'meta'
        },
        computed: false,
        optional: false
      };
    }

    for (const key of Object.keys(node)) {
      if (['parent','start','end','loc'].includes(key)) continue;

      const child = node[key];

      if (Array.isArray(child)) {
        child.forEach((item,index) => {
          if (item && typeof item === 'object' && item.type) {
            child[index] = transformNode(item);
          }
        });
      }

      else if (child && typeof child === 'object' && child.type) {
        node[key] = transformNode(child);
      }
    }

    return node;
  }

  // Kept because the original implementation exposed this separately.
  function transformModuleAST(node) {
    if (!node || typeof node !== 'object') return node;

    // 1. Convert dynamic import(...) -> __importModule(...)
    if (node.type === 'ImportExpression') {
      node.type = 'CallExpression';
      node.callee = {
        type: 'Identifier',
        name: '__importModule'
      };
      node.arguments = [transformModuleAST(node.source)];

      delete node.source;

      return node;
    }

    // 2. Convert import.meta -> __importModule.meta
    if (node.type === 'MetaProperty' &&
        node.meta &&
        node.meta.name === 'import' &&
        node.property &&
        node.property.name === 'meta') {

      return {
        type: 'MemberExpression',
        object: {
          type: 'Identifier',
          name: '__importModule'
        },
        property: {
          type: 'Identifier',
          name: 'meta'
        },
        computed: false,
        optional: false
      };
    }

    // Recursively visit all object keys/children
    for (const key of Object.keys(node)) {
      if (['parent','start','end','loc'].includes(key)) continue;

      const child = node[key];

      if (Array.isArray(child)) {
        child.forEach((item,index) => {
          if (item && typeof item === 'object' && item.type) {
            child[index] = transformModuleAST(item);
          }
        });
      }

      else if (child && typeof child === 'object' && child.type) {
        node[key] = transformModuleAST(child);
      }
    }

    return node;
  }

  async function rewriteCSSURLs(cssText, baseUrl, baseOrigin, networkRequest, createDataUri) {
    // Support both the new page-based API and the old explicit API.
    if (typeof baseUrl === 'object' && baseUrl.network) {
      const page = baseUrl;
      baseOrigin = page.location.origin;
      baseUrl = getPageBaseUrl(page);
      networkRequest = page.network.request.bind(page.network);
      createDataUri = createDataUri || window.createDataUri || window.__createDataUri || globalsCreateDataUri;
    }

    const urlRegex = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi;
    const matches = Array.from(cssText.matchAll(urlRegex));
    if (matches.length === 0) return cssText;

    const urlMap = new Map();

    function decodeCSSDataUri(url) {
      const data = url.split('#')[0];
      const comma = data.indexOf(',');
      if (comma === -1) return null;

      const meta = data.slice(5, comma);
      const payload = data.slice(comma + 1);

      try {
        if (/;base64/i.test(meta)) {
          const binary = atob(payload);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder().decode(bytes);
        }
        return decodeURIComponent(payload);
      } catch (err) {
        console.error('Failed to decode CSS data URI:', err);
        return null;
      }
    }

    async function processCSS(css, cssUrl) {
      const rewritten = await rewriteCSSURLs(css, cssUrl, baseOrigin, networkRequest, createDataUri);
      const response = new Response(rewritten, { status: 200, headers: { 'Content-Type': 'text/css' } });
      response.source_url = cssUrl;
      return await createDataUri(response);
    }

    await Promise.all(matches.map(async (match) => {
      const rawUrl = match[2].trim();
      if (urlMap.has(rawUrl) || rawUrl.startsWith('blob:')) return;

      // Recursively process CSS embedded in a data:text/css URL.
      if (/^data:text\/css/i.test(rawUrl)) {
        try {
          const importedCSS = decodeCSSDataUri(rawUrl);
          if (importedCSS == null) return;

          const dataUri = await processCSS(importedCSS, baseUrl);
          if (dataUri) {
            const fragment = rawUrl.includes('#') ? rawUrl.slice(rawUrl.indexOf('#')) : '';
            urlMap.set(rawUrl, dataUri + (dataUri.includes('#') ? '' : fragment));
          }
        } catch (err) {
          console.error('Failed to process imported CSS:', err);
        }
        return;
      }

      if (rawUrl.startsWith('data:')) return;

      try {
        const resolvedUrl = new URL(rawUrl, baseUrl).href;
        const response = await networkRequest(resolvedUrl, baseOrigin, {}, 'css-url');
        if (!response || !response.ok) return;

        const contentType = response.headers.get('content-type') || '';
        const isCSS = contentType.toLowerCase().includes('text/css') || /\.css(?:[?#]|$)/i.test(resolvedUrl);

        let finalResponse = response;

        if (isCSS) {
          const importedCSS = await response.text();
          const rewrittenCSS = await rewriteCSSURLs(importedCSS, resolvedUrl, baseOrigin, networkRequest, createDataUri);
          finalResponse = new Response(rewrittenCSS, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
          finalResponse.source_url = response.source_url || resolvedUrl;
        }

        const dataUri = await createDataUri(finalResponse);
        if (dataUri) urlMap.set(rawUrl, dataUri);
      } catch (err) {
        console.error(`Failed to process CSS url(${rawUrl}):`, err);
      }
    }));

    return cssText.replace(urlRegex, (match, quote, rawUrl) => {
      const trimmed = rawUrl.trim();
      return urlMap.has(trimmed) ? `url("${urlMap.get(trimmed)}")` : match;
    });
  }

  function getFileNameFromURL(url, defaultName) {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const match = url.match(/#f=([^&#]+)/);
      defaultName = match ? decodeURIComponent(match[1]) : defaultName;
    } else {
      defaultName = new URL(url).pathname.split('/').filter(Boolean).pop() || defaultName;
    }

    return defaultName;
  }

  // Kept only so the page-based rewriteCSSURLs overload can resolve
  // the helper without changing createRuntimeInterceptor.
  var globalsCreateDataUri = createDataUri;

  var usefulHelpers = {
    createDataUri,
    editCode,
    editCodeAsync,
    editCodeModule,
    extractFunctionBody,
    extractGlobals,
    transformAST,
    transformModuleAST,
    createGlobalAssignment,
    createSafeParserNode,
    transformNode,
    rewriteCSSURLs,
    getFileNameFromURL,
    sandboxSource,
    ensureSandBoxSameOrigin,
    preprocessHtml,
    createRuntimeInterceptor,
  };

  __pageRegistry.__usefulHelpers = usefulHelpers;

  /*
   * createRuntimeInterceptor intentionally left as-is.
   */
  function createRuntimeInterceptor(source_url, source_origin, name = "about:srcdoc", base_url) {
    var interceptorFunction = function(BASE_ORIGIN, CURRENT_PAGE_URL, DOCUMENT_URL) { 
      DOCUMENT_URL = DOCUMENT_URL || CURRENT_PAGE_URL;
      if (window.__windowProxy) return;

      if (!window.frameElement.pageEmulator) {
        // do registry search
        let id = window.frameElement.getAttribute('data-page-id');
        if (!id) {
          window.__executeCode = window.eval.bind(window);
          return alert("Finding page emulator failed: no id");
        }
        
        let browserWindow = window;
        while (browserWindow.parent !== browserWindow && !browserWindow.__pageRegistry) browserWindow = browserWindow.parent;

        if (!browserWindow.__pageRegistry) {
          window.__executeCode = window.eval.bind(window);
          return alert("Finding page emulator failed: no registry");
        }

        browserWindow.__pageRegistry[id].iframe = window.frameElement;
        window.frameElement.pageEmulator = browserWindow.__pageRegistry[id];
        window.frameElement.usefulHelpers = browserWindow.__pageRegistry.__usefulHelpers;

        //window.__executeCode = window.eval.bind(window);
        //return alert("Finding page emulator failed!");
      }

      window.__frameElement = window.frameElement;
      window.__pageEmulator = window.frameElement.pageEmulator;
      window.__usefulHelpers = window.frameElement.usefulHelpers;

      window.__runSyncInterceptor = function(__elem,__elemWindow) {
        if (!__elemWindow) return;
        if (__elemWindow.__windowProxy) return __elemWindow.__windowProxy;
        var PATH_URL = new URL(__elem.getAttribute('src') || "about:srcdoc", BASE_ORIGIN);
        var __childPage = __elemWindow.__pageEmulator || __elem.pageEmulator || null;
        var __baseUrl = PATH_URL.href;
        try {
          if (/^about:srcdoc$/i.test(PATH_URL.href) && __childPage?.parent?.location?.url) __baseUrl = __childPage.parent.location.url;
        } catch (e) {}
        var __interceptorCode = window.__usefulHelpers.createRuntimeInterceptor(PATH_URL.href, BASE_ORIGIN, undefined, __baseUrl);
        return (function(window, document){
          with (window) {
            eval(__interceptorCode);
          }
          return window.__windowProxy;
        })(__elemWindow, __elemWindow.document);
      };

      // Module Registry
      window.__moduleRegistry = new Map();

      // Persistent global lexical environment for classic scripts.
      var __globalLexicalScope = Object.create(null);
      function __declareGlobalLexicalConstant(name) {
        if (Object.prototype.hasOwnProperty.call(__globalLexicalScope,name)) {
          throw new SyntaxError(`Identifier '${name}' has already been declared`);
        }

        var initialized = false;
        var value;
        Object.defineProperty(__globalLexicalScope,name,{
          enumerable: false,
          configurable: false,
          get: function() { return value; },
          set: function(nextValue) {
            if (initialized) throw new TypeError("Assignment to constant variable.");
            value = nextValue;
            initialized = true;
          }
        });
      }

      function __declareGlobalLexicalVariable(name) {
        if (Object.prototype.hasOwnProperty.call(__globalLexicalScope,name)) {
          throw new SyntaxError(`Identifier '${name}' has already been declared`);
        }

        var value;
        Object.defineProperty(__globalLexicalScope,name,{
          enumerable: false,
          configurable: false,
          get: function() { return value; },
          set: function(nextValue) { value = nextValue; }
        });
      }

      function __getScriptFileName(__scriptFileName) {
        try {__scriptFileName = __scriptFileName || new URL(document.currentScript.getAttribute('data-raw-src'),BASE_ORIGIN).href;} catch(e) {__scriptFileName = DOCUMENT_URL;};
        return __scriptFileName;
      }
      function __createModuleControls(__scriptFileName) {
        var __importModule = async function(url) {
          const parentUrl = __scriptFileName;
          const resolvedUrl = new URL(url, parentUrl).href;
          
          if (window.__moduleRegistry.has(resolvedUrl)) {
            return window.__moduleRegistry.get(resolvedUrl);
          }

          const res = await window.__pageEmulator.network.request(resolvedUrl, BASE_ORIGIN, {}, 'import');
          if (!res || !res.ok) throw new Error(`Cannot import module: ${resolvedUrl}`);
          
          let sourceCode = await res.text();
          
          var __currentModuleExports = {};
          
          try {
            __currentModuleExports = await window.__executeCodeModule(sourceCode, resolvedUrl, window.__windowProxy, undefined, resolvedUrl);
          } catch(e) {}
          
          const finalizedExports = { ...__currentModuleExports };
          window.__moduleRegistry.set(resolvedUrl, finalizedExports);
          
          return finalizedExports;
        };
        __importModule.meta = new Proxy({}, {
          get(target, prop) {
            const currentUrl = __scriptFileName;
            if (prop === 'url') return currentUrl;
            if (prop === 'resolve') return (specifier) => new URL(specifier, currentUrl).href;
            return undefined;
          }
        });
        var __currentModuleExports = {};
        var __exportModule = function(exports) {
          Object.assign(__currentModuleExports, exports);
        };

        return { __importModule, __exportModule, __currentModuleExports };
      }
      
      // do code later
      (function() { 
        
        const parentWindow = window.parent;
        const pageEmulator = window.__pageEmulator;
        const usefulHelpers = window.__usefulHelpers;
        
        const isTopLevel = !pageEmulator.parent;
        
        // setInterval(function(){
        //   const iframes = document.querySelectorAll('iframe');
        //   for (const iframe of iframes) {
        //     try {
        //       return !iframe.contentWindow.location.href;
        //     } catch (error) {
        //       iframe.src = "";
        //       iframe.srcdoc = "";
        //       console.log("Blocked Frame: ",iframe);
        //       return true;
        //     }
        //   }
        //   return null;
        // },100);

        const sendEvent = pageEmulator.sendEvent.bind(pageEmulator);
        const sendAsyncEvent = pageEmulator.sendAsyncEvent.bind(pageEmulator);
        const createDataUri = usefulHelpers.createDataUri;

        window.sendEvent = sendEvent;

        // - Srcset candidate URL resolution helper ---
        function parseSrcSet(srcsetVal) {
          const candidates = [];
          let currentToken = "";
          let inUrl = true;
          for (let i = 0; i < srcsetVal.length; i++) {
            const char = srcsetVal[i];
            if (inUrl && /\s/.test(char)) {
              inUrl = false;
            }
            if (char === ',' && !inUrl) {
              candidates.push(currentToken.trim());
              currentToken = "";
              inUrl = true;
              continue;
            }
            currentToken += char;
          }
          if (currentToken.trim()) {
            candidates.push(currentToken.trim());
          }
          return candidates.map(candidate => {
            const matches = candidate.match(/^(\S+)\s*(.*)$/);
            if (!matches) return { url: candidate, descriptor: '', full: candidate }
            return { url: matches[1], descriptor: matches[2] }
          });
        }
        async function interceptSrcSet(el) {
          const srcsetVal = el.getAttribute('srcset');
          if (!srcsetVal) return;

          // Use the stateful parser to perfectly extract candidates without breaking data: URIs
          const candidates = parseSrcSet(srcsetVal);
          
          const updated = await Promise.all(candidates.map(async (candidate) => {
            // Safely isolate the URL token from descriptors
            const { url, descriptor } = candidate;

            // This safely catches data: and blob: urls and skips reprocessing them
            if (!url || url.startsWith('data:') || url.startsWith('blob:')) return candidate.full;

            try {
              const resolvedUrl = new URL(url, CURRENT_PAGE_URL).href;
              const response = await pageEmulator.network.request(resolvedUrl, BASE_ORIGIN, {}, 'srcset');
              if (response && response.ok) {
                const uri = await createDataUri(response);
                return uri ? `${uri}${descriptor ? ' ' + descriptor : ''}` : candidate.full;
              }
            } catch (e) {
              console.error(`Failed to process: ${url}`, e);
            }
            return candidate.full;
          }));

          el.setAttribute('srcset', updated.join(', '));
          el.setAttribute('data-raw-srcset', srcsetVal);
        }


        // --- Dynamic Inline On* Handler Rewriter ---
        function patchInlineEvents(node) {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          Array.from(node.attributes || []).forEach(attr => {
            if (attr.name.startsWith('on') && attr.value && !attr.value.includes('__executeCode')) {
              const rawCode = attr.value;
              // Override attribute value to dispatch through sandboxed executor
              node.setAttribute(
                attr.name, 
                `return window.__executeCode(${JSON.stringify(rawCode)}, '<anonymous onevent>', this, typeof event !== 'undefined' ? {event: event} : {})`
              );
            }
          });
        }

        // --- Nested Frame / Embed Interception ---
        async function setupEmbed(el) {
          if (el.__sandboxed) return;
          if (el.tagName.toLowerCase() !== 'embed') return;

          el.__sandboxed = true;
          el.__embedNavigationId = (el.__embedNavigationId || 0) + 1;
          var navigationId = el.__embedNavigationId;
          var src = el.getAttribute('data-raw-src') || el.getAttribute('src');
          if (!src) return;

          el.setAttribute('data-raw-src',src);
          el.removeAttribute('src');

          sendEvent('embed-create',{embed: el});
          await sendAsyncEvent('embed-navigate',{
            embed: el,
            src: src,
            navigationId: navigationId,
          });
        }

        async function setupNestedFrame(el) {
          if (el.__sandboxed) return;
          if (el.tagName.toLowerCase() !== 'iframe') return;

          usefulHelpers.ensureSandBoxSameOrigin(el);

          el.__sandboxed = true;
          el.__iframeNavigationId = (el.__iframeNavigationId || 0) + 1;
          var navigationId = el.__iframeNavigationId;

          if (!el.pageEmulator) {
            const pageId = el.getAttribute('data-page-id');
            const knownPage = pageId ? pageEmulator.__pageRegistry[pageId] : null;

            if (knownPage) {
              knownPage.iframe = el;
              el.pageEmulator = knownPage;
              el.usefulHelpers = pageEmulator.__pageRegistry.__usefulHelpers;

              if (knownPage.tab) {
                knownPage.tab.iframe = el;
                knownPage.tab.frameElement = el;
              }
            } else {
              sendEvent('iframe-create',{
                iframe: el,
              });
            }
          }

          var hasSrcDoc = el.hasAttribute('data-raw-srcdoc') || el.hasAttribute('srcdoc');
          var hasRawSrc = el.hasAttribute('data-raw-src') || el.hasAttribute('src');

          var srcdoc = hasSrcDoc ? (el.getAttribute('srcdoc') ?? el.getAttribute('data-raw-srcdoc')) : null;
          var src = hasRawSrc ? (el.getAttribute('data-raw-src') ?? el.getAttribute('src')) : null;

          if (hasSrcDoc) {
            el.removeAttribute("srcdoc");
            el.removeAttribute("src");
          } else if (hasRawSrc) {
            el.removeAttribute("src");
          } else {
            el.removeAttribute("src");
            el.removeAttribute("srcdoc");
            srcdoc = `<html><head></head><body></body></html>`;
          }

          await sendAsyncEvent('iframe-navigate',{
            iframe: el,
            src: src,
            srcdoc: srcdoc,
            is_doc: !src,
            navigationId: navigationId,
          });

          return null;
        }// else if (frameEl.tagName.toLowerCase() === 'embed') {
          //   const rawSrc = frameEl.getAttribute('src') || frameEl.getAttribute('data-raw-src');
          //   if (!rawSrc) return;
          //   const res = await pageEmulator.network.request(targetUrl, BASE_ORIGIN, {}, 'embed');
          //   if (res && res.ok) {
          //     const content = await res.text();
          //     const blob = new Blob([frameScript + content], { type: 'text/html' });
          //     frameEl.setAttribute('src', URL.createObjectURL(blob));
          //     frameEl.setAttribute('data-raw-src', rawSrc);
          //   }
          // }

        // Target rules for dynamic element checks
        const ATTRIBUTE_MAP = [
          { selector: 'img[src]', attr: 'src' },
          { selector: 'script[src]', attr: 'src' },
          { selector: 'link:not([rel="stylesheet"])[href]', attr: 'href', rawAttr: 'data-raw-href'},
          { selector: 'link[rel="stylesheet"][href]', attr: 'href', rawAttr: 'data-raw-href', 
            filter: async function(response, absoluteUrl) {
              let cssText = await response.text();
              cssText = await rewriteCSSURLs(cssText, pageEmulator);
              return new Response(cssText, { headers: { 'Content-Type': 'text/css' } });
            }
          },
          { selector: 'video[src]', attr: 'src' },
          { selector: 'video[poster]', attr: 'poster', rawAttr: 'data-raw-poster' },
          { selector: 'audio[src]', attr: 'src' },
          { selector: 'source[src]', attr: 'src' },
          { selector: 'object[data]', attr: 'data' }
        ];

        async function interceptElementAttribute(el, attr, rawAttr = 'data-raw-src', filter = f => f) {
          const val = el.getAttribute(attr);
          if (!val || val.startsWith('data:') || val.startsWith('blob:')) return;

          if (!el.hasAttribute(rawAttr)) {
            const resolvedUrl = new URL(val, CURRENT_PAGE_URL).href;
            el.setAttribute(rawAttr, resolvedUrl);

            const response = await pageEmulator.network.request(resolvedUrl, BASE_ORIGIN, {}, el.tagName);
            if (response && response.ok) {
              const processedRes = await filter(response, resolvedUrl, BASE_ORIGIN, el);
              if (processedRes) {
                el.setAttribute(attr, await createDataUri(processedRes));
              }
            }
          }
        }

        function checkNodeAndChildren(node) {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.__editingAttribute) return;
          node.__editingAttribute = true;

          // 1. Rewrite dynamic event handlers
          patchInlineEvents(node);

          // 2. Process inline styles and <style> tags
          processStyleNode(node);
          processInlineStyleAttr(node);

          // 3. Process nested frames & embeds
          if (node.matches('iframe, embed')) {
            setupNestedFrame(node);
          }
          node.querySelectorAll('iframe').forEach(setupNestedFrame);
          node.querySelectorAll('embed').forEach(setupEmbed);

          // 4. Process srcset candidates
          if (node.matches('[srcset]')) interceptSrcSet(node);
          node.querySelectorAll('[srcset]').forEach(interceptSrcSet);

          // 5. Process standard attributes
          ATTRIBUTE_MAP.forEach(({ selector, attr, rawAttr, filter }) => {
            if (node.matches(selector)) {
              interceptElementAttribute(node, attr, rawAttr, filter);
            }
            node.querySelectorAll(selector).forEach(child => {
              interceptElementAttribute(child, attr, rawAttr, filter);
            });
          });
          node.__editingAttribute = false;
        }

        function processStyleNode(node) {
          if (node.tagName && node.tagName.toLowerCase() === 'style' && node.textContent.includes('url(')) {
            usefulHelpers.rewriteCSSURLs(node.textContent, pageEmulator)
              .then(newCss => { node.textContent = newCss; });
          }
          if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('style')) {
            processInlineStyleAttr(node);
          }
        }

        function processInlineStyleAttr(el) {
          const styleAttr = el.getAttribute('style');
          if (styleAttr && styleAttr.includes('url(') && !el.__processing_style) {
            el.__processing_style = true;
            usefulHelpers.rewriteCSSURLs(styleAttr, pageEmulator)
              .then(newStyle => {
                el.setAttribute('style', newStyle);
              })
              .finally(() => { el.__processing_style = false; });
          }
        }

        // --- Enhanced MutationObserver ---
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === 'childList') {
              mutation.addedNodes.forEach(node => {
                checkNodeAndChildren(node);
                if (node.nodeType === Node.ELEMENT_NODE) {
                  node.querySelectorAll('*').forEach(child => checkNodeAndChildren(child));
                }
              });
            } else if (mutation.type === 'attributes') {
              const el = mutation.target;
              const attrName = mutation.attributeName;

              if (el.__editingAttribute) continue;
              el.__editingAttribute = true;
              if (attrName.startsWith('data-raw')) continue;

              // Detect dynamically set or modified inline event listeners (e.g. el.setAttribute('onclick', ...))
              if (attrName.startsWith('on')) {
                patchInlineEvents(el);
                continue;
              }

              // if (attrName === 'srcset') {
              //   interceptSrcSet(el);
              //   continue;
              // }

              if (mutation.attributeName === 'style') {
                processInlineStyleAttr(mutation.target);
                el.__editingAttribute = false;
                continue;
              }

              if (el.tagName && el.tagName.toLowerCase() === 'embed' && attrName === 'src') {
                el.__editingAttribute = false;
                setupEmbed(el);
                continue;
              }

              ATTRIBUTE_MAP.forEach(({ attr, rawAttr, filter }) => {
                if (attrName === attr) {
                  interceptElementAttribute(el, attr, rawAttr, filter);
                }
              });
              el.__editingAttribute = false;
            }
          }
        });

        const observerOptions = {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'href', 'poster', 'data', 'srcset']
        };

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            observer.observe(document.documentElement, observerOptions);
            document.querySelectorAll('embed').forEach(setupEmbed);
          });
        } else {
          observer.observe(document.documentElement, observerOptions);
          document.querySelectorAll('embed').forEach(setupEmbed);
        }

        // modifies everything returned from document, like document.getElementById()
        function patchClass(name, linkprop, oncreate = () => {}, filter = x => x) {
          var _linkprop = "_" + linkprop;
          const originalClass = window[name];
          if (!originalClass) return;

          // window[name] = class extends originalClass {
          //   constructor() {
          //     super(...arguments);
          //     wrapElement(this);
          //   }
          // };

          const wrapperClass = function(...args) {
            var obj = new originalClass(...filter(args));
            obj = wrapElement(obj);
            oncreate.call(obj, ...args);
            return obj;
          };
          Object.setPrototypeOf(wrapperClass.prototype, originalClass.prototype);
          Object.setPrototypeOf(wrapperClass, originalClass);

          window[name] = wrapperClass;
        }

        patchClass("Image", "src");
        patchClass("Audio", "src", function(url) {
          if (url) this.src = url;
        }, function() {
          return [];
        });

        var getOldContextWindow = (f=>f.call.bind(f))(Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get);
        function wrapElement(elem) {
          if (!(elem instanceof HTMLElement)) return elem;
          
          // Guard against re-wrapping the same node
          if (elem.__isWrapped) return elem;
          elem.__isWrapped = true;

          const tagName = elem.tagName.toLowerCase();
          const propMap = {
            "script": {
              "src":"data-raw-src"
            },
            "link": {
              "href":"data-raw-href"
            },
            "img": {
              "src":"data-raw-src",
              "srcset":"data-raw-srcset"
            },
            "audio": {
              "src":"data-raw-src"
            },
            "video": {
              "src":"data-raw-src"
            },
            "source": {
              "src":"data-raw-src"
            },
            "track": {
              "src":"data-raw-src"
            },
            "iframe": {
              "src":"data-raw-src",
              "srcdoc":"data-raw-srcdoc"
            },
            "embed": {
              "src":"data-raw-src"
            },
            "object": {
              "data":"data-raw-data"
            },
          };
          const propObj = propMap[tagName];

          if (!propObj) return elem;

          for (var linkprop in propObj) (function(linkprop){
            Object.defineProperty(elem, linkprop, {
              get: function() { return this.getAttribute(linkprop) },
              set: function(val) { return this.setAttribute(linkprop, val) },
              configurable: true,
              enumerable: true
            });
          })(linkprop);

          if (tagName == "iframe") {
            const ensureFrameEmulator = () => {
              usefulHelpers.ensureSandBoxSameOrigin(elem);
              if (elem.pageEmulator) return elem.pageEmulator;

              const pageId = elem.getAttribute('data-page-id');
              const knownPage = pageId ? pageEmulator.__pageRegistry?.[pageId] : null;

              if (knownPage) {
                knownPage.iframe = elem;
                elem.pageEmulator = knownPage;
                elem.usefulHelpers = pageEmulator.__pageRegistry.__usefulHelpers;

                if (knownPage.tab) {
                  knownPage.tab.iframe = elem;
                  knownPage.tab.frameElement = elem;
                }

                return knownPage;
              }

              return sendEvent('iframe-create',{iframe: elem}) || elem.pageEmulator || null;
            };

            if (!elem.getAttribute('data-page-id')) ensureFrameEmulator();

            Object.defineProperty(elem,'contentWindow',{
              get: () => {
                ensureFrameEmulator();
                const contextWindow = getOldContextWindow(elem);
                return window.__runSyncInterceptor(elem,contextWindow);
              },
              set: () => {}
            });

            Object.defineProperty(elem,'contentDocument',{
              get: () => {
                ensureFrameEmulator();
                const contextWindow = getOldContextWindow(elem);
                const proxyWindow = window.__runSyncInterceptor(elem,contextWindow);
                return proxyWindow?.document;
              },
              set: () => {}
            });
          }

          var oldSetAttribute = elem.setAttribute;
          var oldGetAttribute = elem.getAttribute;
          elem.setAttribute = function(prop, value) {
            const lowerProp = prop.toLowerCase();

            // Guard against internal recursions during dynamic fetches
            if (this.__processing_attr) {
              return oldSetAttribute.call(this, prop, value);
            }

            if (lowerProp in propObj && !this.__editingAttribute) {
              if (!value) {
                oldSetAttribute.call(this, propObj[lowerProp], '');
                return oldSetAttribute.call(this, prop, value);
              }

              oldSetAttribute.call(this, propObj[lowerProp], value);

              if (value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("javascript:")) {
                return oldSetAttribute.call(this, prop, value);
              }

              this.__processing_attr = true;

              // Async resolution
              (async () => {
                if (this.tagName == 'IFRAME') {
                  this.__sandboxed = false;
                  var res = oldSetAttribute.call(this, prop, value);
                  try { 
                    await setupNestedFrame(this);
                  } finally { 
                    this.__processing_attr = false;
                  }
                  return res;
                }
                
                try {
                  const resolvedUrl = new URL(value, CURRENT_PAGE_URL).href;
                  const response = await pageEmulator.network.request(resolvedUrl, BASE_ORIGIN, {}, tagName);
                  if (response && response.ok) {
                    const dataUri = await createDataUri(response);
                    if (dataUri) {
                      return oldSetAttribute.call(this, prop, dataUri);
                    }
                  }
                  oldSetAttribute.call(this, prop, value);
                } catch (err) {
                  oldSetAttribute.call(this, prop, value);
                } finally {
                  this.__processing_attr = false;
                }
              })();

              return; // Prevent setting un-virtualized path synchronously
            }

            return oldSetAttribute.call(this, prop, value);
          };
          elem.getAttribute = function(prop) {
            const lowerProp = prop.toLowerCase();

            if (lowerProp in propObj && !this.__editingAttribute) {
              return oldGetAttribute.call(this, propObj[lowerProp]);
            }

            return oldGetAttribute.call(this, prop);
          };

          return elem;
        }

        const originalInsertRule = CSSStyleSheet.prototype.insertRule;
        CSSStyleSheet.prototype.insertRule = function(rule, index) {
          if (rule && rule.includes('url(')) {
            const sheet = this;
            usefulHelpers.rewriteCSSURLs(rule, pageEmulator)
              .then(processedRule => {
                try {
                  originalInsertRule.call(sheet, processedRule, index);
                } catch(e) {
                  originalInsertRule.call(sheet, rule, index);
                }
              });
            return index || 0;
          }
          return originalInsertRule.apply(this, arguments);
        };

        const originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function(propertyName, value, priority) {
          if (value && typeof value === 'string' && value.includes('url(')) {
            const styleDecl = this;
            usefulHelpers.rewriteCSSURLs(value, pageEmulator)
              .then(processedVal => {
                originalSetProperty.call(styleDecl, propertyName, processedVal, priority);
              });
            return;
          }
          return originalSetProperty.apply(this, arguments);
        };

        // Console logging intercepter

        Object.keys(console).forEach(method => {
          const original = console[method];
          if (typeof original != 'function') return;
          console[method] = function(...args) {
            sendEvent('console',method,args);
          };
        });

        function addEventListener(e,p,f,t) {
          e.addEventListener(p,f,t);
          setTimeout(()=>e.addEventListener(p,f,t),0);
        }

        addEventListener(window, 'error', function(e) {
          var loc = (document.currentScript?.getAttribute || (v=>'undefined')).call(document.currentScript, 'data-raw-src');
          sendEvent('error',e,loc);
        });

        const originalPrepare = Error.prepareStackTrace;
        Error.prepareStackTrace = function (error, structuredStackTrace) {
          const message = `${error.name}: ${error.message || ""}`;
          const frames = structuredStackTrace.map(f => f.toString()).filter((f,i) => !f.includes("data:") || i != structuredStackTrace.length - 1).map(f => f.includes("about:srcdoc") ? '' : `\n    at ${f}`).join("");
          const stackString = message + frames;
          return stackString.replace(/at eval \(([^]*?):(\d+):(\d+)\)$/g, 'at $1:$2:$3');
        };

        window.open = function(url, target, features) {
          if (url && url.startsWith('javascript:')) {
            const code = decodeURIComponent(url.slice(11));
            window.__executeCode(code, '<anonymous>');
            return null;
          }

          const resolved = url ? new URL(url, CURRENT_PAGE_URL).href : 'about:blank';
          const normalizedTarget = (target || '_blank').toLowerCase();

          // 1. Handle targeted contextual routing structures
          if (normalizedTarget === '_self') {
            window.__windowProxy.location.href = resolved;
            return window.__windowProxy;
          } 
          
          if (normalizedTarget === '_parent') {
            window.__windowProxy.parent.location.href = resolved;
            return window.__windowProxy.parent;
          } 
          
          if (normalizedTarget === '_top') {
            window.__windowProxy.top.location.href = resolved;
            return window.__windowProxy.top;
          }

          // Pass false if features specify background rules, or default to foreground (true)
          const activateTab = !features || !features.includes('background');
          const newPage = sendEvent('open', resolved, activateTab);
          
          // Return a mock window context matching standard JS expectations
          return newPage.iframe.contentWindow.__windowProxy || newPage.iframe.contentWindow;
        };

        ['MouseEvent', 'KeyboardEvent', 'FocusEvent', 'UIEvent'].forEach(eventName => {
          if (window[eventName]) {
            window[eventName] = new Proxy(window[eventName], {
              construct(target, args) {
                const [type, params] = args;
                if (params && params.view) {
                  params.view = params.view.__trueWindow || params.view;
                }
                return Reflect.construct(target, args, target);
              }
            });
          }
        });

        // Catch file input activation before the native file picker can open.
        const nativeElementClick = HTMLElement.prototype.click;
        HTMLElement.prototype.click = function() {
          if (this.tagName === 'INPUT' && String(this.getAttribute('type') || '').toLowerCase() === 'file') {
            if (!this.disabled) void sendAsyncEvent('upload',this).catch(() => {});
            return;
          }
          if (this.tagName === 'A') {
            const href = this.getAttribute('href');
            if (href) {
              if (href.startsWith('javascript:')) {
                const code = decodeURIComponent(href.slice(11));
                window.__executeCode(code, '<anonymous>');
                return;
              }

              const resolved = new URL(href, CURRENT_PAGE_URL).href;
              const target = (this.getAttribute('target') || '_self').toLowerCase();

              let targetWindow = window.__windowProxy;
              if (target === '_top') {
                targetWindow = window.__windowProxy.top;
              } else if (target === '_parent') {
                targetWindow = window.__windowProxy.parent;
              } else if (target === '_blank') {
                window.open(resolved, '_blank');
                return;
              }

              if (targetWindow && targetWindow.location) {
                targetWindow.location.href = resolved;
                return;
              }
            }
          }
          
          return nativeElementClick.apply(this, arguments);
        };

        addEventListener(document, 'click', function(e) {
          const fileInput = e.target.closest('input[type=\"file\"]');
          if (fileInput) {
            e.preventDefault();
            e.stopPropagation();
            if (!fileInput.disabled) void sendAsyncEvent('upload',fileInput).catch(() => {});
            return;
          }
          const link = e.target.closest('a');
          if (link && link.dataset.isInternalDownload) {
            return; 
          }
          if (link && link.getAttribute('href')) {
            const href = link.getAttribute('href');
            if (href && href.startsWith('javascript:')) {
              const code = decodeURIComponent(href.slice(11));
              window.__executeCode(code, '<anonymous>');
              return;
            }

            const resolved = new URL(href, CURRENT_PAGE_URL).href;
            const isMiddleClick = e.button === 1;
            const isCmdOrCtrl = e.ctrlKey || e.metaKey;
            const isTargetBlank = link.getAttribute('target') === '_blank';

            if (isMiddleClick || isCmdOrCtrl || isTargetBlank) {
              e.preventDefault();
              e.stopPropagation();
              sendEvent('open', resolved, !isCmdOrCtrl && !isMiddleClick);
            } else if (parentWindow && parentWindow.navigateToInTab) {
              const anchor = e.target.closest('a');
              if (!anchor || !anchor.href) return;
              if (anchor.getAttribute('download')) return (async function() {
                e.preventDefault();
                e.stopPropagation();
                try {
                  await sendAsyncEvent('download',resolved,anchor.getAttribute('download') || '');
                } catch(e) { console.error('Download via fetch failed:', e); };
              })();
              const target = (anchor.getAttribute('target') || '').toLowerCase();
              if (target === '_top') {
                e.preventDefault();
                e.stopPropagation();
                window.__windowProxy.top.location.href = anchor.href;
              } else if (target === '_parent') {
                e.preventDefault();
                e.stopPropagation();
                window.__windowProxy.parent.location.href = anchor.href;
              } else {
                e.preventDefault();
                e.stopPropagation();
                window.__windowProxy.location.href = anchor.href;
              }
            }
          }
        }, true);
        
        // 1. Neutralize programmatic form .submit() calls
        HTMLFormElement.prototype.submit = function() {
          const event = new Event('submit', { 
            bubbles: true, 
            cancelable: true
          });
          this.dispatchEvent(event);
        };

        document.addEventListener('submit', function(e) {
          const form = e.target;
          if (!form || !(form instanceof HTMLFormElement)) return;
          
          // Halt the native browser submission immediately
          e.preventDefault(); 

          // --- 1. Evaluate if this form intended to block navigation ---
          let shouldNavigate = true;
          if (typeof form.onsubmit === 'function') {
            // Run the handler in the context of the form. 
            // If it explicitly returns false, flag it to block redirection later.
            if (form.onsubmit.call(form, e) === false) {
              shouldNavigate = false;
            }
          } else {
            const onsubmitAttr = form.getAttribute('onsubmit');
            if (onsubmitAttr && onsubmitAttr.includes('return false')) {
              shouldNavigate = false;
            }
          }

          // --- 2. Setup your Proxy Network Context ---
          let targetWindow = window.__windowProxy || window;
          const action = form.getAttribute('action') || targetWindow.location.href;
          const method = (form.getAttribute('method') || 'GET').toUpperCase();
          const target = (form.getAttribute('target') || '_self').toLowerCase();
          let targetUrlObj = new URL(action, targetWindow.location.href);

          if (target === '_top') targetWindow = targetWindow.top;
          if (target === '_parent') targetWindow = targetWindow.parent;

          const formData = new FormData(form);

          // --- GET ROUTE ---
          if (method === 'GET') {
            for (const [key, value] of formData.entries()) {
              targetUrlObj.searchParams.append(key, value);
            }
            
            // Only perform the window location shift if the form didn't cancel navigation
            if (shouldNavigate) {
              if (target === '_blank') {
                window.open(targetUrlObj.href, '_blank');
              } else {
                targetWindow.location.href = targetUrlObj.href;
              }
            }
            return;
          }

          // --- POST / OTHER ROUTE ---
          const isMultipart = form.enctype === 'multipart/form-data';
          const bodyPayload = isMultipart ? formData : new URLSearchParams(formData);

          // Only pre-open a blank window if we actually intend to navigate to it
          let blankWindowRef = null;
          if (target === '_blank' && shouldNavigate) {
            blankWindowRef = window.open('about:blank', '_blank');
          }

          fetch(targetUrlObj.href, {
            method: method,
            body: bodyPayload
          }).then(async response => {
            
            // Read the body content regardless of navigation state
            const contentType = response.headers.get('content-type') || '';
            let responseData = null;
            if (contentType.includes('text/html')) {
              responseData = await response.text();
            } else if (contentType.includes('application/json')) {
              responseData = await response.json();
            }

            // --- CRITICAL FIX: Wake up your local consumer code ---
            // We fire a custom event directly onto the form containing the raw proxy response
            const proxyEvent = new CustomEvent('proxysubmit:success', {
              bubbles: true,
              cancelable: true,
              detail: {
                url: response.url,
                status: response.status,
                contentType: contentType,
                data: responseData
              }
            });
            form.dispatchEvent(proxyEvent);

            // If the form intended to cancel standard browser navigation, stop here.
            // The event above has already broadcasted the payload to your other scripts.
            if (!shouldNavigate) {
              if (blankWindowRef) blankWindowRef.close();
              return; 
            }

            const contextWindow = blankWindowRef || targetWindow;

            if (response.redirected) {
              contextWindow.location.href = response.url;
            } else {
              if (contentType.includes('text/html')) {
                contextWindow.document.documentElement.innerHTML = responseData; // reuse the parsed text
                
                contextWindow.document.querySelectorAll('script').forEach(oldScript => {
                  const newScript = contextWindow.document.createElement('script');
                  Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
                  newScript.appendChild(contextWindow.document.createTextNode(oldScript.innerHTML));
                  oldScript.parentNode.replaceChild(newScript, oldScript);
                });
              } else {
                contextWindow.location.href = response.url;
              }
            }
          }).catch(err => {
            console.error(`Proxied Form submission (${method}) failed:`, err.message);
            if (blankWindowRef) blankWindowRef.close();
          });
        }, true);

        if (pageEmulator.runtimeInterceptor) eval(pageEmulator.runtimeInterceptor);

        const originalFetch = window.fetch;
        window.fetch = async function(input, data = {}, type = 'fetch') {
          let fetchUrl = input;
          let requestOptions = { ...data };

          // Check if the input is a Request object
          if (input instanceof Request) {
            fetchUrl = input.url;
            
            // Clone the request so reading the body doesn't break the original fallback
            const clonedRequest = input.clone();
            
            // Extract properties from the Request object into your data object
            requestOptions.method = clonedRequest.method;
            requestOptions.headers = Object.fromEntries(clonedRequest.headers.entries());
            
            // Safely extract the body text if a body exists
            if (clonedRequest.body) {
              try {
                requestOptions.body = await clonedRequest.text();
              } catch (e) {
                console.warn("Could not read request body:", e);
              }
            }
          }

          const resolvedUrl = new URL(typeof fetchUrl === 'string' ? fetchUrl : fetchUrl.url, CURRENT_PAGE_URL).href;
          
          // Pass the enriched requestOptions into your network handler
          const response = await pageEmulator.network.request(resolvedUrl, BASE_ORIGIN, requestOptions, type);
          if (response) return response;
          
          return await originalFetch.apply(this, arguments);
        };

        (function() {
          const OriginalWebSocket = window.WebSocket;
          
          class InterceptableWebSocket extends EventTarget {
            constructor(url, protocols) {
              super();
              const rawUrl = typeof url === 'string' ? url : url.toString();
              const baseUrl =  CURRENT_PAGE_URL;
              this.url = new URL(rawUrl, baseUrl).href;
              this.readyState = OriginalWebSocket.CONNECTING;
              this.protocol = "";
              this.extensions = "";
              this.binaryType = "blob";
              this.bufferedAmount = 0;
              this._sendQueue = [];
              this._mock = null;
              this._serverFrameBuffer = new Uint8Array(0);
              this._init(this.url, protocols);
            }

            async _init(url, protocols) {
              const base = CURRENT_PAGE_URL;
              let response;
              try {
                response = await pageEmulator.network.socket(url, base, protocols);
              } catch (e) {
                console.error('[VirtualWS v10] WS NETWORK REQUEST THREW', e && e.stack || e);
                response = null;
              }

              if (response instanceof OriginalWebSocket) {
                this._setupReal(response);
              } else if (response && typeof response.onClientMessage === 'function') {
                this._setupMock(response);
              } else {
                this._setupReal(new OriginalWebSocket(url, protocols));
              }
            }

            _setupReal(wsInstance) {
              this._ws = wsInstance;
              this._ws.binaryType = this.binaryType;
              this._ws.onopen = (e) => {
                this.readyState = OriginalWebSocket.OPEN;
                this.protocol = this._ws.protocol;
                this.extensions = this._ws.extensions;
                this.dispatchEvent(new Event('open'));
                if (this.onopen) this.onopen(e);
                this._flushQueue();
              };
              this._ws.onmessage = (e) => {
                this.dispatchEvent(new MessageEvent('message', { data: e.data }));
                if (this.onmessage) this.onmessage(e);
              };
              this._ws.onclose = (e) => {
                this.readyState = OriginalWebSocket.CLOSED;
                this.dispatchEvent(new CloseEvent('close', {
                  code: e.code, reason: e.reason, wasClean: e.wasClean
                }));
                if (this.onclose) this.onclose(e);
              };
              this._ws.onerror = (e) => {
                this.dispatchEvent(new Event('error'));
                if (this.onerror) this.onerror(e);
              };
            }

            _setupMock(mockBackend) {
              this._mock = mockBackend;

              // Do NOT replace backend sendToClient/closeClient. The backend owns the
              // server -> browser transport; we only register callbacks on it.
              mockBackend._onOpen = () => {
                if (this.readyState !== OriginalWebSocket.CONNECTING) return;
                this.readyState = OriginalWebSocket.OPEN;
                this.dispatchEvent(new Event('open'));
                if (this.onopen) this.onopen(new Event('open'));
                this._flushQueue();
              };

              mockBackend._onServerData = (data) => {
                try {
                  this._consumeServerFrames(data);
                } catch (err) {
                  console.error('[VirtualWS v15] SERVER DATA PARSER THREW', err && err.stack || err);
                  throw err;
                }
              };

              mockBackend._onClose = (code, reason) => {
                if (this.readyState === OriginalWebSocket.CLOSED) return;
                this.readyState = OriginalWebSocket.CLOSED;
                const evt = new CloseEvent('close', {
                  code: code || 1000,
                  reason: reason || '',
                  wasClean: true
                });
                this.dispatchEvent(evt);
                if (this.onclose) this.onclose(evt);
              };
            }

            _consumeServerFrames(data) {
              // The interceptor and browser shim can run in different VM realms.
              // Do NOT rely on `instanceof Uint8Array` / `instanceof ArrayBuffer`:
              // a Uint8Array created in the interceptor realm is not necessarily an
              // instance of this realm's Uint8Array. ArrayBuffer.isView() plus the
              // byteLength/byteOffset duck-type handles cross-realm Buffer/Uint8Array.
              let incoming;
              if (typeof data === 'string') {
                incoming = new TextEncoder().encode(data);
              } else if (data && typeof data.byteLength === 'number' && data.buffer) {
                const byteOffset = typeof data.byteOffset === 'number' ? data.byteOffset : 0;
                incoming = new Uint8Array(data.buffer, byteOffset, data.byteLength);
              } else if (data && typeof data.byteLength === 'number') {
                // Cross-realm ArrayBuffer fallback. Copy through a Uint8Array view
                // when the value is accepted by the current realm's constructor.
                try {
                  incoming = new Uint8Array(data);
                } catch (_) {
                  incoming = null;
                }
              }
              if (!incoming) return;

              const merged = new Uint8Array(this._serverFrameBuffer.length + incoming.length);
              merged.set(this._serverFrameBuffer);
              merged.set(incoming, this._serverFrameBuffer.length);
              this._serverFrameBuffer = merged;

              let offset = 0;
              while (this._serverFrameBuffer.length - offset >= 2) {
                const b0 = this._serverFrameBuffer[offset];
                const b1 = this._serverFrameBuffer[offset + 1];
                const fin = !!(b0 & 0x80);
                const opcode = b0 & 0x0f;
                const masked = !!(b1 & 0x80);
                let len = b1 & 0x7f;
                let headerLen = 2;

                if (len === 126) {
                  if (this._serverFrameBuffer.length - offset < 4) break;
                  len = (this._serverFrameBuffer[offset+2] << 8) |
                        this._serverFrameBuffer[offset+3];
                  headerLen = 4;
                } else if (len === 127) {
                  if (this._serverFrameBuffer.length - offset < 10) break;
                  // JS safe integer is enough for practical WebSocket payloads.
                  len = 0;
                  for (let i = 0; i < 8; i++) len = len * 256 + this._serverFrameBuffer[offset+2+i];
                  headerLen = 10;
                  if (len > Number.MAX_SAFE_INTEGER) {
                    this.close(1009, 'Message too large');
                    return;
                  }
                }

                const maskLen = masked ? 4 : 0;
                const frameLen = headerLen + maskLen + len;
                if (this._serverFrameBuffer.length - offset < frameLen) break;

                let p = offset + headerLen;
                let mask;
                if (masked) {
                  mask = this._serverFrameBuffer.slice(p, p + 4);
                  p += 4;
                }
                let payload = this._serverFrameBuffer.slice(p, p + len);
                if (masked) {
                  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                }

                offset += frameLen;


                if (opcode === 0x8) {
                  let code = 1000, reason = '';
                  if (payload.length >= 2) {
                    code = (payload[0] << 8) | payload[1];
                    reason = new TextDecoder().decode(payload.slice(2));
                  }
                  this.readyState = OriginalWebSocket.CLOSED;
                  const evt = new CloseEvent('close', {code, reason, wasClean: true});
                  this.dispatchEvent(evt);
                  if (this.onclose) this.onclose(evt);
                  return;
                }
                if (opcode === 0x9) {
                  // RFC6455 ping -> pong. The server normally handles this itself,
                  // but responding here makes the browser-side mock complete.
                  this._sendRawFrame(0xA, payload);
                  continue;
                }
                if (opcode === 0xA || opcode === 0x0) {
                  // pong/continuation handling below
                }

                if (opcode === 0x1 || opcode === 0x2) {
                  if (fin) this._dispatchServerPayload(opcode, payload);
                  else {
                    this._fragmentOpcode = opcode;
                    this._fragmentParts = [payload];
                  }
                } else if (opcode === 0x0 && this._fragmentParts) {
                  this._fragmentParts.push(payload);
                  if (fin) {
                    let total = 0;
                    for (const part of this._fragmentParts) total += part.length;
                    const all = new Uint8Array(total);
                    let at = 0;
                    for (const part of this._fragmentParts) { all.set(part, at); at += part.length; }
                    this._dispatchServerPayload(this._fragmentOpcode, all);
                    this._fragmentParts = null;
                    this._fragmentOpcode = null;
                  }
                }
              }

              this._serverFrameBuffer = this._serverFrameBuffer.slice(offset);
            }

            _dispatchServerPayload(opcode, payload) {
              let data;
              if (opcode === 0x1) data = new TextDecoder().decode(payload);
              else if (this.binaryType === 'arraybuffer') {
                data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
              } else {
                data = new Blob([payload]);
              }
              const evt = new MessageEvent('message', {data});
              try {
                this.dispatchEvent(evt);
              } catch (err) {
                console.error('[VirtualWS v15] BROWSER dispatchEvent THREW', err && err.stack || err);
                throw err;
              }
              if (this.onmessage) {
                this.onmessage(evt);
              }
            }

            _sendRawFrame(opcode, payload) {
              // The server should almost never send us ping frames in Socket.IO, but
              // keep this path safe for completeness. Browser-originated frames are
              // masked; the mock backend receives the complete RFC6455 frame.
              const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
              const mask = new Uint8Array(4);
              if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(mask);
              else for (let i=0;i<4;i++) mask[i]=Math.random()*256;
              let header;
              if (bytes.length < 126) header = new Uint8Array([0x80|opcode, 0x80|bytes.length]);
              else if (bytes.length <= 65535) header = new Uint8Array([0x80|opcode, 0x80|126, bytes.length>>>8, bytes.length&255]);
              else return;
              const frame = new Uint8Array(header.length + 4 + bytes.length);
              frame.set(header);
              frame.set(mask, header.length);
              for (let i=0;i<bytes.length;i++) frame[header.length+4+i]=bytes[i]^mask[i&3];
              if (this._mock) this._mock.onClientMessage(frame);
            }

            _flushQueue() {
              while (this._sendQueue.length > 0 && this.readyState === OriginalWebSocket.OPEN) {
                this.send(this._sendQueue.shift());
              }
            }

            send(data) {
              if (this.readyState === OriginalWebSocket.CONNECTING) {
                this._sendQueue.push(data);
                return;
              }
              if (this.readyState !== OriginalWebSocket.OPEN) {
                throw new DOMException('WebSocket is not open', 'InvalidStateError');
              }
              if (this._ws) {
                this._ws.send(data);
              } else if (this._mock) {
                // The virtual server socket is a Node net.Socket as far as ws is
                // concerned, so it must receive actual RFC6455 frames, not the
                // Socket.IO payload by itself.
                this._sendClientFrame(data);
              }
            }

            _sendClientFrame(data) {
              let payload;
              let opcode = 0x1;
              if (typeof data === 'string') {
                payload = new TextEncoder().encode(data);
              } else if (data instanceof ArrayBuffer) {
                payload = new Uint8Array(data);
                opcode = 0x2;
              } else if (data instanceof Uint8Array) {
                payload = new Uint8Array(data);
                opcode = 0x2;
              } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
                // Native WebSocket.send(Blob) is async; mirror that behavior.
                data.arrayBuffer().then(buf => this._sendClientFrame(buf));
                return;
              } else {
                payload = new TextEncoder().encode(String(data));
              }

              const mask = new Uint8Array(4);
              if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(mask);
              else for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);

              let header;
              if (payload.length < 126) {
                header = new Uint8Array([0x80 | opcode, 0x80 | payload.length]);
              } else if (payload.length <= 65535) {
                header = new Uint8Array([0x80 | opcode, 0x80 | 126,
                  (payload.length >>> 8) & 255, payload.length & 255]);
              } else {
                // Encode a 64-bit length without BigInt so older browser targets work.
                header = new Uint8Array(10);
                header[0] = 0x80 | opcode;
                header[1] = 0x80 | 127;
                let n = payload.length;
                for (let i = 9; i >= 2; i--) {
                  header[i] = n % 256;
                  n = Math.floor(n / 256);
                }
              }

              const frame = new Uint8Array(header.length + 4 + payload.length);
              frame.set(header);
              frame.set(mask, header.length);
              for (let i = 0; i < payload.length; i++) {
                frame[header.length + 4 + i] = payload[i] ^ mask[i & 3];
              }
              this.bufferedAmount = Math.max(0, this.bufferedAmount + frame.byteLength);
              this._mock.onClientMessage(frame);
              this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength);
            }

            close(code, reason) {
              if (this.readyState === OriginalWebSocket.CLOSED ||
                  this.readyState === OriginalWebSocket.CLOSING) return;
              if (this._ws) {
                this.readyState = OriginalWebSocket.CLOSING;
                this._ws.close(code, reason);
              } else if (this._mock && typeof this._mock.closeClient === 'function') {
                this.readyState = OriginalWebSocket.CLOSING;
                this._mock.closeClient(code || 1000, reason || '');
              } else {
                this.readyState = OriginalWebSocket.CLOSED;
              }
            }
          }

          InterceptableWebSocket.CONNECTING = 0;
          InterceptableWebSocket.OPEN = 1;
          InterceptableWebSocket.CLOSING = 2;
          InterceptableWebSocket.CLOSED = 3;
          
          window.WebSocket = InterceptableWebSocket;
        })();

        (function() {
          const global = window;

          // 1. Inherit correctly from EventTarget to support addEventListener/removeEventListener
          class XMLHttpRequestEventTarget extends EventTarget {
            constructor() {
              super();
              this._listeners = new Map();
            }
          }

          class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}

          class XMLHttpRequestPolyfill extends XMLHttpRequestEventTarget {
            // Ready State constants
            static get UNSENT() { return 0; }
            static get OPENED() { return 1; }
            static get HEADERS_RECEIVED() { return 2; }
            static get LOADING() { return 3; }
            static get DONE() { return 4; }

            constructor() {
              super();
              
              // Public States
              this.readyState = XMLHttpRequestPolyfill.UNSENT;
              this.status = 0;
              this.statusText = '';
              this.response = null;
              this.responseText = '';
              this.responseXML = null;
              this.responseType = '';
              this.timeout = 0;
              this.withCredentials = false;
              this.upload = new XMLHttpRequestUpload();

              // Event Property Handlers
              this.onreadystatechange = null;
              this.onloadstart = null;
              this.onprogress = null;
              this.onabort = null;
              this.onerror = null;
              this.onload = null;
              this.ontimeout = null;
              this.onloadend = null;

              // Internal properties
              this._method = '';
              this._url = '';
              this._async = true;
              this._requestHeaders = new Headers();
              this._responseHeaders = new Headers();
              this._abortController = null;
              this._overrideMimeType = null;
              this._timeoutTimer = null;
            }

            // Assign proxy helpers to catch macro on-event hooks
            _dispatchEvent(eventName, eventObj = new Event(eventName)) {
              const handler = this[`on${eventName}`];
              if (typeof handler === 'function') {
                try { handler.call(this, eventObj); } catch (e) { console.error(e); }
              }
              this.dispatchEvent(eventObj);
            }

            _changeState(newState) {
              this.readyState = newState;
              this._dispatchEvent('readystatechange');
            }

            open(method, url, async = true, username = null, password = null) {
              this._method = method.toUpperCase();
              
              // Standardize relative URL resolution
              const parsedUrl = new URL(url, CURRENT_PAGE_URL);
              if (username) parsedUrl.username = username;
              if (password) parsedUrl.password = password;
              this._url = parsedUrl.href;
              
              this._async = !!async;

              // Fail explicitly for Synchronous implementations since native fetch forces Async threads
              if (!this._async) {
                throw new DOMException("Synchronous XMLHttpRequest via fetch polyfill is unsupported.", "NotSupportedError");
              }

              // Reset configurations on reopening
              this._requestHeaders = new Headers();
              this._responseHeaders = new Headers();
              this.responseText = '';
              this.response = null;

              this._changeState(XMLHttpRequestPolyfill.OPENED);
            }

            setRequestHeader(header, value) {
              if (this.readyState !== XMLHttpRequestPolyfill.OPENED) {
                throw new DOMException("Failed to execute 'setRequestHeader': The object's state must be OPENED.", "InvalidStateError");
              }
              this._requestHeaders.append(header, value);
            }

            overrideMimeType(mime) {
              if (this.readyState >= XMLHttpRequestPolyfill.LOADING) {
                throw new DOMException("Failed to execute 'overrideMimeType': Actions cannot be performed after loading begins.", "InvalidStateError");
              }
              this._overrideMimeType = mime;
            }

            getResponseHeader(header) {
              if (this.readyState < XMLHttpRequestPolyfill.HEADERS_RECEIVED) return null;
              return this._responseHeaders.get(header);
            }

            getAllResponseHeaders() {
              if (this.readyState < XMLHttpRequestPolyfill.HEADERS_RECEIVED) return '';
              let headersString = '';
              this._responseHeaders.forEach((value, key) => {
                headersString += `${key}: ${value}\r\n`;
              });
              return headersString;
            }

            abort() {
              if (this._abortController) {
                this._abortController.abort();
              }
              if (this._timeoutTimer) clearTimeout(this._timeoutTimer);
              
              if (this.readyState !== XMLHttpRequestPolyfill.UNSENT && 
                (this.readyState < XMLHttpRequestPolyfill.OPENED || this.readyState === XMLHttpRequestPolyfill.DONE)) {
                this.readyState = XMLHttpRequestPolyfill.UNSENT;
                return;
              }

              this.readyState = XMLHttpRequestPolyfill.UNSENT;
              this._dispatchEvent('abort');
              this._dispatchEvent('loadend');
            }

            send(body = null) {
              //try { console.warn("[XHR v20] SEND", { method: this._method, url: this._url, bodyType: typeof body, bodyPreview: typeof body === "string" ? body.slice(0, 160) : body }); } catch (_) {}
              if (this.readyState !== XMLHttpRequestPolyfill.OPENED) {
                throw new DOMException("Failed to execute 'send': The object's state must be OPENED.", "InvalidStateError");
              }

              this._abortController = new AbortController();
              const fetchOptions = {
                method: this._method,
                headers: this._requestHeaders,
                signal: this._abortController.signal,
                credentials: this.withCredentials ? 'include' : 'same-origin'
              };

              if (body !== null && this._method !== 'GET' && this._method !== 'HEAD') {
                fetchOptions.body = body;
              }

              // Handle timeouts via Abort Signal binding
              if (this.timeout > 0) {
                this._timeoutTimer = setTimeout(() => {
                  this._abortController.abort();
                  this._dispatchEvent('timeout');
                  this._dispatchEvent('loadend');
                }, this.timeout);
              }

              // Execution Pipeline
              this._dispatchEvent('loadstart');

              fetch(this._url, fetchOptions, 'xhr')
                .then(async (res) => {
                  try { console.warn("[XHR v20] FETCH RESPONSE", { method: this._method, url: this._url, status: res.status, ok: res.ok }); } catch (_) {}
                  if (this._timeoutTimer) clearTimeout(this._timeoutTimer);

                  //if (res.redirected) alert(this._url);

                  this.status = res.status;
                  this.statusText = res.statusText;
                  this._responseHeaders = res.headers;

                  this._changeState(XMLHttpRequestPolyfill.HEADERS_RECEIVED);
                  this._changeState(XMLHttpRequestPolyfill.LOADING);

                  // Extract content mapping configurations
                  let mimeType = this._overrideMimeType || res.headers.get('content-type') || 'text/plain';
                  
                  if (this.responseType === 'blob') {
                    this.response = await res.blob();
                  } else if (this.responseType === 'arraybuffer') {
                    this.response = await res.arrayBuffer();
                  } else if (this.responseType === 'json') {
                    const txt = await res.text();
                    this.responseText = txt;
                    this.response = JSON.parse(txt);
                  } else if (this.responseType === 'document' || mimeType.includes('xml') || mimeType.includes('html')) {
                    const txt = await res.text();
                    this.responseText = txt;
                    if (global.DOMParser) {
                      const parser = new DOMParser();
                      this.responseXML = parser.parseFromString(txt, mimeType.includes('html') ? 'text/html' : 'application/xml');
                      this.response = this.responseXML;
                    } else {
                      this.response = txt;
                    }
                  } else {
                    // Default raw text decoding strategy
                    const txt = await res.text();
                    this.responseText = txt;
                    this.response = txt;
                  }

                  this._changeState(XMLHttpRequestPolyfill.DONE);
                  try { console.warn("[XHR v20] LOAD", { method: this._method, url: this._url, responseTextLength: typeof this.responseText === "string" ? this.responseText.length : -1 }); } catch (_) {}
                  this._dispatchEvent('load');
                  this._dispatchEvent('loadend');
                })
                .catch((err) => {
                  if (this._timeoutTimer) clearTimeout(this._timeoutTimer);
                  if (err.name === 'AbortError') return; // Handled locally inside wrapper pipelines

                  try { console.warn("[XHR v20] ERROR", { method: this._method, url: this._url, error: err && err.message || String(err) }); } catch (_) {}
                  this.status = 0;
                  this._changeState(XMLHttpRequestPolyfill.DONE);
                  this._dispatchEvent('error');
                  this._dispatchEvent('loadend');
                });
            }
          }

          // Bind prototype constant fallback chains
          [XMLHttpRequestPolyfill, XMLHttpRequestPolyfill.prototype].forEach(target => {
            target.UNSENT = 0;
            target.OPENED = 1;
            target.HEADERS_RECEIVED = 2;
            target.LOADING = 3;
            target.DONE = 4;
          });

          // Hot swap global object space natively
          global.XMLHttpRequest = XMLHttpRequestPolyfill;
        })();

        const oldGetEntriesByType = performance.getEntriesByType;
        performance.getEntriesByType = function() {
          var value = oldGetEntriesByType.apply(this,arguments);
          for (var i in value) value[i].name = DOCUMENT_URL;
          return value;
        }

        const originalAddEventListener = EventTarget.prototype.addEventListener;
        const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
        const listenerMap = new WeakMap();

        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type !== 'message' || typeof listener !== 'function') {
            return originalAddEventListener.call(this, type, listener, options);
          }
          const wrappedListener = function(event) {
            if (event.origin !== 'null' && event.origin !== 'about:srcdoc' && event.origin) {
              return listener.call(this, event);
            }
            const proxyEvent = new Proxy(event, {
              get(target, prop) {
                if (prop === 'origin') return BASE_ORIGIN;
                if (prop === 'source' && target.source?.__windowProxy) return target.source.__windowProxy;
                const val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
              }
            });
            return listener.call(this, proxyEvent);
          };
          listenerMap.set(listener, wrappedListener);
          return originalAddEventListener.call(this, type, wrappedListener, options);
        };

        EventTarget.prototype.removeEventListener = function(type, listener, options) {
          if (type === 'message' && typeof listener === 'function' && listenerMap.has(listener)) {
            return originalRemoveEventListener.call(this, type, listenerMap.get(listener), options);
          }
          return originalRemoveEventListener.call(this, type, listener, options);
        };

        Object.defineProperty(window, 'frameElement', {
          get: function() { return isTopLevel ? null : wrapElement(window.__frameElement); },
          set: undefined,
          configurable: true,
          enumerable: true
        });

        function createStorageProxy(storageProvider, storagePrefix) {
          return new Proxy(storageProvider, {
            // Intercept property access (e.g., storage.getItem, storage.length, storage.foo)
            get(target, prop, receiver) {
              // 1. Handle explicit method overrides
              if (prop === 'setItem') {
                return (key, value) => target.setItem(storagePrefix + key, value);
              }
              if (prop === 'getItem') {
                return (key) => target.getItem(storagePrefix + key);
              }
              if (prop === 'removeItem') {
                return (key) => target.removeItem(storagePrefix + key);
              }
              if (prop === 'clear') {
                return () => {
                  const keysToRemove = [];
                  for (let i = 0; i < target.length; i++) {
                    const internalKey = target.key(i);
                    if (internalKey && internalKey.startsWith(storagePrefix)) {
                      keysToRemove.push(internalKey);
                    }
                  }
                  keysToRemove.forEach(key => target.removeItem(key));
                };
              }
              if (prop === 'key') {
                return (index) => {
                  let internalIndex = 0;
                  for (let i = 0; i < target.length; i++) {
                    const internalKey = target.key(i);
                    if (internalKey && internalKey.startsWith(storagePrefix)) {
                      if (internalIndex === index) {
                        return internalKey.slice(storagePrefix.length);
                      }
                      internalIndex++;
                    }
                  }
                  return null;
                };
              }

              // 2. Handle 'length' property override
              if (prop === 'length') {
                let count = 0;
                for (let i = 0; i < target.length; i++) {
                  const internalKey = target.key(i);
                  if (internalKey && internalKey.startsWith(storagePrefix)) {
                    count++;
                  }
                }
                return count;
              }

              // 3. Support direct property access (e.g., storageProxy.myKey)
              if (typeof prop === 'string') {
                return target.getItem(storagePrefix + prop);
              }

              // Fallback for symbols or other unhandled properties
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },

            // Intercept property assignment (e.g., storageProxy.myKey = 'value')
            set(target, prop, value) {
              if (typeof prop === 'string') {
                target.setItem(storagePrefix + prop, value);
                return true;
              }
              return Reflect.set(target, prop, value);
            },

            // Intercept the `delete` operator (e.g., delete storageProxy.myKey)
            deleteProperty(target, prop) {
              if (typeof prop === 'string') {
                target.removeItem(storagePrefix + prop);
                return true;
              }
              return Reflect.deleteProperty(target, prop);
            }
          });
        }

        const storagePrefix = BASE_ORIGIN + ":";
        const localStorageProxy = createStorageProxy(window.localStorage, storagePrefix);
        const sessionStorageProxy = createStorageProxy(window.sessionStorage, storagePrefix);
        Object.defineProperty(window, 'localStorage', {
          get: function() { return localStorageProxy; },
          set: undefined,
          configurable: true,
          enumerable: true
        });
        Object.defineProperty(window, 'sessionStorage', {
          get: function() { return localStorageProxy; },
          set: undefined,
          configurable: true,
          enumerable: true
        });

        // history & location
        const virtualLocation = Object.create(Location.prototype);
        Object.assign(virtualLocation, {
          href: DOCUMENT_URL,
          origin: BASE_ORIGIN,
          protocol: new URL(DOCUMENT_URL).protocol,
          host: new URL(DOCUMENT_URL).host,
          hostname: new URL(DOCUMENT_URL).hostname,
          pathname: new URL(DOCUMENT_URL).pathname,
          search: new URL(DOCUMENT_URL).search,
          hash: new URL(DOCUMENT_URL).hash,
          assign: function(newUrl) { sendEvent('navigate', newUrl, true); },
          replace: function(newUrl) { sendEvent('navigate', newUrl, false); },
          reload: function() { sendEvent('navigate', DOCUMENT_URL, false); },
          toString: function() { return DOCUMENT_URL; }
        });
        Object.defineProperty(virtualLocation, 'href', {
          get: function() { return DOCUMENT_URL; },
          set: function(u) { return this.assign(u); }
        });
        Object.defineProperty(virtualLocation, Symbol.toStringTag, {
          value: 'Location',
          configurable: true,
          writable: false,
          enumerable: false
        });

        Object.defineProperty(window, 'origin', {
          value: BASE_ORIGIN,
          configurable: true,
          writable: true
        });

        Object.defineProperty(PerformanceNavigationTiming.prototype, 'name', {
          value: DOCUMENT_URL,
          enumerable: true,
          configurable: true
        });

        var documentTarget = Object.create(Document.prototype);
        Object.getOwnPropertyNames(document).forEach(prop => {
          try {
            if (prop === 'location') {
              Object.defineProperty(documentTarget, prop, {
                get: function() { return virtualLocation; },
                set: function(url) { virtualLocation.assign(url); },
                configurable: true,
                enumerable: true
              });
              return;
            }
            const desc = Object.getOwnPropertyDescriptor(document, prop);
            if (desc) {
              Object.defineProperty(documentTarget, prop, desc);
            }
          } catch(e) {
            console.log("Failed to clone 2:", prop);
          }
        });
        function virtualizeDocumentSelector(selector) {
          if (typeof selector !== 'string') return selector;
          return selector.replace(/(^|[,>+~\s])script(\s*)\[src([\s~|^$*]?=)/gi, '$1script$2[data-raw-src$3');
        }

        const documentProxy = new Proxy(documentTarget, {
          has(target, prop) {
            if (prop === 'location') return true;
            return Reflect.has(document, prop);
          },
          get(target, prop) {
            if (prop === Symbol.unscopables) return undefined;
            
            // Force document.location to return the virtual location object
            if (prop === 'location') return virtualLocation;
            if (prop === 'referrer') return '';
            if (prop === 'documentURI') return DOCUMENT_URL;
            if (prop === 'URL') return DOCUMENT_URL;
            if (prop === 'defaultView') return windowProxy;
            if (prop === 'domain') return new URL(CURRENT_PAGE_URL).hostname;

            // --- Intercept document.open() to prevent context wiping ---
            if (prop === 'open') {
              return function(...args) {
                const ret = Reflect.apply(document.open, document, args);
                return documentProxy;
              };
            }

            // --- Intercept document.write() and document.writeln() ---
            if (prop === 'write' || prop === 'writeln') {
              return function(...args) {
                (async function() {
                  const htmlContent = args.join('');
                  let processedHtml = await usefulHelpers.sandboxSource(htmlContent, pageEmulator, true);
                  Reflect.apply(document[prop], document, [processedHtml]);
                })();
              };
            }

            // --- Intercept document.close() ---
            if (prop === 'close') {
              return function(...args) {
                return Reflect.apply(document.close, document, args);
              };
            }
            
            const value = Reflect.get(document, prop, document);

            // Virtualized resource attributes are stored in data-raw-* while the
            // live DOM uses rewritten URLs. Make selector queries see the same
            // logical attributes that getAttribute()/element.src expose.
            if (prop === 'querySelector' || prop === 'querySelectorAll') {
              return function(selector) {
                const virtualSelector = virtualizeDocumentSelector(selector);
                const result = value.call(document, virtualSelector);
                if (prop === 'querySelectorAll') return Array.from(result).map(wrapElement);
                return wrapElement(result);
              };
            }

            // Handle native methods (like document.getElementById, etc.)
            if (isNativeFunction(value) && !value.prototype && prop != 'constructor') {
              return function(){ return wrapElement(value.apply(document, Array.from(arguments).map(v => v == documentProxy ? document : v))); };
            }
            if (typeof value == 'function' && prop != 'constructor') {
              return function(){ return wrapElement(value.apply(this == documentProxy ? document : this, arguments)); };
            }
            return wrapElement(value);
          },
          set(target, prop, value) {
            if (prop === 'location') {
              virtualLocation.assign(value);
              return true;
            }
            const ret = Reflect.set(document, prop, value, document);
            const desc = Object.getOwnPropertyDescriptor(document, prop);
            if (desc && desc.configurable) {
              Reflect.defineProperty(target, prop, desc);
            }
            return ret;
          },
          ownKeys(target) {
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
          defineProperty(target, prop, desc) {
            try {
              Object.defineProperty(document, prop, desc);
            } catch (e) {
              console.warn("Failed to define property on true document:", prop, e);
            }
            return Reflect.defineProperty(target, prop, desc);
          },
          deleteProperty(target, prop) {
            try {
              Reflect.deleteProperty(document, prop);
            } catch(e) {}
            return Reflect.deleteProperty(target, prop);
          }
        });

        var virtualHistory;
        Object.keys(virtualHistory = {
          state: null,
          length: pageEmulator.history ? pageEmulator.history.length : 1,
          pushState: function(state, unused, url) {
            this.state = state;
            if (url) {
              const resolvedUrl = new URL(url, virtualLocation.href).href;
              sendEvent('navigate', resolvedUrl, true, false);
            }
          },
          replaceState: function(state, unused, url) {
            this.state = state;
            if (url) {
              const resolvedUrl = new URL(url, virtualLocation.href).href;
              virtualLocation.replace(resolvedUrl);
            }
          },
          go: function(delta) {
            if (!pageEmulator || typeof delta !== 'number' || delta === 0) return;
            const targetIndex = pageEmulator.historyIndex + delta;
            if (targetIndex >= 0 && targetIndex < pageEmulator.history.length) {
              pageEmulator.historyIndex = targetIndex;
              const targetUrl = pageEmulator.history[targetIndex];
              sendEvent('navigate', targetUrl, false);
            }
          },
          back: function() {
            this.go(-1);
          },
          forward: function() {
            this.go(1);
          }
        }).forEach((k,v)=>window.history[k] = virtualHistory[k]);

        var windowTarget = Object.create(Window.prototype);
        Object.getOwnPropertyNames(window).forEach(prop => {
          try {
            if (prop === 'location') {
              Object.defineProperty(windowTarget, prop, {
                get: function() { return virtualLocation; },
                set: function(url) { virtualLocation.assign(url); },
                configurable: true,
                enumerable: true
              });
              return;
            }
            if (prop === 'document') {
              Object.defineProperty(windowTarget, prop, {
                get: function() { return documentProxy; },
                set: undefined,
                configurable: true,
                enumerable: true
              });
              return;
            }
            if (['window','globalThis','self'].includes(prop)) {
              Object.defineProperty(windowTarget, prop, {
                get: function() { return window.__windowProxy; },
                set: undefined,
                configurable: true,
                enumerable: prop !== 'globalThis'
              });
              return;
            }
            const desc = Object.getOwnPropertyDescriptor(window, prop);
            if (desc) {
              Object.defineProperty(windowTarget, prop, desc);
            }
          } catch(e) {
            console.log("Failed to clone:", prop);
          }
        });
        let windowProxy;
        function getTopPage() {
          let current = pageEmulator;
          const seen = new Set();
          while (current?.parent && current.parent !== false && !seen.has(current)) {
            seen.add(current);
            current = current.parent;
          }
          return current || pageEmulator;
        }
        function getChildPage(key) {
          const children = pageEmulator?.children || [];
          if (typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key))) {
            return children[Number(key)] || null;
          }
          if (typeof key === 'string') {
            return children.find(child => child?.iframe?.name === key || child?.iframe?.id === key) || null;
          }
          return null;
        }
        windowProxy = new Proxy(windowTarget, {
          has(target, prop) {
            if (prop === 'location' || prop === 'document' || ['window','parent','top','globalThis','self','frames'].includes(prop)) {
              return true;
            }
            if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < (pageEmulator?.children || []).length;
            return Reflect.has(target, prop) || Reflect.has(window, prop);
          },
          get(target, prop) {
            if (prop === Symbol.unscopables) return undefined;
            if (prop === 'location') return virtualLocation;
            if (prop === 'document') return documentProxy;
            if (['window','globalThis','self','frames'].includes(prop)) return windowProxy;
            if (prop === 'length') return (pageEmulator?.children || []).length;
            if (prop === 'top') return getTopPage().__windowProxy || windowProxy;
            if (prop === 'parent') return pageEmulator?.parent && pageEmulator.parent !== false && pageEmulator.parent.__windowProxy ? pageEmulator.parent.__windowProxy : windowProxy;
            if (prop === 'postMessage') {
              return function(message, targetOrigin, transfer) {
                // postMessage is a method of the Window being referenced.
                // In particular, window.top.postMessage() must target top,
                // not resolve the target from the child that created this proxy.
                var receiverPage = pageEmulator;
                if (this && this !== windowProxy) {
                  var current = pageEmulator;
                  var seen = new Set();
                  while (current && !seen.has(current)) {
                    seen.add(current);
                    if (current.__windowProxy === this) {
                      receiverPage = current;
                      break;
                    }
                    current = current.parent && current.parent !== false ? current.parent : null;
                    if (!current) break;
                  }
                  if (pageEmulator?.parent && pageEmulator.parent !== false && pageEmulator.parent.__windowProxy === this) {
                    receiverPage = pageEmulator.parent;
                  }
                }
                var targetWindow = receiverPage?.iframe?.contentWindow;
                if (!targetWindow || typeof targetWindow.postMessage !== 'function') return;
                try {
                  var origin = targetOrigin || '*';
                  targetWindow.postMessage(message, origin, transfer);
                } catch(e) {
                  try { targetWindow.postMessage(message, '*'); } catch(_) {}
                }
              };
            }
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
              const child = getChildPage(prop);
              return child?.__windowProxy || undefined;
            }
            if (typeof prop === 'string') {
              const child = getChildPage(prop);
              if (child?.__windowProxy) return child.__windowProxy;
            }
            const value = Reflect.get(window, prop, window);
            if (isNativeFunction(value) && !value.prototype) {
              return value.bind(window);
            }
            return value;
          },
          set(target, prop, value) {
            if (prop === 'location') {
              virtualLocation.assign(value);
              return true;
            }
            const ret = Reflect.set(window, prop, value, window);
            const desc = Object.getOwnPropertyDescriptor(window, prop);
            if (desc && desc.configurable) {
              Reflect.defineProperty(target, prop, desc);
            }
            return ret;
          },
          ownKeys(target) {
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
          defineProperty(target, prop, desc) {
            try {
              Object.defineProperty(window, prop, desc);
            } catch (e) {
              console.warn("Failed to define property on true window:", prop, e);
            }
            return Reflect.defineProperty(target, prop, desc);
          },
          deleteProperty(target, prop) {
            try {
              Reflect.deleteProperty(window, prop);
            } catch(e) {}
            return Reflect.deleteProperty(target, prop);
          }
        });

        // 1. Store pure, raw native references BEFORE overriding anything
        const rawCall = Function.prototype.call;
        const rawApply = Function.prototype.apply;
        const rawBind = Function.prototype.bind;
        const rawToString = Function.prototype.toString;
        const rawReflectApply = Reflect.apply;

        // 2. Safe native check that DOES NOT invoke .call() on any prototype
        function isNativeFunction(fn) {
          if (typeof fn !== 'function') return false;
          try {
            // Use rawReflectApply so we don't trigger Function.prototype.call
            const str = rawReflectApply(rawToString, fn, []);
            return str.includes('[native code]');
          } catch (e) {
            return false;
          }
        }

        function normalizeThis(fn, thisArg) {
          // Prevent recursion on Function prototype methods themselves
          if (fn === rawCall || fn === rawApply || fn === rawBind || fn === rawToString) {
            return thisArg;
          }

          // Native browser functions (e.g., addEventListener, setTimeout) MUST keep real window/target
          if (isNativeFunction(fn)) {
            if (thisArg == windowProxy) return window;
            return (thisArg === undefined || thisArg === null) ? window : thisArg;
          }

          // User functions: redirect default global (undefined/null/real window) to windowProxy
          if (thisArg === undefined || thisArg === null || thisArg === window) {
            return windowProxy;
          }

          return thisArg;
        }

        // 3. Apply overrides safely using cached rawReflectApply
        Function.prototype.bind = function(thisArg, ...args) {
          const targetThis = normalizeThis(this, thisArg);
          const boundFn = rawReflectApply(rawBind, this, [targetThis, ...args]);

          Object.defineProperty(boundFn, '__boundThis__', {
            value: targetThis,
            writable: false,
            enumerable: false,
            configurable: true
          });

          return boundFn;
        };

        Function.prototype.call = function(thisArg, ...args) {
          const targetThis = normalizeThis(this, thisArg);
          return rawReflectApply(rawCall, this, [targetThis, ...args]);
        };

        Function.prototype.apply = function(thisArg, argsArray) {
          const targetThis = normalizeThis(this, thisArg);
          return rawReflectApply(rawApply, this, [targetThis, argsArray || []]);
        };

        window.__windowProxy = windowProxy;
        pageEmulator.__windowProxy = windowProxy;
        window.__rawReflectApply = rawReflectApply;
      })();

      window.__executeCode = function(__codeString, __sourceURL, __thisArg, __event) {
        var { __importModule } = __createModuleControls(__getScriptFileName());
        var __requireModule = __importModule;

        __codeString = window.__usefulHelpers.editCode(__codeString);
        return __rawReflectApply(function(window, self, globalThis, parent, top, location, document) {
          with (__globalLexicalScope) {
            return eval(`
            ${__event ? 'let event = __event;' : ''}
            ${__codeString.code}
            \n//# sourceURL=`+__sourceURL);
          }
        }, __thisArg, [__windowProxy, __windowProxy, __windowProxy, __windowProxy.parent, __windowProxy.top, __windowProxy.location, __windowProxy.document]);
      };

      window.__executeCodeAsync = function(__codeString, __sourceURL, __thisArg, __event) {
        var { __importModule } = __createModuleControls(__getScriptFileName());
        var __requireModule = __importModule;
        
        __codeString = window.__usefulHelpers.editCode(__codeString);
        __codeString = window.__usefulHelpers.editCodeAsync(__codeString);
        return __rawReflectApply(async function(window, self, globalThis, parent, top, location, document) {
          let __execResult;
          with (__globalLexicalScope) {
            await eval(`
            ${__event ? 'let event = __event;' : ''}
            (async function(){
              ${__codeString.code}
            })();
            \n//# sourceURL=`+__sourceURL);
          }
          return { value: __execResult };
        }, __thisArg, [__windowProxy, __windowProxy, __windowProxy, __windowProxy.parent, __windowProxy.top, __windowProxy.location, __windowProxy.document]);
      };

      window.__executeCodeModule = function(__codeString, __sourceURL, __thisArg, __event, __scriptFileName) {
        var { __importModule, __exportModule, __currentModuleExports } = __createModuleControls(__getScriptFileName(__scriptFileName));
        var __requireModule = __importModule;

        __codeString = `
          (async function(){
            ${window.__usefulHelpers.editCodeModule(__codeString)}
          })();
        `;

        __codeString = window.__usefulHelpers.editCode(__codeString);
        
        return __rawReflectApply(async function(window, self, globalThis, parent, top, location, document) {
          let __execResult;
          with (__globalLexicalScope) {
            await eval(`
            ${__event ? 'let event = __event;' : ''}
            ${__codeString.code}
            \n//# sourceURL=`+__sourceURL);
          }
          return __currentModuleExports;
        }, __thisArg, [__windowProxy, __windowProxy, __windowProxy, __windowProxy.parent, __windowProxy.top, __windowProxy.location, __windowProxy.document]);


      };
      // Hide emulator-only DOM state when page code serializes HTML.
      const nativeElementInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      const nativeElementOuterHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');

      function cleanSerializedElement(root) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return root;
        const elements = [root, ...root.querySelectorAll('*')];
        for (const el of elements) {
          if (el.hasAttribute('data-embed-frame') || el.hasAttribute('data-embed-wrapper')) {
            if (el.parentNode) el.parentNode.removeChild(el);
            continue;
          }
          for (const attr of Array.from(el.attributes || [])) {
            if (attr.name === 'data-page-id') {
              el.removeAttribute(attr.name);
              continue;
            }
            if (!attr.name.startsWith('data-raw-')) continue;
            const publicName = attr.name.slice('data-raw-'.length);
            if (publicName) el.setAttribute(publicName, attr.value);
            el.removeAttribute(attr.name);
          }
        }
        return root;
      }

      function serializePageElement(elem, outer) {
        const clone = elem.cloneNode(true);
        cleanSerializedElement(clone);
        return outer ? nativeElementOuterHTML.get.call(clone) : nativeElementInnerHTML.get.call(clone);
      }

      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: nativeElementInnerHTML.configurable,
        enumerable: nativeElementInnerHTML.enumerable,
        get() { return serializePageElement(this, false); },
        set(value) { return nativeElementInnerHTML.set.call(this, value); }
      });

      Object.defineProperty(Element.prototype, 'outerHTML', {
        configurable: nativeElementOuterHTML.configurable,
        enumerable: nativeElementOuterHTML.enumerable,
        get() { return serializePageElement(this, true); },
        set(value) { return nativeElementOuterHTML.set.call(this, value); }
      });
    }
    return `(${interceptorFunction.toString()})("${source_origin}","${base_url || source_url}","${source_url}");//# sourceURL=${name}`;
  }

  function createPageNetwork(network) {
    if (!(network instanceof Network)) return network || new Network();
    var pageNetwork = new Network();
    pageNetwork.endpoints = network.endpoints;
    return pageNetwork;
  }

  class PageEmulator {
    constructor(iframe, options = {}) {
      this.id = Math.random().toString(36).substring(2);
      window.__pageRegistry[this.id] = this;
      this.__pageRegistry = window.__pageRegistry;

      if (iframe.pageEmulator) throw new Error("iframe already has an emulator");

      const { network, location, history } = options;

      this.iframe = iframe;
      iframe.setAttribute('data-page-id',this.id);
      iframe.pageEmulator = this;
      iframe.usefulHelpers = usefulHelpers;

      this.iframe.removeAttribute('src');
      this.iframe.removeAttribute('srcdoc');

      this.location = location || {
        url: 'http://localhost:3000/',
        origin: 'http://localhost:3000'
      };

      this.history = history || [];
      this.historyIndex = -1;
      this.network = createPageNetwork(network);

      this.parent = false;
      this.children = [];

      this.runtimeInterceptor = "";
      this.eventInterceptors = {};
    }

    remove() {
      delete __pageRegistry[this.id];
      for (var i in this) delete this[i];
    }

    addChild(page) {
      if (!page || page === this) return page;
      if (page.parent === this && this.children.includes(page)) return page;
      if (page.parent && page.parent !== false && Array.isArray(page.parent.children)) {
        const oldIndex = page.parent.children.indexOf(page);
        if (oldIndex >= 0) page.parent.children.splice(oldIndex, 1);
      }
      page.parent = this;
      if (!this.children.includes(page)) this.children.push(page);
      return page;
    }

    async setDocument(rawHtml, processHtml = true, baseUrlOverride = null) {
      // Keep the exact source supplied to the emulator. DevTools Sources uses
      // this as the iframe's Original document, including dynamically-created
      // frames whose source was fetched after the parent document loaded.
      this.rawDocument = String(rawHtml ?? '');
      const finalHtml = await sandboxSource(rawHtml,this,processHtml,baseUrlOverride);

      // idk why i need to double it but it breaks if you remove one

      this.iframe.removeAttribute('src');
      this.iframe.removeAttribute('srcdoc');
      this.iframe.srcdoc = finalHtml;

      this.iframe.removeAttribute('src');
      this.iframe.removeAttribute('srcdoc');
      this.iframe.srcdoc = finalHtml;
    }

    setLocation(url, origin) {
      this.location.url = url;
      this.location.origin = origin;
    }

    setRuntimeInterceptor(funct) {
      this.runtimeInterceptor = extractFunctionBody(funct);
    }

    addRuntimeInterceptor(funct) {
      this.runtimeInterceptor = this.runtimeInterceptor + extractFunctionBody(funct);
    }

    deleteRuntimeInterceptor(funct) {
      this.runtimeInterceptor = '';
    }

    sendEvent(event, ...args) {
      var list = this.eventInterceptors[event];
      if (!list) return console.warn("No interceptor set up for: "+event);
      for (var i = 0; i < list.length; i++) {
        var ret = list[i].callback.apply(this, args);
        if (ret) return ret;
      }
    }

    async sendAsyncEvent(event, ...args) {
      var list = this.eventInterceptors[event];
      if (!list) return console.warn("No interceptor set up for: "+event);
      for (var i = 0; i < list.length; i++) {
        var ret = await list[i].callback.apply(this, args);
        if (ret) return ret;
      }
    }

    interceptEvent(event, callback, options) {
      this.eventInterceptors[event] = this.eventInterceptors[event] || [];
      this.eventInterceptors[event].push({callback,options});
      return callback;
    }
    removeEventListener(event, callback) {
      var list = this.eventInterceptors[event];
      if (!list) return;
      this.eventInterceptors[event] = list.filter(item => item.callback !== callback);
    }

    addEndpoint(endpoint) {
      this.network.addEndpoint(endpoint);
    }

    async runCommand(txt,source='<anonymous>') {
      var targetWin = this.iframe.contentWindow;
      return await targetWin.__executeCodeAsync(txt,source);
    }
  }

  window.PageEmulator = PageEmulator;

  // These are exposed for the existing runtime interceptor / browser-side
  // integrations without moving the implementations back into PageEmulator.
  window.createDataUri = createDataUri;
  window.rewriteCSSURLs = rewriteCSSURLs;
  window.getFileNameFromURL = getFileNameFromURL;
  window.sandboxSource = sandboxSource;
  window.preprocessHtml = preprocessHtml;

})();