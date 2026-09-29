self.MonacoEnvironment = {
  baseUrl: new URL('./', self.location.href).href
};
importScripts(new URL('./vs/base/worker/workerMain.js', self.location.href).href);
