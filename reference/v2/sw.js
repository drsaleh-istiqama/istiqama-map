const CACHE='istiqama-map-v2.5.0';
const LOCAL=['./','./index.html','./styles.css?v=2.5.0','./src/app.js?v=2.5.0','./src/domain.js','./src/locations.js','./src/map-pick.js','./src/people.js','./src/quick-options.js','./src/photos.js','./manifest.webmanifest','./assets/icon.svg','./vendor/leaflet.css','./vendor/leaflet.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(LOCAL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response}).catch(()=>caches.match(event.request).then(hit=>hit||(event.request.mode==='navigate'?caches.match('./index.html'):new Response('',{status:503,statusText:'Offline'})))));
});
