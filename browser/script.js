

// // --- Settings & Environment ---
const ENV_SETTINGS = {
  NODE_ENV: "development",
  PORT: "443",
  //DEBUG: "express:*",
  USER: "browser_user"
};

const appdomain = "https://pumpkin-smasher.com"; 
const apprunfile = "index.js"; // Standard entry for Node 
const appbookmarkName = "Pumpkin Smasher";

var domain = "https://untitled-project.com";
var bookmarkName = "Untitled Project";

var domain2 = "https://test-project.com";
var bookmarkName2 = "Test Project";

// var domain3 = "https://horizon.com";
// var bookmarkName3 = "Horizon Test";


var pumpkinPeer = ensurePeerServer(appdomain,async function() {
  if (window.keepAlive) window.keepAlive.enable();

  var emulator = new NodeEmulator({
    domain: appdomain,
    rootfolder: "_files/Pumpkin-Smasher-2-main/",
    source: window.parent.zip,
    fileSystemSync: false,
    network: browserNetwork,
    env: ENV_SETTINGS
  });

  emulator.addEventListener('loaded',async function() {
    await emulator.terminalCommand("node "+apprunfile);
    // navigateTo(`${domain}/`);
  });

  emulator.addEventListener('console',function(method,args){
    console[method].apply(console,args);
  });

  emulator.addEventListener('error',async function(e,loc){
    console.error("Uncaught Error: " + e.message + " (" + loc + ":" + e.lineno + ") " + e.error.stack);
  });

  return emulator.endpoint;
});

// var domain = "https://untitled-project.com";
// var bookmarkName = "Untitled Project";
// var untitledPeer = ensurePeerServer(domain,async function() {
//   var endpoint = new StaticEndpoint({
//     domain: domain,
//     rootfolder: "_files/Project/",
//     runfile: "index.html",
//     source: window.parent.zip
//   });

//   endpoint.addEventListener('loaded',function(){
//     //navigateTo(`${domain}/`);
//   });

//   return endpoint;
// });

// browserNetwork.prependEndpoint(staticEndpoint);

// var domain2 = "https://test-project.com";
// var bookmarkName2 = "Test Project";

// var testPeer = ensurePeerServer(domain2,async function() {
//   return new StaticEndpoint({
//     domain: domain2,
//     rootfolder: "_files/Test/",
//     runfile: "index.html",
//     source: window.parent.zip
//   });
// });

// browserNetwork.prependEndpoint(staticEndpoint2);

// One client endpoint handles requests for all three domains.
// It determines which PeerServer to connect to from request.url.
var peerEndpoint = new PeerEndpoint();
browserNetwork.prependEndpoint(peerEndpoint);

var staticEndpoint = new StaticEndpoint({
  domain: domain,
  rootfolder: "_files/Project/",
  runfile: "index.html",
  source: window.parent.zip,
});

staticEndpoint.addEventListener('loaded',function(){
  navigateTo(`${domain}/`);
});

browserNetwork.prependEndpoint(staticEndpoint);


var staticEndpoint2 = new StaticEndpoint({
  domain: domain2,
  rootfolder: "_files/Test/",
  runfile: "index.html",
  source: window.parent.zip,
});

staticEndpoint2.addEventListener('loaded',function(){
  //navigateTo(`${domain}/`);
});

browserNetwork.prependEndpoint(staticEndpoint2);

// var emulator = new NodeEmulator({
//   domain: appdomain,
//   rootfolder: "_files/Pumpkin-Smasher-2-main/",
//   source: window.parent.zip,
//   fileSystemSync: false,
//   network: browserNetwork,
//   env: ENV_SETTINGS
// });
// browserNetwork.prependEndpoint(emulator.endpoint);

// emulator.addEventListener('loaded', async function() {
//   await emulator.terminalCommand("node "+apprunfile);
//   //navigateTo(appSettings.defaultTab);
// });

// emulator.addEventListener('console',function(method, args){
//   console[method].apply(console, args);
// });
// emulator.addEventListener('error',async function(e,loc){
//   console.error("Uncaught Error: " + e.message + " (" + loc + ":" + e.lineno + ") "+e.error.stack);
// });


// var staticEndpoint3 = new StaticEndpoint({
//   domain: domain3,
//   rootfolder: "_files/Horizon/",
//   runfile: "index.html",
//   source: window.parent.zip,
// });

// staticEndpoint3.addEventListener('loaded',function(){
//   //navigateTo(`${domain}/`);
// });

// browserNetwork.prependEndpoint(staticEndpoint3);



var staticEndpoint4 = new StaticEndpoint({
  domain: "https://proxy-browser.com",
  rootfolder: "/",
  runfile: "_browser/browser.html",
  source: window.parent.zip,
});
staticEndpoint4.addEventListener('loaded',function(){
  //navigateTo("https://self.host/");
});
browserNetwork.prependEndpoint(staticEndpoint4);



// ============================================================
// BROWSER SETTINGS
// ============================================================

appSettings.defaultTab = `${domain}/`;

updateSettings();

bookmarks = [
  { title: bookmarkName, url: `${domain}/` },
  { title: bookmarkName2, url: `${domain2}/` },
  { title: appbookmarkName, url: `${appdomain}/` }
].concat(bookmarks);

renderBookmarks();