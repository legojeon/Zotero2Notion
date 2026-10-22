var app;
function install() {}
async function startup({ id, resourceURI, rootURI = resourceURI.spec }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  var w = Zotero.getMainWindow();
  var scope = {
    Zotero,
    Services,
    Components,
    ChromeUtils,
    IOUtils,
    PathUtils,
    console: w.console,
    URL: w.URL,
    URLSearchParams: w.URLSearchParams,
    TextEncoder: w.TextEncoder,
    TextDecoder: w.TextDecoder,
    AbortSignal: w.AbortSignal,
    crypto: w.crypto,
    Blob: w.Blob,
    FormData: w.FormData,
    structuredClone: w.structuredClone.bind(w),
  };
  Services.scriptloader.loadSubScript(rootURI + "content/plugin.js", scope);
  app = scope.Zotero.Zotero2Notion;
  await app.start({ id, rootURI });
}
function onMainWindowLoad({ window }) {
  app?.addWindow(window);
}
function onMainWindowUnload({ window }) {
  app?.removeWindow(window);
}
async function shutdown() {
  await app?.stop();
  delete Zotero.Zotero2Notion;
  app = undefined;
}
function uninstall() {}
