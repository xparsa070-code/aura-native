const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeAudio', {
  listDevices: () => ipcRenderer.invoke('native-audio:list-devices'),
  playTrack: (arrayBuffer, opts) => ipcRenderer.invoke('native-audio:play-track', arrayBuffer, opts),
  pause: () => ipcRenderer.invoke('native-audio:pause'),
  resume: () => ipcRenderer.invoke('native-audio:resume'),
  stop: () => ipcRenderer.invoke('native-audio:stop'),
  seek: (sec) => ipcRenderer.invoke('native-audio:seek', sec),
  setVolume: (vol) => ipcRenderer.invoke('native-audio:set-volume', vol),
  getPosition: () => ipcRenderer.invoke('native-audio:get-position'),
  setEQ: (payload) => ipcRenderer.invoke('native-audio:set-eq', payload),
  setTone: (payload) => ipcRenderer.invoke('native-audio:set-tone', payload),
  onEnded: (cb) => ipcRenderer.on('native-audio:ended', cb),
  onPosition: (cb) => ipcRenderer.on('native-audio:position', (evt, sec) => cb(sec))
});
